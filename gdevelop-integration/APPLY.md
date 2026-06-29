# Applying the GDevelop integration

The provider-agnostic AI work needs a handful of small, **env-gated** edits to the GDevelop
newIDE editor. The full GDevelop source is **not** included in this repo (it's a clone of
[4ian/GDevelop](https://github.com/4ian/GDevelop) and carries its own trademark/license).
Instead, this folder ships the changes so you can apply them to your own clone.

There are **12 files**: 10 modified + 2 new (`LocalAiUser.js`, `LocalAiModelSelector.js`).
Every change is inert unless `REACT_APP_LOCAL_AI=true` — without it the editor behaves
exactly like upstream and talks to GDevelop's cloud.

## 1. Clone GDevelop

```sh
git clone --depth 1 https://github.com/4ian/GDevelop.git
```

These changes were made against `master`. If a file has drifted upstream, prefer the
**copy-the-files** method below and re-apply the small edits by hand (they're tiny and
clearly commented with `LocalAi` / `isLocalAiEnabled`).

## 2a. Apply via patch (preferred)

```sh
cd GDevelop
git apply --3way /path/to/gdevelop-integration/changes.patch
```

## 2b. …or copy the files

`gdevelop-integration/files/` mirrors the GDevelop tree. Copy them over your clone:

```sh
cp -r gdevelop-integration/files/newIDE  GDevelop/newIDE
```

(That overwrites the 10 modified files and drops in the 2 new ones.)

## 3. Point the editor at the proxy

Create `GDevelop/newIDE/app/.env.local`:

```ini
REACT_APP_LOCAL_AI=true
REACT_APP_GENERATION_API_URL=http://localhost:4000
REACT_APP_LOCAL_AI_MODE=agent          # chat | agent | orchestrator
```

Then start the proxy (`../ai-proxy`) and the editor:

```sh
cd ai-proxy && npm install && node --env-file=.env src/server.js   # :4000
cd GDevelop/newIDE/app && npm install && npm start                  # :3000
```

Open http://localhost:3000 → **Ask AI**. Configure the model at http://localhost:4000/ or
with the in-chat model picker. Remove `.env.local` to revert to GDevelop's cloud backend.

## What each file does

| File | Change |
|---|---|
| `Profile/LocalAiUser.js` *(new)* | Synthetic AI user (`isLocalAiEnabled`, `getLocalAiMode`, `applyLocalAiUserOverride`) + permissive `limits`/subscription so local mode isn't gated. |
| `Profile/AuthenticatedUserProvider.js` | Wraps the auth context value with `applyLocalAiUserOverride`. |
| `Utils/GDevelopServices/ApiConfigs.js` | `GDevelopGenerationApi.baseUrl` reads `REACT_APP_GENERATION_API_URL`. |
| `Utils/GDevelopServices/Usage.js` | `hasValidSubscriptionPlan`/`canUpgradeSubscription` honor local mode. |
| `AiGeneration/AiConfiguration.js` | All reasoning-level presets available in local mode. |
| `AiGeneration/AiRequestChat/index.js` | Uses `getLocalAiMode()`; renders the model picker. |
| `AiGeneration/AiRequestChat/LocalAiModelSelector.js` *(new)* | In-chat model picker (reads `/omp-models`, writes `/config`). |
| `AiGeneration/AskAiStandAloneForm.js` | Uses `getLocalAiMode()`. |
| `AiGeneration/Utils.js` | Skips cloud project/version saves in local mode. |
| `MainFrame/EditorContainers/HomePage/PlaySection/UseGamesPlatformFrame.js` | Skips the games-platform token fetch in local mode. |
| `MainFrame/EditorContainers/HomePage/UseCourses.js` | Skips the course-recommendation fetch in local mode. |
| `config-overrides.js` | Disables the dev runtime-error overlay so the editor stays clean. |
