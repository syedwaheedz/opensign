import express from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import dgram from 'node:dgram';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD; // optional; otherwise the first visitor sets a password
const PUBLIC_URL = process.env.PUBLIC_URL; // optional, e.g. http://192.168.1.10:3000
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const DB_FILE = path.join(DATA_DIR, 'db.json');
fs.mkdirSync(MEDIA_DIR, { recursive: true });

// ---- tiny JSON store -------------------------------------------------------
let db = { devices: [], media: [], playlists: [], walls: [], admin: null };
if (fs.existsSync(DB_FILE)) db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) };
function save() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}
const uid = () => crypto.randomUUID();
const pairingCode = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');

// ---- app -------------------------------------------------------------------
const app = express();
app.use(express.json());
app.use('/media', express.static(MEDIA_DIR, { maxAge: '30d', immutable: true }));
app.use(express.static(path.join(__dirname, 'public')));

const tokens = new Set();
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
const setupRequired = () => !ADMIN_PASSWORD && !db.admin;
const newToken = () => { const t = crypto.randomBytes(24).toString('hex'); tokens.add(t); return t; };

app.get('/api/auth/status', (_req, res) => res.json({ setupRequired: setupRequired() }));
// First run: whoever opens the admin first chooses the password (no default password to forget to change).
app.post('/api/auth/setup', (req, res) => {
  const pw = String(req.body?.password || '');
  if (!setupRequired()) return res.status(403).json({ error: 'Already set up' });
  if (pw.length < 6) return res.status(400).json({ error: 'Use at least 6 characters' });
  const salt = crypto.randomBytes(16).toString('hex');
  db.admin = { salt, hash: hashPw(pw, salt) };
  save();
  res.json({ token: newToken() });
});
app.post('/api/auth/login', (req, res) => {
  const pw = String(req.body?.password || '');
  const ok = ADMIN_PASSWORD
    ? pw === ADMIN_PASSWORD
    : db.admin && crypto.timingSafeEqual(Buffer.from(hashPw(pw, db.admin.salt), 'hex'), Buffer.from(db.admin.hash, 'hex'));
  if (!ok) return res.status(401).json({ error: 'Wrong password' });
  res.json({ token: newToken() });
});
const requireAdmin = (req, res, next) => {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  if (!tokens.has(token)) return res.status(401).json({ error: 'Unauthorized' });
  next();
};

// ---- links: YouTube / Instagram / Facebook / direct images & videos / any web page ----
function classifyLink(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.replace(/^(www|m|web)\./, '');
  const idOk = (x) => x && /^[\w-]{6,64}$/.test(x);
  if (host === 'youtu.be' || host.endsWith('youtube.com')) {
    const id = host === 'youtu.be' ? u.pathname.slice(1) : u.searchParams.get('v') || (u.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]+)/) || [])[1];
    const list = u.searchParams.get('list');
    if (idOk(id)) return { type: 'web', provider: 'youtube', embed: { id, list: idOk(list) ? list : null } };
    if (idOk(list)) return { type: 'web', provider: 'youtube', embed: { id: null, list } };
  }
  if (host === 'instagram.com') {
    const m = u.pathname.match(/\/(p|reel|reels|tv)\/([\w-]+)/);
    if (m) return { type: 'web', provider: 'instagram', embed: { kind: m[1] === 'reels' ? 'reel' : m[1], code: m[2] } };
  }
  if (host === 'facebook.com' || host === 'fb.watch' || host === 'fb.com') {
    return { type: 'web', provider: 'facebook', embed: { href: u.href, video: /\/(videos|watch|reel)|fb\.watch/.test(u.href) } };
  }
  if (/\.(jpe?g|png|gif|webp|bmp)$/i.test(u.pathname)) return { type: 'image' };
  if (/\.(mp4|webm|mkv|mov)$/i.test(u.pathname)) return { type: 'video' };
  return { type: 'web' };
}

