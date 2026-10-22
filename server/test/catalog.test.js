import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startServer, PNG_1X1 } from './helpers.js';
import { warnings, posterData, isFresh } from '../catalog.js';
import { parseProductPage, derivePosterSpecs } from '../importer.js';

let s;
before(async () => { s = await startServer(); await s.login(); });
after(() => s.stop());

const phone = (over = {}) => ({
  brand: 'Samsung', model: 'Galaxy Test', variants: [{ ram: '8 GB', storage: '256 GB', officialPrice: 50000, sellingPrice: 45000 }],
  highlights: ['6.7 inch display'], sourceUrl: 'https://example.com/p/test', ...over,
});
const upload = async (id, bytes, name = 'phone.png', type = 'image/png') => {
  const fd = new FormData();
  fd.append('files', new Blob([bytes], { type }), name);
  return s.call('POST', `/api/products/${id}/images`, fd);
};

test('products need a brand and a model', async () => {
  assert.equal((await s.call('POST', '/api/products', { brand: 'Samsung' })).status, 400);
  const ok = await s.call('POST', '/api/products', phone());
  assert.equal(ok.status, 200);
  assert.equal(ok.body.status, 'draft');
});

test('prices and offers stay hidden until staff verify; offers also need approval', async () => {
  const p = (await s.call('POST', '/api/products', phone({
    offers: [{ type: 'discount', title: 'Festive discount', amount: 3000, approved: true }, { type: 'discount', title: 'Not approved yet', amount: 500 }],
  }))).body;
  let d = (await s.call('GET', `/api/products/${p.id}/poster-data`)).body;
  assert.equal(d.pricesVisible, false);
  assert.equal(d.variants[0].sellingPrice, null);
  assert.equal(d.offers.length, 0);

  await s.call('POST', `/api/products/${p.id}/verify`, { verified: true });
  d = (await s.call('GET', `/api/products/${p.id}/poster-data`)).body;
  assert.equal(d.pricesVisible, true);
  assert.equal(d.variants[0].sellingPrice, 45000); // the offer is never subtracted from the selling price
  assert.deepEqual(d.offers.map((o) => o.title), ['Festive discount']);
});

test('bank and exchange offers need written conditions before approval', async () => {
  const p = (await s.call('POST', '/api/products', phone())).body;
  const bad = await s.call('PUT', `/api/products/${p.id}`, { offers: [{ type: 'bank', title: '10% bank offer', approved: true }] });
  assert.equal(bad.status, 400);
  const good = await s.call('PUT', `/api/products/${p.id}`, { offers: [{ type: 'bank', title: '10% bank offer', conditions: 'On HDFC cards, up to Rs 2,000', approved: true }] });
  assert.equal(good.status, 200);
});

test('editing verified facts requires a new verification; editing offers does not', async () => {
  const p = (await s.call('POST', '/api/products', phone())).body;
  await s.call('POST', `/api/products/${p.id}/verify`, { verified: true });
  const offerEdit = await s.call('PUT', `/api/products/${p.id}`, { offers: [{ type: 'other', title: 'Free case', approved: true }] });
  assert.equal(offerEdit.body.status, 'verified');
  const priceEdit = await s.call('PUT', `/api/products/${p.id}`, { variants: [{ ram: '8 GB', storage: '256 GB', sellingPrice: 44000 }] });
  assert.equal(priceEdit.body.status, 'draft');
  assert.equal(priceEdit.body.lastVerified, null);
});

test('warnings and poster data honour expiry and outdated verification', () => {
  const base = {
    images: [{ file: 'a.png' }], variants: [{ officialPrice: 100, sellingPrice: 90 }], sourceUrl: 'x', highlights: ['h'],
    posterSpecs: { display: 'd' }, status: 'verified', lastVerified: '2026-01-25', stock: 'in_stock', condition: 'new',
    offers: [{ type: 'discount', title: 'Old', approved: true, expiresOn: '2026-01-31' }, { type: 'discount', title: 'Live', approved: true, expiresOn: '2026-03-01' }],
  };
  const now = '2026-02-10';
  assert.ok(isFresh(base, now));
  assert.deepEqual(posterData(base, now).offers.map((o) => o.title), ['Live']); // expired offer is not published
  assert.ok(warnings(base, now).some((w) => w.code === 'offer_expired'));
  const later = '2026-05-01';
  assert.ok(!isFresh(base, later));
  assert.equal(posterData(base, later).pricesVisible, false);
  assert.ok(warnings(base, later).some((w) => w.code === 'outdated'));
  assert.ok(warnings({ ...base, images: [] }, now).some((w) => w.code === 'no_image'));
});

test('product images: PNG accepted and served, non-images rejected, delete removes the file', async () => {
  const p = (await s.call('POST', '/api/products', phone())).body;
  assert.equal((await upload(p.id, Buffer.from('not an image'), 'evil.png')).status, 400);
  const ok = await upload(p.id, PNG_1X1);
  assert.equal(ok.status, 200);
  const file = ok.body.images[0].file;
  assert.equal((await fetch(`${s.base}/media/${file}`)).status, 200);
  await s.call('DELETE', `/api/products/${p.id}/images/${file}`);
  assert.equal((await fetch(`${s.base}/media/${file}`)).status, 404);
});

