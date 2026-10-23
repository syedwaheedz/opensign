// Store isolation: what one store creates, another store can never see, change, delete or reuse.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, pngForm } from './helpers.js';

let s, a, b, A, B; // A, B: store objects (owner clients); a, b: the data store A created
before(async () => {
  s = await startServer();
  await s.setupPlatform();
  A = await s.createStore('Store A');
  B = await s.createStore('Store B');
  a = await seed(A);
  b = await seed(B);
});
after(() => s.stop());

async function seed(store, tag = store.org.name) {
  const c = store.owner;
  const media = (await c.call('POST', '/api/media', pngForm(`${tag}.png`))).body[0];
  const playlist = (await c.call('POST', '/api/playlists', { name: `${tag} playlist` })).body;
  await c.call('PUT', `/api/playlists/${playlist.id}`, { items: [{ mediaId: media.id, duration: 7 }] });
  const dev = await s.pairDevice(`tv-${tag}`, `${tag} screen`, c);
  const wall = (await c.call('POST', '/api/walls', { name: `${tag} wall` })).body;
  const layout = (await c.call('POST', '/api/layouts', { name: `${tag} layout`, zones: [{ name: 'Main', x: 0, y: 0, w: 100, h: 100, playlistId: playlist.id }] })).body;
  await c.call('PUT', `/api/devices/${dev.id}`, { defaultPlaylistId: playlist.id });
  const product = (await c.call('POST', '/api/products', { brand: 'Samsung', model: `${tag} phone`, sourceUrl: 'https://example.com/p', variants: [{ ram: '8 GB', storage: '128 GB', sellingPrice: 1000 }] })).body;
  const withImage = (await c.call('POST', `/api/products/${product.id}/images`, pngForm('p.png'))).body;
  const poster = (await c.call('POST', '/api/posters', { template: 'flagship', productId: product.id })).body;
  await c.call('POST', '/api/alert', { message: `${tag} alert`, minutes: 5, deviceIds: [] });
  return { media, playlist, dev, wall, layout, product: withImage, poster, deviceId: `tv-${tag}` };
}

test('lists only show the signed-in store\'s own records', async () => {
  const names = async (c, path) => (await c.call('GET', path)).body.map((x) => x.name || x.model || x.productName);
  for (const [store, mine, other] of [[A, 'Store A', 'Store B'], [B, 'Store B', 'Store A']]) {
    const c = store.owner;
    for (const path of ['/api/media', '/api/playlists', '/api/walls', '/api/layouts', '/api/devices', '/api/products']) {
      const got = (await names(c, path)).join('|');
      assert.ok(got.includes(mine), `${mine} should see its own in ${path}`);
      assert.ok(!got.includes(other), `${mine} must not see ${other} in ${path}`);
    }
    const posters = (await c.call('GET', '/api/posters')).body;
    assert.equal(posters.length, 1);
    assert.match(posters[0].productName, new RegExp(mine));
    assert.match((await c.call('GET', '/api/alert')).body.message, new RegExp(mine));
  }
});

