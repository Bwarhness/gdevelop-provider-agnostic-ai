# Provider-agnostic AI for GDevelop

Make GDevelop's built-in **Ask AI** features run against **any OpenAI-compatible LLM**
(Kimi, OpenAI, Gemini, Ollama, vLLM, …) instead of GDevelop's proprietary cloud
backend — for chat, and for agentic project building/editing via tools.

## Status

| Phase | What | Status |
|---|---|---|
| 0 | Clone, build & run the GDevelop IDE locally | ✅ |
| 0.5 | Reverse-engineer the AI API surface | ✅ (`docs/PHASE_0.5_AI_API_MAP.md`) |
| 1 | Chat-only, provider-agnostic | ✅ verified in-browser |
| 2 | Events/logic generation | ✅ verified (agent wrote working platformer events) |
| 3 | Tool/function calling (agent edits the project) | ✅ verified in-browser, real Kimi |
| 5 | Asset/resource search (real sprites) | ✅ verified in-browser |
| 6 | Polish — in-app config UI (proxy `/`), Docker, docs | ✅ |
| 4 | Orchestrator / sub-agents | ✅ planner delegates to edit/explore sub-agents |

Verified end-to-end on **real Kimi**: the agent built a complete playable platformer —
project, scene, a Player sprite with the Platformer Character behavior, ground platforms
(real assets), placed instances, and working events (arrow-key movement + space to jump) —
all executed on the real project by GDevelop's own tool runner.

## Layout

- `GDevelop/` — the cloned IDE (4ian/GDevelop). The editor is `newIDE/app`.
  - 3 small, env-gated edits: `src/Utils/GDevelopServices/ApiConfigs.js` (baseURL),
    `src/Profile/LocalAiUser.js` (synthetic user + mode), `src/AiGeneration/AiRequestChat/index.js`
    + `AskAiStandAloneForm.js` (mode). All controlled by `newIDE/app/.env.local`.
- `ai-proxy/` — the provider-agnostic shim (implements GDevelop's Generation API,
  translates to `/chat/completions`, tool-aware). See `ai-proxy/README.md`.
- `e2e/` — Puppeteer scripts that drive the real IDE for verification.
- `docs/PHASE_0.5_AI_API_MAP.md` — the full API reverse-engineering reference.

## Run it

Two processes: the proxy (port 4000) and the IDE dev server (port 3000).

```sh
# 1) Proxy — edit ai-proxy/.env first (provider base URL, key, model)
cd ai-proxy && npm install && node --env-file=.env src/server.js

# 2) IDE (separate terminal) — newIDE/app/.env.local already points it at the proxy
cd GDevelop/newIDE/app && npm install && npm start
# open http://localhost:3000  ->  "Ask AI"
```

Or use the helper: `./run.ps1` (starts both, waits for the editor to compile).

### Modes
`newIDE/app/.env.local`:
- `REACT_APP_LOCAL_AI=true` — enable the local provider (synthetic user, no GDevelop account).
- `REACT_APP_GENERATION_API_URL=http://localhost:4000` — point at the proxy.
- `REACT_APP_LOCAL_AI_MODE=chat|agent|orchestrator` — `chat` = Q&A; `agent` = the AI edits the project via tools (default, recommended); `orchestrator` = a planner that delegates each step to edit/explore sub-agents (Phase 4).

Remove `.env.local` (or unset the vars) to fall back to GDevelop's cloud backend unchanged.

### Provider
Two ways to configure the backend:
- **In-app config UI** — open **http://localhost:4000/** (the proxy serves a settings
  page). Two ways to pick a backend there:
  - **Agent dropdown** — if you have a local **oh-my-pi** (`omp`) install, the page lists
    every OpenAI-compatible model it knows about (Kimi, Xiaomi MiMo, opencode-go, …) with
    a ✓ where a credential is already on file. Pick one and click **Use this agent** — base
    URL, model, and auth source are filled and saved in one click (e.g. Xiaomi
    *MiMo-V2.5-Pro-UltraSpeed*).
  - **Presets / manual** — pick a preset (OpenAI / Ollama / vLLM / Gemini / Kimi / Xiaomi)
    or type base URL + key + model, **Test connection**, and **Save**.
  All changes apply to the running proxy live.
- **`ai-proxy/.env`** — for startup defaults. The repo default uses the local oh-my-pi
  (`omp`) Kimi credentials (`PROVIDER_AUTH_SOURCE=omp-kimi`, auto-refreshing the
  short-lived token). For a static-key oh-my-pi provider use `PROVIDER_AUTH_SOURCE=omp:<provider>`
  (e.g. `omp:xiaomi`); for a normal provider just set `PROVIDER_API_KEY`.

### Reasoning level
GDevelop's reasoning-level selector (the pill under the chat box) maps to the provider's
`reasoning_effort` (`minimal`/`low`/`medium`/`high`) — the proxy reads the level for the
selected preset from GDevelop's published AI settings and forwards it. Providers that don't
support the param (or a specific value — e.g. Xiaomi MiMo rejects `minimal` alongside tools)
are auto-detected and the proxy adapts (drops the param, or floors `minimal`→`low`) and
remembers. In **local mode** all reasoning levels are unlocked (no GDevelop subscription
needed). The model's chain-of-thought, when returned, is shown as a "thinking" bubble.

### Docker (proxy)
```sh
PROVIDER_API_KEY=sk-... PROVIDER_BASE_URL=https://api.openai.com/v1 PROVIDER_MODEL=gpt-4o \
  docker compose up --build
```
Runs the proxy in a container on :4000 (the IDE still runs on the host). Use a
static-key provider when containerized — `omp-kimi` needs the host's oh-my-pi install.

## Tests & hardening
```sh
cd ai-proxy && npm test    # 26 tests (unit + integration; spawns the proxy + a mock backend)
```
The proxy is hardened for long-running use: provider-call timeouts + retry/backoff, non-blocking
token refresh, bounded in-memory state, JSON error/404 handling, crash guards
(unhandledRejection/uncaughtException), graceful shutdown, and localhost-only bind by default
(`HOST` to override). The browser flows are verified by the scripts in `e2e/`.

## Notes / known issues
- react-scripts inlines `REACT_APP_*` at dev-server start — change `.env.local` then **restart** `npm start`.
- Background GDevelop cloud calls under the synthetic user (games-platform token, course
  recommendations) are skipped when `REACT_APP_LOCAL_AI=true`, and the dev runtime-error
  overlay is disabled (`config-overrides.js`), so the editor stays clean.
- **Premium gates in local mode**: with the local provider there is no GDevelop
  subscription, so the synthetic user is given a permissive `limits` + a synthetic
  subscription (`src/Profile/LocalAiUser.js`) and `hasValidSubscriptionPlan`/
  `canUpgradeSubscription` honor local mode (`Utils/GDevelopServices/Usage.js`). This
  unlocks the purely client-side premium features (loading-screen watermark removal,
  Wi-Fi/LAN preview, leaderboard theming/CSS, hot-reload/debugger nudges, and removes the
  "upgrade" upsells). Cloud-delivered features (online builds, course/asset purchases,
  classroom/team) stay gated — they require a real account server-side. The free "Ask AI"
  send path is preserved (no `consumed-ai-credits` quota injected).
- GDevelop's name/logo are proprietary; rebrand before redistributing.
