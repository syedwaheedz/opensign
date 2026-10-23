// Logins, roles, the platform administrator, per-store features, and the login rate limit.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, pngForm } from './helpers.js';

let s, store;
before(async () => {
  s = await startServer({ LOGIN_FAILURE_LIMIT: '5' });
  await s.setupPlatform();
  store = await s.createStore('Acme');
});
after(() => s.stop());

const staffLogin = async (name = 'staff1') => {
  const r = await store.owner.call('POST', '/api/org/users', { login: name, name: 'Staff', role: 'staff', password: 'staff-pass-1' });
  assert.equal(r.status, 200);
  return { user: r.body, client: await s.clientFor(name, 'staff-pass-1') };
};

test('every admin route needs a login', async () => {
  for (const p of ['/api/media', '/api/playlists', '/api/devices', '/api/me', '/api/org/users', '/api/platform/orgs', '/api/products', '/api/posters']) {
    assert.equal((await s.request(null, 'GET', p)).status, 401, p);
  }
  assert.equal((await s.request('not-a-token', 'GET', '/api/media')).status, 401);
});

test('staff can work on content but cannot manage logins or store settings', async () => {
  const { client } = await staffLogin();
  assert.equal((await client.call('POST', '/api/playlists', { name: 'By staff' })).status, 200);
  assert.equal((await client.call('POST', '/api/media', pngForm('s.png'))).status, 200);
  for (const [m, p, b] of [['GET', '/api/org/users'], ['POST', '/api/org/users', { login: 'x1x', password: 'password-1' }], ['PUT', '/api/org', { name: 'Hacked' }], ['POST', '/api/org/logo', pngForm('l.png', 'file')]]) {
    assert.equal((await client.call(m, p, b)).status, 403, `${m} ${p}`);
  }
  assert.equal((await client.call('GET', '/api/platform/orgs')).status, 403);
  assert.equal(client.me.org.name, 'Acme');
});

test('the platform administrator manages stores but cannot read any store\'s data', async () => {
  const p = s.platform;
  assert.equal((await p.call('GET', '/api/platform/orgs')).body.some((o) => o.name === 'Acme'), true);
  for (const path of ['/api/media', '/api/playlists', '/api/devices', '/api/walls', '/api/layouts', '/api/alert', '/api/reports/plays', '/api/products', '/api/posters']) {
    assert.equal((await p.call('GET', path)).status, 403, path);
  }
  const listing = JSON.stringify((await p.call('GET', '/api/platform/orgs')).body);
  assert.ok(!listing.includes('salt') && !listing.includes('hash'), 'password data must never be returned');
});

test('owner adds, edits, disables and removes staff; the last owner is protected', async () => {
  const o = store.owner;
  const { user, client } = await staffLogin('staff2');
  assert.equal((await o.call('GET', '/api/org/users')).body.length >= 2, true);
  assert.equal((await o.call('POST', '/api/org/users', { login: 'STAFF2', password: 'password-1' })).status, 409); // duplicate, any case
  assert.equal((await o.call('POST', '/api/org/users', { login: 'weak1', password: '123' })).status, 400);
  // disabling kills the staff member's session at once
  await o.call('PUT', `/api/org/users/${user.id}`, { disabled: true });
  assert.equal((await client.call('GET', '/api/media')).status, 401);
  assert.equal((await s.post('/api/auth/login', { login: 'staff2', password: 'staff-pass-1' })).status, 401);
  // password reset by the owner
  await o.call('PUT', `/api/org/users/${user.id}`, { disabled: false, password: 'new-staff-pass' });
  assert.equal((await s.post('/api/auth/login', { login: 'staff2', password: 'new-staff-pass' })).status, 200);
  assert.equal((await o.call('DELETE', `/api/org/users/${user.id}`)).status, 200);
  // protections
  const self = (await o.call('GET', '/api/org/users')).body.find((u) => u.role === 'owner');
  assert.equal((await o.call('DELETE', `/api/org/users/${self.id}`)).status, 400);
  assert.equal((await o.call('PUT', `/api/org/users/${self.id}`, { role: 'staff' })).status, 400);
  assert.equal((await o.call('PUT', `/api/org/users/${self.id}`, { disabled: true })).status, 400);
});