test('poster spec lines come from the product data only', () => {
  const ps = derivePosterSpecs({
    highlights: ['6.7 inch AMOLED display, 120 Hz', 'Dimensity 9400, 12 GB RAM', '50 MP + 12 MP rear cameras', '5,000 mAh battery, IP68'],
    specs: [{ group: 'Camera', items: [{ label: 'Rear cameras', value: '50 MP (F1.8) + 12 MP (F2.2)' }] }],
    variants: [{ ram: '12 GB', storage: '256 GB' }, { ram: '12 GB', storage: '512 GB' }],
  });
  assert.equal(ps.camera, '50 MP + 12 MP cameras');
  assert.equal(ps.memory, '12 GB + 256 GB / 512 GB');
  assert.match(ps.extra, /IP68/);
  assert.equal(derivePosterSpecs({}).camera, ''); // nothing is invented when data is missing
});

// ---- import from a store website (a small fake store served on localhost) ----------------
const pageHtml = ({ name, price, port }) => {
  const variants = [{ id: 'v1', color: 'Black', storage: '128 GB', ram: '8 GB', price: price * 100, mrp: (price + 5000) * 100, stock: 3 }];
  const images = [{ url: '/shop/images/p/front.png', color: 'Black', view: 'front-back' }];
  const flight = JSON.stringify(`{"variants":${JSON.stringify(variants)},"images":${JSON.stringify(images)}}`);
  return `<html><script type="application/ld+json">${JSON.stringify([{ '@type': 'Product', name: `Acme ${name}`, brand: { name: 'Acme' }, itemCondition: 'https://schema.org/NewCondition', image: [] }])}</script>
<ul class="space-y-1.5 text-sm"><li><svg></svg>6.5 inch AMOLED display</li><li>Dimensity 8300, 8 GB RAM</li></ul>
<h3 class="mb-2 text-xs">Battery</h3><dl><div><dt>Capacity</dt><dd>5,000 mAh</dd></div></dl>
<script>self.__next_f.push([1,${flight}])</script></html>`;
};

async function fakeStore(initialPrice) {
  let price = initialPrice;
  const server = http.createServer((req, res) => {
    if (req.url === '/shop/c/smartphones') return res.end('<a href="/shop/p/acme-one">One</a><a href="/shop/p/acme-one">dup</a>');
    if (req.url === '/shop/p/acme-one') return res.end(pageHtml({ name: 'One', price, port: 0 }));
    if (req.url === '/shop/images/p/front.png') { res.setHeader('content-type', 'image/png'); return res.end(PNG_1X1); }
    res.statusCode = 404; res.end();
  });
  await new Promise((r) => server.listen(0, r));
  return { url: `http://localhost:${server.address().port}/shop`, setPrice: (p) => { price = p; }, close: () => server.close() };
}

test('page parser reads variants (paise to rupees), highlights, specs and images', () => {
  const p = parseProductPage(pageHtml({ name: 'One', price: 30000 }), 'http://localhost:1/shop/p/acme-one');
  assert.equal(p.brand, 'Acme');
  assert.equal(p.model, 'One');
  assert.equal(p.variants[0].sellingPrice, 30000);
  assert.equal(p.variants[0].officialPrice, 35000);
  assert.equal(p.highlights.length, 2);
  assert.equal(p.specs[0].items[0].value, '5,000 mAh');
  assert.equal(p.images[0].url, 'http://localhost:1/shop/images/p/front.png');
});

test('import: disallowed hosts are refused', async () => {
  const r = await s.call('POST', '/api/catalog/import', { url: 'https://evil.example.org/shop' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /not an allowed import source/);
});

test('import: creates drafts with images, skips unchanged, and flags changed listings', async (t) => {
  const store = await fakeStore(30000);
  const imp = await startServer({ IMPORT_ALLOWED_HOSTS: 'localhost' });
  t.after(() => { store.close(); imp.stop(); });
  await imp.login();
  const run = async () => {
    assert.equal((await imp.call('POST', '/api/catalog/import', { url: store.url })).status, 202);
    for (let i = 0; i < 100; i++) {
      const j = (await imp.call('GET', '/api/catalog/import')).body;
      if (!j.running && j.finishedAt) return j;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('import did not finish');
  };

  let job = await run();
  assert.equal(job.imported, 1);
  assert.equal(job.images, 1);
  let list = (await imp.call('GET', '/api/products')).body;
  assert.equal(list.length, 1);
  assert.equal(list[0].status, 'draft'); // imported data must be verified by staff
  assert.equal(list[0].variants[0].sellingPrice, 30000);
  assert.ok(list[0].sourceCheckedOn);
  assert.equal((await fetch(`${imp.base}/media/${list[0].images[0].file}`)).status, 200);

  await imp.call('POST', `/api/products/${list[0].id}/verify`, { verified: true });
  job = await run();
  assert.equal(job.unchanged, 1); // same listing: nothing touched, verification kept
  assert.equal((await imp.call('GET', `/api/products/${list[0].id}`)).body.status, 'verified');

  store.setPrice(28000);
  job = await run();
  assert.equal(job.updated, 1);
  const changed = (await imp.call('GET', `/api/products/${list[0].id}`)).body;
  assert.equal(changed.status, 'draft'); // price changed at the source, so verify again
  assert.equal(changed.variants[0].sellingPrice, 28000);
  assert.ok(changed.warnings.some((w) => w.code === 'source_changed'));
  assert.equal(changed.images.length, 1); // the image was not downloaded twice
});
