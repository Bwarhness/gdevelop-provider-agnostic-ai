# GDevelop AI Proxy (provider-agnostic)

A small local server that implements (enough of) GDevelop's **Generation API** and
translates it to any **OpenAI-compatible** `/chat/completions` backend — Kimi
(Moonshot), OpenAI, Gemini (OpenAI-compat endpoint), Ollama, vLLM, etc.

This lets GDevelop's built-in **Ask AI** chat run against your own LLM instead of
GDevelop's proprietary cloud. See `../docs/PHASE_0.5_AI_API_MAP.md` for the full
reverse-engineering of GDevelop's AI API.

## What works today (Phase 1)

- **Chat**: ask questions in GDevelop's "Ask AI" panel, get answers from your LLM.
- Project context (the SimplifiedProject JSON) is forwarded to the model when a
  project is open, including the presigned-URL upload path for large projects.
- Async **working → ready** polling, incremental fetch, and multi-turn follow-ups —
  all faithful to what the IDE expects.
- Auth is ignored; no GDevelop account or credits required.

Not yet: tool/function calling (Phase 3), event/project generation (Phase 2),
agent/orchestrator sub-agents (Phase 4), asset search (Phase 5).

## Setup

```sh
cd ai-proxy
npm install
cp .env.example .env     # then edit .env with your provider + key + model
npm start                # listens on http://localhost:4000
```

`.env` example for **Kimi (Moonshot)**:

```
PORT=4000
PROVIDER_BASE_URL=https://api.moonshot.ai/v1
PROVIDER_API_KEY=sk-...your-key...
PROVIDER_MODEL=kimi-k2-0905-preview
```

Other backends: set `PROVIDER_BASE_URL`/`PROVIDER_MODEL` to OpenAI
(`https://api.openai.com/v1`, `gpt-4o`), Ollama (`http://localhost:11434/v1`,
`llama3.1`), vLLM, etc. For local Ollama/vLLM any non-empty `PROVIDER_API_KEY` works.

## Point the GDevelop IDE at it

In `GDevelop/newIDE/app/.env.local` (already created):

```
REACT_APP_LOCAL_AI=true
REACT_APP_GENERATION_API_URL=http://localhost:4000
```

Then (re)start the IDE dev server: `cd GDevelop/newIDE/app && npm start`.
Open http://localhost:3000 → **Ask AI** → chat.

Unset those two env vars (or remove `.env.local`) to fall back to GDevelop's cloud
backend with no other changes.

## Testing without a real provider

```sh
# Terminal 1: a fake OpenAI endpoint that echoes
MOCK_PORT=5099 node src/mock-openai.js
# Terminal 2: the proxy, pointed at the mock
PORT=4000 PROVIDER_BASE_URL=http://localhost:5099/v1 PROVIDER_API_KEY=test PROVIDER_MODEL=mock node src/server.js
```

## Files

- `src/server.js` — the Generation-API shim (endpoints, polling job, presigned uploads).
- `src/translate.js` — GDevelop `output[]` ⇄ OpenAI Chat Completions message mapping (tool-aware).
- `src/mock-openai.js` — a fake `/chat/completions` endpoint for offline testing.