test('changing a password signs out other sessions and needs the current password', async () => {
  const u = (await s.platform.call('POST', '/api/platform/admins', { login: 'second-admin', password: 'second-pass-1' })).body;
  const one = await s.clientFor('second-admin', 'second-pass-1');
  const two = await s.clientFor('second-admin', 'second-pass-1');
  assert.equal((await one.call('POST', '/api/me/password', { current: 'wrong', next: 'another-pass-1' })).status, 403);
  assert.equal((await one.call('POST', '/api/me/password', { current: 'second-pass-1', next: 'short' })).status, 400);
  const ok = await one.call('POST', '/api/me/password', { current: 'second-pass-1', next: 'another-pass-1' });
  assert.equal(ok.status, 200);
  assert.equal((await two.call('GET', '/api/me')).status, 401); // the other session is gone
  one.token = ok.body.token; // this one is re-issued
  assert.equal((await one.call('GET', '/api/me')).status, 200);
  assert.ok(u.id);
});

test('the catalog and posters are off until the platform administrator switches them on', async () => {
  const plain = await s.createStore('Plain Co', { features: { catalog: false } });
  for (const p of ['/api/products', '/api/posters', '/api/catalog/meta']) assert.equal((await plain.owner.call('GET', p)).status, 403, p);
  assert.equal((await plain.owner.call('POST', '/api/products', { brand: 'x', model: 'y' })).status, 403);
  await s.platform.call('PUT', `/api/platform/orgs/${plain.org.id}`, { features: { catalog: true } });
  assert.equal((await plain.owner.call('GET', '/api/products')).status, 200);
  await s.platform.call('PUT', `/api/platform/orgs/${plain.org.id}`, { features: { catalog: false } });
  assert.equal((await plain.owner.call('GET', '/api/products')).status, 403);
  assert.equal(plain.owner.me.org.features.catalog, false);
});

test('a disabled store is locked out at once and cannot sign in', async () => {
  const gone = await s.createStore('Paused Co');
  await s.platform.call('PUT', `/api/platform/orgs/${gone.org.id}`, { disabled: true });
  assert.equal((await gone.owner.call('GET', '/api/media')).status, 401); // its sessions are revoked immediately
  assert.equal((await s.post('/api/auth/login', { login: gone.login, password: gone.password })).status, 403);
  await s.platform.call('PUT', `/api/platform/orgs/${gone.org.id}`, { disabled: false });
  assert.equal((await s.post('/api/auth/login', { login: gone.login, password: gone.password })).status, 200);
});

test('store settings: name, accent colour and logo (images only)', async () => {
  const o = store.owner;
  const r = await o.call('PUT', '/api/org', { name: 'Acme Phones', accent: '#112233' });
  assert.equal(r.body.org.name, 'Acme Phones');
  assert.equal(r.body.org.accent, '#112233');
  assert.equal((await o.call('PUT', '/api/org', { accent: 'red; background:url(x)' })).body.org.accent, '#112233'); // bad colours ignored
  assert.equal((await o.call('POST', '/api/org/logo', (() => { const fd = new FormData(); fd.append('file', new Blob(['<svg onload=alert(1)>'], { type: 'image/svg+xml' }), 'l.svg'); return fd; })())).status, 400);
  const logo = await o.call('POST', '/api/org/logo', pngForm('logo.png', 'file'));
  assert.equal(logo.status, 200);
  assert.equal((await fetch(s.base + logo.body.org.logoUrl)).status, 200);
  await o.call('PUT', '/api/org', { name: 'Acme' });
});

