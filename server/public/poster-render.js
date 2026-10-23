// Poster renderer: draws a poster on a <canvas> from saved product data. Runs in the admin page only.
// Public entry points: renderPoster(canvas, spec, scale), posterBlob(spec, type), buildPdf(...), POSTER_SIZES.
//   spec = { template, size, data (poster-data from the server, or null), texts, image, options }
// Every price, offer and stock value comes from `data`. The server already removed anything unverified, unapproved or expired.

const POSTER_SIZES = {
  landscape: { label: '1920 × 1080 (landscape signage)', w: 1920, h: 1080 },
  portrait: { label: '1080 × 1350 (digital poster)', w: 1080, h: 1350 },
  square: { label: '1080 × 1080 (square)', w: 1080, h: 1080 },
  a4: { label: 'A4 portrait (print, 300 dpi)', w: 2480, h: 3508, pt: [595.28, 841.89] },
  a3: { label: 'A3 portrait (print, 300 dpi)', w: 3508, h: 4961, pt: [841.89, 1190.55] },
};
const POSTER_TEMPLATES = {
  flagship: 'Premium flagship', camera: 'Camera flagship', gaming: 'Gaming and performance',
  offer: 'Price and offer', launch: 'New launch', brand: 'Store brand',
};
// The store's own colour and name (ORG comes from the admin page). Nothing here is specific to one store.
const accentColor = () => (typeof ORG !== 'undefined' && ORG?.accent) || '#4f8cff';
const storeName = () => (typeof ORG !== 'undefined' && ORG?.name) || 'Our store';
const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)).join(',');
const PFONT = '"Helvetica Neue", Helvetica, Arial, "Segoe UI", system-ui, sans-serif';
const PC = { bg0: '#09090b', bg1: '#1a1a1f', text: '#f5f5f7', muted: '#a5a8b3', silver: '#cfd3dc', cyan: '#19e6ff', violet: '#8a5cff' };

// ---- images -------------------------------------------------------------------------------------
const _imgCache = new Map();
function loadImg(url) {
  if (!_imgCache.has(url)) {
    _imgCache.set(url, new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => no(new Error('image failed: ' + url)); i.src = url; }));
  }
  return _imgCache.get(url);
}

/** Removes the white studio background by flood-filling from the edges, so white parts inside the phone stay. */
function keyOutBackground(id) {
  const { width: w, height: h, data } = id;
  const seen = new Uint8Array(w * h);
  const isBg = (p) => { const r = data[p * 4], g = data[p * 4 + 1], b = data[p * 4 + 2]; return Math.min(r, g, b) >= 242 && Math.max(r, g, b) - Math.min(r, g, b) <= 14; };
  const queue = new Int32Array(w * h);
  let head = 0, tail = 0;
  const push = (p) => { if (!seen[p] && isBg(p)) { seen[p] = 1; queue[tail++] = p; } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (head < tail) {
    const p = queue[head++], x = p % w;
    if (x > 0) push(p - 1);
    if (x < w - 1) push(p + 1);
    if (p >= w) push(p - w);
    if (p < w * (h - 1)) push(p + w);
  }
  for (let p = 0; p < w * h; p++) if (seen[p]) data[p * 4 + 3] = 0;
  // soft edge: pixels touching the removed area fade according to how white they are
  for (let p = 0; p < w * h; p++) {
    if (seen[p]) continue;
    const x = p % w;
    const touches = (x > 0 && seen[p - 1]) || (x < w - 1 && seen[p + 1]) || (p >= w && seen[p - w]) || (p < w * (h - 1) && seen[p + w]);
    if (!touches) continue;
    const m = Math.min(data[p * 4], data[p * 4 + 1], data[p * 4 + 2]);
    if (m > 200) data[p * 4 + 3] = Math.round(255 * Math.max(0, 1 - (m - 200) / 42));
  }
}

const _cutCache = new Map();
function cutout(file) {
  if (!_cutCache.has(file)) {
    _cutCache.set(file, (async () => {
      const img = await loadImg('/media/' + file);
      const c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      const x = c.getContext('2d', { willReadFrequently: true });
      x.drawImage(img, 0, 0);
      const id = x.getImageData(0, 0, c.width, c.height);
      keyOutBackground(id);
      x.putImageData(id, 0, 0);
      let x0 = c.width, y0 = c.height, x1 = 0, y1 = 0;
      for (let y = 0; y < c.height; y++) for (let xx = 0; xx < c.width; xx++) {
        if (id.data[(y * c.width + xx) * 4 + 3] > 24) { if (xx < x0) x0 = xx; if (xx > x1) x1 = xx; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      }
      if (x1 <= x0 || y1 <= y0) { x0 = 0; y0 = 0; x1 = c.width - 1; y1 = c.height - 1; }
      return { canvas: c, box: { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } };
    })());
  }
  return _cutCache.get(file);
}

// ---- text helpers ---------------------------------------------------------------------------------
function setFont(ctx, size, weight = 400) { ctx.font = `${weight} ${size}px ${PFONT}`; }
function wrapLines(ctx, text, maxW, maxLines) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const t = cur ? cur + ' ' + w : w;
    if (!cur || ctx.measureText(t).width <= maxW) cur = t; else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    let l = lines[maxLines - 1];
    while (l.length > 1 && ctx.measureText(l + '…').width > maxW) l = l.slice(0, -1);
    lines[maxLines - 1] = l.trimEnd() + '…';
  }
  return lines;
}
function spaced(ctx, px) { if ('letterSpacing' in ctx) ctx.letterSpacing = px + 'px'; }
const inr = (n) => '₹' + Number(n).toLocaleString('en-IN');
const niceDate = (d) => new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

