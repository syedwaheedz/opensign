// Platform, Team and Settings tabs. Uses helpers from index.html (api, $, esc, render, load, ME, applyBranding).
let platformOrgs = [], platformAdmins = [], teamUsers = [];

async function loadPlatform() { [platformOrgs, platformAdmins] = await Promise.all([api('/platform/orgs'), api('/platform/admins')]); }
async function loadTeam() { teamUsers = await api('/org/users'); }
async function refreshMe() { ME = await api('/me'); applyBranding(); }
const askPw = (who) => prompt(`New password for ${who} (at least 8 characters):`);

// ---- Platform (platform administrator only) ------------------------------------------------------------------
function renderPlatform() {
  return `<div class="card"><h2>Stores</h2>
    <small>Each store has its own screens, media, playlists and people. Here you see store names and logins, never their content.</small></div>
    <div class="card"><h2>New store</h2><div class="row">
      <input id="onName" placeholder="Store name" class="grow">
      <input id="onLogin" placeholder="Owner's email or login" ${ME.org ? '' : 'class="theirs"'}>
      <input id="onPw" type="password" placeholder="Owner's first password (8+)" ${ME.org ? '' : 'class="theirs"'}></div>
      ${ME.org ? '' : '<div class="row" style="margin-top:8px"><label class="switch"><input id="onMine" type="checkbox" onchange="document.querySelectorAll(\'.theirs\').forEach(e=>e.disabled=this.checked)"> This is my own store (I will be its owner, so I need no separate owner login)</label></div>'}
      <div class="row" style="margin-top:8px"><label class="switch"><input id="onCat" type="checkbox"> Phone catalog and posters</label>
      <input id="onSrc" placeholder="Store website to import phones from (optional)" class="grow"><button class="primary" onclick="createOrg()">Create store</button></div>
      <small>Give the owner the login and first password. They can change the password under Settings, and add their own staff under Team.</small></div>
    ${platformOrgs.map((o) => `<div class="card"><div class="row"><b class="grow">${esc(o.name)}</b>
        ${o.disabled ? '<span class="badge warn">Switched off</span>' : '<span class="badge ok">Active</span>'}
        <small>${o.counts.screens} screen${o.counts.screens === 1 ? '' : 's'} · ${o.counts.media} media</small>
        <button onclick="setOrg('${o.id}',{disabled:${!o.disabled}})">${o.disabled ? 'Switch on' : 'Switch off'}</button>
        <button class="danger" onclick="deleteOrg('${o.id}')">Delete…</button></div>
      <div class="row" style="margin-top:8px"><label class="switch"><input type="checkbox" ${o.features.catalog ? 'checked' : ''} onchange="setOrg('${o.id}',{features:{catalog:this.checked}})"> Phone catalog and posters</label>
        <input id="src-${o.id}" class="grow" placeholder="Store website to import from" value="${esc(o.importSource)}"><button onclick="setOrg('${o.id}',{importSource:$('#src-${o.id}').value})">Save address</button></div>
      <div style="margin-top:8px"><small>Logins:</small>${o.users.map((u) => `<div class="row" style="margin-top:4px"><span class="grow">${esc(u.login)} <small>${esc(u.name)} · ${u.role}${u.disabled ? ' · disabled' : ''}${u.lastLogin ? ' · last sign-in ' + new Date(u.lastLogin).toLocaleDateString() : ''}</small></span>
        <button onclick="resetOrgUser('${o.id}','${u.id}','${esc(u.login)}')">Reset password</button></div>`).join('')}</div></div>`).join('') || '<p class="muted">No stores yet. Create the first one above.</p>'}
    <div class="card"><h2>Platform administrators</h2>
      ${platformAdmins.map((u) => `<div class="row"><span class="grow">${esc(u.login)} <small>${esc(u.name)}</small></span></div>`).join('')}
      <div class="row" style="margin-top:8px"><input id="paLogin" placeholder="Login"><input id="paPw" type="password" placeholder="Password (8+)"><button onclick="addPlatformAdmin()">Add administrator</button></div></div>`;
}
async function createOrg() {
  const mine = !!$('#onMine')?.checked;
  await api('/platform/orgs', { method: 'POST', body: { name: $('#onName').value, asMyStore: mine, ownerLogin: $('#onLogin').value, ownerPassword: $('#onPw').value, features: { catalog: $('#onCat').checked }, importSource: $('#onSrc').value } });
  if (mine) { // this login now belongs to the new store: rebuild the tabs and open the store
    await refreshMe(); buildNav(); tab = 'devices'; localStorage.setItem('tab', tab);
  }
  load();
}
async function setOrg(id, patch) { await api('/platform/orgs/' + id, { method: 'PUT', body: patch }); load(); }
async function resetOrgUser(orgId, userId, login) {
  const pw = askPw(login); if (!pw) return;
  await api(`/platform/orgs/${orgId}/users/${userId}/password`, { method: 'POST', body: { password: pw } });
  alert('Password changed. Give it to the person and ask them to change it under Settings.');
}
async function deleteOrg(id) {
  const o = platformOrgs.find((x) => x.id === id);
  const name = prompt(`This permanently deletes ALL of ${o.name}'s screens, media, playlists, products, posters and logins.\n\nType the store name to confirm:`);
  if (name === null) return;
  await api('/platform/orgs/' + id, { method: 'DELETE', body: { confirmName: name } });
  load();
}
async function addPlatformAdmin() { await api('/platform/admins', { method: 'POST', body: { login: $('#paLogin').value, password: $('#paPw').value } }); load(); }

