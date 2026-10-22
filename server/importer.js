// Reads smartphones from the myT Mobiles online store (the owner's own site) so staff do not retype them.
// This module only fetches and parses. Saving is done by catalog-routes.js.
// It runs on the server when an admin clicks "Import from store website". The TV player never calls it.
import crypto from 'node:crypto';

export const DEFAULT_STORE = 'https://storetmobiles2-code.github.io/mytmobiles-web';
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** The import may only read from hosts the owner allows. Default: the myT Mobiles store. */
export function allowedHosts() {
  return (process.env.IMPORT_ALLOWED_HOSTS || 'storetmobiles2-code.github.io').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
}

export function checkStoreUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw Object.assign(new Error('Enter a full store address, e.g. https://example.com/shop'), { status: 400 }); }
  if (!['http:', 'https:'].includes(u.protocol)) throw Object.assign(new Error('Only http(s) addresses are allowed'), { status: 400 });
  if (!allowedHosts().includes(u.hostname.toLowerCase())) {
    throw Object.assign(new Error(`${u.hostname} is not an allowed import source. Set IMPORT_ALLOWED_HOSTS to allow it.`), { status: 400 });
  }
  return u.href.replace(/\/+$/, '');
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (s) => s
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
const text = (html) => decode(html.replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

/** Reads one JSON array that starts at text[start] === '['. Returns the parsed array. */
function readJsonArray(src, start) {
  let depth = 0, inStr = false;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (inStr) { if (c === '\\') i++; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '[') depth++;
    else if (c === ']' && --depth === 0) return JSON.parse(src.slice(start, i + 1));
  }
  throw new Error('unterminated array');
}

/** The page streams its data as JSON string chunks. Join them back into one text. */
function flightData(html) {
  const out = [];
  for (const m of html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)) {
    try { out.push(JSON.parse(m[1])); } catch { /* skip a broken chunk */ }
  }
  return out.join('');
}