// A full-screen page that hosts the provider's embed; the player just loads this like any web page.
app.get('/embed/:id', (req, res) => {
  const m = db.media.find((x) => x.id === req.params.id);
  if (!m?.embed) return res.status(404).end();
  const e = m.embed, enc = encodeURIComponent;
  let frame;
  if (m.provider === 'youtube') {
    const q = 'autoplay=1&mute=1&controls=0&rel=0&playsinline=1&modestbranding=1';
    const src = e.id
      ? `https://www.youtube-nocookie.com/embed/${enc(e.id)}?${q}&loop=1&playlist=${enc(e.id)}${e.list ? '&list=' + enc(e.list) : ''}`
      : `https://www.youtube-nocookie.com/embed/videoseries?list=${enc(e.list)}&${q}&loop=1`;
    frame = `<iframe src="${src}" allow="autoplay; encrypted-media; fullscreen" referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
  } else if (m.provider === 'instagram') {
    frame = `<iframe class="tall" src="https://www.instagram.com/${e.kind}/${enc(e.code)}/embed/" scrolling="no" allow="autoplay; encrypted-media"></iframe>`;
  } else {
    const kind = e.video ? 'video' : 'post';
    frame = `<iframe src="https://www.facebook.com/plugins/${kind}.php?href=${enc(e.href)}&show_text=false&autoplay=true&mute=1&width=1280" scrolling="no" allow="autoplay; encrypted-media; fullscreen"></iframe>`;
  }
  res.type('html').send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>
html,body{margin:0;height:100%;background:#000;overflow:hidden}iframe{border:0;width:100%;height:100%}
iframe.tall{display:block;margin:0 auto;height:100%;width:min(100vw,calc(100vh*.62))}</style>${frame}`);
});

const baseUrl = (req) => PUBLIC_URL || `${req.protocol}://${req.get('host')}`;

// ---- player API (no admin auth; deviceId acts as the credential) -----------
app.post('/api/player/register', (req, res) => {
  const { deviceId, model } = req.body || {};
  if (!deviceId || typeof deviceId !== 'string') return res.status(400).json({ error: 'deviceId required' });
  let d = db.devices.find((x) => x.deviceId === deviceId);
  if (!d) {
    d = {
      id: uid(), deviceId, name: null, model: model || '', paired: false,
      pairingCode: pairingCode(), defaultPlaylistId: null, schedule: [], rev: 0,
      lastSeen: null, nowPlaying: null, createdAt: Date.now(),
    };
    db.devices.push(d);
    save();
  }
  res.json({ paired: d.paired, pairingCode: d.paired ? null : d.pairingCode });
});

// An enabled video wall takes over every member screen: they all play the wall's playlist,
// each showing its own tile (col,row) of a cols x rows canvas.
function wallFor(d) {
  for (const w of db.walls) {
    if (!w.enabled || !w.playlistId) continue;
    const m = w.members.find((x) => x.deviceId === d.id);
    if (m) return { id: w.id, cols: w.cols, rows: w.rows, col: m.col, row: m.row, playlistId: w.playlistId };
  }
  return null;
}

function buildConfig(req, d) {
  const wall = wallFor(d);
  const playlistIds = new Set(wall ? [wall.playlistId] : [d.defaultPlaylistId, ...d.schedule.map((s) => s.playlistId)].filter(Boolean));
  const playlists = {};
  for (const pid of playlistIds) {
    const p = db.playlists.find((x) => x.id === pid);
    if (!p) continue;
    playlists[pid] = {
      id: p.id, name: p.name,
      items: p.items.flatMap((it) => {
        const m = db.media.find((x) => x.id === it.mediaId);
        if (!m) return [];
        return [{
          id: m.id, name: m.name, type: m.type, duration: it.duration || 10, size: m.size || 0,
          src: m.file ? `${baseUrl(req)}/media/${m.file}` : m.embed ? `${baseUrl(req)}/embed/${m.id}` : m.url,
        }];
      }),
    };
  }
  const body = {
    rev: d.rev, name: d.name, defaultPlaylistId: d.defaultPlaylistId, wall,
    schedule: wall ? [] : d.schedule.filter((s) => playlists[s.playlistId]), playlists,
  };
  const version = crypto.createHash('sha1').update(JSON.stringify(body)).digest('hex').slice(0, 12);
  // serverTime is outside the version hash; players use it to sync wall playback across screens.
  return { version, serverTime: Date.now(), ...body };
}