/** Each block knows its height and how to draw itself at a y position. */
function textBlock(ctx, s, { size, weight = 400, color = PC.text, maxW, maxLines = 1, lh = 1.15, spacing = 0, upper = false, align = 'left', minSize = 0 }) {
  let sz = size, lines;
  const str = upper ? String(s).toUpperCase() : String(s);
  for (;;) {
    setFont(ctx, sz, weight); spaced(ctx, spacing);
    lines = wrapLines(ctx, str, maxW, 99);
    if (lines.length <= maxLines || sz <= (minSize || size * 0.6)) break;
    sz *= 0.94;
  }
  setFont(ctx, sz, weight); spaced(ctx, spacing);
  lines = wrapLines(ctx, str, maxW, maxLines);
  spaced(ctx, 0);
  const h = lines.length * sz * lh;
  return {
    h,
    draw(x, y, w) {
      setFont(ctx, sz, weight); spaced(ctx, spacing);
      ctx.fillStyle = color; ctx.textBaseline = 'top'; ctx.textAlign = align;
      const ax = align === 'center' ? x + w / 2 : align === 'right' ? x + w : x;
      lines.forEach((l, i) => ctx.fillText(l, ax, y + i * sz * lh + (sz * lh - sz) / 2));
      spaced(ctx, 0); ctx.textAlign = 'left';
    },
  };
}

function specTiles(ctx, items, { maxW, cols, k, accent, valueSize, labelSize }) {
  const gap = 28 * k, tw = (maxW - gap * (cols - 1)) / cols;
  const tiles = items.map(([label, value]) => {
    const lb = textBlock(ctx, label, { size: labelSize, weight: 700, color: accent, maxW: tw, spacing: 3 * k, upper: true });
    const vb = textBlock(ctx, value, { size: valueSize, weight: 500, color: PC.text, maxW: tw - 4, maxLines: 3, lh: 1.18, minSize: valueSize * 0.7 });
    return { lb, vb, h: lb.h + 8 * k + vb.h };
  });
  const rows = [];
  for (let i = 0; i < tiles.length; i += cols) rows.push(tiles.slice(i, i + cols));
  const rowH = rows.map((r) => Math.max(...r.map((t) => t.h)));
  const h = rowH.reduce((a, b) => a + b, 0) + 26 * k * Math.max(0, rows.length - 1);
  return {
    h,
    draw(x, y) {
      let yy = y;
      rows.forEach((r, ri) => {
        r.forEach((t, ci) => {
          const tx = x + ci * (tw + gap);
          t.lb.draw(tx, yy, tw);
          ctx.fillStyle = accent; ctx.globalAlpha = 0.5; ctx.fillRect(tx, yy + t.lb.h + 2 * k, 36 * k, 2 * k); ctx.globalAlpha = 1;
          t.vb.draw(tx, yy + t.lb.h + 8 * k, tw);
        });
        yy += rowH[ri] + 26 * k;
      });
    },
  };
}

