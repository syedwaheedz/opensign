// Starts a throwaway OpenSign server (temp DATA_DIR, random port, no UDP discovery) for tests.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function startServer(env = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opensign-test-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ['index.js'], {
    cwd: serverDir,
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, DISCOVERY_PORT: '0', ADMIN_PASSWORD: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 10000);
    child.stdout.on('data', (d) => { if (String(d).includes('OpenSign is running')) { clearTimeout(timer); resolve(); } });
    child.on('exit', (c) => reject(new Error('server exited early: ' + c)));
  });
  const base = `http://localhost:${port}`;
  let token = null;
  const call = async (method, p, body) => {
    const headers = { Authorization: 'Bearer ' + token };
    if (body !== undefined && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';
    const r = await fetch(base + p, { method, headers, body: body === undefined || body instanceof FormData ? body : JSON.stringify(body) });
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, body: ct.includes('json') ? await r.json() : await r.text() };
  };
  return {
    base, dataDir, call,
    async login(password = 'secret123') {
      const r = await fetch(base + '/api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
      token = (await r.json()).token;
      return token;
    },
    // A fake TV: registers, then the admin claims it with the pairing code.
    async pairDevice(deviceId, name = 'Test screen') {
      const reg = await (await fetch(base + '/api/player/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId }) })).json();
      await call('POST', '/api/devices/claim', { code: reg.pairingCode, name });
      return (await call('GET', '/api/devices')).body.find((d) => d.deviceId === deviceId);
    },
    config: async (deviceId) => (await fetch(`${base}/api/player/${deviceId}/config`)).json(),
    stop: () => { child.kill(); fs.rmSync(dataDir, { recursive: true, force: true }); },
  };
}

// 1x1 PNG, enough for upload tests.
export const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