app.get('/api/player/:deviceId/config', (req, res) => {
  const d = db.devices.find((x) => x.deviceId === req.params.deviceId);
  if (!d) return res.status(404).json({ error: 'unknown device' });
  d.lastSeen = Date.now();
  if (!d.paired) return res.json({ paired: false, pairingCode: d.pairingCode });
  res.json({ paired: true, ...buildConfig(req, d) });
});

app.post('/api/player/:deviceId/heartbeat', (req, res) => {
  const d = db.devices.find((x) => x.deviceId === req.params.deviceId);
  if (!d) return res.status(404).json({ error: 'unknown device' });
  d.lastSeen = Date.now();
  d.nowPlaying = req.body?.nowPlaying ?? null;
  d.configVersion = req.body?.version ?? null;
  d.appVersion = req.body?.appVersion ?? d.appVersion;
  save();
  res.json({ ok: true });
});

// ---- admin API -------------------------------------------------------------
const api = express.Router();
api.use(requireAdmin);

const upload = multer({
  storage: multer.diskStorage({
    destination: MEDIA_DIR,
    filename: (_req, file, cb) => cb(null, uid() + path.extname(file.originalname).toLowerCase()),
  }),
  limits: { fileSize: 4 * 1024 * 1024 * 1024 },
});

api.get('/media', (_req, res) => res.json(db.media));
api.post('/media', upload.array('files'), (req, res) => {
  const added = (req.files || []).flatMap((f) => {
    const type = f.mimetype.startsWith('video/') ? 'video' : f.mimetype.startsWith('image/') ? 'image' : null;
    if (!type) { fs.unlinkSync(f.path); return []; }
    const m = { id: uid(), name: f.originalname, type, file: f.filename, size: f.size, createdAt: Date.now() };
    db.media.push(m);
    return [m];
  });
  save();
  res.json(added);
});
const addLink = (req, res) => {
  const { name, url } = req.body || {};
  const c = classifyLink((url || '').trim());
  if (!c) return res.status(400).json({ error: 'Paste a full link starting with http:// or https://' });
  const m = { id: uid(), name: name || url, url: url.trim(), size: 0, createdAt: Date.now(), ...c };
  db.media.push(m);
  save();
  res.json(m);
};
api.post('/media/link', addLink);
api.post('/media/web', addLink);
api.delete('/media/:id', (req, res) => {
  const m = db.media.find((x) => x.id === req.params.id);
  if (!m) return res.status(404).json({ error: 'not found' });
  if (m.file) fs.rmSync(path.join(MEDIA_DIR, m.file), { force: true });
  db.media = db.media.filter((x) => x !== m);
  for (const p of db.playlists) p.items = p.items.filter((i) => i.mediaId !== m.id);
  bumpAll();
  res.json({ ok: true });
});

api.get('/playlists', (_req, res) => res.json(db.playlists));
api.post('/playlists', (req, res) => {
  const p = { id: uid(), name: req.body?.name || 'New playlist', items: [] };
  db.playlists.push(p);
  save();
  res.json(p);
});
api.put('/playlists/:id', (req, res) => {
  const p = db.playlists.find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  if (typeof req.body.name === 'string') p.name = req.body.name;
  if (Array.isArray(req.body.items)) {
    p.items = req.body.items.map((i) => ({ mediaId: String(i.mediaId), duration: Math.max(1, Number(i.duration) || 10) }));
  }
  bumpAll();
  res.json(p);
});
api.delete('/playlists/:id', (req, res) => {
  db.playlists = db.playlists.filter((x) => x.id !== req.params.id);
  for (const w of db.walls) if (w.playlistId === req.params.id) { w.playlistId = null; w.enabled = false; }
  for (const d of db.devices) {
    if (d.defaultPlaylistId === req.params.id) d.defaultPlaylistId = null;
    d.schedule = d.schedule.filter((s) => s.playlistId !== req.params.id);
  }
  bumpAll();
  res.json({ ok: true });
});