function gap(h) { return { h, draw() {} }; }
function rule(k, color) { return { h: 4 * k, draw(x, y) { ctx2(color, x, y, 120 * k, 4 * k); } }; }
let _c2 = null;
function ctx2(color, x, y, w, h) { _c2.fillStyle = color; _c2.fillRect(x, y, w, h); }

function pill(ctx, label, k, bg, fg = '#fff') {
  const size = 30 * k;
  setFont(ctx, size, 800); spaced(ctx, 4 * k);
  const w = ctx.measureText(label).width + 48 * k, h = size * 1.9;
  spaced(ctx, 0);
  return {
    h,
    draw(x, y) {
      ctx.fillStyle = bg; ctx.beginPath(); ctx.roundRect(x, y, w, h, h / 2); ctx.fill();
      setFont(ctx, size, 800); spaced(ctx, 4 * k); ctx.fillStyle = fg; ctx.textBaseline = 'middle'; ctx.fillText(label, x + 24 * k, y + h / 2 + 1);
      spaced(ctx, 0); ctx.textBaseline = 'top';
    },
  };
}

// ---- content assembled from the verified data ----------------------------------------------------------
function chosenVariant(spec) {
  const vs = spec.data?.variants || [];
  const priced = vs.map((v, i) => ({ v, i })).filter((x) => x.v.sellingPrice);
  return priced.find((x) => x.i === spec.options.variantIndex)?.v || priced.sort((a, b) => a.v.sellingPrice - b.v.sellingPrice)[0]?.v || null;
}
function variantLabel(v) { return [v.ram, v.storage].filter(Boolean).join(' + '); }
function specItems(d, keys) {
  const names = { display: 'Display', processor: 'Processor', camera: 'Camera', battery: 'Battery', memory: 'Memory', network: 'Network', colours: 'Colours', extra: 'Built to last' };
  return keys.map((k) => [names[k], d.posterSpecs[k]]).filter(([, v]) => v);
}

