// Products tab: the smartphone catalog. Uses the helpers from index.html (api, $, esc, render, load).
let products = [], prodMeta = null, prodFilter = { q: '', brand: '', status: '' }, prodEditing = null, prodDraft = null, importJob = null, importTimer = null;

const rupees = (n) => (n ? '₹' + Number(n).toLocaleString('en-IN') : '—');
const prodImg = (p) => (p.images[0] ? `/media/${p.images[0].file}` : '');
const varOf = (p) => p.variants.filter((v) => v.sellingPrice).sort((a, b) => a.sellingPrice - b.sellingPrice);

async function loadProducts() {
  if (!prodMeta) prodMeta = await api('/catalog/meta');
  const qs = new URLSearchParams(Object.entries(prodFilter).filter(([, v]) => v)).toString();
  products = await api('/products' + (qs ? '?' + qs : ''));
  importJob = await api('/catalog/import');
  if (importJob.running) pollImport();
  if (prodEditing && !products.some((p) => p.id === prodEditing)) prodEditing = prodDraft = null;
}

function pollImport() {
  clearInterval(importTimer);
  importTimer = setInterval(async () => {
    importJob = await api('/catalog/import');
    if (!importJob.running) { clearInterval(importTimer); products = await api('/products'); }
    if (tab === 'products' && !prodEditing) render();
  }, 1500);
}

const statusBadge = (p) => p.status === 'verified'
  ? `<span class="badge ${p.fresh ? 'ok' : 'warn'}">${p.fresh ? 'Verified' : 'Outdated'} ${p.lastVerified}</span>`
  : '<span class="badge">Draft</span>';

function renderProducts() {
  if (prodEditing && prodDraft) return renderProductEdit();
  const j = importJob;
  const imp = j?.running
    ? `<div class="muted">Importing… read ${j.read || 0} of ${j.total || '?'} pages · ${j.imported} new · ${j.updated} changed · ${j.images} images</div>`
    : j?.finishedAt ? `<small>Last import: ${j.imported} new, ${j.updated} changed, ${j.unchanged} unchanged, ${j.images} images${j.errors.length ? `, <span style="color:var(--bad)">${j.errors.length} problem(s)</span>` : ''}.</small>` : '';
  return `<div class="card"><div class="row"><h2 class="grow" style="margin:0">Smartphone catalog</h2>
      ${prodMeta.importSource ? `<button onclick="importStore()" ${j?.running ? 'disabled' : ''}>Import from store website</button>` : ''}
      <button class="primary" onclick="newProduct()">+ New product</button></div>
    <small>Imported products start as <b>Draft</b>. Prices and offers appear on posters only after staff verify the product. ${prodMeta.importSource ? 'Source: ' + esc(prodMeta.importSource) : 'No store website is set up for importing. Add products by hand, or ask the platform administrator to set the import address.'}</small>
    <div style="margin-top:6px">${imp}</div>${j?.errors?.length && !j.running ? `<details><summary><small>Show problems</small></summary><small>${j.errors.map(esc).join('<br>')}</small></details>` : ''}</div>
    <div class="card row"><input id="pq" placeholder="Search brand or model" value="${esc(prodFilter.q)}" class="grow" onchange="prodFilter.q=this.value;load()">
      <select onchange="prodFilter.brand=this.value;load()"><option value="">All brands</option>${prodMeta.brands.map((b) => `<option ${prodFilter.brand === b ? 'selected' : ''}>${esc(b)}</option>`).join('')}</select>
      <select onchange="prodFilter.status=this.value;load()"><option value="">All statuses</option><option value="draft" ${prodFilter.status === 'draft' ? 'selected' : ''}>Draft</option><option value="verified" ${prodFilter.status === 'verified' ? 'selected' : ''}>Verified</option></select>
      <small>${products.length} product${products.length === 1 ? '' : 's'}</small>
      ${products.some((p) => p.status !== 'verified') ? '<button onclick="verifyAllShown()">Verify all shown</button>' : ''}</div>
    <div class="grid pgrid">${products.map((p) => {
      const v = varOf(p)[0];
      const errs = p.warnings.filter((w) => w.level !== 'info').length;
      return `<div class="thumb pcard" onclick="editProduct('${p.id}')"><div class="pic">${prodImg(p) ? `<img src="${prodImg(p)}" loading="lazy" style="object-fit:contain;background:#fff">` : 'No image'}</div>
        <div class="meta"><b>${esc(p.brand)} ${esc(p.model)}</b>${p.condition === 'demo' ? ' <span class="badge">Demo</span>' : ''}<br>
        <span>${v ? 'from ' + rupees(v.sellingPrice) : 'No selling price'}</span><br>${statusBadge(p)}${errs ? ` <span class="badge warn">${errs} to check</span>` : ''}</div></div>`;
    }).join('') || '<p class="muted">No products yet. Import them from the store website or add one.</p>'}</div>`;
}

