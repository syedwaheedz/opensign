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
const PLAYS_FILE = path.join(DATA_DIR, 'plays.ndjson'); // append-only proof-of-play log
fs.mkdirSync(MEDIA_DIR, { recursive: true });

// ---- tiny JSON store -------------------------------------------------------
let db = { devices: [], media: [], playlists: [], walls: [], layouts: [], admin: null, alert: null };
if (fs.existsSync(DB_FILE)) db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) };
function save() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}
const uid = () => crypto.randomUUID();
const pairingCode = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');

// ---- instant push: players hold a request open and we answer the moment their config changes ----
const waiters = new Map(); // deviceId -> Set<res>
function notify(deviceIds) {
  for (const id of deviceIds ?? waiters.keys()) {
    for (const res of waiters.get(id) ?? []) res.json({ changed: true });
    waiters.delete(id);
  }
}
const notifyDevice = (d) => notify([d.deviceId]);

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
  if (m?.widget) return res.type('html').send(widgetPage(m.widget));
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

const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function widgetPage(w) {
  const head = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
html,body{margin:0;height:100%;overflow:hidden;background:${w.bg};color:${w.fg};font-family:system-ui,sans-serif}
.c{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:4vw;box-sizing:border-box}`;
  if (w.kind === 'clock') {
    return head + `.t{font-size:min(22vw,36vh);font-weight:700;line-height:1}.d{font-size:min(5vw,8vh);opacity:.8;margin-top:1vh}</style>
<div class="c"><div class="t" id="t"></div><div class="d" id="d"></div></div>
<script>function u(){const n=new Date();t.textContent=n.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});d.textContent=n.toLocaleDateString([],{weekday:'long',day:'numeric',month:'long',year:'numeric'})}u();setInterval(u,1000)</script>`;
  }
  if (w.kind === 'ticker') {
    return head + `.m{white-space:nowrap;font-size:60vh;line-height:1;font-weight:700;animation:s 18s linear infinite;padding-left:100vw}
@keyframes s{to{transform:translateX(-100%)}}.c{padding:0}</style><div class="c" style="justify-content:center"><div class="m" id="m">${esc(w.text)}</div></div>
<script>m.style.animationDuration=Math.max(10,m.textContent.length*0.35)+'s'</script>`;
  }
  return head + `.x{font-size:9vw;font-weight:700;line-height:1.2;max-width:90vw;white-space:pre-wrap;word-break:break-word}</style>
