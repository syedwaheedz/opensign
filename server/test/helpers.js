// Starts a throwaway OpenSign server (temp DATA_DIR, random port, no UDP discovery) for tests.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');

export async function startServer(env = {}, { dataDir: given } = {}) {
  const dataDir = given || fs.mkdtempSync(path.join(os.tmpdir(), 'opensign-test-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ['index.js'], {
    cwd: serverDir,
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, DISCOVERY_PORT: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 10000);
    child.stdout.on('data', (d) => { if (String(d).includes('OpenSign is running')) { clearTimeout(timer); resolve(); } });
    child.on('exit', (c) => reject(new Error('server exited early: ' + c)));
  });
  const base = `http://localhost:${port}`;

  const request = async (token, method, p, body) => {
    const headers = {};
    if (token) headers.Authorization = 'Bearer ' + token;
    if (body !== undefined && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';
    const r = await fetch(base + p, { method, headers, body: body === undefined || body instanceof FormData ? body : JSON.stringify(body) });
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, body: ct.includes('json') ? await r.json() : await r.text() };
  };
  const post = (p, body) => request(null, 'POST', p, body);

  /** A signed-in person: `call` acts as them. */
  const clientFor = async (login, password) => {
    const r = await post('/api/auth/login', { login, password });
    if (r.status !== 200) throw new Error(`login failed for ${login}: ${r.status} ${JSON.stringify(r.body)}`);
    const c = { token: r.body.token, me: r.body, call: (m, p, b) => request(c.token, m, p, b) };
    return c;
  };

  let platformClient = null, current = null;
  const self = {
    base, dataDir, request, post, clientFor,
    call: (m, p, b) => current.call(m, p, b),
    get client() { return current; },
    async setupPlatform(login = 'platform', password = 'platform-pass-1') {
      const r = await post('/api/auth/setup', { login, password });
      if (r.status !== 200) throw new Error('setup failed: ' + JSON.stringify(r.body));
      platformClient = await clientFor(login, password);
      return platformClient;
    },
    get platform() { return platformClient; },
    async usePlatform(login, password) { platformClient = await clientFor(login, password); return platformClient; },
    /** Platform administrator creates a store and its owner; returns a client signed in as that owner. */
    async createStore(name, { features = { catalog: true }, importSource = '', ownerLogin, ownerPassword = 'owner-pass-1' } = {}) {
      if (!platformClient) await self.setupPlatform();
      const login = ownerLogin || `owner@${slug(name)}.test`;
      const r = await platformClient.call('POST', '/api/platform/orgs', { name, features, importSource, ownerLogin: login, ownerPassword });
      if (r.status !== 200) throw new Error('createStore failed: ' + JSON.stringify(r.body));
      const owner = await clientFor(login, ownerPassword);
      return { org: r.body, login, password: ownerPassword, owner };
    },
    /** Default setup for most tests: platform admin + one store with the catalog on, signed in as its owner. */
    async login(opts) {
      const store = await self.createStore('Test Store', opts);
      current = store.owner;
      return store.owner.token;
    },
    // A fake TV: registers, then the current store claims it with the pairing code.
    async register(deviceId, model = '') {
      return (await post('/api/player/register', { deviceId, model })).body;
    },
    async pairDevice(deviceId, name = 'Test screen', client = null) {
      const reg = await self.register(deviceId);
      const c = client || current;
      await c.call('POST', '/api/devices/claim', { code: reg.pairingCode, name });
      return (await c.call('GET', '/api/devices')).body.find((d) => d.deviceId === deviceId);
    },
    config: async (deviceId) => (await fetch(`${base}/api/player/${deviceId}/config`)).json(),
    stop: () => { child.kill(); if (!given) fs.rmSync(dataDir, { recursive: true, force: true }); },
  };
  return self;
}

// 1x1 PNG, enough for upload tests.
export const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
export const pngForm = (name = 'x.png', field = 'files') => { const fd = new FormData(); fd.append(field, new Blob([PNG_1X1], { type: 'image/png' }), name); return fd; };
