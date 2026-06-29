# Phase 2 — Events / game-logic generation (spec & plan)

Goal: let the agent add **game logic (events)** so generated games actually *do* things.
This is the hardest phase. Below is the exact contract + the recommended approach,
derived from reading the GDevelop newIDE source.

## The flow
`add_scene_events` / `generate_events` (EditorFunctions) → `createAiGeneratedEvent`
(`Utils/GDevelopServices/Generation.js:684`) → **POST `/ai-generated-event`** (our shim) →
poll **GET `/ai-generated-event/{id}`** until `status` ready → `UseGenerateEvents.js`
applies via `AiGeneration/ApplyEventsChanges.js` which calls the **WASM**
`unserializeFromJSObject(eventsList, content, 'unserializeFrom', project)` — strict,
client-side validation that throws on bad JSON/instruction types.

## Request the shim receives (POST /ai-generated-event)
`{ sceneName, eventsDescription | eventBatches[], extensionNamesList (CSV), objectsList (CSV),
existingEventsAsText (human-readable), existingEventsJson, gameProjectJson(+UserRelativeKey),
projectSpecificExtensionsSummaryJson, placementHint, relatedAiRequestId, estimatedComplexity }`

## Response the shim must return (AiGeneratedEvent)
`{ id, createdAt, userId, status:'working'|'ready'|'error', ... , changes: AiGeneratedEventChange[] | null, error }`
Each change (`ApplyEventsChanges.js:169`):
```
{ operationName, operationTargetEvent, generatedEvents (STRINGIFIED events JSON | null),
  isEventsJsonValid, areEventsValid, extensionNames[], diagnosticLines[],
  undeclaredVariables[], undeclaredObjectVariables{}, missingObjectBehaviors{}, missingResources[] }
```
`operationName` ∈ { insert_at_end, insert_before_event, insert_after_event, insert_as_sub_event,
insert_and_replace_event, replace_entire_event_and_sub_events, replace_event_but_keep_existing_sub_events,
insert_actions_conditions_at_end, insert_actions_conditions_at_start, replace_all_actions,
replace_all_conditions, delete_event }. For "append new logic" use `insert_at_end` (target null).

## Serialized events JSON (`generatedEvents`, stringified array)
```json
[{
  "type": "BuiltinCommonInstructions::Standard",
  "conditions": [{ "type": { "value": "KeyPressed" }, "parameters": ["", "Space"] }],
  "actions":    [{ "type": { "value": "SimulateJumpKey" }, "parameters": ["Player", "PlatformerObject"] }],
  "events": []
}]
```
Event types: `BuiltinCommonInstructions::Standard | While | Repeat | ForEach | Group | Comment`.
`While` adds a `whileConditions[]`. Instruction = `{ type:{value:"<InstructionType>"}, parameters:[...] }`.
**Parameter order/count is instruction-specific** (object actions take the object name first; behavior
actions take object + behavior name; many take a leading "" for the object-less slot). Getting these
exactly right is the whole difficulty.

## The blocker: instruction-type catalog
Instruction `type.value` strings (e.g. `KeyPressed`, `SimulateJumpKey`, `PlatformBehavior::IsOnFloor`,
`MettreX`, `Cache`/`Montre`, `BuiltinObject::...`) and their parameter specs exist **only in libGD (WASM)**
via `gd.MetadataProvider.getActionMetadata(platform, type)` / `extension.getAllActions()`. There is no
static JSON catalog in the repo.

## Recommended approach (for a focused future session)
1. **Extract the catalog once** using the already-running IDE's WASM: a Puppeteer script that
   `page.evaluate`s over the global `gd` (libGD) — iterate `gd.JsPlatform.get()` extensions,
   `getAllActions()/getAllConditions()`, and for each dump `{ type, fullName, description,
   parameters:[{type,name,optional}] }` to `ai-proxy/src/instruction-catalog.json`. (libGD is already
   loaded at `localhost:3000`; this avoids embedding WASM in the shim.)
2. **Shim `/ai-generated-event`**: async job (working→ready like /ai-request). For each
   description/batch, prompt the LLM with: the scene's `objectsList` + behaviors (from gameProjectJson),
   `existingEventsAsText`, and the **relevant subset of the catalog** (filter by the objects'/behaviors'
   extensions to keep tokens sane). Ask for the events JSON in the exact shape above. Return a change
   with `operationName:'insert_at_end'` and `generatedEvents` = the stringified array. Set
   `isEventsJsonValid/areEventsValid: true` (the IDE re-validates via WASM regardless).
3. **Re-enable** `add_scene_events`/`generate_events` (remove from `DISABLED_TOOLS` in server.js).
4. **Iterate**: the IDE's `ApplyEventsChanges` sets `areEventsValid` and `diagnosticLines`; surface
   those back so the LLM can self-correct on a retry (the real backend retries too —
   `AiGeneratedEventStats.retriesCount`).

## Alternative (more robust, more work)
Embed `libGD.js` in the shim (Node can load the same WASM the IDE uses) and have the shim *build/validate*
events via `gd.Serializer`/`gd.MetadataProvider` from an intermediate LLM description — removes the
guesswork but requires initializing the platform + a project context server-side.

## Risk
Even with the catalog, parameter-order mistakes are common → `areEventsValid:false`. Expect a
retry loop. Simple input→movement→visibility logic is achievable first; complex logic is uncertain.