test('another store\'s ids behave as if they do not exist (404), for every action', async () => {
  const c = B.owner;
  const attempts = [
    ['DELETE', `/api/media/${a.media.id}`],
    ['PUT', `/api/playlists/${a.playlist.id}`, { name: 'hacked' }],
    ['DELETE', `/api/playlists/${a.playlist.id}`],
    ['PUT', `/api/walls/${a.wall.id}`, { name: 'hacked' }],
    ['DELETE', `/api/walls/${a.wall.id}`],
    ['PUT', `/api/layouts/${a.layout.id}`, { name: 'hacked' }],
    ['DELETE', `/api/layouts/${a.layout.id}`],
    ['PUT', `/api/devices/${a.dev.id}`, { name: 'hacked' }],
    ['POST', `/api/devices/${a.dev.id}/refresh`],
    ['DELETE', `/api/devices/${a.dev.id}`],
    ['GET', `/api/products/${a.product.id}`],
    ['PUT', `/api/products/${a.product.id}`, { model: 'hacked' }],
    ['POST', `/api/products/${a.product.id}/verify`, { verified: true }],
    ['GET', `/api/products/${a.product.id}/poster-data`],
    ['DELETE', `/api/products/${a.product.id}/images/${a.product.images[0].file}`],
    ['DELETE', `/api/products/${a.product.id}`],
    ['GET', `/api/posters/${a.poster.id}`],
    ['PUT', `/api/posters/${a.poster.id}`, { texts: { headline: 'hacked' } }],
    ['POST', `/api/posters/${a.poster.id}/approve`],
    ['POST', `/api/posters/${a.poster.id}/unapprove`],
    ['DELETE', `/api/posters/${a.poster.id}`],
  ];
  for (const [method, path, body] of attempts) {
    const r = await c.call(method, path, body);
    assert.equal(r.status, 404, `${method} ${path} should be 404 but was ${r.status}`);
  }
  // and nothing of A changed
  const ca = A.owner;
  assert.equal((await ca.call('GET', '/api/media')).body.length, 1);
  assert.equal((await ca.call('GET', '/api/playlists')).body[0].name, 'Store A playlist');
  assert.equal((await ca.call('GET', `/api/products/${a.product.id}`)).body.model, 'Store A phone');
  assert.equal((await ca.call('GET', '/api/devices')).body[0].name, 'Store A screen');
});

test('a store cannot pull another store\'s content into its own screens, playlists, layouts or posters', async () => {
  const c = B.owner;
  // A's playlist cannot become the default of B's screen
  const put = await c.call('PUT', `/api/devices/${b.dev.id}`, { defaultPlaylistId: a.playlist.id, schedule: [{ playlistId: a.playlist.id, days: [1], start: '09:00', end: '10:00' }] });
  assert.equal(put.body.defaultPlaylistId, null);
  assert.deepEqual(put.body.schedule, []);
  assert.equal((await s.config(b.deviceId)).playlists[a.playlist.id], undefined);
  // A's media cannot be put in B's playlist
  const pl = await c.call('PUT', `/api/playlists/${b.playlist.id}`, { items: [{ mediaId: a.media.id, duration: 5 }, { mediaId: b.media.id, duration: 5 }] });
  assert.deepEqual(pl.body.items.map((i) => i.mediaId), [b.media.id]);
  // A's playlist cannot be a zone of B's layout, nor the playlist of B's wall
  const lay = await c.call('PUT', `/api/layouts/${b.layout.id}`, { zones: [{ name: 'Z', x: 0, y: 0, w: 50, h: 50, playlistId: a.playlist.id }] });
  assert.equal(lay.body.zones[0].playlistId, null);
  const wall = await c.call('PUT', `/api/walls/${b.wall.id}`, { playlistId: a.playlist.id, members: [{ deviceId: a.dev.id, col: 0, row: 0 }] });
  assert.equal(wall.body.playlistId, null);
  assert.deepEqual(wall.body.members, []); // A's screen cannot join B's wall
  // B cannot make a poster of A's product, nor use A's image file
  assert.equal((await c.call('POST', '/api/posters', { template: 'flagship', productId: a.product.id })).status, 400);
  assert.equal((await c.call('POST', '/api/posters', { template: 'flagship', productId: b.product.id, image: { file: a.product.images[0].file } })).status, 400);
});

