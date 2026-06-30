// GDevelop AI proxy / shim.
//
// Implements (enough of) GDevelop's Generation REST API so the IDE can talk to
// any OpenAI-compatible /chat/completions backend instead of GDevelop's cloud.
//
// Design (see ../../docs/PHASE_0.5_AI_API_MAP.md):
//  - The IDE creates an AiRequest (POST /ai-request) then POLLS GET /ai-request/{id}
//    until status flips 'working' -> 'ready'. We reproduce that async illusion:
//    POST returns immediately with status 'working'; the LLM call runs in the
//    background and appends an assistant message, then sets status 'ready'.
//  - We honor the incremental contract: GET ?outputFromMessageId=X returns X echoed
//    as output[0] followed by newer messages.
//  - Auth is ignored (any/no Authorization header is accepted).

import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { readFileSync, existsSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  gdevelopOutputToOpenAiMessages,
  openAiChoiceToAssistantMessage,
  makeUserMessage,
  newMessageId,
} from './translate.js';
import { getKimiToken, refreshKimiToken, ensureKimiToken } from './kimiAuth.js';
import { getOmpApiKey, ensureOmpApiKey, listOmpModels } from './ompAuth.js';
import {
  loadCatalog,
  EVENTS_SYSTEM_PROMPT,
  buildEventsUserPrompt,
  parseEventsFromLLM,
  placementToOperation,
  validateEvents,
} from './events.js';
import { CONFIG_UI_HTML } from './configUi.js';
import {
  DELEGATION_TOOLS,
  ORCHESTRATOR_TOOLS,
  ORCHESTRATOR_SYSTEM_PROMPT,
  EXPLORER_SYSTEM_PROMPT,
  readOnlyTools,
  safeJsonParse,
} from './orchestrator.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT || '4000', 10);

let parsedHeaders = {};
try { if (process.env.PROVIDER_EXTRA_HEADERS) parsedHeaders = JSON.parse(process.env.PROVIDER_EXTRA_HEADERS); } catch (e) { /* ignore */ }