// ---- Team (store owner) -------------------------------------------------------------------------------------------
function renderTeam() {
  return `<div class="card"><h2>Team</h2><small>Owners manage logins and settings. Staff can manage screens, media, playlists and posters.</small></div>
    ${teamUsers.map((u) => `<div class="card row"><span class="grow"><b>${esc(u.name)}</b> <small>${esc(u.login)}${u.lastLogin ? ' · last sign-in ' + new Date(u.lastLogin).toLocaleDateString() : ' · never signed in'}</small></span>
      ${u.disabled ? '<span class="badge warn">Disabled</span>' : ''}
      <select onchange="teamSet('${u.id}',{role:this.value})"><option value="staff" ${u.role === 'staff' ? 'selected' : ''}>Staff</option><option value="owner" ${u.role === 'owner' ? 'selected' : ''}>Owner</option></select>
      <button onclick="teamReset('${u.id}','${esc(u.login)}')">Reset password</button>
      <button onclick="teamSet('${u.id}',{disabled:${!u.disabled}})">${u.disabled ? 'Enable' : 'Disable'}</button>
      ${u.id === ME.user.id ? '' : `<button class="danger" onclick="teamRemove('${u.id}','${esc(u.login)}')">Remove</button>`}</div>`).join('')}
    <div class="card"><h2>Add a person</h2><div class="row"><input id="tuLogin" placeholder="Email or login"><input id="tuName" placeholder="Name"><input id="tuPw" type="password" placeholder="First password (8+)">
      <select id="tuRole"><option value="staff">Staff</option><option value="owner">Owner</option></select><button class="primary" onclick="teamAdd()">Add</button></div>
      <small>Give them the login and first password. They can change it under Settings.</small></div>`;
}
async function teamAdd() { await api('/org/users', { method: 'POST', body: { login: $('#tuLogin').value, name: $('#tuName').value, password: $('#tuPw').value, role: $('#tuRole').value } }); load(); }
async function teamSet(id, patch) { await api('/org/users/' + id, { method: 'PUT', body: patch }); load(); }
async function teamReset(id, login) { const pw = askPw(login); if (!pw) return; await api('/org/users/' + id, { method: 'PUT', body: { password: pw } }); alert('Password changed.'); }
async function teamRemove(id, login) { if (confirm(`Remove ${login}?`)) { await api('/org/users/' + id, { method: 'DELETE' }); load(); } }

// ---- Settings (store owner: store; everyone: own account) -----------------------------------------------------------
function renderSettings() {
  const o = ME.org, owner = ME.user.role === 'owner';
  return `${owner ? `<div class="card"><h2>Store</h2>
      <div class="row"><input id="stName" class="grow" value="${esc(o.name)}" placeholder="Store name"><label>Accent colour <input id="stAccent" type="color" value="${esc(o.accent)}"></label><button class="primary" onclick="saveStore()">Save</button></div>
      <div class="row" style="margin-top:10px">${o.logoUrl ? `<img src="${esc(o.logoUrl)}" style="height:56px;background:#000;border-radius:6px;padding:4px">` : '<small>No logo yet. The store name is shown instead.</small>'}
        <input type="file" id="stLogo" accept="image/png,image/jpeg,image/webp"><button onclick="uploadLogo()">Upload logo</button>${o.logoUrl ? '<button class="danger" onclick="removeLogo()">Remove logo</button>' : ''}</div>
      <small>The logo and colour appear in this admin and on your posters. Use a PNG, JPEG or WebP image; a logo on a black or transparent background looks best.</small></div>` : ''}
    <div class="card"><h2>My account</h2><div class="row"><input id="acName" value="${esc(ME.user.name)}" placeholder="Name"><input id="acLogin" value="${esc(ME.user.login)}" placeholder="Login"><button onclick="saveAccount()">Save</button></div></div>
    <div class="card"><h2>Change password</h2><div class="row"><input id="pwOld" type="password" placeholder="Current password"><input id="pwNew" type="password" placeholder="New password (8+)"><button onclick="changePassword()">Change password</button></div>
      <small>Other devices where you are signed in will be signed out.</small></div>`;
}
async function saveStore() { await api('/org', { method: 'PUT', body: { name: $('#stName').value, accent: $('#stAccent').value } }); await refreshMe(); render(); }
async function uploadLogo() {
  const f = $('#stLogo').files[0]; if (!f) return;
  const fd = new FormData(); fd.append('file', f);
  await api('/org/logo', { method: 'POST', body: fd }); await refreshMe(); render();
}
async function removeLogo() { await api('/org/logo', { method: 'DELETE' }); await refreshMe(); render(); }
async function saveAccount() { await api('/me', { method: 'PUT', body: { name: $('#acName').value, login: $('#acLogin').value } }); await refreshMe(); render(); }
async function changePassword() {
  const r = await api('/me/password', { method: 'POST', body: { current: $('#pwOld').value, next: $('#pwNew').value } });
  token = r.token; localStorage.setItem('token', token); alert('Password changed.'); render();
}
