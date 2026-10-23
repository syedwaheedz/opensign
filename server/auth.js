// Accounts for a shared OpenSign server: stores (organisations), people, sessions, roles and feature switches.
//
//   platform admin  runs the server. Creates stores and their owner logins. Sees no store's data.
//   owner           runs one store: its content, staff logins and settings.
//   staff           works on the store's content. Cannot manage logins or settings.
//
// Every store-owned record carries `orgId`. Routes must filter by req.orgId (see index.js).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';

export const PW_MIN = 8;
const hex = (n) => crypto.randomBytes(n).toString('hex');

export function hashPassword(pw) {
  const salt = hex(16);
  return { salt, hash: crypto.scryptSync(String(pw), salt, 32).toString('hex') };
}
const DUMMY = hashPassword('dummy-password-for-timing');
export function checkPassword(pw, rec) {
  const r = rec?.salt && rec?.hash ? rec : DUMMY; // always do the same work, so timing does not reveal who exists
  const want = Buffer.from(r.hash, 'hex');
  const got = crypto.scryptSync(String(pw), r.salt, 32);
  return want.length === got.length && crypto.timingSafeEqual(want, got) && r !== DUMMY;
}

const err = (status, message) => Object.assign(new Error(message), { status });
const str = (v, max) => String(v ?? '').trim().slice(0, max);
const validLogin = (l) => /^[^\s]{3,80}$/.test(l);
const validPassword = (p) => typeof p === 'string' && p.length >= PW_MIN && p.length <= 200;
const hexColor = (v, d) => (/^#[0-9a-f]{6}$/i.test(v) ? v : d);
export const FEATURES = ['catalog']; // switchable per store: product catalog + poster generator
export const DEFAULT_ACCENT = '#4f8cff';

export function registerAuth({ app, db, save, uid, MEDIA_DIR, upload, onOrgRemoved }) {
  const h = (fn) => async (req, res) => {
    try { await fn(req, res); } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  };

  // ---- sessions (in memory: a restart signs everyone out) --------------------------------------
  const SESSION_MS = 24 * 3600e3;
  const sessions = new Map(); // token -> { userId, expires }
  const issue = (user) => { const t = hex(24); sessions.set(t, { userId: user.id, expires: Date.now() + SESSION_MS }); return t; };
  const revokeUser = (userId) => { for (const [t, s] of sessions) if (s.userId === userId) sessions.delete(t); };
  setInterval(() => { const n = Date.now(); for (const [t, s] of sessions) if (s.expires < n) sessions.delete(t); }, 600e3).unref();

  // ---- login rate limit -----------------------------------------------------------------------
  const failures = new Map(); // key -> { n, until }
  const LIMIT = Number(process.env.LOGIN_FAILURE_LIMIT) || 8;
  const tooMany = (key) => { const f = failures.get(key); return f && f.n >= LIMIT && f.until > Date.now(); };
  const fail = (key) => { const f = failures.get(key); const n = f && f.until > Date.now() ? f.n + 1 : 1; failures.set(key, { n, until: Date.now() + 10 * 60e3 }); };

  const org = (id) => db.orgs.find((o) => o.id === id) || null;
  const publicUser = (u) => ({ id: u.id, login: u.login, name: u.name, role: u.role, platform: !!u.platform, orgId: u.orgId || null, disabled: !!u.disabled, lastLogin: u.lastLogin || null });
  const publicOrg = (o) => o && ({
    id: o.id, name: o.name, accent: o.accent || DEFAULT_ACCENT, features: { ...o.features },
    logoUrl: o.logoFile ? `/media/${o.logoFile}` : '', importSource: o.importSource || '',
  });
  const me = (u) => ({ user: publicUser(u), org: publicOrg(org(u.orgId)) });

  // ---- middleware -----------------------------------------------------------------------------
  const requireAuth = (req, res, next) => {
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    const s = sessions.get(token);
    const user = s && s.expires > Date.now() ? db.users.find((u) => u.id === s.userId && !u.disabled) : null;
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const o = user.orgId ? org(user.orgId) : null;
    if (user.orgId && (!o || o.disabled)) return res.status(403).json({ error: 'This store is switched off' });
    s.expires = Date.now() + SESSION_MS;
    req.user = user; req.org = o; req.orgId = user.orgId || null; req.token = token;
    next();
  };
  const requireOrg = (req, res, next) => (req.orgId ? next() : res.status(403).json({ error: 'This login does not belong to a store' }));
  const requireOwner = (req, res, next) => (req.user.role === 'owner' ? next() : res.status(403).json({ error: 'Only the store owner can do this' }));
  const requirePlatform = (req, res, next) => (req.user.platform ? next() : res.status(403).json({ error: 'Only the platform administrator can do this' }));
  const requireFeature = (name) => (req, res, next) => (req.org?.features?.[name] ? next() : res.status(403).json({ error: 'This feature is not switched on for your store' }));

  // ---- public: first run, login -----------------------------------------------------------------
  app.get('/api/auth/status', (_req, res) => res.json({ setupRequired: db.users.length === 0 }));

  // First run only: whoever opens the page first becomes the platform administrator.
  app.post('/api/auth/setup', h((req, res) => {
    if (db.users.length) throw err(403, 'Already set up');
    const login = str(req.body?.login, 80), name = str(req.body?.name, 80) || login;
    if (!validLogin(login)) throw err(400, 'Use an email or name of 3 to 80 characters without spaces');
    if (!validPassword(req.body?.password)) throw err(400, `Use at least ${PW_MIN} characters for the password`);
    const user = { id: uid(), orgId: null, login, name, role: 'owner', platform: true, ...hashPassword(req.body.password), disabled: false, createdAt: Date.now() };
    db.users.push(user);
    save();
    res.json({ token: issue(user), ...me(user) });
  }));

  app.post('/api/auth/login', h((req, res) => {
    const login = str(req.body?.login, 80).toLowerCase();
    const key = `${req.ip}|${login}`;
    if (tooMany(key) || tooMany(`${req.ip}|*`)) throw err(429, 'Too many attempts. Wait a few minutes and try again.');
    const user = db.users.find((u) => u.login.toLowerCase() === login);
    const ok = checkPassword(req.body?.password, user) && !user.disabled;
    if (!ok) { fail(key); fail(`${req.ip}|*`); throw err(401, 'Wrong login or password'); }
    const o = user.orgId ? org(user.orgId) : null;
    if (user.orgId && (!o || o.disabled)) throw err(403, 'This store is switched off. Ask the platform administrator.');
    failures.delete(key);
    user.lastLogin = Date.now();
    save();
    res.json({ token: issue(user), ...me(user) });
  }));

  // ---- signed in: who am I, change my details ---------------------------------------------------------
  const account = express.Router();
  account.use(requireAuth);
  account.get('/me', (req, res) => res.json(me(req.user)));
  account.post('/auth/logout', (req, res) => { sessions.delete(req.token); res.json({ ok: true }); });
  account.put('/me', h((req, res) => {
    const u = req.user;
    if (req.body?.name !== undefined) u.name = str(req.body.name, 80) || u.login;
    if (req.body?.login !== undefined) {
      const login = str(req.body.login, 80);
      if (!validLogin(login)) throw err(400, 'Use an email or name of 3 to 80 characters without spaces');
      if (db.users.some((x) => x !== u && x.login.toLowerCase() === login.toLowerCase())) throw err(409, 'That login is already used');
      u.login = login;
    }
    save();
    res.json(me(u));
  }));
  account.post('/me/password', h((req, res) => {
    if (!checkPassword(req.body?.current, req.user)) throw err(403, 'The current password is wrong');
    if (!validPassword(req.body?.next)) throw err(400, `Use at least ${PW_MIN} characters for the new password`);
    Object.assign(req.user, hashPassword(req.body.next));
    revokeUser(req.user.id);
    const token = issue(req.user); // other devices are signed out, this one stays signed in
    save();
    res.json({ token });
  }));

  // ---- store settings and people (owner) -----------------------------------------------------------------
  account.put('/org', requireOrg, requireOwner, h((req, res) => {
    const o = req.org;
    if (req.body?.name !== undefined) {
      const name = str(req.body.name, 80);
      if (!name) throw err(400, 'Type a store name');
      o.name = name;
    }
    if (req.body?.accent !== undefined) o.accent = hexColor(req.body.accent, o.accent || DEFAULT_ACCENT);
    save();
    res.json(me(req.user));
  }));
  account.post('/org/logo', requireOrg, requireOwner, upload.single('file'), h((req, res) => {
    if (!req.file) throw err(400, 'Choose a PNG, JPEG or WebP image');
    const head = Buffer.alloc(12);
    const fd = fs.openSync(req.file.path, 'r'); fs.readSync(fd, head, 0, 12, 0); fs.closeSync(fd);
    const isPng = head.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const isJpg = head[0] === 0xff && head[1] === 0xd8;
    const isWebp = head.subarray(0, 4).toString() === 'RIFF' && head.subarray(8, 12).toString() === 'WEBP';
    if (!isPng && !isJpg && !isWebp) { fs.rmSync(req.file.path, { force: true }); throw err(400, 'Choose a PNG, JPEG or WebP image'); }
    if (req.org.logoFile) fs.rmSync(path.join(MEDIA_DIR, req.org.logoFile), { force: true });
    req.org.logoFile = req.file.filename;
    save();
    res.json(me(req.user));
  }));
  account.delete('/org/logo', requireOrg, requireOwner, h((req, res) => {
    if (req.org.logoFile) fs.rmSync(path.join(MEDIA_DIR, req.org.logoFile), { force: true });
    req.org.logoFile = '';
    save();
    res.json(me(req.user));
  }));

  const orgUsers = (orgId) => db.users.filter((u) => u.orgId === orgId);
  const activeOwners = (orgId) => orgUsers(orgId).filter((u) => u.role === 'owner' && !u.disabled);
  account.get('/org/users', requireOrg, requireOwner, (req, res) => res.json(orgUsers(req.orgId).map(publicUser)));
  account.post('/org/users', requireOrg, requireOwner, h((req, res) => {
    const login = str(req.body?.login, 80);
    if (!validLogin(login)) throw err(400, 'Use an email or name of 3 to 80 characters without spaces');
    if (db.users.some((u) => u.login.toLowerCase() === login.toLowerCase())) throw err(409, 'That login is already used');
    if (!validPassword(req.body?.password)) throw err(400, `Use at least ${PW_MIN} characters for the password`);
    const u = { id: uid(), orgId: req.orgId, login, name: str(req.body?.name, 80) || login, role: req.body?.role === 'owner' ? 'owner' : 'staff', platform: false, ...hashPassword(req.body.password), disabled: false, createdAt: Date.now() };
    db.users.push(u);
    save();
    res.json(publicUser(u));
  }));
  account.put('/org/users/:id', requireOrg, requireOwner, h((req, res) => {
    const u = orgUsers(req.orgId).find((x) => x.id === req.params.id);
    if (!u) throw err(404, 'Not found');
    const b = req.body || {};
    const next = { role: b.role === undefined ? u.role : (b.role === 'owner' ? 'owner' : 'staff'), disabled: b.disabled === undefined ? u.disabled : !!b.disabled };
    if ((u.role === 'owner' && !u.disabled) && (next.role !== 'owner' || next.disabled) && activeOwners(req.orgId).length <= 1) throw err(400, 'A store needs at least one active owner');
    if (b.name !== undefined) u.name = str(b.name, 80) || u.login;
    Object.assign(u, next);
    if (b.password !== undefined) {
      if (!validPassword(b.password)) throw err(400, `Use at least ${PW_MIN} characters for the password`);
      Object.assign(u, hashPassword(b.password));
    }
    if (u.disabled || b.password !== undefined || b.role !== undefined) revokeUser(u.id);
    save();
    res.json(publicUser(u));
  }));
  account.delete('/org/users/:id', requireOrg, requireOwner, h((req, res) => {
    const u = orgUsers(req.orgId).find((x) => x.id === req.params.id);
    if (!u) throw err(404, 'Not found');
    if (u.id === req.user.id) throw err(400, 'You cannot remove your own login');
    if (u.role === 'owner' && !u.disabled && activeOwners(req.orgId).length <= 1) throw err(400, 'A store needs at least one active owner');
    revokeUser(u.id);
    db.users = db.users.filter((x) => x !== u);
    save();
    res.json({ ok: true });
  }));

  // ---- platform administration (no store data is exposed here) -------------------------------------------------
  const platform = express.Router();
  platform.use(requireAuth, requirePlatform);
  const orgSummary = (o) => ({
    ...publicOrg(o), disabled: !!o.disabled, createdAt: o.createdAt,
    users: orgUsers(o.id).map(publicUser),
    counts: { screens: db.devices.filter((d) => d.orgId === o.id).length, media: db.media.filter((m) => m.orgId === o.id).length },
  });
  platform.get('/orgs', (_req, res) => res.json(db.orgs.map(orgSummary)));
  const cleanImportSource = (v) => {
    const s = str(v, 300);
    if (!s) return '';
    let u;
    try { u = new URL(s); } catch { throw err(400, 'The import address must be a full http(s) address'); }
    if (!['http:', 'https:'].includes(u.protocol)) throw err(400, 'The import address must be a full http(s) address');
    return u.href.replace(/\/+$/, '');
  };
  platform.post('/orgs', h((req, res) => {
    const name = str(req.body?.name, 80);
    if (!name) throw err(400, 'Type the store name');
    if (db.orgs.some((o) => o.name.toLowerCase() === name.toLowerCase())) throw err(409, 'A store with that name exists');
    // "My own store": the signed-in platform administrator becomes the owner (one login for both jobs).
    const mine = req.body?.asMyStore === true;
    if (mine && req.user.orgId) throw err(400, 'You already belong to a store');
    const login = str(req.body?.ownerLogin, 80);
    if (!mine) {
      if (!validLogin(login)) throw err(400, 'The owner login must be an email or name of 3 to 80 characters without spaces');
      if (db.users.some((u) => u.login.toLowerCase() === login.toLowerCase())) throw err(409, 'That owner login is already used');
      if (!validPassword(req.body?.ownerPassword)) throw err(400, `Use at least ${PW_MIN} characters for the owner's first password`);
    }
    const o = {
      id: uid(), name, accent: hexColor(req.body?.accent, DEFAULT_ACCENT), logoFile: '', importSource: cleanImportSource(req.body?.importSource),
      features: Object.fromEntries(FEATURES.map((f) => [f, req.body?.features?.[f] === true])), disabled: false, createdAt: Date.now(),
    };
    db.orgs.push(o);
    if (mine) Object.assign(req.user, { orgId: o.id, role: 'owner' });
    else db.users.push({ id: uid(), orgId: o.id, login, name: str(req.body?.ownerName, 80) || login, role: 'owner', platform: false, ...hashPassword(req.body.ownerPassword), disabled: false, createdAt: Date.now() });
    save();
    res.json(orgSummary(o));
  }));
  platform.put('/orgs/:id', h((req, res) => {
    const o = org(req.params.id);
    if (!o) throw err(404, 'Not found');
    const b = req.body || {};
    if (b.name !== undefined) {
      const name = str(b.name, 80);
      if (!name) throw err(400, 'Type the store name');
      o.name = name;
    }
    if (b.features) for (const f of FEATURES) if (b.features[f] !== undefined) o.features[f] = b.features[f] === true;
    if (b.importSource !== undefined) o.importSource = cleanImportSource(b.importSource);
    if (b.disabled !== undefined) { o.disabled = !!b.disabled; if (o.disabled) for (const u of orgUsers(o.id)) revokeUser(u.id); }
    save();
    res.json(orgSummary(o));
  }));
  // Reset a store login's password (for example, an owner who forgot theirs).
  platform.post('/orgs/:id/users/:uid/password', h((req, res) => {
    const u = orgUsers(req.params.id).find((x) => x.id === req.params.uid);
    if (!u) throw err(404, 'Not found');
    if (!validPassword(req.body?.password)) throw err(400, `Use at least ${PW_MIN} characters for the password`);
    Object.assign(u, hashPassword(req.body.password));
    revokeUser(u.id);
    save();
    res.json({ ok: true });
  }));
  // Deleting a store removes ALL of its data and files. The caller must type the store name.
  platform.delete('/orgs/:id', h((req, res) => {
    const o = org(req.params.id);
    if (!o) throw err(404, 'Not found');
    if (str(req.body?.confirmName, 80) !== o.name) throw err(400, 'Type the exact store name to confirm');
    for (const u of orgUsers(o.id)) revokeUser(u.id);
    onOrgRemoved(o.id);
    if (o.logoFile) fs.rmSync(path.join(MEDIA_DIR, o.logoFile), { force: true });
    db.users = db.users.filter((u) => u.orgId !== o.id);
    db.orgs = db.orgs.filter((x) => x !== o);
    save();
    res.json({ ok: true });
  }));
  platform.get('/admins', (_req, res) => res.json(db.users.filter((u) => u.platform).map(publicUser)));
  platform.post('/admins', h((req, res) => {
    const login = str(req.body?.login, 80);
    if (!validLogin(login)) throw err(400, 'Use an email or name of 3 to 80 characters without spaces');
    if (db.users.some((u) => u.login.toLowerCase() === login.toLowerCase())) throw err(409, 'That login is already used');
    if (!validPassword(req.body?.password)) throw err(400, `Use at least ${PW_MIN} characters for the password`);
    const u = { id: uid(), orgId: null, login, name: str(req.body?.name, 80) || login, role: 'owner', platform: true, ...hashPassword(req.body.password), disabled: false, createdAt: Date.now() };
    db.users.push(u);
    save();
    res.json(publicUser(u));
  }));

  // Recovery: set both variables to create or reset a platform administrator at start-up.
  const envLogin = process.env.PLATFORM_ADMIN_LOGIN, envPw = process.env.PLATFORM_ADMIN_PASSWORD;
  if (envLogin && validLogin(envLogin) && validPassword(envPw)) {
    let u = db.users.find((x) => x.login.toLowerCase() === envLogin.toLowerCase());
    if (!u) { u = { id: uid(), orgId: null, login: envLogin, name: envLogin, role: 'owner', platform: true, disabled: false, createdAt: Date.now() }; db.users.push(u); }
    Object.assign(u, hashPassword(envPw), { platform: true, disabled: false });
    save();
  }

  return { account, platform, requireAuth, requireOrg, requireOwner, requireFeature, publicOrg };
}