export function parseProductPage(html, pageUrl) {
  const ld = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .flatMap((m) => { try { const j = JSON.parse(m[1]); return Array.isArray(j) ? j : [j]; } catch { return []; } })
    .find((o) => o['@type'] === 'Product');
  if (!ld) throw new Error('no product data on page');

  const blob = flightData(html);
  const vi = blob.indexOf('"variants":[');
  const rawVariants = vi >= 0 ? readJsonArray(blob, vi + '"variants":'.length) : [];
  const ii = vi >= 0 ? blob.indexOf('"images":[', vi) : -1;
  const rawImages = ii >= 0 ? readJsonArray(blob, ii + '"images":'.length) : [];
  const origin = new URL(pageUrl).origin;
  const siteRoot = new URL(pageUrl).pathname.split('/p/')[0]; // e.g. /mytmobiles-web
  const abs = (u) => new URL(u.startsWith('/') && !u.startsWith(siteRoot + '/') ? siteRoot + u : u, origin).href;

  const variants = rawVariants.map((v) => ({
    ram: String(v.ram || ''), storage: String(v.storage || ''), colour: String(v.color || ''),
    officialPrice: v.mrp ? Math.round(v.mrp / 100) : null, // the site stores paise
    sellingPrice: v.price ? Math.round(v.price / 100) : null,
    stock: Number.isFinite(v.stock) ? v.stock : null,
  }));
  const images = rawImages.filter((i) => i?.url).map((i) => ({ url: abs(i.url), color: i.color || '', view: i.view || '', alt: i.alt || '' }));
  // schema.org lists the first colour's images; keep them if the payload had none
  if (!images.length) for (const u of ld.image || []) images.push({ url: u, color: '', view: '', alt: '' });

  const hl = html.match(/<ul class="space-y-1\.5[^"]*">([\s\S]*?)<\/ul>/);
  const highlights = hl ? [...hl[1].matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((m) => text(m[1])).filter(Boolean) : [];

  const specs = [...html.matchAll(/<h3 class="mb-2[^>]*>([\s\S]*?)<\/h3><dl[^>]*>([\s\S]*?)<\/dl>/g)].map((g) => ({
    group: text(g[1]),
    items: [...g[2].matchAll(/<dt[^>]*>([\s\S]*?)<\/dt><dd[^>]*>([\s\S]*?)<\/dd>/g)].map((r) => ({ label: text(r[1]), value: text(r[2]) })),
  })).filter((g) => g.group && g.items.length);

  const brand = ld.brand?.name || '';
  const model = String(ld.name || '').replace(new RegExp('^' + brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s+', 'i'), '').trim() || ld.name;
  const totalStock = variants.reduce((n, v) => n + (v.stock || 0), 0);
  const parsed = {
    brand, model,
    condition: /new/i.test(ld.itemCondition || 'New') ? 'new' : 'demo',
    colours: [...new Set(variants.map((v) => v.colour).filter(Boolean))],
    variants, highlights, specs, images,
    stock: !variants.length ? 'unknown' : totalStock === 0 ? 'out_of_stock' : totalStock <= 2 ? 'low_stock' : 'in_stock',
    sourceUrl: pageUrl,
  };
  parsed.posterSpecs = derivePosterSpecs(parsed);
  parsed.sourceHash = crypto.createHash('sha1').update(JSON.stringify({
    b: brand, m: model, v: variants, h: highlights, s: specs, i: images.map((i) => i.url),
  })).digest('hex');
  return parsed;
}

/** Short lines for posters, taken from the product's own highlights and specs (nothing is invented). */
export function derivePosterSpecs({ highlights = [], specs = [], variants = [] }) {
  const flat = specs.flatMap((g) => g.items.map((i) => ({ group: g.group, ...i })));
  const spec = (groupRe, labelRe) => flat.find((i) => groupRe.test(i.group) && labelRe.test(i.label))?.value || '';
  const hl = (re) => highlights.find((h) => re.test(h)) || '';
  const mpList = (s) => (s.match(/\d+(?:\.\d+)?\s*MP/gi) || []).map((x) => x.replace(/\s+/g, ' ').toUpperCase());

  const display = hl(/display|inch/i) || [spec(/display/i, /^size/i), spec(/display/i, /^type/i), spec(/display/i, /refresh/i)].filter(Boolean).join(', ');
  const processor = spec(/performance|processor/i, /processor|chipset|chip/i) || (hl(/snapdragon|dimensity|helio|exynos|bionic|\bA\d{2}\b|tensor|unisoc/i).split(',')[0] || '');
  const rear = spec(/camera/i, /rear|main|primary/i) || hl(/\bMP\b.*camera|camera/i);
  const mp = mpList(rear);
  const camera = mp.length ? mp.join(' + ') + (mp.length > 1 ? ' cameras' : ' camera') : rear;
  const battery = spec(/battery/i, /capacity/i) || (hl(/mAh/i).match(/[\d,]+\s*mAh[^,]*/i) || [''])[0];
  const rams = [...new Set(variants.map((v) => v.ram).filter(Boolean))];
  const stor = [...new Set(variants.map((v) => v.storage).filter(Boolean))];
  const memory = rams.length || stor.length ? [rams.join(' / '), stor.join(' / ')].filter(Boolean).join(' + ') : '';
  const extra = hl(/IP\d{2}/i) || hl(/S Pen|water|dust/i);
  const network = spec(/key facts|network|connectivity/i, /^network/i) || (hl(/\b5G\b/).match(/\b5G\b/) || [''])[0];
  const colours = [...new Set(variants.map((v) => v.colour).filter(Boolean))].join(', ');
  const cut = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
  return { display: cut(display, 90), processor: cut(processor, 80), camera: cut(camera, 90), battery: cut(battery, 60), memory: cut(memory, 60), network: cut(network, 40), colours: cut(colours, 80), extra: cut(extra, 90) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url, fetchImpl) {
  const r = await fetchImpl(url, { headers: { 'User-Agent': 'OpenSign-importer (store owner import)' } });
  if (!r.ok) throw new Error(`${url} answered ${r.status}`);
  return r.text();
}

/** Product page addresses from the store's smartphone category page. */
export async function listProductUrls(base, { fetchImpl = fetch } = {}) {
  const html = await fetchText(`${base}/c/smartphones`, fetchImpl);
  const origin = new URL(base).origin;
  const hrefs = [...html.matchAll(/href="([^"]*\/p\/[a-z0-9][a-z0-9-]*)"/g)].map((m) => new URL(m[1], origin).href);
  return [...new Set(hrefs)];
}

/** Reads every product page, one at a time, with a short pause (the store is a small site). */
export async function readCatalog(base, { fetchImpl = fetch, delayMs = 250, onProgress = () => {} } = {}) {
  const urls = await listProductUrls(base, { fetchImpl });
  onProgress({ total: urls.length });
  const products = [], errors = [];
  for (const url of urls) {
    try { products.push(parseProductPage(await fetchText(url, fetchImpl), url)); }
    catch (e) { errors.push(`${url}: ${e.message}`); }
    onProgress({ read: products.length + errors.length });
    await sleep(delayMs);
  }
  return { products, errors };
}

/** Downloads one image. Checks the file type by its first bytes, not by what the server claims. */
export async function downloadImage(url, { fetchImpl = fetch } = {}) {
  const r = await fetchImpl(url, { headers: { 'User-Agent': 'OpenSign-importer (store owner import)' } });
  if (!r.ok) throw new Error(`image ${url} answered ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > MAX_IMAGE_BYTES) throw new Error('image is too large');
  const ext = imageExt(buf);
  if (!ext) throw new Error('not a PNG, JPEG or WebP image');
  return { buf, ext };
}

export function imageExt(buf) {
  if (buf.length > 12 && buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return '.webp';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
  return null;
}
