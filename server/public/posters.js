// Posters tab: create a poster from a product, preview, approve, export, publish to the media library and a playlist.
// Uses helpers from index.html (api, $, esc, render, load, tab) and products.js (products), and poster-render.js (renderPoster...).
let posters = [], posterMeta = null, posterEdit = null, posterInfo = null, posterBusy = '', posterMsg = '', posterSel = new Set();
let slide = { template: 'flagship', size: 'landscape', category: 'Latest smartphones', brand: '', newOnly: true };
const dataCache = new Map(); // productId -> poster-data (cleared on every load)

const posterSlug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const prodById = (id) => products.find((p) => p.id === id);

async function loadPosters() {
  if (!posterMeta) posterMeta = await api('/posters/meta');
  [posters, products] = await Promise.all([api('/posters'), api('/products')]);
  dataCache.clear();
}

async function dataFor(productId) {
  if (!productId) return null;
  if (!dataCache.has(productId)) dataCache.set(productId, await api(`/products/${productId}/poster-data`));
  return dataCache.get(productId);
}

const posterStatus = (po) => po.retired ? '<span class="badge warn">Removed from playlists – content changed</span>' : po.needsReview ? '<span class="badge warn">Needs review</span>'
  : po.status === 'approved' ? `<span class="badge ok">Approved${po.mediaId ? ' · in library' : ''}</span>` : '<span class="badge">Draft</span>';

function specOf(po, data) {
  return { template: po.template, size: po.size, data, texts: po.texts, image: po.image, options: po.options };
}