async function importStore() {
  if (!confirm('Read all smartphones from the store website and save them as drafts?\nExisting products are updated only if the store changed them.')) return;
  await api('/catalog/import', { method: 'POST', body: {} });
  importJob = { running: true, read: 0, total: 0, imported: 0, updated: 0, images: 0, errors: [] };
  pollImport();
  render();
}

async function verifyAllShown() {
  const drafts = products.filter((p) => p.status !== 'verified');
  if (!confirm(`Mark ${drafts.length} product(s) as verified today?\nOnly do this after you checked their prices and specifications.`)) return;
  for (const p of drafts) await api(`/products/${p.id}/verify`, { method: 'POST', body: { verified: true } });
  load();
}

function newProduct() {
  prodEditing = 'new';
  prodDraft = { brand: prodMeta.brands[0], model: '', category: 'smartphone', condition: 'new', colours: [], variants: [{ ram: '', storage: '', officialPrice: null, sellingPrice: null }], highlights: [], specs: [], posterSpecs: { display: '', processor: '', camera: '', battery: '', memory: '', extra: '' }, images: [], offers: [], stock: 'unknown', stockNote: '', sourceUrl: '', warnings: [], status: 'draft' };
  render();
}
function editProduct(id) { prodEditing = id; prodDraft = JSON.parse(JSON.stringify(products.find((p) => p.id === id))); render(); }
const pd = (k, v) => { prodDraft[k] = v; };
const pdv = (i, k, v) => { prodDraft.variants[i][k] = (k === 'officialPrice' || k === 'sellingPrice') ? (v === '' ? null : Number(v)) : v; };
const pdo = (i, k, v) => { prodDraft.offers[i][k] = v; };
const pds = (k, v) => { prodDraft.posterSpecs[k] = v; };
const specsToText = (specs) => specs.flatMap((g) => g.items.map((i) => `${g.group} | ${i.label} | ${i.value}`)).join('\n');
function textToSpecs(t) {
  const groups = [];
  for (const line of t.split('\n')) {
    const [group, label, ...rest] = line.split('|').map((x) => x.trim());
    if (!group || !label) continue;
    let g = groups.find((x) => x.group === group);
    if (!g) groups.push((g = { group, items: [] }));
    g.items.push({ label, value: rest.join(' | ') });
  }
  return groups;
}

