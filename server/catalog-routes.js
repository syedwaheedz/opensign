// Admin API for the smartphone catalog and the store import. Registered on the existing authenticated router.
import fs from 'node:fs';
import path from 'node:path';
import * as C from './catalog.js';
import * as I from './importer.js';

export function registerCatalogRoutes({ api, db, save, uid, MEDIA_DIR, upload }) {
  const find = (id) => db.products.find((p) => p.id === id);
  const view = (p) => ({ ...p, warnings: C.warnings(p), fresh: C.isFresh(p) });
  const h = (fn) => async (req, res) => {
    try { await fn(req, res); } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  };
  const getOr404 = (req) => find(req.params.id) || Object.assign(new Error('Product not found'), { status: 404 });
  const throwIf = (e) => { if (e instanceof Error) throw e; return e; };

  api.get('/catalog/meta', (_req, res) => res.json({
    brands: C.BRANDS, offerTypes: C.OFFER_TYPES, stock: C.STOCK, staleDays: C.STALE_DAYS, defaultStore: I.DEFAULT_STORE, today: C.today(),
  }));

  api.get('/products', (req, res) => {
    const q = String(req.query.q || '').toLowerCase();
    const list = db.products
      .filter((p) => (!req.query.brand || p.brand === req.query.brand) && (!req.query.status || p.status === req.query.status))
      .filter((p) => !q || `${p.brand} ${p.model}`.toLowerCase().includes(q))
      .sort((a, b) => `${a.brand} ${a.model}`.localeCompare(`${b.brand} ${b.model}`));
    res.json(list.map(view));
  });

  api.post('/products', h((req, res) => {
    const p = C.newProduct(req.body || {}, uid);
    db.products.push(p);
    save();
    res.json(view(p));
  }));

  api.get('/products/:id', h((req, res) => res.json(view(throwIf(getOr404(req))))));

  api.put('/products/:id', h((req, res) => {
    const p = throwIf(getOr404(req));
    const next = C.applyEdit(p, req.body || {}, uid);
    db.products[db.products.indexOf(p)] = next;
    save();
    res.json(view(next));
  }));

  api.post('/products/:id/verify', h((req, res) => {
    const p = throwIf(getOr404(req));
    if (req.body?.verified === false) { p.status = 'draft'; p.lastVerified = null; }
    else { p.status = 'verified'; p.lastVerified = C.today(); p.sourceChangedOn = null; }
    p.updatedAt = Date.now();
    save();
    res.json(view(p));
  }));

  api.delete('/products/:id', h((req, res) => {
    const p = throwIf(getOr404(req));
    for (const i of p.images) fs.rmSync(path.join(MEDIA_DIR, i.file), { force: true });
    db.products = db.products.filter((x) => x !== p);
    save();
    res.json({ ok: true });
  }));

  // Staff-uploaded product images use the same media folder as the rest of OpenSign.
  api.post('/products/:id/images', upload.array('files'), h((req, res) => {
    const p = throwIf(getOr404(req));
    const added = [];
    for (const f of req.files || []) {
      const head = Buffer.alloc(16);
      const fd = fs.openSync(f.path, 'r');
      fs.readSync(fd, head, 0, 16, 0);
      fs.closeSync(fd);
      if (!I.imageExt(head)) { fs.rmSync(f.path, { force: true }); continue; } // only PNG, JPEG or WebP
      const img = { file: f.filename, url: '', color: '', view: '', alt: f.originalname };
      p.images.push(img);
      added.push(img);
    }
    p.updatedAt = Date.now();
    save();
    if (!added.length) return res.status(400).json({ error: 'Upload a PNG, JPEG or WebP image' });
    res.json(view(p));
  }));

  api.delete('/products/:id/images/:file', h((req, res) => {
    const p = throwIf(getOr404(req));
    const img = p.images.find((i) => i.file === req.params.file);
    if (!img) return res.status(404).json({ error: 'Image not found' });
    fs.rmSync(path.join(MEDIA_DIR, img.file), { force: true });
    p.images = p.images.filter((i) => i !== img);
    p.updatedAt = Date.now();
    save();
    res.json(view(p));
  }));

  // What a public poster may show for this product (hides unverified prices and unapproved/expired offers).
  api.get('/products/:id/poster-data', h((req, res) => res.json(C.posterData(throwIf(getOr404(req))))));

  // ---- import from the store website ------------------------------------------------------
  let job = { running: false };

  async function addImages(p, wanted) {
    const have = new Set(p.images.map((i) => i.url).filter(Boolean));
    for (const img of wanted.slice(0, 16)) {
      if (have.has(img.url)) continue;
      try {
        const { buf, ext } = await I.downloadImage(img.url);
        const file = uid() + ext;
        fs.writeFileSync(path.join(MEDIA_DIR, file), buf);
        p.images.push({ file, url: img.url, color: img.color, view: img.view, alt: img.alt });
        job.images++;
      } catch (e) { job.errors.push(e.message); }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  async function upsert(parsed) {
    const stamp = C.today();
    const existing = db.products.find((p) => p.sourceUrl === parsed.sourceUrl);
    const fields = {
      brand: parsed.brand, model: parsed.model, condition: parsed.condition, colours: parsed.colours, variants: parsed.variants,
      highlights: parsed.highlights, specs: parsed.specs, stock: parsed.stock, sourceUrl: parsed.sourceUrl,
      sourceName: 'myT Mobiles online store',
    };
    if (!existing) {
      const p = C.newProduct({ ...fields, posterSpecs: parsed.posterSpecs }, uid);
      Object.assign(p, { sourceCheckedOn: stamp, sourceHash: parsed.sourceHash, posterSpecsDerived: parsed.posterSpecs });
      await addImages(p, parsed.images);
      db.products.push(p);
      job.imported++;
    } else if (existing.sourceHash === parsed.sourceHash) {
      existing.sourceCheckedOn = stamp;
      await addImages(existing, parsed.images); // retry images that failed last time
      job.unchanged++;
    } else {
      // The store changed this listing. Refresh source facts, keep staff offers, and require a new verification.
      const staffEditedPosterSpecs = JSON.stringify(existing.posterSpecs) !== JSON.stringify(existing.posterSpecsDerived);
      const next = C.applyEdit(existing, { ...fields, posterSpecs: staffEditedPosterSpecs ? existing.posterSpecs : parsed.posterSpecs }, uid);
      Object.assign(next, {
        status: 'draft', lastVerified: null, sourceCheckedOn: stamp, sourceChangedOn: stamp,
        sourceHash: parsed.sourceHash, posterSpecsDerived: parsed.posterSpecs,
      });
      await addImages(next, parsed.images);
      db.products[db.products.indexOf(existing)] = next;
      job.updated++;
    }
  }

  async function runImport(base) {
    job = { running: true, base, startedAt: Date.now(), finishedAt: null, total: 0, read: 0, imported: 0, updated: 0, unchanged: 0, images: 0, errors: [] };
    try {
      const { products, errors } = await I.readCatalog(base, { onProgress: (p) => Object.assign(job, p) });
      job.errors.push(...errors);
      for (const parsed of products) {
        try { await upsert(parsed); } catch (e) { job.errors.push(`${parsed.sourceUrl}: ${e.message}`); }
        save();
      }
    } catch (e) { job.errors.push(e.message); }
    job.running = false;
    job.finishedAt = Date.now();
    job.errors = job.errors.slice(0, 50);
    save();
  }

  api.post('/catalog/import', h((req, res) => {
    if (job.running) return res.status(409).json({ error: 'An import is already running' });
    const base = I.checkStoreUrl(req.body?.url || I.DEFAULT_STORE);
    runImport(base); // runs in the background; poll GET /catalog/import
    res.status(202).json({ started: true });
  }));
  api.get('/catalog/import', (_req, res) => res.json(job));
}
