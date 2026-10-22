// Smartphone catalog rules: data shape, staff verification, warnings, and what may appear on a public poster.
// Prices are whole rupees. Dates are YYYY-MM-DD strings (store-local calendar days).

export const BRANDS = [
  'Apple', 'Samsung', 'OnePlus', 'Xiaomi', 'Redmi', 'vivo', 'OPPO', 'iQOO', 'realme', 'Motorola', 'Nothing', 'Google Pixel',
];
export const OFFER_TYPES = ['discount', 'bank', 'exchange', 'other'];
export const STOCK = ['in_stock', 'low_stock', 'out_of_stock', 'unknown'];
const CONDITIONAL_OFFERS = ['bank', 'exchange']; // these always need written conditions

export const STALE_DAYS = Number(process.env.PRODUCT_STALE_DAYS) || 30;

export const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const price = (v) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? n : null;
};

export function cleanOffer(o, uid) {
  const type = OFFER_TYPES.includes(o?.type) ? o.type : 'other';
  const offer = {
    id: str(o?.id, 64) || uid(),
    type,
    title: str(o?.title, 120),
    amount: price(o?.amount), // value of the benefit in rupees, informational only; never subtracted from a price
    conditions: str(o?.conditions, 300),
    expiresOn: isDate(o?.expiresOn) ? o.expiresOn : null,
    approved: o?.approved === true,
  };
  if (offer.approved && CONDITIONAL_OFFERS.includes(type) && !offer.conditions) {
    throw Object.assign(new Error(`A ${type} offer needs its conditions before it can be approved`), { status: 400 });
  }
  if (offer.approved && !offer.title) {
    throw Object.assign(new Error('An approved offer needs a title'), { status: 400 });
  }
  return offer;
}

export function cleanVariants(list) {
  return (Array.isArray(list) ? list : []).slice(0, 30).map((v) => ({
    ram: str(v?.ram, 20),
    storage: str(v?.storage, 20),
    colour: str(v?.colour ?? v?.color, 40),
    officialPrice: price(v?.officialPrice), // brand MRP / official launch price
    sellingPrice: price(v?.sellingPrice), // myT Mobiles selling price
    stock: Number.isFinite(Number(v?.stock)) ? Math.max(0, Math.round(Number(v.stock))) : null,
  }));
}

export function cleanSpecs(list) {
  return (Array.isArray(list) ? list : []).slice(0, 30).map((g) => ({
    group: str(g?.group, 60),
    items: (Array.isArray(g?.items) ? g.items : []).slice(0, 40).map((i) => ({ label: str(i?.label, 80), value: str(i?.value, 300) })),
  }));
}

export function cleanPosterSpecs(s) {
  const out = {};
  for (const k of ['display', 'processor', 'camera', 'battery', 'memory', 'extra']) out[k] = str(s?.[k], 120);
  return out;
}

/** Fields that describe the product itself. Changing them invalidates a staff verification. */
const VERIFIED_FIELDS = ['brand', 'model', 'variants', 'specs', 'highlights'];

export function applyEdit(existing, input, uid) {
  const p = { ...existing };
  if (input.brand !== undefined) p.brand = str(input.brand, 40);
  if (input.model !== undefined) p.model = str(input.model, 120);
  if (input.category !== undefined) p.category = str(input.category, 40) || 'smartphone';
  if (input.condition !== undefined) p.condition = input.condition === 'demo' ? 'demo' : 'new';
  if (input.colours !== undefined) p.colours = (Array.isArray(input.colours) ? input.colours : []).slice(0, 20).map((c) => str(c, 40)).filter(Boolean);
  if (input.variants !== undefined) p.variants = cleanVariants(input.variants);
  if (input.highlights !== undefined) p.highlights = (Array.isArray(input.highlights) ? input.highlights : []).slice(0, 12).map((h) => str(h, 200)).filter(Boolean);
  if (input.specs !== undefined) p.specs = cleanSpecs(input.specs);
  if (input.posterSpecs !== undefined) p.posterSpecs = cleanPosterSpecs(input.posterSpecs);
  if (input.offers !== undefined) p.offers = (Array.isArray(input.offers) ? input.offers : []).slice(0, 12).map((o) => cleanOffer(o, uid));
  if (input.stock !== undefined) p.stock = STOCK.includes(input.stock) ? input.stock : 'unknown';
  if (input.stockNote !== undefined) p.stockNote = str(input.stockNote, 120);
  if (input.sourceUrl !== undefined) p.sourceUrl = str(input.sourceUrl, 500);
  if (input.sourceName !== undefined) p.sourceName = str(input.sourceName, 120);
  if (Array.isArray(input.images)) {
    // Only reorder or drop images that already belong to the product.
    const byFile = new Map(existing.images.map((i) => [i.file, i]));
    p.images = input.images.map((i) => byFile.get(typeof i === 'string' ? i : i?.file)).filter(Boolean);
  }
  if (!p.brand || !p.model) throw Object.assign(new Error('Brand and model are required'), { status: 400 });
  if (p.status === 'verified' && VERIFIED_FIELDS.some((k) => JSON.stringify(p[k]) !== JSON.stringify(existing[k]))) {
    p.status = 'draft'; // the verified facts changed, so staff must verify again
    p.lastVerified = null;
  }
  p.updatedAt = Date.now();
  return p;
}