function renderProductEdit() {
  const p = prodDraft, isNew = prodEditing === 'new';
  const ws = p.warnings || [];
  const wcls = { error: 'var(--bad)', warn: '#f5b84c', info: 'var(--muted)' };
  return `<div class="card"><div class="row"><button onclick="prodEditing=prodDraft=null;load()">← Back</button><h2 class="grow" style="margin:0">${isNew ? 'New product' : esc(p.brand + ' ' + p.model)}</h2>
      ${!isNew ? statusBadge(p) : ''}<button class="primary" onclick="saveProduct()">Save</button>
      ${!isNew ? (p.status === 'verified' ? '<button onclick="verifyProduct(false)">Unverify</button>' : '<button onclick="verifyProduct(true)">Mark as verified today</button>') : ''}
      ${!isNew ? '<button class="danger" onclick="deleteProduct()">Delete</button>' : ''}</div>
    ${ws.length ? `<ul class="warns">${ws.map((w) => `<li style="color:${wcls[w.level]}">${esc(w.message)}</li>`).join('')}</ul>` : ''}</div>

    <div class="card"><h2>Product</h2><div class="row">
      <select onchange="pd('brand',this.value)">${[...prodMeta.brands, ...(prodMeta.brands.includes(p.brand) ? [] : [p.brand])].map((b) => `<option ${b === p.brand ? 'selected' : ''}>${esc(b)}</option>`).join('')}</select>
      <input class="grow" placeholder="Model" value="${esc(p.model)}" oninput="pd('model',this.value)">
      <select onchange="pd('condition',this.value)"><option value="new" ${p.condition === 'new' ? 'selected' : ''}>New</option><option value="demo" ${p.condition === 'demo' ? 'selected' : ''}>Demo unit</option></select></div>
      <div class="row" style="margin-top:8px"><input class="grow" placeholder="Launch information for the New launch poster, e.g. Launched in India on 5 March 2026 (verify before use)" value="${esc(p.launchInfo || '')}" oninput="pd('launchInfo',this.value)"></div>
      <div class="row" style="margin-top:8px"><input class="grow" placeholder="Source URL (official page or store listing)" value="${esc(p.sourceUrl)}" oninput="pd('sourceUrl',this.value)">
      <small>${p.sourceCheckedOn ? 'Source read on ' + p.sourceCheckedOn : ''}</small></div></div>

    <div class="card"><div class="row"><h2 class="grow" style="margin:0">Variants and prices</h2><button onclick="prodDraft.variants.push({ram:'',storage:'',officialPrice:null,sellingPrice:null});render()">+ Variant</button></div>
      <small>Official price = brand MRP / launch price. Selling price = your store's price. Offers are separate and never change these.</small>
      ${p.variants.map((v, i) => `<div class="row" style="margin-top:8px"><input style="width:90px" placeholder="RAM" value="${esc(v.ram)}" oninput="pdv(${i},'ram',this.value)">
        <input style="width:100px" placeholder="Storage" value="${esc(v.storage)}" oninput="pdv(${i},'storage',this.value)">
        <input style="width:120px" placeholder="Colour" value="${esc(v.colour || '')}" oninput="pdv(${i},'colour',this.value)">
        <label>Official ₹ <input type="number" style="width:110px" value="${v.officialPrice ?? ''}" oninput="pdv(${i},'officialPrice',this.value)"></label>
        <label>Selling ₹ <input type="number" style="width:110px" value="${v.sellingPrice ?? ''}" oninput="pdv(${i},'sellingPrice',this.value)"></label>
        <button class="danger" onclick="prodDraft.variants.splice(${i},1);render()">✕</button></div>`).join('')}</div>

    <div class="card"><h2>Poster spec highlights</h2><small>Short lines shown on posters. Taken from the product data; edit them if needed.</small>
      ${[['display', 'Display'], ['processor', 'Processor'], ['camera', 'Camera'], ['battery', 'Battery'], ['memory', 'Memory'], ['extra', 'Extra']].map(([k, l]) => `<div class="row" style="margin-top:6px"><span style="width:80px">${l}</span><input class="grow" value="${esc(p.posterSpecs[k])}" oninput="pds('${k}',this.value)"></div>`).join('')}</div>

    <div class="card"><h2>Offers</h2><small>An offer appears on a poster only when approved, not expired, and the product is verified. Bank and exchange offers need conditions.</small>
      ${p.offers.map((o, i) => `<div class="card" style="margin:8px 0 0"><div class="row">
        <select onchange="pdo(${i},'type',this.value)">${prodMeta.offerTypes.map((t) => `<option ${t === o.type ? 'selected' : ''}>${t}</option>`).join('')}</select>
        <input class="grow" placeholder="Offer title" value="${esc(o.title)}" oninput="pdo(${i},'title',this.value)">
        <label>Value ₹ <input type="number" style="width:90px" value="${o.amount ?? ''}" oninput="pdo(${i},'amount',this.value)"></label>
        <label>Expires <input type="date" value="${o.expiresOn || ''}" onchange="pdo(${i},'expiresOn',this.value||null)"></label></div>
        <div class="row" style="margin-top:6px"><input class="grow" placeholder="Conditions (e.g. HDFC cards, up to ₹2,000)" value="${esc(o.conditions)}" oninput="pdo(${i},'conditions',this.value)">
        <label class="switch"><input type="checkbox" ${o.approved ? 'checked' : ''} onchange="pdo(${i},'approved',this.checked)"> Approved</label>
        <button class="danger" onclick="prodDraft.offers.splice(${i},1);render()">✕</button></div></div>`).join('')}
      <div style="margin-top:8px"><button onclick="prodDraft.offers.push({type:'discount',title:'',amount:null,conditions:'',expiresOn:null,approved:false});render()">+ Offer</button></div></div>

    <div class="card"><h2>Stock</h2><div class="row"><select onchange="pd('stock',this.value)">${prodMeta.stock.map((s) => `<option value="${s}" ${s === p.stock ? 'selected' : ''}>${s.replace('_', ' ')}</option>`).join('')}</select>
      <input class="grow" placeholder="Stock note (optional)" value="${esc(p.stockNote || '')}" oninput="pd('stockNote',this.value)"><small>Shown on posters only for verified products.</small></div></div>

    <div class="card"><h2>Highlights and specifications</h2>
      <small>Highlights: one per line.</small><textarea rows="5" style="width:100%" oninput="pd('highlights',this.value.split('\\n').map(s=>s.trim()).filter(Boolean))">${esc(p.highlights.join('\n'))}</textarea>
      <small>Specifications: one per line as <code>Group | Label | Value</code>.</small><textarea rows="8" style="width:100%" oninput="pd('specs',textToSpecs(this.value))">${esc(specsToText(p.specs))}</textarea></div>

    ${isNew ? '<div class="card muted">Save the product first, then add images.</div>' : `<div class="card"><div class="row"><h2 class="grow" style="margin:0">Images (${p.images.length})</h2>
      <input type="file" id="pimg" accept="image/png,image/jpeg,image/webp" multiple><button onclick="uploadProductImages()">Upload</button></div>
      <small>The first image is the main poster image. Use approved product images that show the real phone.</small>
      <div class="grid" style="margin-top:8px">${p.images.map((im, i) => `<div class="thumb"><div class="pic" style="height:120px"><img src="/media/${im.file}" loading="lazy" style="object-fit:contain;background:#fff"></div>
        <div class="meta">${esc([im.color, im.view].filter(Boolean).join(' · ') || 'image')}<br>
        ${i ? `<button onclick="mainImage('${im.file}')">Make main</button>` : '<span class="badge ok">Main</span>'} <button class="danger" onclick="removeImage('${im.file}')">Delete</button></div></div>`).join('')}</div></div>`}`;
}

