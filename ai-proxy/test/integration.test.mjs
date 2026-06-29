// Integration tests: spawn the proxy + a mock OpenAI backend on test ports and
// exercise the HTTP layer end-to-end (no network, no real provider).
// Run with: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, '..', 'src');
const MOCK_PORT = 5199;
const PORT = 4099;
const BASE = `http://localhost:${PORT}`;
const U = '?userId=test-user';
const sleep = ms => new Promise(r => setTimeout(r, ms));

let mockProc, serverProc;

async function waitHealthy(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.ok) return true; } catch (e) {}
    await sleep(250);
  }
  throw new Error(`not healthy: ${url}`);
}
function kill(proc) {
  if (!proc) return;
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F']);
    else proc.kill('SIGKILL');
  } catch (e) {}
}

before(async () => {
  mockProc = spawn('node', [join(SRC, 'mock-openai.js')], { env: { ...process.env, MOCK_PORT: String(MOCK_PORT) }, stdio: 'ignore' });
  serverProc = spawn('node', [join(SRC, 'server.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      PROVIDER_BASE_URL: `http://localhost:${MOCK_PORT}/v1`,
      PROVIDER_API_KEY: 'test-key',
      PROVIDER_MODEL: 'mock',
      PROVIDER_AUTH_SOURCE: '',
      CONFIG_FILE: join(__dirname, 'test-config.json'),
    },
    stdio: 'ignore',
  });
  await waitHealthy(`http://localhost:${MOCK_PORT}/`);
  await waitHealthy(`${BASE}/health`);
});

after(() => { kill(serverProc); kill(mockProc); });

const withUser = p => BASE + p + (p.includes('?') ? '&userId=test-user' : U);
const post = async (p, b) => (await fetch(withUser(p), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).json();
const get = async p => (await fetch(withUser(p))).json();
async function poll(id, tries = 40) {
  for (let i = 0; i < tries; i++) { const r = await get(`/ai-request/${id}`); if (r.status === 'ready' || r.status === 'error') return r; await sleep(250); }
  return get(`/ai-request/${id}`);
}

test('health + config endpoints', async () => {
  const h = await get('/health');
  assert.equal(h.ok, true);
  const c = await get('/config');
  assert.ok(c.baseUrl.includes(String(MOCK_PORT)));
  assert.equal(c.model, 'mock');
});

test('chat: create -> poll -> assistant text', async () => {
  const c = await post('/ai-request', { userRequest: 'hello', mode: 'chat', aiConfiguration: { presetId: 'default' }, payWithCredits: false, toolsVersion: 'v5' });
  assert.ok(c.id);
  assert.equal(c.status, 'working');
  const r = await poll(c.id);
  assert.equal(r.status, 'ready');
  const text = r.output.find(m => m.role === 'assistant').content.find(x => x.type === 'output_text');
  assert.ok(text.text.length > 0);
});

test('incremental fetch echoes outputFromMessageId as output[0]', async () => {
  const c = await post('/ai-request', { userRequest: 'q', mode: 'chat', payWithCredits: false });
  const r = await poll(c.id);
  const firstId = r.output[0].messageId;
  const inc = await get(`/ai-request/${c.id}?outputFromMessageId=${firstId}`);
  assert.equal(inc.output[0].messageId, firstId);
});

test('agent: mock emits a tool call (function_call item)', async () => {
  const c = await post('/ai-request', { userRequest: 'create a scene', mode: 'agent', aiConfiguration: { presetId: 'agent' }, payWithCredits: false, toolsVersion: 'v5', gameProjectJson: '{"layouts":[{"name":"G"}]}' });
  const r = await poll(c.id);
  assert.equal(r.status, 'ready');
  const fc = r.output.flatMap(m => m.content || []).find(x => x.type === 'function_call');
  assert.ok(fc, 'expected a function_call');
});

test('add-message tool result continues the loop', async () => {
  const c = await post('/ai-request', { userRequest: 'create a scene', mode: 'agent', payWithCredits: false, gameProjectJson: '{"layouts":[{"name":"G"}]}' });
  let r = await poll(c.id);
  const fc = r.output.flatMap(m => m.content || []).find(x => x.type === 'function_call');
  const a = await post(`/ai-request/${c.id}/action/add-message`, { functionCallOutputs: [{ type: 'function_call_output', call_id: fc.call_id, output: '{"success":true}' }], mode: 'agent', payWithCredits: false });
  assert.equal(a.status, 'working');
  r = await poll(c.id);
  assert.equal(r.status, 'ready');
});

test('batched status poll returns {id,status,userId}', async () => {
  const c = await post('/ai-request', { userRequest: 'x', mode: 'chat', payWithCredits: false });
  await poll(c.id);
  const st = await get(`/ai-request?ids=${c.id}&include=status`);
  assert.ok(Array.isArray(st));
  assert.equal(st[0].id, c.id);
});

test('GET unknown request -> 404 json', async () => {
  const r = await fetch(`${BASE}/ai-request/does-not-exist${U}`);
  assert.equal(r.status, 404);
});

test('POST /config rejects non-http baseUrl', async () => {
  const r = await fetch(withUser('/config'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseUrl: 'ftp://evil.example' }) });
  assert.equal(r.status, 400);
});
test('POST /config rejects link-local/metadata host (SSRF)', async () => {
  const r = await fetch(withUser('/config'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseUrl: 'http://169.254.169.254/latest' }) });
  assert.equal(r.status, 400);
});
test('CORS: allowed IDE origin reflected, foreign origin not', async () => {
  const ok = await fetch(`${BASE}/health`, { headers: { Origin: 'http://localhost:3000' } });
  assert.equal(ok.headers.get('access-control-allow-origin'), 'http://localhost:3000');
  const bad = await fetch(`${BASE}/health`, { headers: { Origin: 'http://evil.example' } });
  assert.notEqual(bad.headers.get('access-control-allow-origin'), 'http://evil.example');
});
test('GET /config redacts sensitive extraHeaders', async () => {
  await post('/config', { extraHeaders: { 'User-Agent': 'X', Authorization: 'super-secret' } });
  const c = await get('/config');
  assert.equal(c.extraHeaders.Authorization, '***');
  assert.equal(c.extraHeaders['User-Agent'], 'X');
});

test('events endpoint returns a record and reaches terminal status', async () => {
  const c = await post('/ai-generated-event', { sceneName: 'L', eventsDescription: 'do something', objectsList: 'Hero:Sprite', gameProjectJson: '{}' });
  assert.ok(c.id);
  let r;
  for (let i = 0; i < 40; i++) { r = await get(`/ai-generated-event/${c.id}`); if (r.status === 'ready' || r.status === 'error') break; await sleep(250); }
  assert.ok(r.status === 'ready' || r.status === 'error'); // never stuck in 'working'
});