function buildBlocks(ctx, spec, bw, land, k) {
  const d = spec.data || {}, o = spec.options, t = spec.texts;
  const accent = { flagship: PC.silver, camera: PC.silver, gaming: PC.cyan, offer: accentColor(), launch: accentColor(), brand: PC.silver }[spec.template];
  const headline = t.headline || (d.model || '');
  const blocks = [];
  const add = (b) => blocks.push(b);
  const brandLine = () => add(textBlock(ctx, d.brand || '', { size: 34 * k, weight: 700, color: accent, maxW: bw, spacing: 8 * k, upper: true }));
  const title = (lines = 2, size = 124) => add(textBlock(ctx, headline, { size: size * k, weight: 700, maxW: bw, maxLines: lines, lh: 1.04, minSize: 56 * k }));
  const tagline = () => t.tagline && add(textBlock(ctx, t.tagline, { size: 38 * k, weight: 400, color: PC.muted, maxW: bw, maxLines: 2, lh: 1.25 }));
  // When a phone lacks headline specs, fill the tiles with other verified facts (memory, network, colours). Nothing is invented.
  const usedKeys = new Set();
  const sp = (keys, cols, big = 1) => {
    if (!o.showSpecs) return;
    const want = keys.filter((x) => d.posterSpecs?.[x]);
    const fill = ['memory', 'network', 'colours'].filter((x) => d.posterSpecs?.[x] && !want.includes(x));
    const use = [...want, ...fill].slice(0, Math.max(keys.length, 3));
    use.forEach((x) => usedKeys.add(x));
    const items = specItems(d, use);
    if (items.length) add(specTiles(ctx, items, { maxW: bw, cols, k, accent, valueSize: 40 * k * big, labelSize: 24 * k }));
  };
  const variant = chosenVariant(spec);
  const priceVisible = o.showPrice && d.pricesVisible && variant;
  const memoryChip = () => d.posterSpecs?.memory && !usedKeys.has('memory') && add(textBlock(ctx, d.posterSpecs.memory, { size: 30 * k, weight: 600, color: accent, maxW: bw, spacing: 2 * k }));
  const offers = (max) => {
    const list = o.showOffers ? (d.offers || []).slice(0, max) : [];
    list.forEach((of) => {
      const line = [of.title, of.amount ? `worth ${inr(of.amount)}` : ''].filter(Boolean).join(' · ');
      add(textBlock(ctx, line, { size: 38 * k, weight: 700, color: PC.text, maxW: bw, maxLines: 2, lh: 1.15 }));
      const cond = [of.conditions, of.expiresOn ? `Valid till ${niceDate(of.expiresOn)}` : ''].filter(Boolean).join(' · ');
      if (cond) add(textBlock(ctx, cond, { size: 26 * k, color: PC.muted, maxW: bw, maxLines: 2, lh: 1.25 }));
      add(gap(14 * k));
    });
    if (list.length) add(textBlock(ctx, 'Offers are subject to the conditions shown.', { size: 22 * k, color: PC.muted, maxW: bw }));
  };
  const lowPrice = () => priceVisible && add(textBlock(ctx, `From ${inr(variant.sellingPrice)}`, { size: 44 * k, weight: 600, color: PC.silver, maxW: bw }));

  if (spec.template === 'brand') {
    add(textBlock(ctx, t.headline || storeName(), { size: 110 * k, weight: 700, maxW: bw, maxLines: 3, lh: 1.05, minSize: 50 * k }));
    add(gap(14 * k));
    if (t.tagline) add(textBlock(ctx, t.tagline, { size: 42 * k, color: PC.muted, maxW: bw, maxLines: 3, lh: 1.25 }));
    return blocks;
  }
  if (spec.template === 'flagship') {
    brandLine(); add(gap(10 * k)); title(2); add(gap(14 * k)); tagline(); add(gap(22 * k)); add(rule(k, PC.silver)); add(gap(26 * k));
    sp(['display', 'processor', 'camera', 'battery'], 2); add(gap(22 * k)); memoryChip(); add(gap(18 * k)); lowPrice();
  } else if (spec.template === 'camera') {
    brandLine(); add(gap(10 * k)); title(2, 96);
    const mp = (d.posterSpecs.camera.match(/(\d+(?:\.\d+)?)\s*MP/i) || [])[1];
    if (mp) {
      add(gap(10 * k));
      add({ h: 190 * k, draw(x, y) { setFont(ctx, 190 * k, 800); ctx.fillStyle = PC.text; ctx.textBaseline = 'top'; ctx.fillText(mp, x, y - 22 * k); const w = ctx.measureText(mp).width; setFont(ctx, 62 * k, 700); ctx.fillStyle = accent; ctx.fillText('MP', x + w + 14 * k, y + 104 * k); } });
    }
    add(gap(14 * k));
    const lines = (d.highlights || []).filter((h) => /camera|\bMP\b|zoom|OIS|video|selfie|lens/i.test(h)).slice(0, 3);
    (lines.length ? lines : [d.posterSpecs.camera]).filter(Boolean).forEach((l) => { add(textBlock(ctx, l, { size: 34 * k, weight: 500, maxW: bw, maxLines: 2, lh: 1.2 })); add(gap(10 * k)); });
    add(gap(8 * k)); sp(['processor', 'battery', 'display'], 2, 0.92); add(gap(18 * k)); lowPrice();
  } else if (spec.template === 'gaming') {
    brandLine(); add(gap(10 * k)); title(2, 116); add(gap(16 * k)); tagline(); add(gap(22 * k));
    if (o.showSpecs) {
      const hero = d.posterSpecs.processor;
      if (hero) { add(textBlock(ctx, 'PERFORMANCE', { size: 21 * k, weight: 700, color: PC.cyan, maxW: bw, spacing: 4 * k })); add(textBlock(ctx, hero, { size: 54 * k, weight: 800, maxW: bw, maxLines: 2, lh: 1.08, minSize: 32 * k })); add(gap(22 * k)); }
      sp(['display', 'battery', 'memory'], land ? 2 : 3, 0.95);
    }
    add(gap(20 * k)); lowPrice();
  } else if (spec.template === 'offer') {
    brandLine(); add(gap(8 * k)); title(2, 92); add(gap(22 * k));
    if (priceVisible) {
      if (variantLabel(variant)) { add(textBlock(ctx, variantLabel(variant), { size: 32 * k, weight: 600, color: PC.muted, maxW: bw, spacing: 2 * k })); add(gap(14 * k)); }
      add({ h: 128 * k, draw(x, y) { setFont(ctx, 118 * k, 800); ctx.fillStyle = PC.text; ctx.textBaseline = 'top'; ctx.fillText(inr(variant.sellingPrice), x, y); } });
      if (variant.officialPrice && variant.officialPrice > variant.sellingPrice) {
        add({ h: 44 * k, draw(x, y) { setFont(ctx, 34 * k, 500); ctx.fillStyle = PC.muted; ctx.textBaseline = 'top'; const s = 'Official price ' + inr(variant.officialPrice); ctx.fillText(s, x, y + 4 * k); const w = ctx.measureText(s).width; ctx.fillRect(x, y + 24 * k, w, 2 * k); } });
      }
      add(gap(18 * k));
    } else {
      add(textBlock(ctx, "Ask our team for today's price", { size: 46 * k, weight: 600, color: PC.silver, maxW: bw, maxLines: 2 })); add(gap(18 * k));
    }
    offers(3); add(gap(18 * k)); sp(['camera', 'battery'], 2, 0.9);
  } else { // launch
    add(pill(ctx, 'NEW LAUNCH', k, accentColor())); add(gap(18 * k)); brandLine(); add(gap(8 * k)); title(2, 130); add(gap(12 * k));
    const info = d.launchInfo || t.tagline || `Now at ${storeName()}`;
    add(textBlock(ctx, info, { size: 40 * k, color: PC.muted, maxW: bw, maxLines: 2, lh: 1.2 })); add(gap(24 * k));
    sp(['display', 'camera', 'processor', 'battery'], 2, 0.95); add(gap(18 * k)); lowPrice();
  }
  return blocks;
}