async function saveProduct() {
  const body = { ...prodDraft };
  delete body.warnings; delete body.fresh;
  try {
    const saved = prodEditing === 'new' ? await api('/products', { method: 'POST', body }) : await api('/products/' + prodEditing, { method: 'PUT', body });
    prodEditing = saved.id; prodDraft = JSON.parse(JSON.stringify(saved));
    products = await api('/products');
    render();
  } catch { /* api() already showed the message */ }
}
async function verifyProduct(on) {
  await saveProduct();
  const p = await api(`/products/${prodEditing}/verify`, { method: 'POST', body: { verified: on } });
  prodDraft = JSON.parse(JSON.stringify(p)); products = await api('/products'); render();
}
async function deleteProduct() {
  if (!confirm('Delete this product and its images?')) return;
  await api('/products/' + prodEditing, { method: 'DELETE' });
  prodEditing = prodDraft = null; load();
}
async function refreshEdited(p) { prodDraft = JSON.parse(JSON.stringify(p)); products = await api('/products'); render(); }
async function uploadProductImages() {
  const f = $('#pimg').files; if (!f.length) return;
  const fd = new FormData(); for (const x of f) fd.append('files', x);
  refreshEdited(await api(`/products/${prodEditing}/images`, { method: 'POST', body: fd }));
}
async function removeImage(file) { if (confirm('Delete this image?')) refreshEdited(await api(`/products/${prodEditing}/images/${file}`, { method: 'DELETE' })); }
async function mainImage(file) {
  const order = [file, ...prodDraft.images.map((i) => i.file).filter((x) => x !== file)];
  refreshEdited(await api('/products/' + prodEditing, { method: 'PUT', body: { images: order } }));
}
