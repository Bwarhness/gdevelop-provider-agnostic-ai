// Generic auth + model catalog reader for a local oh-my-pi (`omp`) install.
//
// oh-my-pi stores provider credentials in ~/.omp/agent/agent.db (table
// auth_credentials) and a cached model catalog in ~/.omp/agent/models.db (table
// model_cache). This module lets the proxy:
//   - resolve a *static* api_key for any omp provider (e.g. 'xiaomi') for use as the
//     bearer token  ->  authSource 'omp:<provider>'   (Kimi's short-lived OAuth token is
//     handled separately in kimiAuth.js via authSource 'omp-kimi').
//   - list the OpenAI-compatible models omp knows about, so the config UI can offer a
//     one-click provider/model picker.
//
// Reads happen via `python -c` (sqlite3 in the stdlib) — the same approach as kimiAuth.js,
// avoiding a native sqlite dependency. Paths overridable via env: OMP_AGENT_DB, OMP_MODELS_DB.
import { execFile } from 'child_process';
import { promisify } from 'util';
import { homedir } from 'os';

const execFileAsync = promisify(execFile);

const AGENT_DB = (process.env.OMP_AGENT_DB || `${homedir()}/.omp/agent/agent.db`).replace(/\\/g, '/');
const MODELS_DB = (process.env.OMP_MODELS_DB || `${homedir()}/.omp/agent/models.db`).replace(/\\/g, '/');

let lastErrAt = 0;
function logErr(stage, e) {
  if (Date.now() - lastErrAt > 30000) {
    lastErrAt = Date.now();
    // eslint-disable-next-line no-console
    console.error(`[ompAuth] ${stage} failed: ${String((e && e.message) || e).slice(0, 200)}`);
  }
}

// --- static api_key resolution -------------------------------------------------
const keyCache = new Map();   // provider -> api key string
const keyReadInFlight = new Map();

function readKeyPy(provider) {
  // provider is validated by the caller; embed it as a python string literal safely.
  const p = JSON.stringify(provider);
  return `import sqlite3,json
c=sqlite3.connect("file:${AGENT_DB}?mode=ro",uri=True)
r=c.execute("select data from auth_credentials where provider=? and disabled_cause is null order by updated_at desc limit 1",(${p},)).fetchone()
c.close()
d=json.loads(r[0]) if r else {}
print(d.get("key") or d.get("api_key") or d.get("access") or d.get("token") or "")`;
}

function isValidProvider(provider) {
  return typeof provider === 'string' && /^[a-z0-9._-]{1,40}$/i.test(provider);
}

// Async read of a provider's static api key from oh-my-pi's store. Coalesced per provider.
function readOmpApiKey(provider) {
  if (keyReadInFlight.has(provider)) return keyReadInFlight.get(provider);
  const promise = (async () => {
    try {
      const { stdout } = await execFileAsync('python', ['-c', readKeyPy(provider)], { encoding: 'utf8', timeout: 15000 });
      const key = (stdout || '').trim();
      if (key) keyCache.set(provider, key);
      return key || keyCache.get(provider) || '';
    } catch (e) {
      logErr(`api-key read (${provider})`, e);
      return keyCache.get(provider) || '';
    } finally {
      keyReadInFlight.delete(provider);
    }
  })();
  keyReadInFlight.set(provider, promise);
  return promise;
}

// SYNCHRONOUS hot-path accessor used by bearerToken(): returns the cached static key.
// Static keys don't expire, so once warmed it's stable; trigger a lazy re-read if missing.
export function getOmpApiKey(provider) {
  if (!isValidProvider(provider)) return '';
  if (!keyCache.has(provider)) readOmpApiKey(provider); // fire-and-forget
  return keyCache.get(provider) || '';
}

// Pre-warm one provider's key (await once at startup / on config change).
export async function ensureOmpApiKey(provider) {
  if (!isValidProvider(provider)) return '';
  if (!keyCache.has(provider)) await readOmpApiKey(provider);
  return keyCache.get(provider) || '';
}

// --- model catalog -------------------------------------------------------------
const MODELS_PY = `import sqlite3,json
def rows(db,q):
    try:
        c=sqlite3.connect("file:%s?mode=ro"%db,uri=True);r=c.execute(q).fetchall();c.close();return r
    except Exception:
        return []
creds=set(x[0] for x in rows(${JSON.stringify(AGENT_DB)},"select distinct provider from auth_credentials where disabled_cause is null"))
out=[]
for pid,mjson in rows(${JSON.stringify(MODELS_DB)},"select provider_id,models from model_cache"):
    try: models=json.loads(mjson)
    except Exception: continue
    if isinstance(models,dict): models=models.get("models") or list(models.values())
    if not isinstance(models,list): continue
    for m in models:
        if not isinstance(m,dict): continue
        api=str(m.get("api",""))
        if "openai" not in api: continue
        out.append({
            "provider":pid,
            "id":m.get("id") or m.get("name"),
            "name":m.get("name") or m.get("id"),
            "baseUrl":m.get("baseUrl") or "",
            "api":api,
            "reasoning":bool(m.get("reasoning")),
            "contextWindow":m.get("contextWindow"),
            "hasCredential":pid in creds,
        })
print(json.dumps(out))`;

let modelsCache = null;
let modelsAt = 0;

// List OpenAI-compatible models oh-my-pi knows about (for the config UI dropdown).
// Cached 60s. Returns [] if oh-my-pi isn't installed.
export async function listOmpModels() {
  if (modelsCache && Date.now() - modelsAt < 60000) return modelsCache;
  try {
    const { stdout } = await execFileAsync('python', ['-c', MODELS_PY], { encoding: 'utf8', timeout: 15000 });
    const arr = JSON.parse(stdout || '[]');
    modelsCache = Array.isArray(arr) ? arr.filter(m => m && m.id && m.baseUrl) : [];
    modelsAt = Date.now();
  } catch (e) {
    logErr('model catalog read', e);
    if (!modelsCache) modelsCache = [];
  }
  return modelsCache;
}