// ---- background, phone, logo -------------------------------------------------------------------------------
function paintBackground(ctx, tpl, W, H, art) {
  const g = ctx.createLinearGradient(0, 0, W * 0.4, H);
  g.addColorStop(0, tpl === 'gaming' ? '#06080f' : PC.bg0); g.addColorStop(1, tpl === 'gaming' ? '#121428' : PC.bg1);
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  const cx = art.x + art.w / 2, cy = art.y + art.h * 0.52, r = Math.max(art.w, art.h) * 0.62;
  const glow = (color, a, rr = r, x = cx, y = cy) => { const rg = ctx.createRadialGradient(x, y, 0, x, y, rr); rg.addColorStop(0, color.replace('A', a)); rg.addColorStop(1, color.replace('A', 0)); ctx.fillStyle = rg; ctx.fillRect(0, 0, W, H); };
  if (tpl === 'flagship') glow('rgba(214,218,228,A)', 0.22);
  else if (tpl === 'camera') {
    glow('rgba(214,218,228,A)', 0.16);
    ctx.strokeStyle = 'rgba(207,211,220,0.16)';
    [0.30, 0.43, 0.58].forEach((f, i) => { ctx.lineWidth = (3 - i) * (W / 1080) * 1.4; ctx.beginPath(); ctx.arc(cx, cy, Math.min(art.w, art.h) * f, 0, Math.PI * 2); ctx.stroke(); });
  } else if (tpl === 'gaming') {
    glow('rgba(25,230,255,A)', 0.20, r * 0.9, cx - art.w * 0.12, cy); glow('rgba(138,92,255,A)', 0.22, r * 0.9, cx + art.w * 0.14, cy + art.h * 0.1);
    ctx.save(); ctx.strokeStyle = PC.cyan; ctx.lineWidth = 3 * (W / 1080); ctx.globalAlpha = 0.9;
    ctx.beginPath(); ctx.moveTo(0, H * 0.965); ctx.lineTo(W * 0.62, H * 0.965); ctx.stroke();
    ctx.strokeStyle = PC.violet; ctx.beginPath(); ctx.moveTo(W * 0.62, H * 0.965); ctx.lineTo(W, H * 0.965); ctx.stroke(); ctx.restore();
  } else if (tpl === 'offer' || tpl === 'launch') glow(`rgba(${hexRgb(accentColor())},A)`, 0.20);
  else glow('rgba(214,218,228,A)', 0.12);
  // fine metallic frame line
  ctx.strokeStyle = 'rgba(207,211,220,0.14)'; ctx.lineWidth = 2 * (W / 1080);
  const m = W * 0.02; ctx.strokeRect(m, m, W - 2 * m, H - 2 * m);
}

