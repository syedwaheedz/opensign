import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, PNG_1X1 } from './helpers.js';

let s;
before(async () => { s = await startServer(); });
after(() => s.stop());

test('first visitor sets the admin password; setup is then closed', async () => {
  assert.deepEqual(await (await fetch(s.base + '/api/auth/status')).json(), { setupRequired: true });
  const short = await fetch(s.base + '/api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: '123' }) });
  assert.equal(short.status, 400);
  assert.ok(await s.login());
  const again = await fetch(s.base + '/api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'another1' }) });
  assert.equal(again.status, 403);
  const wrong = await fetch(s.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'nope' }) });
  assert.equal(wrong.status, 401);
});

test('admin API rejects requests without a token', async () => {
  assert.equal((await fetch(s.base + '/api/devices')).status, 401);
});

test('screen pairing, media upload, playlist and player config', async () => {
  const dev = await s.pairDevice('tv-core');
  const fd = new FormData();
  fd.append('files', new Blob([PNG_1X1], { type: 'image/png' }), 'slide.png');
  const up = await s.call('POST', '/api/media', fd);
  assert.equal(up.status, 200);
  assert.equal(up.body[0].type, 'image');
  const pl = (await s.call('POST', '/api/playlists', { name: 'Main' })).body;
  await s.call('PUT', `/api/playlists/${pl.id}`, { items: [{ mediaId: up.body[0].id, duration: 7 }] });
  await s.call('PUT', `/api/devices/${dev.id}`, { defaultPlaylistId: pl.id });
  const cfg = await s.config('tv-core');
  assert.equal(cfg.paired, true);
  assert.equal(cfg.playlists[pl.id].items[0].duration, 7);
  assert.match(cfg.playlists[pl.id].items[0].src, /\/media\/.+\.png$/);
  const file = await fetch(cfg.playlists[pl.id].items[0].src);
  assert.equal(file.status, 200);
});

test('links are classified: YouTube, Instagram, Facebook, image, video, web, bad', async () => {
  const add = async (url) => s.call('POST', '/api/media/link', { url });
  assert.equal((await add('https://youtu.be/2Ummj-Do9JI?si=abc')).body.provider, 'youtube');
  assert.equal((await add('https://www.instagram.com/reel/C1abcDEF234/')).body.provider, 'instagram');
  assert.equal((await add('https://www.facebook.com/page/videos/123456789/')).body.provider, 'facebook');
  assert.equal((await add('https://example.com/a.jpg')).body.type, 'image');
  assert.equal((await add('https://example.com/a.mp4')).body.type, 'video');
  assert.equal((await add('https://example.com/')).body.type, 'web');
  assert.equal((await add('javascript:alert(1)')).status, 400);
});

test('widgets render escaped HTML', async () => {
  const w = (await s.call('POST', '/api/media/widget', { kind: 'text', text: 'Sale <b>now</b>' })).body;
  const html = await (await fetch(`${s.base}/embed/${w.id}`)).text();
  assert.ok(html.includes('Sale &lt;b&gt;now&lt;/b&gt;'));
});

test('schedule slots are returned in the config', async () => {
  const dev = await s.pairDevice('tv-sched');
  const pl = (await s.call('POST', '/api/playlists', { name: 'Slot' })).body;
  await s.call('PUT', `/api/devices/${dev.id}`, { schedule: [{ playlistId: pl.id, days: [1, 2], start: '09:00', end: '17:00' }] });
  const cfg = await s.config('tv-sched');
  assert.deepEqual(cfg.schedule[0].days, [1, 2]);
  assert.equal(cfg.schedule[0].start, '09:00');
});

test('video wall toggle, one wall per screen', async () => {
  const a = await s.pairDevice('wall-a');
  const b = await s.pairDevice('wall-b');
  const pl = (await s.call('POST', '/api/playlists', { name: 'Wall' })).body;
  const w = (await s.call('POST', '/api/walls', { name: 'W' })).body;
  await s.call('PUT', `/api/walls/${w.id}`, { cols: 2, rows: 1, playlistId: pl.id, members: [{ deviceId: a.id, col: 0, row: 0 }, { deviceId: b.id, col: 1, row: 0 }] });
  assert.equal((await s.config('wall-a')).wall, null);
  await s.call('PUT', `/api/walls/${w.id}`, { enabled: true });
  assert.equal((await s.config('wall-b')).wall.col, 1);
  await s.call('PUT', `/api/walls/${w.id}`, { enabled: false });
  assert.equal((await s.config('wall-b')).wall, null);
});

test('layouts: zones are clamped and delivered in the config', async () => {
  const dev = await s.pairDevice('tv-layout');
  const l = (await s.call('POST', '/api/layouts', { name: 'L', zones: [{ name: 'Main', x: 0, y: 0, w: 100, h: 85 }, { name: 'Ticker', x: 90, y: 85, w: 100, h: 500 }] })).body;
  assert.equal(l.zones[1].w, 10);
  assert.equal(l.zones[1].h, 15);
  await s.call('PUT', `/api/devices/${dev.id}`, { defaultPlaylistId: l.id });
  assert.equal(Object.keys((await s.config('tv-layout')).layouts).length, 1);
  assert.equal((await s.call('PUT', `/api/layouts/${l.id}`, { zones: [] })).status, 400);
});

test('emergency alert reaches only the chosen screen and long-poll wakes up', async () => {
  const a = await s.pairDevice('al-a');
  await s.pairDevice('al-b');
  const v = (await s.config('al-a')).version;
  const waiting = fetch(`${s.base}/api/player/al-a/wait?v=${v}`).then((r) => r.json());
  await new Promise((r) => setTimeout(r, 200));
  await s.call('POST', '/api/alert', { message: 'Test alert', minutes: 1, deviceIds: [a.id] });
  assert.deepEqual(await waiting, { changed: true });
  assert.equal((await s.config('al-a')).alert.message, 'Test alert');
  assert.equal((await s.config('al-b')).alert, null);
  await s.call('DELETE', '/api/alert');
  assert.equal((await s.config('al-a')).alert, null);
});

test('proof of play is stored and reported', async () => {
  const dev = await s.pairDevice('pop');
  const m = (await s.call('POST', '/api/media/widget', { kind: 'clock' })).body;
  await fetch(`${s.base}/api/player/pop/heartbeat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ plays: [{ itemId: m.id, name: 'Clock', start: Date.now() - 1000, ms: 9000 }, { bad: true }] }),
  });
  const rep = (await s.call('GET', '/api/reports/plays?days=1')).body;
  assert.equal(rep.total, 1);
  assert.equal(rep.byScreen[0].name, dev.name);
  const csv = await s.call('GET', '/api/reports/plays.csv?days=1');
  assert.ok(csv.body.startsWith('time,screen,media,seconds'));
});
