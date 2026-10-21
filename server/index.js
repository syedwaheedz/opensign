import express from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const PUBLIC_URL = process.env.PUBLIC_URL; // optional, e.g. http://192.168.1.10:3000
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const DB_FILE = path.join(DATA_DIR, 'db.json');
fs.mkdirSync(MEDIA_DIR, { recursive: true });

// ---- tiny JSON store -------------------------------------------------------
let db = { devices: [], media: [], playlists: [] };
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
app.post('/api/auth/login', (req, res) => {
  if (req.body?.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Wrong password' });
  const token = crypto.randomBytes(24).toString('hex');
  tokens.add(token);
  res.json({ token });
});
const requireAdmin = (req, res, next) => {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  if (!tokens.has(token)) return res.status(401).json({ error: 'Unauthorized' });
  next();
};

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

function buildConfig(req, d) {
  const playlistIds = new Set([d.defaultPlaylistId, ...d.schedule.map((s) => s.playlistId)].filter(Boolean));
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
          src: m.type === 'web' ? m.url : `${baseUrl(req)}/media/${m.file}`,
        }];
      }),
    };
  }
  const body = {
    rev: d.rev, name: d.name, defaultPlaylistId: d.defaultPlaylistId,
    schedule: d.schedule.filter((s) => playlists[s.playlistId]), playlists,
  };
  const version = crypto.createHash('sha1').update(JSON.stringify(body)).digest('hex').slice(0, 12);
  return { version, ...body };
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
api.post('/media/web', (req, res) => {
  const { name, url } = req.body || {};
  if (!/^https?:\/\//.test(url || '')) return res.status(400).json({ error: 'valid http(s) url required' });
  const m = { id: uid(), name: name || url, type: 'web', url, size: 0, createdAt: Date.now() };
  db.media.push(m);
  save();
  res.json(m);
});
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
  save();
  res.json({ ok: true });
});

function bumpAll() {
  for (const d of db.devices) d.rev++;
  save();
}

app.use('/api', api);

app.listen(PORT, () => {
  console.log(`OpenSign server listening on :${PORT}`);
  if (ADMIN_PASSWORD === 'admin') console.warn('WARNING: using default admin password. Set ADMIN_PASSWORD.');
});