// Runtime-mutable provider config (initialized from env, editable via the /config UI).
const cfg = {
  baseUrl: (process.env.PROVIDER_BASE_URL || 'https://api.moonshot.ai/v1').replace(/\/+$/, ''),
  apiKey: process.env.PROVIDER_API_KEY || '',
  model: process.env.PROVIDER_MODEL || 'kimi-k2-0905-preview',
  maxTokens: parseInt(process.env.PROVIDER_MAX_TOKENS || '4096', 10),
  temperature: parseFloat(process.env.PROVIDER_TEMPERATURE || '0.7'),
  // authSource: 'omp-kimi' reads/refreshes the bearer token from a local oh-my-pi
  // install (see kimiAuth.js); otherwise apiKey is used.
  authSource: process.env.PROVIDER_AUTH_SOURCE || '',
  // Extra headers some providers require, e.g. Kimi: {"User-Agent":"KimiCLI/1.0","X-Msh-Platform":"kimi_cli"}
  extraHeaders: parsedHeaders,
  timeoutMs: parseInt(process.env.PROVIDER_TIMEOUT_MS || '120000', 10),
  maxRetries: parseInt(process.env.PROVIDER_MAX_RETRIES || '3', 10),
  // Request-body field used to control reasoning depth (OpenAI standard: 'reasoning_effort').
  // Set PROVIDER_REASONING_PARAM='' to never send a reasoning param.
  reasoningParam: process.env.PROVIDER_REASONING_PARAM !== undefined ? process.env.PROVIDER_REASONING_PARAM : 'reasoning_effort',
  _reasoningUnsupported: false, // set true if the provider rejects the reasoning param entirely
  _minimalUnsupported: false, // set true if the provider rejects effort='minimal' (e.g. Xiaomi MiMo) — map to 'low'
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Persist runtime config changes (from the /config UI) so they survive restarts.
const CONFIG_FILE = process.env.CONFIG_FILE || `${dirname(fileURLToPath(import.meta.url))}/config.json`;
function loadConfigFile() {
  try {
    if (existsSync(CONFIG_FILE)) {
      const saved = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
      Object.assign(cfg, saved);
    }
  } catch (e) { /* ignore corrupt config */ }
}
function saveConfigFile() {
  try {
    writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
  } catch (e) { /* non-fatal */ }
}
loadConfigFile();

function bearerToken() {
  if (cfg.authSource === 'omp-kimi') return getKimiToken() || cfg.apiKey;
  // 'omp:<provider>' reads a static api_key from the local oh-my-pi store (e.g. omp:xiaomi).
  if (cfg.authSource && cfg.authSource.startsWith('omp:'))
    return getOmpApiKey(cfg.authSource.slice(4)) || cfg.apiKey;
  return cfg.apiKey;
}
// True when the configured auth source supplies the credential itself (no apiKey needed).
function authSourceProvidesKey() {
  return cfg.authSource === 'omp-kimi' || (cfg.authSource || '').startsWith('omp:');
}

const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||
  `You are the AI assistant built into GDevelop, the open-source, no-code/low-code 2D & 3D game engine.
You help users build games in GDevelop. You understand GDevelop concepts: scenes (layouts), objects (Sprite, Text, TiledSprite, 3D models, etc.), behaviors, events (conditions -> actions), variables (scene/global/object), layers, effects, and the extension/behavior ecosystem.
Answer clearly and concisely. Prefer concrete, GDevelop-specific guidance (which events, conditions, actions, behaviors, or object types to use) over generic programming advice. When a game project is provided as context, ground your answer in it.
You are currently in chat mode: explain and advise, but do not claim to have modified the project.`;

const AGENT_SYSTEM_PROMPT =
  process.env.AGENT_SYSTEM_PROMPT ||
  `You are the agentic AI assistant built into GDevelop, the open-source 2D & 3D game engine. You build and edit the user's game by CALLING TOOLS that the GDevelop editor executes on the real in-memory project.

Workflow:
- The current game project is provided in the system context as a SimplifiedProject JSON (scenes, objects, variables, etc.). Use it to know exact scene names and object names. If no project exists yet, your FIRST tool call must be initialize_project.
- Use inspect_* tools to read details before changing things when unsure. Use the mutation tools (create_scene, create_object, add_behavior, change_object_property, add_or_edit_variable, put_2d_instances, etc.) to make changes.
- Make one logical change at a time; you may call several tools in sequence. After each tool result, decide the next step.
- Argument names and value formats are strict — follow each tool's schema exactly (e.g. positions like 'x,y', sizes like 'w;h;d', property changes as {property_name,new_value} with string values).
- To create a VISUAL game object (a player, enemy, coin, platform, etc.), call create_object with 'search_terms' describing it (e.g. 'player character', 'coin', 'enemy slime') and a fitting 'object_type' (usually 'Sprite' for 2D). The editor installs a matching asset from the asset store. For plain non-visual objects use 'object_type' (e.g. 'TextObject::Text', 'PanelSpriteObject::PanelSprite', 'Scene3D::Cube3DObject') and leave search_terms empty.
- To add game LOGIC, call add_scene_events with a clear 'events_description' of the behavior to add (e.g. "When the Right arrow key is pressed, move the Player to the right"). First make sure the objects and behaviors the logic relies on already exist (create the object, add its behavior), THEN add the events that use them. Reference objects/behaviors by the exact names you gave them.
- When the user's request is fully done, reply with a short plain-text summary of what you did. Do NOT claim a change unless you made it via a tool.
- Keep explanations brief; prefer doing over describing.`;

// Tool schemas (OpenAI function-tool format) for agent mode. Generated from the
// GDevelop EditorFunctions source. Optional: if missing, agent mode runs tool-less.
//
// These tools are excluded locally because their real implementation is server-side
// (not in the open-source IDE) or depends on GDevelop's cloud services we don't host:
//  - get_game_starter_summary, read_full_docs, search_docs: backend-handled (client no-op failure)
//  - read_game_project_json: redundant (we already put the project JSON in context)
//  - add_scene_events, generate_events: require the /ai-generated-event events-generation
//    service (Phase 2 — the LLM would have to emit GDevelop's exact serialized events JSON)
const DISABLED_TOOLS = new Set(
  (process.env.DISABLED_TOOLS ||
    'get_game_starter_summary,read_full_docs,search_docs,read_game_project_json')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
);

let TOOLS = [];
let READ_ONLY_TOOLS = [];
const toolsPath = process.env.TOOLS_PATH || join(__dirname, 'tools.json');
function loadTools() {
  try {
    if (existsSync(toolsPath)) {
      const raw = JSON.parse(readFileSync(toolsPath, 'utf8'));
      const arr = Array.isArray(raw) ? raw : raw.tools || [];
      // Strip local-only meta fields (_modifiesProject etc.) — providers reject unknown keys.
      TOOLS = arr
        .filter(t => t && t.function && t.function.name && !DISABLED_TOOLS.has(t.function.name))
        .map(t => ({ type: 'function', function: t.function }));
      READ_ONLY_TOOLS = readOnlyTools(TOOLS);
    }
  } catch (e) {
    log(`failed to load tools from ${toolsPath}: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------
/** @type {Map<string, object>} aiRequestId -> AiRequest */
const requests = new Map();
/** @type {Map<string, object>} aiGeneratedEventId -> AiGeneratedEvent */
const aiGeneratedEvents = new Map();
/** @type {Map<string, string>} userRelativeKey -> uploaded blob (raw JSON text) */
const uploads = new Map();

// Bound in-memory state so a long-running server doesn't leak memory.
const MAX_REQUESTS = parseInt(process.env.MAX_REQUESTS || '500', 10);
const MAX_GENERATED_EVENTS = parseInt(process.env.MAX_GENERATED_EVENTS || '500', 10);
const MAX_UPLOADS = parseInt(process.env.MAX_UPLOADS || '300', 10);
// Evict oldest entries (Map preserves insertion order) until at/under the cap.
function capMap(map, max, keep) {
  if (map.size <= max) return;
  for (const [k, v] of map) {
    if (map.size <= max) break;
    if (keep && keep(v)) continue; // keep in-progress entries
    map.delete(k);
  }
}

const nowIso = () => new Date().toISOString();
const newRequestId = () =>
  `ai_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

function log(...args) {
  // eslint-disable-next-line no-console
  console.log(`[ai-proxy ${new Date().toISOString()}]`, ...args);
}

// ---------------------------------------------------------------------------
// Provider call
// ---------------------------------------------------------------------------
// Reasoning level (0-3, from GDevelop's AI settings) -> provider reasoning_effort.
const EFFORT_BY_LEVEL = ['minimal', 'low', 'medium', 'high'];
const AI_SETTINGS_URL = process.env.AI_SETTINGS_URL || 'https://public-resources.gdevelop.io/ai/ai-settings-v2.json';
let reasoningMap = null;
let reasoningMapAt = 0;
async function getReasoningMap() {
  if (reasoningMap && Date.now() - reasoningMapAt < 60 * 60 * 1000) return reasoningMap;
  try {
    const res = await fetchWithTimeout(AI_SETTINGS_URL, 15000);
    if (!res.ok) throw new Error(`ai-settings ${res.status}`);
    const data = await res.json();
    const map = {};
    for (const p of (data.aiRequest && data.aiRequest.presets) || []) {
      if (p.id && p.mode != null && typeof p.reasoningLevel === 'number') map[`${p.mode}:${p.id}`] = p.reasoningLevel;
    }
    reasoningMap = map;
    reasoningMapAt = Date.now();
  } catch (e) {
    if (!reasoningMap) reasoningMap = {};
  }
  return reasoningMap;
}
async function reasoningEffortFor(req) {
  if (!cfg.reasoningParam || cfg._reasoningUnsupported) return null;
  const presetId = req.aiConfiguration && req.aiConfiguration.presetId;
  if (!presetId) return null;
  const map = await getReasoningMap();
  const level = map[`${req.mode}:${presetId}`];
  if (level == null) return null;
  return EFFORT_BY_LEVEL[Math.max(0, Math.min(3, level))];
}

// Backoff delay (ms): honor Retry-After header when present, else exponential + jitter.
function backoffDelay(attempt, retryAfterHeader) {
  if (retryAfterHeader) {
    const n = Number(retryAfterHeader);
    const ms = Number.isFinite(n) ? n * 1000 : Date.parse(retryAfterHeader) - Date.now();
    if (Number.isFinite(ms) && ms > 0) return Math.min(ms, 30000);
  }
  const base = Math.min(8000, 600 * Math.pow(2, attempt));
  return base + Math.floor(base * 0.3 * Math.random());
}

async function callProvider(messages, tools, reasoningEffort) {
  const url = `${cfg.baseUrl}/chat/completions`;
  const body = {
    model: cfg.model,
    messages,
    temperature: cfg.temperature,
    max_tokens: cfg.maxTokens,
    stream: false,
  };
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  if (reasoningEffort && cfg.reasoningParam && !cfg._reasoningUnsupported) {
    // Apply the learned 'minimal'->'low' floor for providers that reject 'minimal'.
    body[cfg.reasoningParam] =
      reasoningEffort === 'minimal' && cfg._minimalUnsupported ? 'low' : reasoningEffort;
  }
  const doFetch = () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
    return fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bearerToken()}`,
        ...cfg.extraHeaders,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    }).finally(() => clearTimeout(timer));
  };

  let lastErr;
  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    try {
      let res = await doFetch();
      // Kimi token expired mid-flight: refresh once via oh-my-pi and retry immediately.
      if (res.status === 401 && cfg.authSource === 'omp-kimi') {
        log('provider 401 — refreshing kimi token via omp and retrying');
        await refreshKimiToken();
        res = await doFetch();
      }
      // Reasoning-effort compatibility (providers that reject specific efforts):
      //  - 400 mentioning reason/effort: bump 'minimal' -> 'low' (remembered); other efforts ->
      //    drop the param entirely (provider has no reasoning support; remembered).
      //  - 5xx while sending 'minimal' (Xiaomi MiMo 500s on minimal+tools despite advertising
      //    it): bump to 'low' and remember — but never globally disable reasoning on a 5xx,
      //    which may be transient.
      if (cfg.reasoningParam && body[cfg.reasoningParam] !== undefined &&
          (res.status === 400 || res.status >= 500)) {
        const isMinimal = body[cfg.reasoningParam] === 'minimal';
        if (res.status === 400) {
          const text = await res.text().catch(() => '');
          if (/reason|effort/i.test(text)) {
            if (isMinimal) {
              cfg._minimalUnsupported = true;
              body[cfg.reasoningParam] = 'low';
              log(`provider rejected ${cfg.reasoningParam}='minimal' — retrying with 'low'`);
            } else {
              cfg._reasoningUnsupported = true;
              delete body[cfg.reasoningParam];
              log(`provider rejected ${cfg.reasoningParam} — dropping it (no reasoning support)`);
            }
            continue;
          }
          throw new Error(`Provider 400 ${res.statusText} from ${url}: ${text.slice(0, 500)}`);
        }
        if (isMinimal && !cfg._minimalUnsupported) {
          cfg._minimalUnsupported = true;
          body[cfg.reasoningParam] = 'low';
          log(`provider ${res.status} with ${cfg.reasoningParam}='minimal' — retrying with 'low'`);
          continue;
        }
      }
      // Retry transient server/rate-limit errors with backoff (honors Retry-After + jitter).
      if (res.status === 429 || res.status >= 500) {
        const text = await res.text().catch(() => '');
        lastErr = new Error(`Provider ${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
        if (attempt < cfg.maxRetries) {
          const delay = backoffDelay(attempt, res.headers.get('retry-after'));
          log(`provider ${res.status} — retry ${attempt + 1}/${cfg.maxRetries} in ${delay}ms`);
          await sleep(delay);
          continue;
        }
        throw lastErr;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Provider ${res.status} ${res.statusText} from ${url}: ${text.slice(0, 500)}`);
      }
      const data = await res.json();
      if (!data.choices || !data.choices[0]) {
        throw new Error(`Provider returned no choices: ${JSON.stringify(data).slice(0, 500)}`);
      }
      return data;
    } catch (err) {
      // Network errors / timeouts / aborts: retry with backoff; other errors: rethrow.
      const transient = err.name === 'AbortError' || /fetch failed|network|ECONN|ETIMEDOUT|socket/i.test(String(err.message));
      lastErr = err.name === 'AbortError' ? new Error(`Provider request timed out after ${cfg.timeoutMs}ms`) : err;
      if (transient && attempt < cfg.maxRetries) {
        const delay = backoffDelay(attempt);
        log(`provider ${err.name === 'AbortError' ? 'timeout' : 'network error'} — retry ${attempt + 1}/${cfg.maxRetries} in ${delay}ms`);
        await sleep(delay);
        continue;
      }
      throw lastErr;
    }
  }
  throw lastErr || new Error('Provider call failed');
}

// ---------------------------------------------------------------------------
// Request processing (the async "working -> ready" job)
// ---------------------------------------------------------------------------
function resolveProjectContext(req) {
  let projectJson = req._gameProjectJson;
  if (!projectJson && req._gameProjectJsonUserRelativeKey) {
    projectJson = uploads.get(req._gameProjectJsonUserRelativeKey) || null;
  }
  let extensionsSummary = req._projectSpecificExtensionsSummaryJson;
  if (!extensionsSummary && req._projectSpecificExtensionsSummaryJsonUserRelativeKey) {
    extensionsSummary =
      uploads.get(req._projectSpecificExtensionsSummaryJsonUserRelativeKey) || null;
  }
  if (!projectJson && !extensionsSummary) return null;
  let ctx = '';
  if (projectJson) ctx += projectJson;
  if (extensionsSummary)
    ctx += '\n\n# Project-specific extensions summary\n' + extensionsSummary;
  return ctx;
}

// Create a sub-agent (child) AiRequest delegated by an orchestrator's run_*_agent call.
function createSubAgent(parent, callId, role, args) {
  const id = newRequestId();
  const task = (args && (args.prompt || args.short_title)) || 'Perform the delegated task.';
  const child = {
    id,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    userId: parent.userId,
    gameId: parent.gameId || null,
    mode: 'agent',
    aiConfiguration: parent.aiConfiguration,
    toolsVersion: parent.toolsVersion,
    toolOptions: null,
    error: null,
    status: 'working',
    output: [makeUserMessage(task)],
    _role: role, // 'edit' | 'explore'
    _parentId: parent.id,
    _parentCallId: callId,
    _gameProjectJson: parent._gameProjectJson,
    _gameProjectJsonUserRelativeKey: parent._gameProjectJsonUserRelativeKey,
    _projectSpecificExtensionsSummaryJson: parent._projectSpecificExtensionsSummaryJson,
    _projectSpecificExtensionsSummaryJsonUserRelativeKey: parent._projectSpecificExtensionsSummaryJsonUserRelativeKey,
  };
  requests.set(id, child);
  log(`spawned ${role} sub-agent ${id} for ${parent.id}: "${String((args && args.short_title) || '').slice(0, 50)}"`);
  return child;
}

// Sub-agent function_calls in the parent that don't yet have a function_call_output.
function getPendingParentSubAgents(parent) {
  const subAgentCalls = [];
  for (const m of parent.output) {
    if (m && m.type === 'message' && m.role === 'assistant') {
      for (const c of m.content || []) {
        if (c.type === 'function_call' && c.subAgentAiRequestId) subAgentCalls.push(c);
      }
    }
  }
  const doneIds = new Set(parent.output.filter(m => m && m.type === 'function_call_output').map(m => m.call_id));
  return subAgentCalls.filter(c => !doneIds.has(c.call_id));
}

// A sub-agent finished (replied with text, no more tools to run): report to the parent
// and, once all of the parent's sub-agents are done, resume the orchestrator.
function finalizeSubAgent(child) {
  const parent = requests.get(child._parentId);
  if (!parent) return;
  const lastAssistant = [...child.output].reverse().find(m => m.type === 'message' && m.role === 'assistant');
  const finalText = lastAssistant
    ? (lastAssistant.content || []).filter(c => c.type === 'output_text').map(c => c.text).join('\n') || 'Done.'
    : 'Done.';
  parent.output.push({
    type: 'function_call_output',
    call_id: child._parentCallId,
    output: JSON.stringify({ success: !child.error, result: child.error ? child.error.message : finalText }),
  });
  // Propagate the latest project state the sub-agent saw back to the orchestrator, so
  // the next delegated task starts from the current project.
  if (child._gameProjectJson) parent._gameProjectJson = child._gameProjectJson;
  if (child._gameProjectJsonUserRelativeKey) parent._gameProjectJsonUserRelativeKey = child._gameProjectJsonUserRelativeKey;
  parent.updatedAt = nowIso();
  if (getPendingParentSubAgents(parent).length === 0) {
    parent.status = 'working';
    processRequest(parent);
  }
}

async function processRequest(req) {
  req.status = 'working';
  req.updatedAt = nowIso();
  try {
    const isSubAgent = !!req._parentId;
    const isOrchestrator = req.mode === 'orchestrator' && !isSubAgent;
    const isExplorer = req._role === 'explore';

    let systemPrompt;
    let tools;
    if (isOrchestrator) {
      systemPrompt = ORCHESTRATOR_SYSTEM_PROMPT;
      tools = ORCHESTRATOR_TOOLS;
    } else if (isExplorer) {
      systemPrompt = EXPLORER_SYSTEM_PROMPT;
      tools = READ_ONLY_TOOLS;
    } else if (req.mode === 'agent' || req.mode === 'orchestrator' || isSubAgent) {
      systemPrompt = AGENT_SYSTEM_PROMPT;
      tools = TOOLS;
    } else {
      systemPrompt = SYSTEM_PROMPT;
      tools = null;
    }

    const projectContext = resolveProjectContext(req);
    const messages = gdevelopOutputToOpenAiMessages({ output: req.output, systemPrompt, projectContext });
    const reasoningEffort = await reasoningEffortFor(req);
    log(`request ${req.id}: calling provider (mode=${req.mode}${isSubAgent ? '/' + req._role : ''}, ${messages.length} msgs, ${tools ? tools.length : 0} tools${reasoningEffort ? ', effort=' + reasoningEffort : ''})`);
    const completion = await callProvider(messages, tools, reasoningEffort);
    // If the request was suspended while the provider call was in flight, don't clobber it.
    if (req._cancelled) {
      req.status = 'suspended';
      req.updatedAt = nowIso();
      return;
    }
    const assistantMsg = openAiChoiceToAssistantMessage(completion.choices[0]);

    // Orchestrator delegated work: spawn sub-agents and tag the function_call with the child id.
    if (isOrchestrator) {
      for (const item of assistantMsg.content) {
        if (item.type === 'function_call' && DELEGATION_TOOLS.has(item.name)) {
          const args = safeJsonParse(item.arguments);
          const role = item.name === 'run_explorer_agent' ? 'explore' : 'edit';
          const child = createSubAgent(req, item.call_id, role, args);
          item.subAgentAiRequestId = child.id;
          if (args && args.short_title) item.short_title = args.short_title;
          processRequest(child); // fire-and-forget; IDE will poll + run its tools
        }
      }
    }

    req.output.push(assistantMsg);
    req.status = 'ready';
    req.updatedAt = nowIso();
    log(`request ${req.id}: ready`);

    // A sub-agent that replied with text and no tool calls has finished its task.
    if (isSubAgent && !assistantMsg.content.some(c => c.type === 'function_call')) {
      finalizeSubAgent(req);
    }
  } catch (err) {
    req.error = { code: 'local-provider-error', message: String((err && err.message) || err) };
    req.status = 'error';
    req.updatedAt = nowIso();
    log(`request ${req.id}: ERROR ${req.error.message}`);
    if (req._parentId) finalizeSubAgent(req); // report failure up so the orchestrator can react
  }
}

/** Public (client-facing) view of an AiRequest, optionally sliced incrementally. */
function viewRequest(req, outputFromMessageId) {
  let output = req.output;
  if (outputFromMessageId) {
    const idx = req.output.findIndex(m => m.messageId === outputFromMessageId);
    if (idx >= 0) output = req.output.slice(idx);
  }
  return {
    id: req.id,
    createdAt: req.createdAt,
    updatedAt: req.updatedAt,
    userId: req.userId,
    gameId: req.gameId || null,
    status: req.status,
    mode: req.mode,
    aiConfiguration: req.aiConfiguration || { presetId: 'default' },
    toolsVersion: req.toolsVersion || 'v5',
    toolOptions: req.toolOptions || null,
    error: req.error || null,
    parentAiRequestId: req._parentId || null,
    forkedFromAiRequestId: req.forkedFromAiRequestId || null,
    forkedAfterOriginalMessageId: req.forkedAfterOriginalMessageId || null,
    forkedAfterNewMessageId: req.forkedAfterNewMessageId || null,
    output,
    lastUserMessagePriceInCredits: 0,
    totalPriceInCredits: 0,
  };
}

// ---------------------------------------------------------------------------
// Events generation (Phase 2)
// ---------------------------------------------------------------------------
function resolveBlob(inline, key) {
  if (inline) return inline;
  if (key) return uploads.get(key) || null;
  return null;
}

// Events generation is the hardest structured task in the pipeline, so it runs at a
// real reasoning effort and with a validate→repair loop: the generated events are checked
// against the instruction catalog (unknown types, condition/action mix-ups, wrong arity)
// and, on a parse or validation failure, the model is handed the precise problems and
// asked to fix them (AXI-style structured, definitive feedback) — a couple of rounds.
// 'low' keeps the common (valid-first-shot) case fast — the rich catalog reference carries
// correctness; the repair loop only adds calls when there's an actual problem to fix.
const EVENTS_REASONING_EFFORT = process.env.EVENTS_REASONING_EFFORT || 'low';
const EVENTS_MAX_REPAIRS = parseInt(process.env.EVENTS_MAX_REPAIRS || '1', 10);

async function generateOneEventsBatch({ description, objectsList, existingEventsAsText, gameProjectJson }) {
  const userPrompt = buildEventsUserPrompt({ description, objectsList, existingEventsAsText, gameProjectJson });
  const messages = [
    { role: 'system', content: EVENTS_SYSTEM_PROMPT },
    { role: 'user', content: userPrompt },
  ];

  // Track the best (fewest catalog problems) PARSED attempt. We never hard-fail when we have
  // *something* parseable: best-effort events are handed to the IDE, whose WASM validation is
  // authoritative — it flags any residual bad instruction in the diagnostic report, which the
  // "Fix with AI" button can then clean up. We only throw if nothing parsed at all.
  let best = null; // { events, problems }
  for (let attempt = 0; attempt <= EVENTS_MAX_REPAIRS; attempt++) {
    const completion = await callProvider(messages, null, EVENTS_REASONING_EFFORT);
    const text = (completion.choices[0].message && completion.choices[0].message.content) || '';
    const events = parseEventsFromLLM(text);
    const problems = events
      ? validateEvents(events)
      : ['Output was not valid JSON. Return ONLY {"events": [...]} with no prose or markdown fences.'];

    if (events && problems.length === 0) {
      if (attempt > 0) log(`events generation: clean after ${attempt} repair round(s)`);
      return events;
    }
    if (events && (!best || problems.length < best.problems.length)) best = { events, problems };

    if (attempt < EVENTS_MAX_REPAIRS) {
      log(`events generation: ${problems.length} problem(s), repairing (round ${attempt + 1})`);
      messages.push({ role: 'assistant', content: text });
      messages.push({
        role: 'user',
        content:
          `Your events have these problems:\n- ${problems.slice(0, 20).join('\n- ')}\n\n` +
          `Fix ONLY the offending instructions by choosing a valid type from the CATALOG above (respect [c]/[a] and the slot list). ` +
          `KEEP every piece of requested logic — do NOT delete events or drop requirements to make a problem go away. ` +
          `Return the complete corrected {"events": [...]} only.`,
      });
    }
  }

  if (best) {
    if (best.problems.length)
      log(`events generation: returning best-effort with ${best.problems.length} unresolved problem(s) — IDE will flag them`);
    return best.events;
  }
  throw new Error('Could not parse events JSON from the model output');
}

function emptyChangeExtras() {
  return {
    isEventsJsonValid: true,
    areEventsValid: true,
    extensionNames: [],
    diagnosticLines: [],
    undeclaredVariables: [],
    undeclaredObjectVariables: {},
    missingObjectBehaviors: {},
    missingResources: [],
  };
}

async function processGeneratedEvent(record, body) {
  try {
    const gameProjectJson = resolveBlob(body.gameProjectJson, body.gameProjectJsonUserRelativeKey);
    const existingEventsAsText = body.existingEventsAsText || '';
    const objectsList = body.objectsList || '';
    const changes = [];

    const batches =
      Array.isArray(body.eventBatches) && body.eventBatches.length
        ? body.eventBatches
        : [{ eventsDescription: body.eventsDescription || '', placementRelation: 'at_end' }];

    for (const batch of batches) {
      const description = batch.eventsDescription || body.eventsDescription || '';
      if (!description) continue;
      const events = await generateOneEventsBatch({
        description,
        objectsList,
        existingEventsAsText,
        gameProjectJson,
      });
      const { operationName, operationTargetEvent } = placementToOperation(batch);
      changes.push({
        operationName,
        operationTargetEvent,
        generatedEvents: JSON.stringify(events),
        ...emptyChangeExtras(),
      });
    }

    record.changes = changes;
    record.resultMessage = `Generated ${changes.length} events change(s).`;
    record.status = 'ready';
    record.updatedAt = nowIso();
    log(`ai-generated-event ${record.id}: ready (${changes.length} change(s))`);
  } catch (err) {
    record.error = { code: 'local-events-error', message: String((err && err.message) || err) };
    record.status = 'error';
    record.updatedAt = nowIso();
    log(`ai-generated-event ${record.id}: ERROR ${record.error.message}`);
  }
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const app = express();
// Lock CORS to the local GDevelop IDE origin(s) only. This is the key defense against a
// malicious web page (open in the user's browser) issuing cross-origin requests to the
// proxy to repoint the provider and exfiltrate the API key (CSRF). Non-browser callers
// (curl, the IDE's own server-side, no Origin header) are allowed. Override with
// ALLOWED_ORIGINS (comma-separated) if the IDE runs on a different origin.
const ALLOWED_ORIGINS = new Set(
  (process.env.ALLOWED_ORIGINS ||
    'http://localhost:3000,http://127.0.0.1:3000,http://localhost:4000,http://127.0.0.1:4000')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
);
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || ALLOWED_ORIGINS.has(origin)) return cb(null, true);
      cb(null, false); // disallowed origin -> browser blocks the request
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'Link'],
    exposedHeaders: ['Link'],
  })
);

// Presigned-URL upload target — registered BEFORE express.json so we capture the
// raw blob regardless of content-type. Mirrors POST /ai-user-content/.../create-presigned-urls.
app.put('/_upload/:key', express.raw({ type: '*/*', limit: '96mb' }), (req, res) => {
  const key = req.params.key;
  uploads.set(key, Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body || ''));
  capMap(uploads, MAX_UPLOADS);
  log(`upload stored: ${key} (${uploads.get(key).length} bytes)`);
  res.status(200).send('OK');
});

app.use(express.json({ limit: '96mb' }));

// Config UI (browser) + health (JSON)
app.get('/', (req, res) => {
  if ((req.headers.accept || '').includes('application/json')) {
    return res.json({ ok: true, service: 'gdevelop-ai-proxy', provider: { baseUrl: cfg.baseUrl, model: cfg.model }, activeRequests: requests.size });
  }
  res.type('html').send(CONFIG_UI_HTML);
});
app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'gdevelop-ai-proxy', provider: { baseUrl: cfg.baseUrl, model: cfg.model }, activeRequests: requests.size });
});

// Runtime provider config: read (secrets masked) + update.
const SENSITIVE_HEADER = /authorization|api[-_]?key|token|secret|cookie/i;
const redactHeaders = h =>
  Object.fromEntries(Object.entries(h || {}).map(([k, v]) => [k, SENSITIVE_HEADER.test(k) ? '***' : v]));
const publicConfig = () => ({
  baseUrl: cfg.baseUrl,
  model: cfg.model,
  maxTokens: cfg.maxTokens,
  temperature: cfg.temperature,
  authSource: cfg.authSource,
  extraHeaders: redactHeaders(cfg.extraHeaders),
  hasKey: !!cfg.apiKey || authSourceProvidesKey(),
});
app.get('/config', (_req, res) => res.json(publicConfig()));
// Models the local oh-my-pi install knows about (for the config UI provider/model picker).
app.get('/omp-models', async (_req, res) => {
  try {
    res.json({ models: await listOmpModels() });
  } catch (e) {
    res.json({ models: [], error: String((e && e.message) || e).slice(0, 200) });
  }
});
app.post('/config', (req, res) => {
  const b = req.body || {};
  if (typeof b.baseUrl === 'string' && b.baseUrl.trim()) {
    let u;
    try { u = new URL(b.baseUrl.trim()); } catch (e) { return res.status(400).json({ code: 'bad-config', message: 'baseUrl is not a valid URL' }); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return res.status(400).json({ code: 'bad-config', message: 'baseUrl must be http(s)' });
    const host = u.hostname.toLowerCase();
    if (host.startsWith('169.254.') || host === 'metadata.google.internal' || host === 'metadata') {
      return res.status(400).json({ code: 'bad-config', message: 'baseUrl host is not allowed (link-local/metadata)' });
    }
    const next = b.baseUrl.trim().replace(/\/+$/, '');
    if (next !== cfg.baseUrl) { cfg._reasoningUnsupported = false; cfg._minimalUnsupported = false; }
    cfg.baseUrl = next;
  }
  if (typeof b.model === 'string' && b.model.trim()) {
    if (b.model.trim() !== cfg.model) { cfg._reasoningUnsupported = false; cfg._minimalUnsupported = false; }
    cfg.model = b.model.trim();
  }
  if (typeof b.apiKey === 'string' && b.apiKey) cfg.apiKey = b.apiKey;
  if (typeof b.authSource === 'string') {
    cfg.authSource = b.authSource;
    // Warm the static key cache for omp:<provider> sources so the next request has it.
    if (cfg.authSource.startsWith('omp:')) ensureOmpApiKey(cfg.authSource.slice(4));
  }
  if (b.temperature !== undefined && !Number.isNaN(Number(b.temperature))) cfg.temperature = Number(b.temperature);
  if (b.maxTokens !== undefined && !Number.isNaN(parseInt(b.maxTokens, 10))) cfg.maxTokens = parseInt(b.maxTokens, 10);
  if (b.extraHeaders && typeof b.extraHeaders === 'object') {
    // Keep the existing value for any redacted ('***') sensitive header the UI echoed back.
    const merged = {};
    for (const [k, v] of Object.entries(b.extraHeaders)) {
      merged[k] = v === '***' && cfg.extraHeaders[k] !== undefined ? cfg.extraHeaders[k] : v;
    }
    cfg.extraHeaders = merged;
  }
  saveConfigFile();
  log(`config updated via UI: ${cfg.baseUrl} model=${cfg.model} auth=${cfg.authSource || 'api-key'}`);
  res.json(publicConfig());
});
app.post('/config/test', async (_req, res) => {
  try {
    const completion = await callProvider([{ role: 'user', content: 'Reply with exactly: OK' }], null);
    const text = (completion.choices[0].message && completion.choices[0].message.content) || '';
    res.json({ ok: true, message: `Connected to ${cfg.model}. Reply: ${text.slice(0, 80)}` });
  } catch (e) {
    res.json({ ok: false, message: String((e && e.message) || e).slice(0, 300) });
  }
});

// Create presigned upload URLs (point back at this shim).
app.post('/ai-user-content/action/create-presigned-urls', (req, res) => {
  const base = `http://localhost:${PORT}/_upload`;
  const out = {};
  const mk = (hash, prefix) => {
    const key = `${prefix}/${hash || newMessageId('blob')}`;
    return { signedUrl: `${base}/${encodeURIComponent(key)}`, key };
  };
  if (req.body.gameProjectJsonHash !== undefined) {
    const { signedUrl, key } = mk(req.body.gameProjectJsonHash, 'game-project');
    out.gameProjectJsonSignedUrl = signedUrl;
    out.gameProjectJsonUserRelativeKey = key;
  }
  if (req.body.projectSpecificExtensionsSummaryJsonHash !== undefined) {
    const { signedUrl, key } = mk(
      req.body.projectSpecificExtensionsSummaryJsonHash,
      'extensions-summary'
    );
    out.projectSpecificExtensionsSummaryJsonSignedUrl = signedUrl;
    out.projectSpecificExtensionsSummaryJsonUserRelativeKey = key;
  }
  if (req.body.eventsJsonHash !== undefined) {
    const { signedUrl, key } = mk(req.body.eventsJsonHash, 'events');
    out.eventsJsonSignedUrl = signedUrl;
    out.eventsJsonUserRelativeKey = key;
  }
  res.json(out);
});

// Asset search (Phase 5): the agent's create_object(search_terms=...) path calls this.
// We text-match GDevelop's PUBLIC asset database and return AssetShortHeaders; the IDE
// then resolves the full asset + installs it from the public CDN (no auth needed).
let assetHeadersCache = null;
let assetHeadersFetchedAt = 0;
let assetFetchInFlight = null;
async function fetchWithTimeout(url, ms = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}
async function getAssetShortHeaders() {
  if (assetHeadersCache && Date.now() - assetHeadersFetchedAt < 60 * 60 * 1000) return assetHeadersCache;
  if (assetFetchInFlight) return assetFetchInFlight; // coalesce concurrent callers
  assetFetchInFlight = (async () => {
    try {
      const metaRes = await fetchWithTimeout('https://api.gdevelop.io/asset/asset?environment=live');
      if (!metaRes.ok) throw new Error(`asset meta ${metaRes.status}`);
      const meta = await metaRes.json();
      const res = await fetchWithTimeout(meta.assetShortHeadersUrl);
      if (!res.ok) throw new Error(`asset short-headers ${res.status}`);
      assetHeadersCache = await res.json();
      assetHeadersFetchedAt = Date.now();
      log(`asset database loaded: ${assetHeadersCache.length} assets`);
      return assetHeadersCache;
    } finally {
      assetFetchInFlight = null;
    }
  })();
  return assetFetchInFlight;
}
function makeAssetSearch(userId, body, results) {
  return {
    id: `assetsearch_${Date.now().toString(36)}`,
    userId: userId || 'local-user',
    createdAt: nowIso(),
    query: {
      searchTerms: (body.searchTerms || '').split(/\s+/).filter(Boolean),
      objectType: body.objectType || null,
      description: body.description || null,
      twoDimensionalViewKind: body.twoDimensionalViewKind || null,
      relatedAiRequestId: body.relatedAiRequestId || null,
      lastUserMessage: body.lastUserMessage || null,
      lastAssistantMessages: body.lastAssistantMessages || [],
    },
    status: 'completed',
    results,
  };
}
app.post('/asset-search', async (req, res) => {
  const b = req.body || {};
  const userId = req.query.userId;
  let headers;
  try {
    headers = await getAssetShortHeaders();
  } catch (e) {
    log(`asset-search failed to load DB: ${e.message}`);
    return res.json(makeAssetSearch(userId, b, []));
  }
  const objectType = (b.objectType || '').trim().toLowerCase();
  let results;
  if (b.exactOrPartialAssetId) {
    const idq = String(b.exactOrPartialAssetId).toLowerCase();
    results = headers
      .filter(a => a.id && (a.id.toLowerCase() === idq || a.id.toLowerCase().includes(idq)))
      .slice(0, 8)
      .map(a => ({ score: 1, asset: a }));
  } else {
    const raw = (b.searchTerms || '').toLowerCase().trim();
    const terms = raw.split(/[^a-z0-9]+/).filter(Boolean);
    const scoreAll = useType => {
      const scored = [];
      for (const a of headers) {
        if (useType && objectType && (a.objectType || '').toLowerCase() !== objectType) continue;
        const hay = `${a.name || ''} ${a.shortDescription || ''} ${(a.tags || []).join(' ')}`.toLowerCase();
        let s = 0;
        for (const t of terms) if (hay.includes(t)) s++;
        if (raw && (a.name || '').toLowerCase().includes(raw)) s += 2;
        if (s > 0) scored.push({ score: s / Math.max(1, terms.length), asset: a });
      }
      scored.sort((x, y) => y.score - x.score);
      return scored.slice(0, 8);
    };
    results = scoreAll(true);
    if (!results.length) results = scoreAll(false); // fall back without objectType filter
  }
  log(`asset-search "${b.searchTerms || b.exactOrPartialAssetId}" (type=${objectType || 'any'}) -> ${results.length} results`);
  res.json(makeAssetSearch(userId, b, results));
});

// Events generation: create (async working -> ready) and poll.
app.post('/ai-generated-event', (req, res) => {
  const b = req.body || {};
  const id = `aigenevent_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const record = {
    id,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    userId: req.query.userId || 'local-user',
    status: 'working',
    partialGameProjectJson: '',
    eventsDescription: b.eventsDescription || null,
    eventBatches: b.eventBatches || null,
    extensionNamesList: b.extensionNamesList || '',
    objectsList: b.objectsList || '',
    existingEventsAsText: b.existingEventsAsText || '',
    resultMessage: null,
    changes: null,
    error: null,
    stats: null,
  };
  aiGeneratedEvents.set(id, record);
  capMap(aiGeneratedEvents, MAX_GENERATED_EVENTS, r => r.status === 'working');
  processGeneratedEvent(record, b);
  res.status(200).json(record);
});

app.get('/ai-generated-event/:id', (req, res) => {
  const r = aiGeneratedEvents.get(req.params.id);
  if (!r) return res.status(404).json({ code: 'not-found', message: 'AiGeneratedEvent not found' });
  res.json(r);
});

// List history OR batched status poll: GET /ai-request[?ids=..&include=status]
app.get('/ai-request', (req, res) => {
  const userId = req.query.userId;
  if (req.query.include === 'status' && req.query.ids) {
    const ids = String(req.query.ids).split(',').filter(Boolean);
    const statuses = ids
      .map(id => requests.get(id))
      .filter(Boolean)
      .map(r => ({ id: r.id, status: r.status, userId: r.userId }));
    return res.json(statuses);
  }
  // History list (array), newest first. Exclude sub-agent children (internal).
  const list = [...requests.values()]
    .filter(r => !r._parentId && (!userId || r.userId === userId))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, 10)
    .map(r => viewRequest(r));
  return res.json(list);
});

// Fetch one request (full or incremental).
app.get('/ai-request/:id', (req, res) => {
  const r = requests.get(req.params.id);
  if (!r) return res.status(404).json({ code: 'not-found', message: 'AiRequest not found' });
  res.json(viewRequest(r, req.query.outputFromMessageId || null));
});

// Create a request.
app.post('/ai-request', (req, res) => {
  const b = req.body || {};
  const id = newRequestId();
  const request = {
    id,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    userId: req.query.userId || b.userId || 'local-user',
    gameId: b.gameId || null,
    mode: b.mode || 'chat',
    aiConfiguration: b.aiConfiguration || { presetId: 'default' },
    toolsVersion: b.toolsVersion || 'v5',
    toolOptions: null,
    error: null,
    status: 'working',
    output: [makeUserMessage(b.userRequest)],
    // Stash project context for the background job.
    _gameProjectJson: b.gameProjectJson || null,
    _gameProjectJsonUserRelativeKey: b.gameProjectJsonUserRelativeKey || null,
    _projectSpecificExtensionsSummaryJson: b.projectSpecificExtensionsSummaryJson || null,
    _projectSpecificExtensionsSummaryJsonUserRelativeKey:
      b.projectSpecificExtensionsSummaryJsonUserRelativeKey || null,
  };
  requests.set(id, request);
  // Keep only in-progress requests; old completed ones (incl. finished sub-agents) are evictable.
  capMap(requests, MAX_REQUESTS, r => r.status === 'working');
  // Fire-and-forget the LLM call; the client will poll.
  processRequest(request);
  res.json(viewRequest(request));
});

// Add a follow-up message and/or tool outputs.
app.post('/ai-request/:id/action/add-message', (req, res) => {
  const r = requests.get(req.params.id);
  if (!r) return res.status(404).json({ code: 'not-found', message: 'AiRequest not found' });
  const b = req.body || {};

  for (const fco of b.functionCallOutputs || []) {
    r.output.push({
      type: 'function_call_output',
      call_id: fco.call_id,
      output: typeof fco.output === 'string' ? fco.output : JSON.stringify(fco.output),
    });
  }
  if (b.userMessage && b.userMessage.length) {
    r.output.push(makeUserMessage(b.userMessage));
  }
  // Refresh project context if provided with the follow-up.
  if (b.gameProjectJson !== undefined) r._gameProjectJson = b.gameProjectJson;
  if (b.gameProjectJsonUserRelativeKey !== undefined)
    r._gameProjectJsonUserRelativeKey = b.gameProjectJsonUserRelativeKey;

  if (b.paused) {
    r.status = 'ready';
    r.updatedAt = nowIso();
    return res.json(viewRequest(r));
  }

  r.status = 'working';
  r.updatedAt = nowIso();
  processRequest(r);
  res.json(viewRequest(r));
});

// Suspend an in-flight request. Sets a cancelled flag so an in-flight provider call
// won't overwrite the 'suspended' status when it returns.
app.post('/ai-request/:id/action/suspend', (req, res) => {
  const r = requests.get(req.params.id);
  if (!r) return res.status(404).json({ code: 'not-found', message: 'AiRequest not found' });
  r._cancelled = true;
  r.status = 'suspended';
  r.updatedAt = nowIso();
  res.json(viewRequest(r));
});

// Suggestions / feedback / fork — accepted as no-ops for chat-only.
app.post('/ai-request/:id/action/get-suggestions', (req, res) => {
  const r = requests.get(req.params.id);
  if (!r) return res.status(404).json({ code: 'not-found', message: 'AiRequest not found' });
  res.json(viewRequest(r));
});
app.post('/ai-request/:id/action/set-feedback', (req, res) => {
  const r = requests.get(req.params.id);
  if (!r) return res.status(404).json({ code: 'not-found', message: 'AiRequest not found' });
  res.json(viewRequest(r));
});
app.post('/ai-request/:id/action/fork', (req, res) => {
  const r = requests.get(req.params.id);
  if (!r) return res.status(404).json({ code: 'not-found', message: 'AiRequest not found' });
  // Shallow fork: clone output up to optional upToMessageId.
  const id = newRequestId();
  let output = r.output;
  if (req.body && req.body.upToMessageId) {
    const idx = r.output.findIndex(m => m.messageId === req.body.upToMessageId);
    if (idx >= 0) output = r.output.slice(0, idx + 1);
  }
  const forked = {
    ...r,
    id,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    output: [...output],
    status: 'ready',
    forkedFromAiRequestId: r.id,
    forkedAfterOriginalMessageId: (req.body && req.body.upToMessageId) || null,
    forkedAfterNewMessageId: null,
  };
  requests.set(id, forked);
  res.json(viewRequest(forked));
});

// Version-id checkpoints — accepted no-op.
app.patch('/ai-request/:id/message/:messageId', (_req, res) => {
  res.status(200).json({});
});

// Unknown route -> JSON 404 (never HTML).
app.use((req, res) => {
  res.status(404).json({ code: 'not-found', message: `No route ${req.method} ${req.path}` });
});

// Final error handler: malformed JSON bodies, oversized payloads, or any thrown
// error become clean JSON instead of crashing/hanging the request.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  const status = err.status || err.statusCode || (err.type === 'entity.too.large' ? 413 : 400);
  log(`request error ${req.method} ${req.path}: ${err.message}`);
  if (res.headersSent) return;
  res.status(status >= 400 && status < 600 ? status : 500).json({
    code: err.type || 'bad-request',
    message: String(err.message || 'Request failed').slice(0, 300),
  });
});

// Don't let a stray rejected promise (e.g. a fire-and-forget background job) crash the server.
process.on('unhandledRejection', reason => {
  log(`unhandledRejection: ${String((reason && reason.message) || reason)}`);
});
process.on('uncaughtException', err => {
  log(`uncaughtException: ${String((err && err.message) || err)}`);
});

loadTools();
const catalogCount = loadCatalog(join(__dirname, 'instruction-catalog.json'));

function onListen() {
  log(`provider: ${cfg.baseUrl} model=${cfg.model} auth=${cfg.authSource || (cfg.apiKey ? 'api-key' : 'NONE')}`);
  log(`config UI: http://localhost:${PORT}/`);
  log(`agent tools loaded: ${TOOLS.length} (${toolsPath})`);
  log(`instruction catalog loaded: ${catalogCount} instructions`);
  if (!cfg.apiKey && !authSourceProvidesKey()) log('WARNING: no PROVIDER_API_KEY set and no auth source — provider calls will fail until configured at /');
  if (TOOLS.length === 0) log('WARNING: no tools loaded (tools.json missing) — agent mode will be tool-less');
  if (catalogCount === 0) log('WARNING: no instruction catalog loaded — events generation will be unguided');
  if (cfg.authSource === 'omp-kimi') ensureKimiToken().then(t => log(`kimi token pre-warm: ${t ? 'ok' : 'FAILED (no token found)'}`));
  if ((cfg.authSource || '').startsWith('omp:')) {
    const prov = cfg.authSource.slice(4);
    ensureOmpApiKey(prov).then(k => log(`omp:${prov} key pre-warm: ${k ? 'ok' : 'FAILED (no credential found)'}`));
  }
}

// Bind: if HOST is set (e.g. 0.0.0.0 in Docker) use it; otherwise bind BOTH loopback
// interfaces (IPv4 127.0.0.1 + IPv6 ::1) so http://localhost works regardless of how the
// OS resolves it, while staying loopback-only (not exposed to the LAN).
const servers = [];
if (process.env.HOST) {
  servers.push(app.listen(PORT, process.env.HOST, () => { log(`listening on http://${process.env.HOST}:${PORT}`); onListen(); }));
} else {
  servers.push(app.listen(PORT, '127.0.0.1', () => { log(`listening on http://127.0.0.1:${PORT}`); onListen(); }));
  const s6 = createServer(app);
  s6.on('error', () => {}); // IPv6 loopback may be unavailable — ignore
  s6.listen(PORT, '::1', () => log(`listening on http://[::1]:${PORT}`));
  servers.push(s6);
}

function shutdown(sig) {
  log(`${sig} received — shutting down`);
  let pending = servers.length;
  for (const s of servers) { try { s.close(() => { if (--pending === 0) process.exit(0); }); } catch (e) { if (--pending === 0) process.exit(0); } }
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