test('alerts, long-poll wake-ups and proof of play stay inside a store', async () => {
  assert.equal((await s.config(a.deviceId)).alert.message, 'Store A alert');
  assert.equal((await s.config(b.deviceId)).alert.message, 'Store B alert');
  // a change in B must not wake A's screen
  const v = (await s.config(a.deviceId)).version;
  const woke = await Promise.race([
    fetch(`${s.base}/api/player/${a.deviceId}/wait?v=${v}`).then((r) => r.json()).then(() => 'woke'),
    (async () => { await new Promise((r) => setTimeout(r, 300)); await B.owner.call('PUT', `/api/playlists/${b.playlist.id}`, { name: 'changed by B' }); await new Promise((r) => setTimeout(r, 500)); return 'quiet'; })(),
  ]);
  assert.equal(woke, 'quiet');
  // plays reported by A's TV appear only in A's reports
  await fetch(`${s.base}/api/player/${a.deviceId}/heartbeat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plays: [{ itemId: a.media.id, name: 'A item', start: Date.now() - 1000, ms: 9000 }] }) });
  assert.equal((await A.owner.call('GET', '/api/reports/plays?days=1')).body.total, 1);
  assert.equal((await B.owner.call('GET', '/api/reports/plays?days=1')).body.total, 0);
  assert.ok(!(await B.owner.call('GET', '/api/reports/plays.csv?days=1')).body.includes('A item'));
  // clearing B's alert leaves A's alive
  await B.owner.call('DELETE', '/api/alert');
  assert.equal((await s.config(a.deviceId)).alert.message, 'Store A alert');
});

test('screens: a code claims one waiting screen, and waiting screens are hidden when there are several stores', async () => {
  const reg = await s.register('waiting-tv');
  // with two stores nobody sees waiting screens
  for (const st of [A, B]) assert.ok(!(await st.owner.call('GET', '/api/devices')).body.some((d) => d.deviceId === 'waiting-tv'));
  // a wrong code claims nothing
  assert.equal((await A.owner.call('POST', '/api/devices/claim', { code: '000000x', name: 'x' })).status, 404);
  // the right code works once; the other store cannot take a screen that is already claimed
  assert.equal((await A.owner.call('POST', '/api/devices/claim', { code: reg.pairingCode, name: 'Window' })).status, 200);
  assert.equal((await B.owner.call('POST', '/api/devices/claim', { code: reg.pairingCode, name: 'Steal' })).status, 404);
  assert.ok((await A.owner.call('GET', '/api/devices')).body.some((d) => d.deviceId === 'waiting-tv'));
  assert.ok(!(await B.owner.call('GET', '/api/devices')).body.some((d) => d.deviceId === 'waiting-tv'));
});

test('with a single store, waiting screens are listed (the easy one-click add)', async () => {
  const one = await startServer();
  try {
    await one.login();
    await one.register('solo-tv');
    assert.ok((await one.call('GET', '/api/devices')).body.some((d) => d.deviceId === 'solo-tv' && !d.paired));
  } finally { one.stop(); }
});

test('pairing codes are unique among waiting screens', async () => {
  const codes = new Set();
  for (let i = 0; i < 60; i++) codes.add((await s.register(`code-tv-${i}`)).pairingCode);
  assert.equal(codes.size, 60);
});

test('deleting a screen frees it: the TV asks again and gets a new pairing code', async () => {
  const dev = await s.pairDevice('free-tv', 'Temp', A.owner);
  await A.owner.call('DELETE', `/api/devices/${dev.id}`);
  const cfg = await fetch(`${s.base}/api/player/free-tv/config`);
  assert.equal(cfg.status, 404); // the TV then registers again
  const again = await s.register('free-tv');
  assert.equal(again.paired, false);
  assert.ok(again.pairingCode);
});

test('open registration is capped so a flood of fake screens cannot fill the server', async () => {
  const capped = await startServer({ MAX_WAITING_SCREENS: '3' });
  try {
    for (let i = 0; i < 3; i++) assert.equal((await capped.post('/api/player/register', { deviceId: `flood-${i}` })).status, 200);
    assert.equal((await capped.post('/api/player/register', { deviceId: 'flood-3' })).status, 429);
    assert.equal((await capped.post('/api/player/register', { deviceId: 'flood-0' })).status, 200); // a known screen still gets through
  } finally { capped.stop(); }
});
