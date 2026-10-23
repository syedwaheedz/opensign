import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, PNG_1X1 } from './helpers.js';

let s, product;
before(async () => {
  s = await startServer();
  await s.login();
  product = (await s.call('POST', '/api/products', {
    brand: 'Samsung', model: 'Galaxy Poster', sourceUrl: 'https://example.com/p',
    variants: [{ ram: '8 GB', storage: '256 GB', officialPrice: 50000, sellingPrice: 45000 }],
    posterSpecs: { display: '6.7 inch', processor: 'Chip', camera: '50 MP camera', battery: '5,000 mAh', memory: '8 GB + 256 GB', extra: '' },
  })).body;
  const fd = new FormData();
  fd.append('files', new Blob([PNG_1X1], { type: 'image/png' }), 'phone.png');
  product = (await s.call('POST', `/api/products/${product.id}/images`, fd)).body;
});
after(() => s.stop());

const png = () => { const fd = new FormData(); fd.append('file', new Blob([PNG_1X1], { type: 'image/png' }), 'poster.png'); return fd; };

test('a poster needs a real product and one of its own images; brand posters need no product', async () => {
  assert.equal((await s.call('POST', '/api/posters', { template: 'nope', productId: product.id })).status, 400);
  assert.equal((await s.call('POST', '/api/posters', { template: 'flagship' })).status, 400);
  assert.equal((await s.call('POST', '/api/posters', { template: 'flagship', productId: product.id, image: { file: 'other.png' } })).status, 400);
  assert.equal((await s.call('POST', '/api/posters', { template: 'brand', category: 'myT Mobiles store branding' })).status, 200);
  const ok = await s.call('POST', '/api/posters', { template: 'flagship', productId: product.id, image: { file: product.images[0].file, zoom: 999 } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.image.zoom, 250); // clamped
  assert.equal(ok.body.productName, 'Samsung Galaxy Poster');
});

test('a poster reaches the media library only after approval', async () => {
  const po = (await s.call('POST', '/api/posters', { template: 'offer', productId: product.id })).body;
  assert.equal((await s.call('POST', `/api/posters/${po.id}/library`, png())).status, 409);
  const approved = await s.call('POST', `/api/posters/${po.id}/approve`);
  assert.equal(approved.body.status, 'approved');
  const lib = await s.call('POST', `/api/posters/${po.id}/library`, png());
  assert.equal(lib.status, 200);
  assert.equal(lib.body.media.type, 'image');
  const media = (await s.call('GET', '/api/media')).body.find((m) => m.id === lib.body.media.id);
  assert.ok(media);
  assert.equal(lib.body.poster.publishedHash, lib.body.poster.approvedHash); // lets the admin reuse the library image as the thumbnail
  assert.equal((await fetch(`${s.base}/media/${media.file}`)).status, 200);
});

test('publishing again replaces the file but keeps the media id (playlists keep working)', async () => {
  const dev = await s.pairDevice('poster-tv');
  const po = (await s.call('POST', '/api/posters', { template: 'flagship', productId: product.id })).body;
  await s.call('POST', `/api/posters/${po.id}/approve`);
  const first = (await s.call('POST', `/api/posters/${po.id}/library`, png())).body.media;
  const pl = (await s.call('POST', '/api/playlists', { name: 'Posters' })).body;
  await s.call('PUT', `/api/playlists/${pl.id}`, { items: [{ mediaId: first.id, duration: 10 }] });
  await s.call('PUT', `/api/devices/${dev.id}`, { defaultPlaylistId: pl.id });
  const v1 = (await s.config('poster-tv')).version;
  const second = (await s.call('POST', `/api/posters/${po.id}/library`, png())).body.media;
  assert.equal(second.id, first.id);
  assert.notEqual(second.file, first.file);
  assert.equal((await fetch(`${s.base}/media/${first.file}`)).status, 404); // old file removed
  assert.notEqual((await s.config('poster-tv')).version, v1); // screens refresh
});

test('editing a poster, or changing what it shows, requires approval again', async () => {
  const po = (await s.call('POST', '/api/posters', { template: 'offer', productId: product.id })).body;
  await s.call('POST', `/api/posters/${po.id}/approve`);
  // product data changes after approval (verification adds visible prices)
  await s.call('POST', `/api/products/${product.id}/verify`, { verified: true });
  const now = (await s.call('GET', `/api/posters/${po.id}`)).body;
  assert.equal(now.needsReview, true);
  assert.equal((await s.call('POST', `/api/posters/${po.id}/library`, png())).status, 409);
  await s.call('POST', `/api/posters/${po.id}/approve`);
  assert.equal((await s.call('POST', `/api/posters/${po.id}/library`, png())).status, 200);
  const edited = await s.call('PUT', `/api/posters/${po.id}`, { texts: { headline: 'New headline' } });
  assert.equal(edited.body.status, 'draft');
  await s.call('POST', `/api/products/${product.id}/verify`, { verified: false });
});

test('approval is refused when the product has no image; library rejects non-images', async () => {
  const bare = (await s.call('POST', '/api/products', { brand: 'OPPO', model: 'No Image' })).body;
  const po = await s.call('POST', '/api/posters', { template: 'flagship', productId: bare.id });
  assert.equal((await s.call('POST', `/api/posters/${po.body.id}/approve`)).status, 400);
  const ok = (await s.call('POST', '/api/posters', { template: 'flagship', productId: product.id })).body;
  await s.call('POST', `/api/posters/${ok.id}/approve`);
  const fd = new FormData();
  fd.append('file', new Blob([Buffer.from('<html>')], { type: 'image/png' }), 'x.png');
  assert.equal((await s.call('POST', `/api/posters/${ok.id}/library`, fd)).status, 400);
});

test('a published poster is taken off playlists when its offer stops being valid', async () => {
  const p = (await s.call('POST', '/api/products', {
    brand: 'vivo', model: 'Offer Phone', sourceUrl: 'https://example.com/v',
    variants: [{ ram: '8 GB', storage: '128 GB', officialPrice: 30000, sellingPrice: 27000 }],
    offers: [{ type: 'discount', title: 'Festive discount', amount: 2000, approved: true }],
  })).body;
  const fd = new FormData();
  fd.append('files', new Blob([PNG_1X1], { type: 'image/png' }), 'v.png');
  await s.call('POST', `/api/products/${p.id}/images`, fd);
  await s.call('POST', `/api/products/${p.id}/verify`, { verified: true });

  const po = (await s.call('POST', '/api/posters', { template: 'offer', productId: p.id })).body;
  await s.call('POST', `/api/posters/${po.id}/approve`);
  const media = (await s.call('POST', `/api/posters/${po.id}/library`, png())).body.media;
  const dev = await s.pairDevice('retire-tv');
  const pl = (await s.call('POST', '/api/playlists', { name: 'Retire test' })).body;
  await s.call('PUT', `/api/playlists/${pl.id}`, { items: [{ mediaId: media.id, duration: 10 }] });
  await s.call('PUT', `/api/devices/${dev.id}`, { defaultPlaylistId: pl.id });
  assert.equal((await s.config('retire-tv')).playlists[pl.id].items.length, 1);
  const before = (await s.config('retire-tv')).version;

  // staff withdraw the offer approval: the published image still shows it, so it must stop playing
  await s.call('PUT', `/api/products/${p.id}`, { offers: [{ type: 'discount', title: 'Festive discount', amount: 2000, approved: false }] });
  const after = await s.config('retire-tv');
  assert.equal(after.playlists[pl.id].items.length, 0);
  assert.notEqual(after.version, before);
  const now = (await s.call('GET', `/api/posters/${po.id}`)).body;
  assert.equal(now.retired, true);
  assert.equal(now.needsReview, true);

  // review, approve and publish again: the retired flag clears
  await s.call('POST', `/api/posters/${po.id}/approve`);
  const again = await s.call('POST', `/api/posters/${po.id}/library`, png());
  assert.equal(again.status, 200);
  assert.equal(again.body.poster.retired, false);
});