export function newProduct(input, uid) {
  const base = {
    id: uid(), category: 'smartphone', condition: 'new', brand: '', model: '', colours: [], variants: [], highlights: [], specs: [],
    posterSpecs: cleanPosterSpecs({}), images: [], offers: [], stock: 'unknown', stockNote: '', sourceUrl: '', sourceName: '',
    sourceCheckedOn: null, sourceHash: null, sourceChangedOn: null, posterSpecsDerived: null, status: 'draft', lastVerified: null, createdAt: Date.now(), updatedAt: Date.now(),
  };
  return applyEdit(base, input, uid);
}

export const isFresh = (p, now = today()) => p.status === 'verified' && isDate(p.lastVerified) && daysBetween(p.lastVerified, now) <= STALE_DAYS;
export const offerActive = (o, now = today()) => o.approved && (!o.expiresOn || o.expiresOn >= now);

/** Problems staff should fix before publishing. level: 'error' blocks nothing by itself but must be read. */
export function warnings(p, now = today()) {
  const w = [];
  const add = (level, code, message) => w.push({ level, code, message });
  if (!p.images.length) add('error', 'no_image', 'No product image. Upload an approved image.');
  if (!p.variants.length) add('warn', 'no_variant', 'No storage/RAM variant is listed.');
  else if (!p.variants.some((v) => v.sellingPrice)) add('warn', 'no_selling_price', 'No myT Mobiles selling price is set.');
  if (p.variants.length && !p.variants.some((v) => v.officialPrice)) add('warn', 'no_official_price', 'No official price (MRP) is set.');
  if (!p.sourceUrl) add('warn', 'no_source', 'No source URL is recorded.');
  if (!p.highlights.length && !p.specs.length) add('warn', 'no_specs', 'No key specifications are listed.');
  if (!Object.values(p.posterSpecs).some(Boolean)) add('warn', 'no_poster_specs', 'No poster spec highlights are set.');
  if (p.status !== 'verified') add('info', 'not_verified', 'Not verified. Prices and offers stay hidden on posters.');
  else if (!isFresh(p, now)) add('warn', 'outdated', `Verified more than ${STALE_DAYS} days ago. Verify again before publishing prices.`);
  for (const o of p.offers) {
    if (o.expiresOn && o.expiresOn < now) add('warn', 'offer_expired', `Offer "${o.title || o.type}" expired on ${o.expiresOn} and is hidden.`);
    else if (!o.approved) add('info', 'offer_unapproved', `Offer "${o.title || o.type}" is not approved and is hidden.`);
  }
  if (p.sourceChangedOn) add('warn', 'source_changed', `The store listing changed on ${p.sourceChangedOn}. Check the details and verify again.`);
  if (p.condition === 'demo') add('info', 'demo', 'Demo unit: sold as open-box stock.');
  if (p.stock === 'unknown') add('info', 'stock_unknown', 'Stock status is unknown. It is not shown on posters.');
  return w;
}

/**
 * The only product data a public poster may use.
 * Prices need a fresh staff verification. Offers also need their own approval and must not be expired.
 * Offers are listed beside the selling price and never subtracted from it.
 */
export function posterData(p, now = today()) {
  const verified = isFresh(p, now);
  return {
    id: p.id, brand: p.brand, model: p.model, condition: p.condition,
    colours: p.colours,
    highlights: p.highlights,
    posterSpecs: p.posterSpecs,
    images: p.images.map((i) => ({ file: i.file, color: i.color || '', view: i.view || '' })),
    variants: p.variants.map((v) => ({
      ram: v.ram, storage: v.storage, colour: v.colour,
      officialPrice: verified ? v.officialPrice : null,
      sellingPrice: verified ? v.sellingPrice : null,
    })),
    offers: verified ? p.offers.filter((o) => offerActive(o, now)).map((o) => ({ type: o.type, title: o.title, amount: o.amount, conditions: o.conditions, expiresOn: o.expiresOn })) : [],
    stock: verified && p.stock !== 'unknown' ? p.stock : null,
    pricesVisible: verified,
    verifiedOn: p.lastVerified,
  };
}