// ---- list view ------------------------------------------------------------------------------------------------
function renderPosters() {
  if (posterEdit) return renderPosterEditor();
  const eligible = slideshowCandidates();
  const sel = [...posterSel].filter((id) => posters.some((p) => p.id === id));
  return `<div class="card"><div class="row"><h2 class="grow" style="margin:0">Posters</h2><button class="primary" onclick="newPoster()">+ New poster</button></div>
    <small>Pick a phone, choose a template, preview, approve, then add it to the media library and a playlist. Approved posters play on the TVs like any other image.</small></div>

    <div class="card"><h2>Create a slideshow from products</h2>
      <div class="row"><select onchange="slide.brand=this.value;render()"><option value="">All brands</option>${prodBrands().map((b) => `<option ${slide.brand === b ? 'selected' : ''}>${esc(b)}</option>`).join('')}</select>
      <select onchange="slide.template=this.value">${posterMeta.templates.filter((t) => t !== 'brand').map((t) => `<option value="${t}" ${slide.template === t ? 'selected' : ''}>${POSTER_TEMPLATES[t]}</option>`).join('')}</select>
      <select onchange="slide.size=this.value">${posterMeta.sizes.map((s) => `<option value="${s}" ${slide.size === s ? 'selected' : ''}>${POSTER_SIZES[s].label}</option>`).join('')}</select>
      <select onchange="slide.category=this.value">${posterMeta.categories.map((c) => `<option ${slide.category === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
      <label class="switch"><input type="checkbox" ${slide.newOnly ? 'checked' : ''} onchange="slide.newOnly=this.checked;render()"> New phones only (skip demo units)</label></div>
      <div class="row" style="margin-top:8px"><button class="primary" onclick="createSlideshow()" ${posterBusy || !eligible.length ? 'disabled' : ''}>Create ${eligible.length} poster${eligible.length === 1 ? '' : 's'} (drafts)</button>
      <small>Phones that already have a poster with this template and size are skipped. Specs come from each product; prices show only for verified products.</small></div></div>

    ${posterBusy || posterMsg ? `<div class="card">${posterBusy ? `<b>${esc(posterBusy)}</b>` : ''}${posterMsg ? `<div>${posterMsg}</div>` : ''}</div>` : ''}

    <div class="card row"><select onchange="posterFilter=this.value;render()"><option value="">All categories</option>${posterMeta.categories.map((c) => `<option ${posterFilter === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
      <small class="grow">${posters.length} poster${posters.length === 1 ? '' : 's'} · ${sel.length} selected</small>
      <button onclick="selectAllPosters()">Select all shown</button>
      <button onclick="approveSelected()" ${posterBusy || !sel.length ? 'disabled' : ''}>Approve selected</button>
      <button onclick="publishSelected()" ${posterBusy || !sel.length ? 'disabled' : ''}>Add selected to media library</button>
      <button class="primary" onclick="buildCategoryPlaylist()" ${posterBusy ? 'disabled' : ''}>Build playlist for category…</button></div>
    <div class="grid pgrid2">${shownPosters().map((po) => `<div class="thumb"><div class="pic" style="height:auto;aspect-ratio:${POSTER_SIZES[po.size].w}/${POSTER_SIZES[po.size].h}"><canvas class="pthumb" data-id="${po.id}" style="width:100%;height:100%"></canvas></div>
      <div class="meta"><label><input type="checkbox" ${posterSel.has(po.id) ? 'checked' : ''} onchange="togglePosterSel('${po.id}',this.checked)"> <b>${esc(po.productName || 'Store brand')}</b></label><br>
      <small>${POSTER_TEMPLATES[po.template]} · ${po.size}${po.category ? ' · ' + esc(po.category) : ''}</small><br>${posterStatus(po)}
      <div class="row" style="margin-top:6px"><button onclick="editPoster('${po.id}')">Open</button><button class="danger" onclick="deletePoster('${po.id}')">Delete</button></div></div></div>`).join('') || '<p class="muted">No posters yet.</p>'}</div>`;
}
let posterFilter = '';
const shownPosters = () => posters.filter((p) => !posterFilter || p.category === posterFilter);
const prodBrands = () => [...new Set(products.map((p) => p.brand))].sort();
function slideshowCandidates() {
  return products.filter((p) => p.images.length && (!slide.brand || p.brand === slide.brand) && (!slide.newOnly || p.condition === 'new'))
    .filter((p) => !posters.some((po) => po.productId === p.id && po.template === slide.template && po.size === slide.size));
}
function togglePosterSel(id, on) { on ? posterSel.add(id) : posterSel.delete(id); render(); }
function selectAllPosters() { shownPosters().forEach((p) => posterSel.add(p.id)); render(); }

async function posterAfterRender() {
  if (posterEdit) return drawPreview();
  for (const c of document.querySelectorAll('canvas.pthumb')) {
    const po = posters.find((p) => p.id === c.dataset.id);
    if (!po || !c.isConnected) continue;
    try { await renderPoster(c, specOf(po, await dataFor(po.productId)), 360 / POSTER_SIZES[po.size].w); } catch { /* an image may be missing */ }
  }
}
function afterRender() { if (tab === 'posters') posterAfterRender(); }

function bestImage(p) { return (p.images.find((i) => i.view === 'front-back') || p.images[0])?.file || ''; }

async function createSlideshow() {
  const list = slideshowCandidates();
  posterBusy = `Creating ${list.length} posters…`; posterMsg = ''; render();
  let made = 0;
  for (const p of list) {
    try {
      await api('/posters', { method: 'POST', body: { productId: p.id, template: slide.template, size: slide.size, category: slide.category, image: { file: bestImage(p), zoom: 100, offsetX: 0, offsetY: 0 } } });
      made++;
    } catch { /* skip this product */ }
  }
  posterBusy = ''; posterMsg = `Created ${made} draft poster${made === 1 ? '' : 's'}. Check them, then approve.`;
  await loadPosters(); render();
}

async function approveSelected() {
  const ids = [...posterSel].filter((id) => posters.some((p) => p.id === id));
  if (!confirm(`Approve ${ids.length} poster(s)?\nApprove only after you checked each preview, its text and any prices or offers shown.`)) return;
  posterBusy = 'Approving…'; render();
  let ok = 0, failed = [];
  for (const id of ids) { try { await api(`/posters/${id}/approve`, { method: 'POST' }); ok++; } catch { failed.push(id); } }
  posterBusy = ''; posterMsg = `Approved ${ok}.${failed.length ? ` ${failed.length} could not be approved (for example, no product image).` : ''}`;
  await loadPosters(); render();
}

async function uploadToLibrary(po) {
  const data = await dataFor(po.productId);
  // JPEG keeps each slide near 200 KB (a PNG is about 1.5 MB), so TVs sync faster and store more.
  const blob = await posterBlob(specOf(po, data), 'image/jpeg');
  const fd = new FormData();
  fd.append('file', blob, `${posterSlug(po.productName || 'myt-mobiles')}-${po.template}-${po.size}.jpg`);
  return api(`/posters/${po.id}/library`, { method: 'POST', body: fd });
}

async function publishSelected() {
  const todo = [...posterSel].map((id) => posters.find((p) => p.id === id)).filter(Boolean);
  const ready = todo.filter((p) => p.status === 'approved' && !p.needsReview);
  if (!ready.length) { posterMsg = 'None of the selected posters are approved. Approve them first.'; return render(); }
  let n = 0;
  for (const po of ready) {
    posterBusy = `Rendering and adding ${++n} of ${ready.length} to the media library…`; render();
    try { await uploadToLibrary(po); } catch { /* the message from api() was shown */ }
  }
  posterBusy = ''; posterMsg = `Added ${ready.length} poster${ready.length === 1 ? '' : 's'} to the <b>Media</b> library${todo.length > ready.length ? `. ${todo.length - ready.length} were skipped because they are not approved.` : '.'} Next: build a playlist.`;
  await loadPosters(); render();
}

async function buildCategoryPlaylist() {
  const cat = prompt('Category for the playlist:\n' + posterMeta.categories.map((c, i) => `${i + 1}. ${c}`).join('\n') + '\n\nType the number.', '1');
  const category = posterMeta.categories[Number(cat) - 1];
  if (!category) return;
  const ready = posters.filter((p) => p.category === category && p.status === 'approved' && !p.needsReview && !p.retired && p.mediaId)
    .sort((a, b) => a.productName.localeCompare(b.productName));
  if (!ready.length) { posterMsg = `No approved posters in “${esc(category)}” are in the media library yet.`; return render(); }
  const name = `myT Mobiles – ${category}`;
  const lists = await api('/playlists');
  const pl = lists.find((l) => l.name === name) || await api('/playlists', { method: 'POST', body: { name } });
  await api(`/playlists/${pl.id}`, { method: 'PUT', body: { name, items: ready.map((p) => ({ mediaId: p.mediaId, duration: 10 })) } });
  posterMsg = `Playlist <b>${esc(name)}</b> now has ${ready.length} poster${ready.length === 1 ? '' : 's'} (10 seconds each). Next: open <b>Screens</b> and choose it as a screen's default content.`;
  render();
}

async function deletePoster(id) {
  if (!confirm('Delete this poster? Its media library item stays.')) return;
  await api('/posters/' + id, { method: 'DELETE' }); posterSel.delete(id); await loadPosters(); render();
}

// ---- editor ------------------------------------------------------------------------------------------------------
async function newPoster() {
  const p = products.find((x) => x.images.length) || products[0];
  posterEdit = { id: null, productId: p?.id || null, template: 'flagship', size: 'landscape', category: '', texts: { headline: '', tagline: '', footer: '' }, image: { file: p ? bestImage(p) : '', zoom: 100, offsetX: 0, offsetY: 0 }, options: { showSpecs: true, showPrice: true, showOffers: true, variantIndex: 0 }, status: 'draft', dirty: true };
  posterInfo = await dataFor(posterEdit.productId);
  render();
}
async function editPoster(id) {
  posterEdit = JSON.parse(JSON.stringify(posters.find((p) => p.id === id))); posterEdit.dirty = false;
  posterInfo = await dataFor(posterEdit.productId);
  render();
}

let previewTimer;
function peSet(path, v) {
  const parts = path.split('.'); let o = posterEdit;
  while (parts.length > 1) o = o[parts.shift()];
  o[parts[0]] = v; posterEdit.dirty = true;
  clearTimeout(previewTimer); previewTimer = setTimeout(drawPreview, 60);
}
async function peProduct(id) {
  const p = prodById(id);
  posterEdit.productId = id; posterEdit.image = { file: p ? bestImage(p) : '', zoom: 100, offsetX: 0, offsetY: 0 }; posterEdit.options.variantIndex = 0; posterEdit.dirty = true;
  dataCache.delete(id); posterInfo = await dataFor(id); render();
}
function peTemplate(t) { posterEdit.template = t; posterEdit.dirty = true; render(); }
function peImage(file) { posterEdit.image.file = file; posterEdit.dirty = true; render(); }

async function drawPreview() {
  const c = $('#ppv'); if (!c || !posterEdit) return;
  const data = posterEdit.template === 'brand' ? null : posterInfo;
  const note = $('#pnote');
  try { await renderPoster(c, specOf(posterEdit, data), 1); if (note) note.textContent = ''; }
  catch (e) { if (note) note.textContent = 'Could not draw the poster: ' + e.message; }
}

function renderPosterEditor() {
  const po = posterEdit, p = prodById(po.productId), d = posterInfo;
  const isBrand = po.template === 'brand';
  const approvedOk = po.status === 'approved' && !po.dirty && !po.needsReview;
  const variants = (d?.variants || []).map((v, i) => ({ v, i })).filter((x) => x.v.sellingPrice);
  const notes = [];
  if (!isBrand && d) {
    notes.push(d.pricesVisible ? '✓ Verified product: prices, stock and approved offers can appear.' : 'Prices, stock and offers are hidden because the product is not verified (or its verification is outdated).');
    if (d.pricesVisible) notes.push(`${d.offers.length} approved, unexpired offer${d.offers.length === 1 ? '' : 's'} available.`);
    for (const w of (p?.warnings || []).filter((w) => w.level !== 'info')) notes.push('⚠ ' + w.message);
  }
  return `<div class="card"><div class="row"><button onclick="posterEdit=null;load()">← Back</button><h2 class="grow" style="margin:0">${po.id ? esc(po.productName || 'Store brand') : 'New poster'}</h2>
      ${po.id ? posterStatus(po) : '<span class="badge">New</span>'}${po.dirty ? '<span class="badge warn">Unsaved changes</span>' : ''}</div>
    ${po.needsReview ? `<p style="color:#f5b84c;margin:8px 0 0">The product, price or offers changed since you approved this poster.${po.retired ? ' It was removed from playlists.' : ''} Check the preview, approve it again and add it to the media library again.</p>` : ''}</div>
    <div class="peditor"><div>
      <div class="card"><h2>Poster</h2>
        ${isBrand ? '' : `<label>Phone<br><select style="width:100%" onchange="peProduct(this.value)">${products.map((x) => `<option value="${x.id}" ${x.id === po.productId ? 'selected' : ''}>${esc(x.brand + ' ' + x.model)}${x.status !== 'verified' ? ' (draft)' : ''}${x.images.length ? '' : ' – no image'}</option>`).join('')}</select></label>`}
        <div class="chips" style="margin-top:8px">${posterMeta.templates.map((t) => `<button class="${po.template === t ? 'primary' : ''}" onclick="peTemplate('${t}')">${POSTER_TEMPLATES[t]}</button>`).join('')}</div>
        <div class="row" style="margin-top:8px"><select onchange="peSet('size',this.value);render()">${posterMeta.sizes.map((s) => `<option value="${s}" ${po.size === s ? 'selected' : ''}>${POSTER_SIZES[s].label}</option>`).join('')}</select>
        <select onchange="peSet('category',this.value)"><option value="">No category</option>${posterMeta.categories.map((c) => `<option ${po.category === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></div></div>
      <div class="card"><h2>Text</h2>
        <input style="width:100%" placeholder="Headline (default: ${esc(p ? p.model : 'headline')})" value="${esc(po.texts.headline)}" oninput="peSet('texts.headline',this.value)">
        <input style="width:100%;margin-top:6px" placeholder="Tagline (optional)" value="${esc(po.texts.tagline)}" oninput="peSet('texts.tagline',this.value)">
        <input style="width:100%;margin-top:6px" placeholder="Footer text (optional)" value="${esc(po.texts.footer)}" oninput="peSet('texts.footer',this.value)">
        <small>Prices, specs and offers come from the product record. Text you type here is not checked.</small></div>
      ${isBrand ? '' : `<div class="card"><h2>Phone image</h2><div class="thumbrow">${(p?.images || []).map((im) => `<img src="/media/${im.file}" class="${im.file === po.image.file ? 'sel' : ''}" title="${esc([im.color, im.view].filter(Boolean).join(' · '))}" onclick="peImage('${im.file}')">`).join('')}</div>
        <label>Zoom <input type="range" min="50" max="250" value="${po.image.zoom}" oninput="peSet('image.zoom',+this.value)"></label><br>
        <label>Left / right <input type="range" min="-50" max="50" value="${po.image.offsetX}" oninput="peSet('image.offsetX',+this.value)"></label><br>
        <label>Up / down <input type="range" min="-50" max="50" value="${po.image.offsetY}" oninput="peSet('image.offsetY',+this.value)"></label>
        <div><button onclick="posterEdit.image.zoom=100;posterEdit.image.offsetX=0;posterEdit.image.offsetY=0;posterEdit.dirty=true;render()">Reset position</button></div></div>
      <div class="card"><h2>Show</h2><div class="row"><label class="switch"><input type="checkbox" ${po.options.showSpecs ? 'checked' : ''} onchange="peSet('options.showSpecs',this.checked)"> Specs</label>
        <label class="switch"><input type="checkbox" ${po.options.showPrice ? 'checked' : ''} onchange="peSet('options.showPrice',this.checked)"> Price</label>
        <label class="switch"><input type="checkbox" ${po.options.showOffers ? 'checked' : ''} onchange="peSet('options.showOffers',this.checked)"> Offers</label></div>
        ${variants.length > 1 ? `<div style="margin-top:8px"><label>Variant for the price<br><select onchange="peSet('options.variantIndex',+this.value)">${variants.map((x) => `<option value="${x.i}" ${x.i === po.options.variantIndex ? 'selected' : ''}>${esc([x.v.ram, x.v.storage, x.v.colour].filter(Boolean).join(' + '))}</option>`).join('')}</select></label></div>` : ''}
        ${notes.map((n) => `<small style="display:block;margin-top:6px">${esc(n)}</small>`).join('')}</div>`}
    </div>
    <div><div class="card"><canvas id="ppv" style="width:100%;height:auto;border-radius:6px;background:#000"></canvas><small id="pnote"></small></div>
      <div class="card"><div class="row">
        <button class="primary" onclick="savePoster(false)" ${po.dirty || !po.id ? '' : 'disabled'}>Save draft</button>
        <button class="primary" onclick="savePoster(true)" ${approvedOk ? 'disabled' : ''}>Approve poster</button>
        ${po.status === 'approved' ? '<button onclick="unapprovePoster()">Unapprove</button>' : ''}</div>
        <div class="row" style="margin-top:10px"><b>After approval:</b>
        <button onclick="exportPoster('png')" ${approvedOk ? '' : 'disabled'}>Download PNG</button><button onclick="exportPoster('jpeg')" ${approvedOk ? '' : 'disabled'}>Download JPEG</button><button onclick="exportPoster('pdf')" ${approvedOk ? '' : 'disabled'}>Download PDF</button>
        <button class="primary" onclick="posterToLibrary()" ${approvedOk ? '' : 'disabled'}>Add to media library</button></div>
        ${posterMsg ? `<div style="margin-top:8px">${posterMsg}</div>` : ''}${po.mediaId ? playlistAdder() : ''}</div></div></div>`;
}

function playlistAdder() { return '<div class="row" style="margin-top:8px"><button onclick="addPosterToPlaylist()">Add to a playlist…</button><small>Then choose that playlist for a screen under Screens.</small></div>'; }

async function savePoster(approve) {
  const po = posterEdit;
  const body = { productId: po.template === 'brand' ? null : po.productId, template: po.template, size: po.size, category: po.category, texts: po.texts, image: po.image, options: po.options };
  try {
    let saved = po.id && !po.dirty ? posters.find((x) => x.id === po.id) : (po.id ? await api('/posters/' + po.id, { method: 'PUT', body }) : await api('/posters', { method: 'POST', body }));
    if (approve) saved = await api(`/posters/${saved.id}/approve`, { method: 'POST' });
    posters = await api('/posters');
    posterEdit = { ...saved, dirty: false }; posterMsg = approve ? 'Approved. You can now export it or add it to the media library.' : 'Saved as a draft.';
    render();
  } catch { /* api() showed the message */ }
}
async function unapprovePoster() {
  const s = await api(`/posters/${posterEdit.id}/unapprove`, { method: 'POST' });
  posters = await api('/posters'); posterEdit = { ...s, dirty: false }; posterMsg = ''; render();
}
async function exportPoster(fmt) {
  const po = posterEdit, spec = specOf(po, po.template === 'brand' ? null : posterInfo);
  const name = `${posterSlug(po.productName || 'myt-mobiles')}-${po.template}-${po.size}`;
  const blob = fmt === 'pdf' ? await buildPdf(spec) : await posterBlob(spec, fmt === 'jpeg' ? 'image/jpeg' : 'image/png');
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${name}.${fmt === 'jpeg' ? 'jpg' : fmt}`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
async function posterToLibrary() {
  posterMsg = 'Adding to the media library…'; render();
  try {
    const r = await uploadToLibrary(posterEdit);
    posters = await api('/posters'); posterEdit = { ...r.poster, dirty: false };
    posterMsg = `Added to the <b>Media</b> library as “${esc(r.media.name)}”.`;
  } catch { posterMsg = ''; }
  render();
}
async function addPosterToPlaylist() {
  const lists = await api('/playlists');
  const pick = prompt('Add to which playlist?\n' + lists.map((l, i) => `${i + 1}. ${l.name}`).join('\n') + '\n\nType a number, or type a new playlist name.', lists.length ? '1' : 'myT Mobiles posters');
  if (!pick) return;
  const existing = lists[Number(pick) - 1];
  const pl = existing || await api('/playlists', { method: 'POST', body: { name: pick } });
  if (!pl.items.some((i) => i.mediaId === posterEdit.mediaId)) pl.items.push({ mediaId: posterEdit.mediaId, duration: 10 });
  await api('/playlists/' + pl.id, { method: 'PUT', body: { items: pl.items } });
  posterMsg = `Added to playlist <b>${esc(pl.name)}</b>. Next: choose it for a screen under <b>Screens</b>.`; render();
}
