// Upgrading a single-store server: everything moves into one store, TVs keep playing, the old password still works.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, PNG_1X1 } from './helpers.js';
import { hashPassword } from '../auth.js';

/** A database exactly as the single-store version wrote it (no orgs, no users, one admin hash, one alert). */
function legacyDir({ myt = false, withAdmin = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opensign-legacy-'));
  fs.mkdirSync(path.join(dir, 'media'));
  fs.writeFileSync(path.join(dir, 'media', 'a.png'), PNG_1X1);
  const now = Date.now();
  const db = {
    devices: [{ id: 'd1', deviceId: 'legacy-tv', name: 'Lobby', model: '', paired: true, pairingCode: null, defaultPlaylistId: 'p1', schedule: [], rev: 3, createdAt: now }],
    media: [{ id: 'm1', name: 'a.png', type: 'image', file: 'a.png', size: 70, createdAt: now }],
    playlists: [{ id: 'p1', name: 'Main', items: [{ mediaId: 'm1', duration: 9 }] }],
    walls: [], layouts: [], products: [], posters: [],
    alert: { id: 'al1', message: 'Legacy alert', deviceIds: [], until: now + 3600e3, color: '#c62828' },
  };
  if (withAdmin) db.admin = hashPassword('old-admin-password');
  if (myt) {
    db.products = [{ id: 'pr1', brand: 'Samsung', model: 'Galaxy', category: 'smartphone', condition: 'new', colours: [], variants: [], highlights: [], specs: [], posterSpecs: {}, images: [], offers: [], stock: 'unknown', stockNote: '', sourceName: 'myT Mobiles online store', sourceUrl: 'https://storetmobiles2-code.github.io/mytmobiles-web/p/samsung-galaxy', status: 'draft', lastVerified: null, createdAt: now, updatedAt: now }];
    db.posters = [{ id: 'po1', productId: 'pr1', template: 'brand', size: 'landscape', category: 'myT Mobiles store branding', texts: {}, image: {}, options: {}, status: 'draft', createdAt: now, updatedAt: now }];
  }
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify(db));
  fs.writeFileSync(path.join(dir, 'plays.ndjson'), JSON.stringify({ d: 'd1', i: 'm1', n: 'a.png', t: now - 1000, ms: 5000 }) + '\n');
  return dir;
}

test('a single-store server upgrades into one store; TVs, content, alert, reports and the old password carry over', async () => {
  const dir = legacyDir();
  const s = await startServer({}, { dataDir: dir });
  try {
    assert.deepEqual(await (await fetch(s.base + '/api/auth/status')).json(), { setupRequired: false });
    const before = await s.config('legacy-tv'); // the TV's view works with no login and no change to its API
    assert.equal(before.paired, true);
    assert.equal(before.playlists.p1.items[0].duration, 9);
    assert.match(before.playlists.p1.items[0].src, /\/media\/a\.png$/);
    assert.equal(before.alert.message, 'Legacy alert');
    assert.equal((await fetch(before.playlists.p1.items[0].src)).status, 200);

    const admin = await s.clientFor('admin', 'old-admin-password'); // the old password still opens the door
    assert.equal(admin.me.user.role, 'owner');
    assert.equal(admin.me.user.platform, true);
    assert.equal(admin.me.org.name, 'My Store');
    assert.equal(admin.me.org.features.catalog, false);
    assert.equal((await admin.call('GET', '/api/devices')).body[0].name, 'Lobby');
    assert.equal((await admin.call('GET', '/api/playlists')).body[0].name, 'Main');
    assert.equal((await admin.call('GET', '/api/media')).body.length, 1);
    assert.equal((await admin.call('GET', '/api/alert')).body.message, 'Legacy alert');
    assert.equal((await admin.call('GET', '/api/reports/plays?days=1')).body.total, 1);
    // the platform side can see the store but the old file no longer holds a plain admin record
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8'));
    assert.equal(saved.schemaVersion, 2);
    assert.equal(saved.admin, undefined);
    assert.equal(saved.orgs.length, 1);
  } finally { s.stop(); }

  // starting again must not migrate twice
  const again = await startServer({}, { dataDir: dir });
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8'));
    assert.equal(saved.orgs.length, 1);
    assert.equal(saved.users.length, 1);
    assert.equal((await again.clientFor('admin', 'old-admin-password')).me.org.name, 'My Store');
  } finally { again.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('data from the myT Mobiles import becomes the "myT Mobiles" store with its logo, colour and import address', async () => {
  const dir = legacyDir({ myt: true });
  const s = await startServer({}, { dataDir: dir });
  try {
    const admin = await s.clientFor('admin', 'old-admin-password');
    const org = admin.me.org;
    assert.equal(org.name, 'myT Mobiles');
    assert.equal(org.accent, '#f23088');
    assert.equal(org.features.catalog, true);
    assert.equal(org.importSource, 'https://storetmobiles2-code.github.io/mytmobiles-web');
    const logo = await fetch(s.base + org.logoUrl);
    assert.equal(logo.status, 200);
    assert.equal((await logo.arrayBuffer()).byteLength > 1000, true);
    assert.equal((await admin.call('GET', '/api/products')).body.length, 1);
    assert.equal((await admin.call('GET', '/api/posters')).body[0].category, 'Store branding'); // renamed, no store name inside
  } finally { s.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a legacy server that used ADMIN_PASSWORD keeps that password as the "admin" login', async () => {
  const dir = legacyDir({ withAdmin: false });
  const s = await startServer({ ADMIN_PASSWORD: 'env-admin-password' }, { dataDir: dir });
  try {
    assert.equal((await s.clientFor('admin', 'env-admin-password')).me.org.name, 'My Store');
  } finally { s.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('LEGACY_STORE_NAME names the migrated store', async () => {
  const dir = legacyDir();
  const s = await startServer({ LEGACY_STORE_NAME: 'Corner Shop' }, { dataDir: dir });
  try {
    assert.equal((await s.clientFor('admin', 'old-admin-password')).me.org.name, 'Corner Shop');
  } finally { s.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});