test('platform: creating stores validates input; deleting a store needs its name and removes its data', async () => {
  const p = s.platform;
  assert.equal((await p.call('POST', '/api/platform/orgs', { name: 'Acme', ownerLogin: 'dup-owner', ownerPassword: 'password-1' })).status, 409);
  assert.equal((await p.call('POST', '/api/platform/orgs', { name: 'Bad', ownerLogin: 'x y', ownerPassword: 'password-1' })).status, 400);
  assert.equal((await p.call('POST', '/api/platform/orgs', { name: 'Bad', ownerLogin: 'okowner', ownerPassword: 'short' })).status, 400);
  assert.equal((await p.call('POST', '/api/platform/orgs', { name: 'Bad', ownerLogin: 'okowner', ownerPassword: 'password-1', importSource: 'javascript:alert(1)' })).status, 400);

  const doomed = await s.createStore('Doomed Co');
  const media = (await doomed.owner.call('POST', '/api/media', pngForm('d.png'))).body[0];
  await s.pairDevice('doomed-tv', 'D', doomed.owner);
  assert.equal((await fetch(`${s.base}/media/${media.file}`)).status, 200);
  assert.equal((await p.call('DELETE', `/api/platform/orgs/${doomed.org.id}`, { confirmName: 'wrong' })).status, 400);
  assert.equal((await p.call('DELETE', `/api/platform/orgs/${doomed.org.id}`, { confirmName: 'Doomed Co' })).status, 200);
  assert.equal((await fetch(`${s.base}/media/${media.file}`)).status, 404); // files are removed
  assert.equal((await doomed.owner.call('GET', '/api/media')).status, 401); // sessions are gone
  assert.equal((await fetch(`${s.base}/api/player/doomed-tv/config`)).status, 404); // the TV is released
  assert.ok(!fs.readFileSync(path.join(s.dataDir, 'db.json'), 'utf8').includes('doomed-tv'));
});

test('repeated wrong passwords are rate limited', async () => {
  const login = 'ratelimit-target';
  await s.platform.call('POST', '/api/platform/admins', { login, password: 'right-pass-123' });
  let last;
  for (let i = 0; i < 6; i++) last = await s.post('/api/auth/login', { login, password: 'wrong-pass-' + i });
  assert.equal(last.status, 429);
  assert.equal((await s.post('/api/auth/login', { login, password: 'right-pass-123' })).status, 429); // even the right password waits
});

test('recovery: PLATFORM_ADMIN_LOGIN / PLATFORM_ADMIN_PASSWORD create or reset a platform administrator', async () => {
  const r = await startServer({ PLATFORM_ADMIN_LOGIN: 'rescue', PLATFORM_ADMIN_PASSWORD: 'rescue-pass-1' });
  try {
    assert.deepEqual(await (await fetch(r.base + '/api/auth/status')).json(), { setupRequired: false });
    const c = await r.clientFor('rescue', 'rescue-pass-1');
    assert.equal(c.me.user.platform, true);
  } finally { r.stop(); }
});

test('"my own store": a platform administrator without a store can make one and become its owner', async () => {
  const r = await startServer();
  try {
    const admin = await r.setupPlatform();
    assert.equal((await admin.call('GET', '/api/media')).status, 403); // no store yet
    const made = await admin.call('POST', '/api/platform/orgs', { name: 'Corner Shop', asMyStore: true, features: { catalog: false } });
    assert.equal(made.status, 200);
    const me = (await admin.call('GET', '/api/me')).body;
    assert.equal(me.org.name, 'Corner Shop');
    assert.equal(me.user.role, 'owner');
    assert.equal(me.user.platform, true);
    assert.equal((await admin.call('POST', '/api/playlists', { name: 'Mine' })).status, 200); // works at once, same session
    assert.equal((await admin.call('POST', '/api/platform/orgs', { name: 'Another', asMyStore: true })).status, 400); // only one
    assert.equal(made.body.users.length, 1); // no extra owner login was created
  } finally { r.stop(); }
});

test('uploads cannot become web pages: the extension is chosen by the server and files are served sandboxed', async () => {
  const o = store.owner;
  const evil = new FormData();
  evil.append('files', new Blob(['<html><script>fetch("/steal")</script></html>'], { type: 'image/png' }), 'evil.html');
  const up = await o.call('POST', '/api/media', evil);
  assert.equal(up.status, 200);
  assert.match(up.body[0].file, /\.png$/); // not .html, whatever the file was called
  const served = await fetch(`${s.base}/media/${up.body[0].file}`);
  assert.equal(served.headers.get('content-type'), 'image/png');
  assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
  assert.match(served.headers.get('content-security-policy'), /sandbox/);
  // types outside the list are refused and leave no file behind
  const svg = new FormData();
  svg.append('files', new Blob(['<svg onload=alert(1)/>'], { type: 'image/svg+xml' }), 'x.svg');
  assert.deepEqual((await o.call('POST', '/api/media', svg)).body, []);
  const html = new FormData();
  html.append('files', new Blob(['<html></html>'], { type: 'text/html' }), 'x.html');
  assert.deepEqual((await o.call('POST', '/api/media', html)).body, []);
  assert.equal((await fetch(s.base + '/')).headers.get('x-frame-options'), 'SAMEORIGIN');
});