async function drawPhone(ctx, spec, art) {
  const file = spec.image.file || spec.data?.images?.[0]?.file;
  if (!file) return;
  const { canvas, box } = await cutout(file);
  const zoom = (spec.image.zoom || 100) / 100;
  const fit = Math.min(art.w / box.w, art.h / box.h) * 0.94 * zoom;
  const dw = box.w * fit, dh = box.h * fit;
  const dx = art.x + (art.w - dw) / 2 + (spec.image.offsetX / 100) * art.w;
  const dy = art.y + (art.h - dh) / 2 + (spec.image.offsetY / 100) * art.h;
  ctx.save();
  ctx.beginPath(); ctx.rect(art.x - 10, art.y - 10, art.w + 20, art.h + 20); ctx.clip();
  // floor shadow
  const sh = ctx.createRadialGradient(dx + dw / 2, dy + dh * 0.98, 0, dx + dw / 2, dy + dh * 0.98, dw * 0.5);
  sh.addColorStop(0, 'rgba(0,0,0,0.55)'); sh.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.save(); ctx.translate(0, 0); ctx.fillStyle = sh; ctx.beginPath(); ctx.ellipse(dx + dw / 2, dy + dh * 0.98, dw * 0.5, dh * 0.035, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore();
  ctx.imageSmoothingQuality = 'high';
  ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowBlur = 40 * (ctx.canvas.width / 1920); ctx.shadowOffsetY = 14 * (ctx.canvas.width / 1920);
  ctx.drawImage(canvas, box.x, box.y, box.w, box.h, dx, dy, dw, dh);
  ctx.restore();
}

/** The store's logo image, or null when it has none (then the store name is drawn as text). */
async function logoImg() {
  const url = typeof ORG !== 'undefined' ? ORG?.logoUrl : '';
  if (!url) return null;
  try { return await loadImg(url); } catch { return null; }
}

/** Draws the logo (or the store name as text) with its left edge at x and height h. Returns the width used. */
function drawMark(ctx, logo, x, y, h, measureOnly = false) {
  if (logo) {
    const w = h * (logo.naturalWidth / logo.naturalHeight);
    if (!measureOnly) { ctx.save(); ctx.globalCompositeOperation = 'lighten'; ctx.drawImage(logo, x, y, w, h); ctx.restore(); } // a black logo background blends away
    return w;
  }
  const size = h * 0.62;
  setFont(ctx, size, 800);
  const w = ctx.measureText(storeName()).width;
  if (!measureOnly) { ctx.fillStyle = PC.text; ctx.textBaseline = 'middle'; ctx.fillText(storeName(), x, y + h / 2); ctx.fillStyle = accentColor(); ctx.fillRect(x, y + h * 0.88, Math.min(w, h * 1.2), Math.max(3, h * 0.05)); ctx.textBaseline = 'top'; }
  return w;
}

// ---- main ------------------------------------------------------------------------------------------------------
// Renders share one drawing context variable, so they run one at a time.
let _rq = Promise.resolve();
function renderPoster(canvas, spec, scale = 1) {
  const run = () => drawPoster(canvas, spec, scale);
  const p = _rq.then(run, run);
  _rq = p.catch(() => {});
  return p;
}

async function drawPoster(canvas, spec, scale = 1) {
  const S = POSTER_SIZES[spec.size];
  canvas.width = Math.round(S.w * scale); canvas.height = Math.round(S.h * scale);
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  _c2 = ctx;
  const W = S.w, H = S.h, land = W > H;
  const k = land ? W / 1920 : W / 1080; // unit: everything is designed on 1920 (landscape) or 1080 (vertical)
  const art = land ? { x: W * 0.50, y: H * 0.07, w: W * 0.46, h: H * 0.86 }
    : { x: W * 0.07, y: H * (spec.size === 'square' ? 0.04 : 0.045), w: W * 0.86, h: H * (spec.size === 'square' ? 0.46 : 0.45) };
  const logo = await logoImg();
  const footH = (land ? 0.17 : 0.1) * H;
  const copy = land ? { x: W * 0.06, y: H * 0.08, w: W * 0.40, h: H - H * 0.08 - footH }
    : { x: W * 0.07, y: art.y + art.h + H * 0.01, w: W * 0.86, h: H - (art.y + art.h + H * 0.01) - footH };

  paintBackground(ctx, spec.template, W, H, art);
  if (spec.template !== 'brand') await drawPhone(ctx, spec, art);
  else { // store brand slide: the logo is the hero
    let bh = Math.min(art.h * 0.55, logo ? (art.w * 0.8) / (logo.naturalWidth / logo.naturalHeight) : art.h * 0.4);
    let bw2 = drawMark(ctx, logo, 0, 0, bh, true);
    if (!logo && bw2 > art.w * 0.9) { bh *= (art.w * 0.9) / bw2; bw2 = drawMark(ctx, logo, 0, 0, bh, true); } // a long store name is scaled to fit
    drawMark(ctx, logo, art.x + (art.w - bw2) / 2, art.y + (art.h - bh) / 2, bh);
  }

  // text blocks: shrink everything a little at a time until the stack fits its box
  // Text grows (up to 1.3x) to use the space, or shrinks until the stack fits, so it stays readable from a distance.
  let blocks, total, s = 1.3;
  for (; s >= 0.55; s -= 0.05) {
    blocks = buildBlocks(ctx, spec, copy.w, land, k * s);
    total = blocks.reduce((a, b) => a + b.h, 0);
    if (total <= copy.h) break;
  }
  let y = land ? copy.y + Math.max(0, (copy.h - total) / 2) : copy.y;
  for (const b of blocks) { b.draw(copy.x, y, copy.w); y += b.h; }

  // footer: logo (black background blended away) and optional text
  const lh = footH * 0.62, lw = drawMark(ctx, logo, 0, 0, lh, true);
  const fy = H - footH * 0.5 - lh / 2 - (land ? H * 0.02 : H * 0.012);
  const lx = land ? copy.x : W * 0.07;
  drawMark(ctx, logo, lx, fy, lh);
  if (spec.texts.footer) {
    setFont(ctx, 30 * k, 500); ctx.fillStyle = PC.muted; ctx.textBaseline = 'middle'; ctx.textAlign = land ? 'left' : 'right';
    ctx.fillText(spec.texts.footer, land ? lx + lw + 30 * k : W * 0.93, fy + lh / 2);
    ctx.textAlign = 'left';
  }
}

// ---- export ------------------------------------------------------------------------------------------------------------
const canvasBlob = (c, type, q) => new Promise((ok) => c.toBlob(ok, type, q));

async function posterBlob(spec, type = 'image/png') {
  const c = document.createElement('canvas');
  await renderPoster(c, spec, 1);
  return canvasBlob(c, type, 0.92);
}

/** A one-page PDF holding the poster as a JPEG. No library needed. */
async function buildPdf(spec) {
  const S = POSTER_SIZES[spec.size];
  const jpeg = new Uint8Array(await (await posterBlob(spec, 'image/jpeg')).arrayBuffer());
  const [wPt, hPt] = S.pt || [S.w * 0.75, S.h * 0.75];
  const enc = new TextEncoder();
  const parts = [], offsets = [];
  let len = 0;
  const push = (x) => { const b = typeof x === 'string' ? enc.encode(x) : x; parts.push(b); len += b.length; };
  const obj = (n, body) => { offsets[n] = len; push(`${n} 0 obj\n`); push(body); push('\nendobj\n'); };
  push('%PDF-1.4\n');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${wPt.toFixed(2)} ${hPt.toFixed(2)}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`);
  offsets[4] = len;
  push(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${S.w} /Height ${S.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`);
  push(jpeg); push('\nendstream\nendobj\n');
  const content = `q ${wPt.toFixed(2)} 0 0 ${hPt.toFixed(2)} 0 0 cm /Im0 Do Q`;
  obj(5, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  const xref = len;
  push(`xref\n0 6\n0000000000 65535 f \n${[1, 2, 3, 4, 5].map((n) => String(offsets[n]).padStart(10, '0') + ' 00000 n \n').join('')}`);
  push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(len);
  let p = 0;
  for (const b of parts) { out.set(b, p); p += b.length; }
  return new Blob([out], { type: 'application/pdf' });
}