api.get('/walls', (_req, res) => res.json(db.walls));
api.post('/walls', (req, res) => {
  const w = { id: uid(), name: req.body?.name || 'Video wall', enabled: false, cols: 2, rows: 1, playlistId: null, members: [] };
  db.walls.push(w);
  save();
  res.json(w);
});
api.put('/walls/:id', (req, res) => {
  const w = db.walls.find((x) => x.id === req.params.id);
  if (!w) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  if (typeof b.name === 'string') w.name = b.name;
  if (typeof b.enabled === 'boolean') w.enabled = b.enabled;
  if (b.cols !== undefined) w.cols = Math.min(8, Math.max(1, Number(b.cols) || 1));
  if (b.rows !== undefined) w.rows = Math.min(8, Math.max(1, Number(b.rows) || 1));
  if (b.playlistId !== undefined) w.playlistId = b.playlistId || null;
  if (Array.isArray(b.members)) {
    const seen = new Set();
    w.members = b.members.filter((m) => db.devices.some((d) => d.id === m.deviceId) && !seen.has(m.deviceId) && seen.add(m.deviceId));
    w.members = w.members.map((m) => ({ deviceId: m.deviceId, col: Number(m.col) || 0, row: Number(m.row) || 0 }));
    // a screen can belong to only one wall
    for (const o of db.walls) if (o !== w) o.members = o.members.filter((m) => !seen.has(m.deviceId));
  }
  w.members = w.members.filter((m) => m.col < w.cols && m.row < w.rows);
  bumpAll();
  res.json(w);
});
api.delete('/walls/:id', (req, res) => {
  db.walls = db.walls.filter((x) => x.id !== req.params.id);
  bumpAll();
  res.json({ ok: true });
});

api.get('/devices', (_req, res) => res.json(db.devices));
api.post('/devices/claim', (req, res) => {
  const d = db.devices.find((x) => !x.paired && x.pairingCode === String(req.body?.code || '').trim());
  if (!d) return res.status(404).json({ error: 'No device is waiting with that code' });
  d.paired = true;
  d.pairingCode = null;
  d.name = req.body?.name || d.model || 'Screen';
  d.rev++;
  save();
  res.json(d);
});
api.put('/devices/:id', (req, res) => {
  const d = db.devices.find((x) => x.id === req.params.id);
  if (!d) return res.status(404).json({ error: 'not found' });
  const { name, defaultPlaylistId, schedule } = req.body || {};
  if (typeof name === 'string') d.name = name;
  if (defaultPlaylistId !== undefined) d.defaultPlaylistId = defaultPlaylistId || null;
  if (Array.isArray(schedule)) {
    d.schedule = schedule.map((s) => ({
      playlistId: String(s.playlistId),
      days: (s.days || []).map(Number).filter((n) => n >= 0 && n <= 6),
      start: /^\d\d:\d\d$/.test(s.start) ? s.start : '00:00',
      end: /^\d\d:\d\d$/.test(s.end) ? s.end : '23:59',
    }));
  }
  d.rev++;
  save();
  res.json(d);
});
api.post('/devices/:id/refresh', (req, res) => {
  const d = db.devices.find((x) => x.id === req.params.id);
  if (!d) return res.status(404).json({ error: 'not found' });
  d.rev++;
  save();
  res.json(d);
});
api.delete('/devices/:id', (req, res) => {
  db.devices = db.devices.filter((x) => x.id !== req.params.id);
  for (const w of db.walls) w.members = w.members.filter((m) => m.deviceId !== req.params.id);
  save();
  res.json({ ok: true });
});

function bumpAll() {
  for (const d of db.devices) d.rev++;
  save();
}

app.use('/api', api);

app.listen(PORT, () => {
  const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i.family === 'IPv4' && !i.internal).map((i) => i.address);
  console.log('\nOpenSign is running. Open this address in your browser:');
  for (const ip of ips) console.log(`   http://${ip}:${PORT}`);
  console.log('TV players on the same network will find this server automatically.\n');
});

// Lets TV players find the server with no typing: they broadcast "OPENSIGN?" and we answer with our port.
const DISCOVERY_PORT = 41234;
const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
udp.on('message', (msg, rinfo) => {
  if (msg.toString().trim() !== 'OPENSIGN?') return;
  const reply = Buffer.from('OPENSIGN ' + JSON.stringify({ port: Number(PORT), name: os.hostname() }));
  udp.send(reply, rinfo.port, rinfo.address);
});
udp.on('error', (e) => console.warn('Auto-discovery disabled:', e.message));
udp.bind(DISCOVERY_PORT);