<div class="c"><div class="x" id="x">${esc(w.text)}</div></div>
<script>let f=9;while(x.scrollHeight>innerHeight*0.9&&f>1.5){f-=0.5;x.style.fontSize=f+'vw'}</script>`;
}

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

function alertFor(d) {
  const a = db.alert;
  if (!a || a.until <= Date.now()) return null;
  if (a.deviceIds.length && !a.deviceIds.includes(d.id)) return null;
  return { message: a.message, color: a.color, until: a.until };
}

function buildConfig(req, d) {
  const wall = wallFor(d);
  const playlistIds = new Set(wall ? [wall.playlistId] : [d.defaultPlaylistId, ...d.schedule.map((s) => s.playlistId)].filter(Boolean));
  // A screen's default/slot id may point to a layout; its zones pull in their own playlists.
  const layouts = {};
  for (const id of [...playlistIds]) {
    const l = db.layouts.find((x) => x.id === id);
    if (!l) continue;
    layouts[id] = { id, name: l.name, zones: l.zones.map(({ x, y, w, h, playlistId }) => ({ x, y, w, h, playlistId })) };
    for (const z of l.zones) if (z.playlistId) playlistIds.add(z.playlistId);
  }
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
          src: m.file ? `${baseUrl(req)}/media/${m.file}` : m.embed || m.widget ? `${baseUrl(req)}/embed/${m.id}` : m.url,
        }];
      }),
    };
  }
  const body = {
    rev: d.rev, name: d.name, defaultPlaylistId: d.defaultPlaylistId, wall, alert: alertFor(d),
    schedule: wall ? [] : d.schedule.filter((s) => playlists[s.playlistId] || layouts[s.playlistId]), playlists, layouts,
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

app.get('/api/player/:deviceId/wait', (req, res) => {
  const d = db.devices.find((x) => x.deviceId === req.params.deviceId);
  if (!d) return res.status(404).json({ error: 'unknown device' });
  d.lastSeen = Date.now();
  if (req.query.v && d.paired && buildConfig(req, d).version !== req.query.v) return res.json({ changed: true });
  const set = waiters.get(d.deviceId) ?? new Set();
  waiters.set(d.deviceId, set);
  set.add(res);
  const timer = setTimeout(() => { set.delete(res); res.json({ changed: false }); }, 25000);
  res.on('close', () => { clearTimeout(timer); set.delete(res); });
});

app.post('/api/player/:deviceId/heartbeat', (req, res) => {
  const d = db.devices.find((x) => x.deviceId === req.params.deviceId);
  if (!d) return res.status(404).json({ error: 'unknown device' });
  d.lastSeen = Date.now();
  d.nowPlaying = req.body?.nowPlaying ?? null;
  d.configVersion = req.body?.version ?? null;
  d.appVersion = req.body?.appVersion ?? d.appVersion;
  const plays = Array.isArray(req.body?.plays) ? req.body.plays.slice(0, 500) : [];
  const lines = plays
    .filter((p) => typeof p?.itemId === 'string' && Number.isFinite(p.start) && Number.isFinite(p.ms))
    .map((p) => JSON.stringify({ d: d.id, i: p.itemId, n: String(p.name || '').slice(0, 200), t: Math.round(p.start), ms: Math.round(p.ms) }));
  if (lines.length) fs.appendFileSync(PLAYS_FILE, lines.join('\n') + '\n');
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
  for (const l of db.layouts) for (const z of l.zones) if (z.playlistId === req.params.id) z.playlistId = null;
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

// ---- layouts: split the screen into zones, each playing its own playlist ----
const pct = (v, lo, hi, d) => Math.min(hi, Math.max(lo, Number.isFinite(Number(v)) ? Math.round(Number(v) * 10) / 10 : d));
function cleanZones(zones) {
  return (Array.isArray(zones) ? zones : []).slice(0, 8).map((z, i) => {
    const x = pct(z.x, 0, 95, 0), y = pct(z.y, 0, 95, 0);
    return {
      id: String(z.id || uid()), name: String(z.name || `Zone ${i + 1}`).slice(0, 40), x, y,
      w: pct(z.w, 5, 100 - x, 100 - x), h: pct(z.h, 5, 100 - y, 100 - y),
      playlistId: z.playlistId && db.playlists.some((p) => p.id === z.playlistId) ? z.playlistId : null,
    };
  });
}
api.get('/layouts', (_req, res) => res.json(db.layouts));
api.post('/layouts', (req, res) => {
  const zones = cleanZones(req.body?.zones?.length ? req.body.zones : [{ name: 'Main', x: 0, y: 0, w: 100, h: 100 }]);
  const l = { id: uid(), name: String(req.body?.name || 'New layout').slice(0, 60), zones };
  db.layouts.push(l);
  save();
  res.json(l);
});
api.put('/layouts/:id', (req, res) => {
  const l = db.layouts.find((x) => x.id === req.params.id);
  if (!l) return res.status(404).json({ error: 'not found' });
  if (typeof req.body.name === 'string') l.name = req.body.name.slice(0, 60);
  if (Array.isArray(req.body.zones)) {
    if (!req.body.zones.length) return res.status(400).json({ error: 'A layout needs at least one zone' });
    l.zones = cleanZones(req.body.zones);
  }
  bumpAll();
  res.json(l);
});
api.delete('/layouts/:id', (req, res) => {
  db.layouts = db.layouts.filter((x) => x.id !== req.params.id);
  for (const d of db.devices) {
    if (d.defaultPlaylistId === req.params.id) d.defaultPlaylistId = null;
    d.schedule = d.schedule.filter((s) => s.playlistId !== req.params.id);
  }
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
  notifyDevice(d);
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
  notifyDevice(d);
  res.json(d);
});
api.post('/devices/:id/refresh', (req, res) => {
  const d = db.devices.find((x) => x.id === req.params.id);
  if (!d) return res.status(404).json({ error: 'not found' });
  d.rev++;
  save();
  notifyDevice(d);
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
  notify();
}

// ---- emergency alerts: full-screen takeover on all (or chosen) screens, pushed instantly ----
api.get('/alert', (_req, res) => res.json(db.alert && db.alert.until > Date.now() ? db.alert : null));
api.post('/alert', (req, res) => {
  const message = String(req.body?.message || '').trim().slice(0, 500);
  if (!message) return res.status(400).json({ error: 'Type the alert message' });
  const minutes = Math.min(1440, Math.max(1, Number(req.body?.minutes) || 5));
  const deviceIds = (req.body?.deviceIds || []).filter((id) => db.devices.some((d) => d.id === id));
  db.alert = {
    id: uid(), message, deviceIds, until: Date.now() + minutes * 60000,
    color: /^#[0-9a-f]{6}$/i.test(req.body?.color) ? req.body.color : '#c62828',
  };
  save();
  notify(db.devices.filter((d) => !deviceIds.length || deviceIds.includes(d.id)).map((d) => d.deviceId));
  res.json(db.alert);
});
api.delete('/alert', (_req, res) => {
  db.alert = null;
  save();
  notify();
  res.json({ ok: true });
});

// ---- proof of play ----
function readPlays(days) {
  if (!fs.existsSync(PLAYS_FILE)) return [];
  const since = Date.now() - days * 86400000;
  return fs.readFileSync(PLAYS_FILE, 'utf8').split('\n').filter(Boolean).flatMap((l) => {
    try { const p = JSON.parse(l); return p.t >= since ? [p] : []; } catch { return []; }
  });
}
const daysParam = (req) => Math.min(365, Math.max(1, Number(req.query.days) || 7));
api.get('/reports/plays', (req, res) => {
  const plays = readPlays(daysParam(req));
  const agg = (keyOf, nameOf) => {
    const m = new Map();
    for (const p of plays) {
      const k = keyOf(p), e = m.get(k) || { name: nameOf(p), plays: 0, seconds: 0, last: 0 };
      e.plays++; e.seconds += p.ms / 1000; e.last = Math.max(e.last, p.t);
      m.set(k, e);
    }
    return [...m.values()].sort((a, b) => b.plays - a.plays).map((e) => ({ ...e, seconds: Math.round(e.seconds) }));
  };
  res.json({
    total: plays.length,
    byMedia: agg((p) => p.i, (p) => db.media.find((x) => x.id === p.i)?.name || p.n),
    byScreen: agg((p) => p.d, (p) => db.devices.find((x) => x.id === p.d)?.name || 'Removed screen'),
  });
});
api.get('/reports/plays.csv', (req, res) => {
  const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const rows = readPlays(daysParam(req)).map((p) =>
    [new Date(p.t).toISOString(), q(db.devices.find((x) => x.id === p.d)?.name || p.d), q(db.media.find((x) => x.id === p.i)?.name || p.n), (p.ms / 1000).toFixed(1)].join(','));
  res.type('text/csv').send(['time,screen,media,seconds', ...rows].join('\n') + '\n');
});

// ---- widgets: text, scrolling ticker and clock, rendered as pages (no design tools needed) ----
api.post('/media/widget', (req, res) => {
  const b = req.body || {};
  const kind = ['text', 'ticker', 'clock'].includes(b.kind) ? b.kind : null;
  if (!kind) return res.status(400).json({ error: 'Unknown widget' });
  if (kind !== 'clock' && !String(b.text || '').trim()) return res.status(400).json({ error: 'Type the text to show' });
  const color = (v, d) => (/^#[0-9a-f]{6}$/i.test(v) ? v : d);
  const m = {
    id: uid(), type: 'web', provider: 'widget', size: 0, createdAt: Date.now(),
    name: b.name || (kind === 'clock' ? 'Clock' : String(b.text).slice(0, 40)),
    widget: { kind, text: String(b.text || '').slice(0, 1000), bg: color(b.bg, '#0b1220'), fg: color(b.fg, '#ffffff') },
  };
  db.media.push(m);
  save();
  res.json(m);
});

app.use('/api', api);

app.listen(PORT, () => {
  const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i.family === 'IPv4' && !i.internal).map((i) => i.address);
  console.log('\nOpenSign is running. Open this address in your browser:');
  for (const ip of ips) console.log(`   http://${ip}:${PORT}`);
  console.log('TV players on the same network will find this server automatically.');
  console.log(`If a TV cannot find it, hold OK on its remote and type: http://${ips[0] ?? 'this-computer'}:${PORT}\n`);
});

// Lets TV players find the server with no typing: they broadcast "OPENSIGN?" and we answer with our port.
const DISCOVERY_PORT = 41234;
const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
udp.on('message', (msg, rinfo) => {
  if (msg.toString().trim() !== 'OPENSIGN?') return;
  console.log(`A TV at ${rinfo.address} is looking for this server.`);
  const reply = Buffer.from('OPENSIGN ' + JSON.stringify({ port: Number(PORT), name: os.hostname() }));
  udp.send(reply, rinfo.port, rinfo.address);
});
udp.on('error', (e) => console.warn('Auto-discovery disabled:', e.message));
udp.bind(DISCOVERY_PORT);
