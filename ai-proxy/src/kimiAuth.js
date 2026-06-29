// Optional auth source for Kimi (api.kimi.com/coding/v1) via a local oh-my-pi
// installation. Kimi uses short-lived OAuth access tokens that oh-my-pi refreshes.
//
// Design: the hot path (getKimiToken) is SYNCHRONOUS and never blocks the event loop —
// it returns the in-memory cached token. Reading the token from oh-my-pi's SQLite store
// and refreshing it via `omp` both happen ASYNCHRONOUSLY in the background / on 401.
//
// Enabled by PROVIDER_AUTH_SOURCE=omp-kimi. Paths overridable via env:
//   OMP_AGENT_DB (default ~/.omp/agent/agent.db), OMP_BIN (default ~/.bun/bin/omp.exe),
//   OMP_KIMI_MODEL (default kimi-code/kimi-for-coding).
import { execFile } from 'child_process';
import { promisify } from 'util';
import { homedir } from 'os';

const execFileAsync = promisify(execFile);

const DB = (process.env.OMP_AGENT_DB || `${homedir()}/.omp/agent/agent.db`).replace(/\\/g, '/');
const OMP_BIN = process.env.OMP_BIN || `${homedir()}/.bun/bin/omp.exe`;
const OMP_MODEL = process.env.OMP_KIMI_MODEL || 'kimi-code/kimi-for-coding';

const PY = `import sqlite3,json
c=sqlite3.connect("file:${DB}?mode=ro",uri=True)
r=c.execute("select data from auth_credentials where provider='kimi-code'").fetchone()
c.close()
print(json.loads(r[0])["access"] if r else "")`;

let cachedToken = null;
let cachedAt = 0;
let readInFlight = null;
let lastReadError = 0;

function logErr(stage, e) {
  // Rate-limit error logging (never print the token).
  if (Date.now() - lastReadError > 30000) {
    lastReadError = Date.now();
    // eslint-disable-next-line no-console
    console.error(`[kimiAuth] ${stage} failed: ${String((e && e.message) || e).slice(0, 200)}`);
  }
}

// Async read of the current token from oh-my-pi's store; updates the cache. Coalesced.
function readToken() {
  if (readInFlight) return readInFlight;
  readInFlight = (async () => {
    try {
      const { stdout } = await execFileAsync('python', ['-c', PY], { encoding: 'utf8', timeout: 15000 });
      const tok = (stdout || '').trim();
      if (tok) {
        cachedToken = tok;
        cachedAt = Date.now();
      }
      return tok || cachedToken;
    } catch (e) {
      logErr('token read', e);
      return cachedToken;
    } finally {
      readInFlight = null;
    }
  })();
  return readInFlight;
}

// SYNCHRONOUS hot-path accessor: returns the cached token immediately and triggers a
// background re-read if the cache is stale (to pick up external refreshes).
export function getKimiToken() {
  if (Date.now() - cachedAt > 60000) readToken(); // fire-and-forget, non-blocking
  return cachedToken;
}

// Pre-warm the cache at startup (await once so the first request has a token).
export async function ensureKimiToken() {
  if (!cachedToken) await readToken();
  if (!cachedToken) logErr('token pre-warm (omp-kimi configured but no token found)', new Error('empty'));
  return cachedToken;
}

let refreshInFlight = null;

// Refresh the token via oh-my-pi (async — does NOT block the event loop). Coalesced.
export async function refreshKimiToken() {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      await execFileAsync(
        OMP_BIN,
        ['-p', 'ok', '--model', OMP_MODEL, '--no-session', '--no-tools', '--thinking', 'off', '--allow-home'],
        { encoding: 'utf8', timeout: 120000, env: { ...process.env, NO_COLOR: '1' } }
      );
      cachedToken = null;
      cachedAt = 0;
      await readToken();
      return true;
    } catch (e) {
      logErr('token refresh (omp)', e);
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}
