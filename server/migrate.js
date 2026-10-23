// One-time upgrade of a single-store OpenSign database to the multi-store layout (schemaVersion 2).
// Everything that existed becomes one store. TVs keep their pairing, so they keep playing.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SEED_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'seed');
const TENANT_LISTS = ['devices', 'media', 'playlists', 'walls', 'layouts', 'products', 'posters'];
const MYT_STORE_HOST = 'storetmobiles2-code.github.io';

/** If the old data came from the myT Mobiles store import, keep that store's name, colour, logo and import address. */
function detectBranding(db) {
  const fromMyT = db.products?.find((p) => /myT Mobiles/i.test(p.sourceName || '') || String(p.sourceUrl || '').includes(MYT_STORE_HOST));
  if (!fromMyT) return { name: process.env.LEGACY_STORE_NAME || 'My Store', accent: '#4f8cff', logoSeed: null, importSource: '' };
  const m = String(fromMyT.sourceUrl || '').match(/^(.*?)\/p\//);
  return {
    name: process.env.LEGACY_STORE_NAME || 'myT Mobiles', accent: '#f23088', logoSeed: path.join(SEED_DIR, 'myt-logo.png'),
    importSource: m ? m[1] : '',
  };
}

export function migrate(db, { MEDIA_DIR, hashPassword }) {
  if (db.schemaVersion >= 2) return false;
  db.orgs ??= []; db.users ??= []; db.alerts ??= {};
  const legacy = !!db.admin || process.env.ADMIN_PASSWORD || TENANT_LISTS.some((k) => db[k]?.length);
  db.schemaVersion = 2;
  if (!legacy) return true; // a brand-new server: nothing to move

  const b = detectBranding(db);
  const org = {
    id: crypto.randomUUID(), name: b.name, accent: b.accent, logoFile: '', importSource: b.importSource,
    features: { catalog: !!(db.products?.length || db.posters?.length || b.importSource) }, disabled: false, createdAt: Date.now(),
  };
  if (b.logoSeed && fs.existsSync(b.logoSeed)) {
    org.logoFile = crypto.randomUUID() + '.png';
    fs.copyFileSync(b.logoSeed, path.join(MEDIA_DIR, org.logoFile));
  }
  db.orgs.push(org);
  for (const k of TENANT_LISTS) for (const x of db[k] || []) x.orgId = org.id;
  for (const po of db.posters || []) if (po.category === 'myT Mobiles store branding') po.category = 'Store branding';
  if (db.alert) db.alerts[org.id] = db.alert;
  delete db.alert;
  db.legacyOrgId = org.id; // old proof-of-play lines have no store; they belong to this one

  // The old admin password becomes the login "admin": the owner of this store and a platform administrator.
  const pw = db.admin ? { salt: db.admin.salt, hash: db.admin.hash } : hashPassword(process.env.ADMIN_PASSWORD || crypto.randomBytes(18).toString('hex'));
  db.users.push({ id: crypto.randomUUID(), orgId: org.id, login: 'admin', name: 'Administrator', role: 'owner', platform: true, ...pw, disabled: false, createdAt: Date.now() });
  delete db.admin;
  return true;
}
