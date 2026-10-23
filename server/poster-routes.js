// Posters: saved poster designs, staff approval, and publishing into the existing media library.
// Posters are drawn in the admin page (canvas). The server stores the design, enforces approval, and keeps the PNG/JPEG.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as C from './catalog.js';
import { imageExt } from './importer.js';

export const TEMPLATES = ['flagship', 'camera', 'gaming', 'offer', 'launch', 'brand'];
export const SIZES = ['landscape', 'portrait', 'square', 'a4', 'a3'];
export const CATEGORIES = [
  'Latest smartphones', 'Premium flagships', 'Best-value smartphones', 'Camera-focused phones', 'Gaming phones',
  'Approved promotional offers', 'Store branding',
];

const str = (v, max) => String(v ?? '').trim().slice(0, max);
const num = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d);
const sha = (o) => crypto.createHash('sha1').update(JSON.stringify(o)).digest('hex');

export function registerPosterRoutes({ api, db, save, uid, MEDIA_DIR, upload, bumpOrg, hooks = {}, requireFeature }) {
  api.use('/posters', requireFeature('catalog')); // switched on per store by the platform administrator
  const ownPoster = (req) => db.posters.find((p) => p.id === req.params.id && p.orgId === req.orgId);
  const h = (fn) => async (req, res) => {
    try { await fn(req, res); } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  };
  const fail = (status, message) => Object.assign(new Error(message), { status });
  const product = (po) => db.products.find((p) => p.id === po.productId && p.orgId === po.orgId);

  /** Everything that decides what the poster shows. If this changes after approval, the poster needs review again. */
  const contentHash = (po) => sha({
    t: po.template, s: po.size, texts: po.texts, image: po.image, options: po.options,
    data: po.template === 'brand' ? null : (product(po) ? C.posterData(product(po)) : null),
  });
  const view = (po) => {
    const p = product(po);
    return {
      ...po, productName: p ? `${p.brand} ${p.model}` : '',
      needsReview: po.status === 'approved' && po.approvedHash !== contentHash(po),
      retired: !!po.retiredAt,
    };
  };

  /**
   * A published poster is a flat image. If the product, its price or its offers changed after approval
   * (an offer expired, a price changed, verification lapsed), it can show wrong claims. Take it off every
   * playlist so TVs stop showing it. Staff review, approve and add it again.
   */
  function retireStale() {
    const changedOrgs = new Set();
    for (const po of db.posters) {
      if (!po.mediaId || po.retiredAt || po.status !== 'approved' || po.approvedHash === contentHash(po)) continue;
      for (const pl of db.playlists) if (pl.orgId === po.orgId) pl.items = pl.items.filter((i) => i.mediaId !== po.mediaId);
      po.retiredAt = Date.now();
      changedOrgs.add(po.orgId);
    }
    for (const orgId of changedOrgs) bumpOrg(orgId);
    return changedOrgs.size > 0;
  }
  // Posters published before the library image was tracked: treat the approved design as the published one.
  for (const po of db.posters) if (po.mediaId && po.status === 'approved' && po.approvedHash && !po.publishedHash && !po.retiredAt) po.publishedHash = po.approvedHash;
  hooks.retireStale = retireStale;
  setInterval(retireStale, 60_000).unref();

  function clean(input, existing) {
    const o = { ...existing };
    if (input.template !== undefined) { if (!TEMPLATES.includes(input.template)) throw fail(400, 'Unknown template'); o.template = input.template; }
    if (input.size !== undefined) { if (!SIZES.includes(input.size)) throw fail(400, 'Unknown size'); o.size = input.size; }
    if (input.category !== undefined) o.category = CATEGORIES.includes(input.category) ? input.category : '';
    if (input.productId !== undefined) o.productId = input.productId || null;
    if (input.texts !== undefined) o.texts = { headline: str(input.texts?.headline, 80), tagline: str(input.texts?.tagline, 140), footer: str(input.texts?.footer, 120) };
    if (input.image !== undefined) {
      o.image = { file: str(input.image?.file, 100), zoom: num(input.image?.zoom, 50, 250, 100), offsetX: num(input.image?.offsetX, -50, 50, 0), offsetY: num(input.image?.offsetY, -50, 50, 0) };
    }
    if (input.options !== undefined) {
      o.options = {
        showSpecs: input.options?.showSpecs !== false, showPrice: input.options?.showPrice !== false, showOffers: input.options?.showOffers !== false,
        variantIndex: Math.max(0, Math.round(num(input.options?.variantIndex, 0, 30, 0))),
      };
    }
    if (o.template !== 'brand') {
      const p = product(o);
      if (!p) throw fail(400, 'Choose a product');
      if (o.image.file && !p.images.some((i) => i.file === o.image.file)) throw fail(400, 'That image does not belong to the product');
    }
    return o;
  }
  const blank = () => ({
    id: uid(), orgId: null, productId: null, template: 'flagship', size: 'landscape', category: '', texts: { headline: '', tagline: '', footer: '' },
    image: { file: '', zoom: 100, offsetX: 0, offsetY: 0 }, options: { showSpecs: true, showPrice: true, showOffers: true, variantIndex: 0 },
    status: 'draft', approvedAt: null, approvedHash: null, mediaId: null, createdAt: Date.now(), updatedAt: Date.now(),
  });

  api.get('/posters/meta', (_req, res) => res.json({ templates: TEMPLATES, sizes: SIZES, categories: CATEGORIES }));
  api.get('/posters', (req, res) => {
    const list = db.posters.filter((p) => p.orgId === req.orgId).filter((p) => (!req.query.category || p.category === req.query.category) && (!req.query.status || p.status === req.query.status));
    res.json(list.map(view));
  });
  api.get('/posters/:id', h((req, res) => {
    const po = ownPoster(req);
    if (!po) throw fail(404, 'Poster not found');
    res.json(view(po));
  }));
  api.post('/posters', h((req, res) => {
    const po = clean(req.body || {}, { ...blank(), orgId: req.orgId });
    db.posters.push(po);
    save();
    res.json(view(po));
  }));
  api.put('/posters/:id', h((req, res) => {
    const old = ownPoster(req);
    if (!old) throw fail(404, 'Poster not found');
    const next = clean(req.body || {}, old);
    Object.assign(next, { status: 'draft', approvedAt: null, approvedHash: null, updatedAt: Date.now() }); // any edit needs a new approval
    db.posters[db.posters.indexOf(old)] = next;
    save();
    res.json(view(next));
  }));
  api.delete('/posters/:id', h((req, res) => {
    const po = ownPoster(req);
    if (!po) throw fail(404, 'Poster not found');
    db.posters = db.posters.filter((p) => p !== po);
    save();
    res.json({ ok: true });
  }));

  api.post('/posters/:id/approve', h((req, res) => {
    const po = ownPoster(req);
    if (!po) throw fail(404, 'Poster not found');
    if (po.template !== 'brand') {
      const p = product(po);
      if (!p) throw fail(400, 'The product no longer exists');
      if (!p.images.length) throw fail(400, 'The product has no image. Upload an approved image first.');
    }
    po.status = 'approved';
    po.approvedAt = Date.now();
    po.approvedHash = contentHash(po);
    save();
    res.json(view(po));
  }));
  api.post('/posters/:id/unapprove', h((req, res) => {
    const po = ownPoster(req);
    if (!po) throw fail(404, 'Poster not found');
    Object.assign(po, { status: 'draft', approvedAt: null, approvedHash: null });
    save();
    res.json(view(po));
  }));

  // The browser sends the rendered PNG/JPEG. It becomes (or replaces) an item in the normal media library.
  api.post('/posters/:id/library', upload.single('file'), h((req, res) => {
    const po = ownPoster(req);
    const drop = () => req.file && fs.rmSync(req.file.path, { force: true });
    if (!po) { drop(); throw fail(404, 'Poster not found'); }
    const v = view(po);
    if (po.status !== 'approved') { drop(); throw fail(409, 'Approve the poster before adding it to the media library.'); }
    if (v.needsReview) { drop(); throw fail(409, 'The product or offers changed since approval. Review and approve the poster again.'); }
    if (!req.file) throw fail(400, 'Send the poster image');
    const head = Buffer.alloc(16);
    const fd = fs.openSync(req.file.path, 'r');
    fs.readSync(fd, head, 0, 16, 0);
    fs.closeSync(fd);
    const ext = imageExt(head);
    if (ext !== '.png' && ext !== '.jpg') { drop(); throw fail(400, 'Send a PNG or JPEG image'); }
    const name = `${v.productName || 'Store'} poster`;
    let m = db.media.find((x) => x.id === po.mediaId && x.orgId === po.orgId);
    po.retiredAt = null; // published again after review
    po.publishedHash = po.approvedHash; // the design the library image shows (lets the admin reuse that image as the thumbnail)
    if (m) { // keep the same media id so playlists that use it keep working
      if (m.file) fs.rmSync(path.join(MEDIA_DIR, m.file), { force: true });
      Object.assign(m, { file: req.file.filename, size: req.file.size, name });
      bumpOrg(po.orgId);
    } else {
      m = { id: uid(), orgId: po.orgId, name, type: 'image', file: req.file.filename, size: req.file.size, createdAt: Date.now(), posterId: po.id };
      db.media.push(m);
      po.mediaId = m.id;
      save();
    }
    res.json({ poster: view(po), media: m });
  }));
}
