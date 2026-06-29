# GDevelop AI API — Phase 0.5 Reference

> Scope: making GDevelop newIDE's "Ask AI" features provider-agnostic (route to any OpenAI-compatible LLM). Synthesized from 6 parallel reads of `C:/Users/nalar/gdeveloplocal/GDevelop`. Repo paths below are relative to `GDevelop/newIDE/app/src/` unless absolute.

---

## 1. Overview

GDevelop's "Ask AI" is built around a **server-owned, append-only conversation object** called an `AiRequest`. The client never talks to an LLM directly; it talks only to GDevelop's own Generation REST API (`GDevelopGenerationApi.baseUrl` = `https://api.gdevelop.io/generation`, dev: `https://api-dev.gdevelop.io/generation`). The client **creates** a request (`POST /ai-request`), then **polls** it (`GET /ai-request/{id}`) until `status` flips from `working` to `ready`, stitching in incremental message slices as they arrive. The conversation `output[]` is an **OpenAI Responses-API-style** array of items (`message` with content parts `user_request`/`output_text`/`reasoning`, plus `function_call` and `function_call_output` items). In `agent`/`orchestrator` modes the model emits `function_call` items; the client executes them locally via the `EditorFunctions` registry (mutating the in-memory libGDevelop WASM project), then posts `function_call_output` items back via `POST .../action/add-message`, which flips the request back to `working` — an agentic loop driven entirely by polling. The model, tool schemas, sub-agent orchestration, and the exact message schema all live **server-side**; the frontend is a thin state machine over them.

---

## 2. Endpoint catalog

All under `GDevelopGenerationApi.baseUrl` except `fetchAiSettings` (separate CDN) and presigned PUTs (S3). Every authenticated call sends `Authorization: <getAuthorizationHeader()>` header + `userId` query param; most POST bodies carry `gdevelopVersionWithHash`.

| # | METHOD path | Purpose | Key request fields | Response | Tier |
|---|---|---|---|---|---|
| 1 | `GET /ai-request/{id}` | Fetch one request (full or incremental slice) | query: `userId`, `outputFromMessageId` | `AiRequest` | chat-only |
| 2 | `GET /ai-request?ids=…&include=status` | Batched status-only poll (parent + sub-agents) | query: `userId`, `ids` (comma-joined), `include=status` | `Array<{id,status,userId}>` | full (agent polling) |
| 3 | `GET /ai-request` | History list (paginated) | query: `userId`, `perPage:10`; `Link` header → `nextPageUri` | `{aiRequests:[…], nextPageUri}` | chat-only (UX) |
| 4 | `POST /ai-request` | **Create** a request | `mode`('chat'\|'agent'\|'orchestrator'), `userRequest`, `gameProjectJson`(+`UserRelativeKey`), `projectSpecificExtensionsSummaryJson`(+Key), `payWithCredits`, `payWithAiCredits`(=!payWithCredits), `aiConfiguration:{presetId}`, `gameId`, `projectVersionIdBeforeMessage`, `fileMetadata`, `storageProviderName`, `toolsVersion`(='v5'), `gdevelopVersionWithHash` | `AiRequest` (must have `id`) | chat-only |
| 5 | `POST /ai-request/{id}/action/add-message` | Follow-up turn / **post tool results** | `functionCallOutputs:[]`, `userMessage`, `paused`, `mode`, `toolsVersion`, `gameProjectJson`(+Key), `projectVersionIdBeforeMessage`, `payWithCredits`/`payWithAiCredits` | `AiRequest` (back to `working`) | chat-only |
| 6 | `POST /ai-request/{id}/action/suspend` | Abort an in-flight request | `{}` | `AiRequest` | full (UX) |
| 7 | `PATCH /ai-request/{id}/message/{messageId}` | Record project-version checkpoints | `projectVersionIdBeforeMessage`, `…AfterMessage` | void | UX |
| 8 | `POST /ai-request/{id}/action/set-feedback` | Like/dislike a message | `messageIndex`, `feedback`('like'\|'dislike'), `reason`, `freeFormDetails` | `AiRequest` | UX |
| 9 | `POST /ai-request/{id}/action/get-suggestions` | Follow-up suggestions for a message | `suggestionsType`('simple-list'\|'list-with-explanations'), `gameProjectJson`(+Key), extensions summary | `AiRequest` | UX (agent/orchestrator only) |
| 10 | `POST /ai-request/{id}/action/fork` | Branch a conversation | `upToMessageId` | `AiRequest` | UX |
| 11 | `POST /ai-generated-event` | Generate scene events (used by `add_scene_events`/`generate_events` tool) | `sceneName`, `eventsDescription`, `eventBatches`, `extensionNamesList`, `objectsList`, `existingEventsAsText`, `existingEventsJson`(+Key), `gameProjectJson`(+Key), `placementHint`, `relatedAiRequestId`, `estimatedComplexity` | 200→`{creationSucceeded:true, aiGeneratedEvent}`, 400→`{creationSucceeded:false, errorMessage}`, else throw | full (project-gen) |
| 12 | `GET /ai-generated-event/{id}` | Poll async event generation | query: `userId` | `AiGeneratedEvent` | full |
| 13 | `POST /asset-search` | Agent asset-store search | `searchTerms`, `description`, `objectType`, `twoDimensionalViewKind`, `exactOrPartialAssetId`, `relatedAiRequestId`, `lastUserMessage`, `lastAssistantMessages` | `AssetSearch{results:[{score,asset}]}` | full (assets) |
| 14 | `POST /resource-search` | Agent resource search | `searchTerms`, `resourceKind` | `ResourceSearch{results:[{score,resource:{name,url}}]}` | full (assets) |
| 15 | `POST /ai-user-content/action/create-presigned-urls` | Get S3 PUT URLs for large blobs | `gameProjectJsonHash`, `projectSpecificExtensionsSummaryJsonHash`, `eventsJsonHash` | signed PUT URLs + `*UserRelativeKey` per blob | full (and chat when project JSON is large) |
| — | `PUT <signedUrl>` (S3) | Upload large project/events JSON out-of-band | raw JSON body | (S3 200) | conditional |
| — | `GET {GDevelopAiCdn.baseUrl}/ai-settings-v2.json` | **Unauthenticated** preset list for the mode/preset selector | (none) | `AiSettings{aiRequest:{presets:[…]}}` | chat-only (UX, optional) |

Note: endpoints 1 and 2 use **bare `axios.get` with interpolated baseUrl**, not the shared `apiClient`. Both still read the same `GDevelopGenerationApi.baseUrl` constant, so overriding that constant redirects them too — but swapping `apiClient`'s `baseURL` alone would NOT redirect them.

---

## 3. Message & data format

### `AiRequest` (the core object — `Generation.js:112`)
```
{
  id, status: 'working'|'ready'|'error'|'suspended',
  mode: 'chat'|'agent'|'orchestrator',
  userId,
  output: Array<AiRequestMessage>,   // append-only conversation
  totalPriceInCredits, ...
}
```
The UI drives all state (working/ready/suspended, message rendering, function-call execution) off this shape. A local provider MUST emit this exact schema — not a raw OpenAI chat completion.

### `output[]` item types (OpenAI Responses-API style)
- **`message`** — `{ type:'message', role:'user'|'assistant', content:[…], messageId, suggestions?, projectVersionIdBeforeMessage?, projectVersionIdAfterMessage? }`. Content parts:
  - `user_request` — the user's prompt text (inside a `user` message).
  - `output_text` — assistant natural-language text.
  - `reasoning` — assistant reasoning trace.
  - `function_call` — `{ type:'function_call', call_id, name, arguments (JSON string), short_title?, subAgentAiRequestId? }`. May appear inside an assistant `message`'s content array.
- **`function_call_output`** — `{ type:'function_call_output', call_id, output: JSON.stringify({success, ...output}) }`. Client-produced tool result, posted back via add-message.

`messageId` is load-bearing for incremental fetch (see §4). `suggestions` are a chat-UI concept (`AiRequestChat/SuggestionLines.js`), unrelated to tool outputs.

### Mapping to OpenAI APIs
- **OpenAI Chat Completions**: `message`(role user/assistant + text) ↔ `messages[]`. A `function_call` item ↔ an assistant message with `tool_calls:[{id:call_id, function:{name, arguments}}]`. A `function_call_output` ↔ a `role:'tool'` message with `tool_call_id=call_id` and `content=output`. The `reasoning` part has no chat-completions equivalent (drop or fold into content).
- **OpenAI Responses API** (closest match): the GDevelop `output[]` array is essentially the Responses `output`/`input` item list. `function_call` ↔ Responses `function_call` item (`call_id`, `name`, `arguments`); `function_call_output` ↔ Responses `function_call_output` item (`call_id`, `output`); `reasoning` ↔ Responses `reasoning` item; `message`/`output_text` ↔ Responses `message`/`output_text`. **Tool-call mapping is the cleanest against the Responses API**: `call_id` is the join key in both directions, and arguments/output are JSON strings in both.

A local shim wrapping an OpenAI-compatible provider must: (a) translate `output[]` ↔ the provider's message list, (b) re-wrap synchronous completions in an async job so `GET status` can report `working`→`ready`, and (c) preserve `messageId`, `call_id`, `subAgentAiRequestId`, `short_title`, `suggestions`, and `projectVersionId{Before,After}Message`.

---

## 4. Request lifecycle & polling

### Create → poll → ready
1. **Create**: `createAiRequest` (`Generation.js:388`) POSTs `/ai-request`; the returned `id` becomes `selectedAiRequestId`, which arms the watch loop.
2. **Poll**: `AiRequestContext.js` holds the central provider (`useAiRequestsStorage`: a `{id→AiRequest}` map). A single adaptive `useInterval` (`AiRequestContext.js:941`) runs `onWatch` (`:795`) for the selected parent **and** all active sub-agents. It only runs when `(shouldWatchRequest || hasActiveSubAgents) && !pendingEditApproval` — polling **pauses** while an inline edit-approval prompt is shown.
3. **Ready**: `aiRequestShouldBeWatched` (`AiRequestUtils.js:237`) = `status==='working'`, OR `status==='ready'` while `getPendingSubAgentFunctionCalls(...).length > 0`. `error`/`suspended` are never watched.

### Cadence
- Base interval = `toolOptions.watchPollingIntervalInMs || 1400` ms; adaptive ×1.5 backoff per idle tick (1400→2100→3150…) capped at `max(base,5000)`. `reportWatchPollingTick(sawChange)` resets to base on activity; `resetWatchPollingInterval()` on selection/watch-state change.
- **Full-fetch fail-safe**: `fullFetchIntervalInMs = 7000`. Per entity each tick: do a full incremental `GET /ai-request/{id}` if `now - lastFullFetch >= 7000`, else add the id to a batched **status-only** `GET /ai-request?ids=…&include=status`. A status change observed in the batched response forces an immediate full fetch.

### Incremental merge (load-bearing contract)
- `doFullFetch` (`AiRequestContext.js:820`) sets `outputFromMessageId` = last known `messageId`. The backend MUST return that message echoed as `output[0]` followed by newer messages.
- `mergeIncrementalAiRequest` (`:561`): if `output[0].messageId === outputFromMessageId` and a cached output exists, it splices `previousOutput.slice(0, spliceIndex)` + fetched slice (taking the echoed tail from the fetched copy so in-place updates like suggestions propagate). Otherwise it treats the response as a full output.
- `aiRequestPollSawActivity` (`:254`): `newMessageCount = incremental ? max(0, fetchedCount-1) : fetchedCount`; activity = status changed OR `newMessageCount > 0`. **If the backend ignores `outputFromMessageId`, merge silently falls back and activity miscounts.**

### Agent function-call loop
1. **Detect**: `getFunctionCallsToProcess` (`AiRequestUtils.js:63`) scans `output[]` from the end, collecting assistant `function_call` items not yet executed (`editorFunctionCallResults`), without a `function_call_output`, and **without** `subAgentAiRequestId` (those run server-side). Stops at the first assistant message with no function calls.
2. **Execute**: `useProcessFunctionCalls` (`Utils.js:213`) auto-runs them. `onProcessFunctionCalls` (`Utils.js:361`) guards duplicates via an in-flight lock (`<reqId>:<callId>`), gates project-modifying calls behind `requestEditApproval` when auto-edit is off, marks calls `working`, runs `processEditorFunctionCalls`, discards results if any came back `aborted`.
3. **Post back**: `getFunctionCallOutputsFromEditorFunctionCallResults` (`AiRequestUtils.js:311`) builds `{type:'function_call_output', call_id, output: JSON.stringify({success,...output})}`; `onSendEditorFunctionCallResults` → `addMessageToAiRequest` (`Generation.js:463`) with `functionCallOutputs[]`; request flips to `working`; loop resumes.

### Chat vs agent vs orchestrator
- **`chat`** — plain Q&A; no tool execution, no agentic loop, no suggestions/auto-save.
- **`agent`** — single agent emitting `function_call`s executed locally and looped back.
- **`orchestrator`** — top-level agent that spawns **server-side sub-agents** (explorer/edit) via `function_call`s carrying `subAgentAiRequestId`. Orchestrator-specific: skip suggestions right after `initialize_project` and while a plan is active; save as cloud project right after `initialize_project`. **The client always sends `orchestrator` mode with `toolsVersion='v5'`** (`Utils.js:97-99`).

### Sub-agents
Created **server-side**; the client only discovers them via `subAgentAiRequestId` on a parent `function_call`. `useActivatePendingSubAgents` → `activateSubAgent(subAgentId, parentId, call_id)` adds them to `activeSubAgentsRef` so `onWatch` polls them in the same batched status request. The backend appends a `function_call_output` for that call to the **parent** when the sub-agent finishes; `removeSubAgentIfDone` then drops it. `useLoadSubAgentRequests` does one-shot fetches for sub-agents of historical/suspended parents.

### Suspend / work-in-progress
`suspendAiRequest` (`AiRequestContext.js:1037`) optimistically sets `status='suspended'`, clears editor results, dismisses edit approval, POSTs `action/suspend`. `aiRequestHasWorkInProgress` (`AiRequestUtils.js:284`) blocks destructive actions (e.g. closing the project) while work is pending.

---

## 5. Tool catalog (EditorFunctions)

Defined in `EditorFunctions/index.js` as a flat name→impl registry. **No client-side JSON schemas exist** — the authoritative tool schemas (names, params, required/optional, enums, descriptions shown to the LLM) live **server-side**. Arg types below are reverse-engineered from `SafeExtractor` calls. Each tool = `{ renderForEditor?, launchFunction, modifiesProject }`. Dispatch: `processEditorFunctionCalls` (`EditorFunctionCallRunner.js:71`) JSON-parses `arguments`, looks up name, enforces project rules (no project + name≠`initialize_project` → "No project opened."; project present + `initialize_project` → rejected), awaits `launchFunction`, builds `{status:'finished', call_id, success, output, didModifyProject}` (`didModifyProject = modifiesProject && success`).

### `editorFunctions` (require an open project) — registry `index.js:6362`
| Tool | Signature (key args) | Purpose | modifies |
|---|---|---|---|
| `create_object` / `create_or_replace_object` | `scene_name*`, `object_name*`, `object_type?`, `target_object_scope?`('scene'\|'global'), `replace_existing_object?`, `duplicated_object_name?`, `duplicated_object_scene?`, `description?`, `search_terms?`, `asset_id?`, `two_dimensional_view_kind?` | Create/replace/duplicate/move an object; can install from asset store or build from scratch; returns properties + `objectSizeInfo` | yes |
| `inspect_object_properties` | `scene_name*`, `object_name*` | Object config properties, behaviors, animation names, var/behavior counts, default size/origin | no |
| `change_object_property` | `scene_name*`, `object_name*`, `changed_properties:[{property_name,new_value}]` | Set object properties; `name` renames; warns on mismatch | yes |
| `add_behavior` | `scene_name*`, `object_name*`, `behavior_type*`, `behavior_name?` | Add behavior to object/group, install extension if needed | yes |
| `remove_behavior` | `scene_name*`, `object_name*`, `behavior_name*` | Remove named behavior | yes |
| `inspect_behavior_properties` | `scene_name*`, `object_name*`, `behavior_name*` | Behavior properties + shared properties | no |
| `change_behavior_property` | `scene_name*`, `object_name*`, `behavior_name*`, `changed_properties:[{property_name,new_value}]` | Set behavior (and shared) properties | yes |
| `describe_instances` | `scene_name*`, `filter_by_object_name?` | List initial instances (id/object/layer/x/y/z/z-order/rotation/size); returns `positionSemantics` + `objectSizeInfo` | no |
| `put_2d_instances` | `scene_name*`, `object_name?`, `layer_name*`, `brush_kind*`('point'\|'line'\|'grid'\|'erase'), `brush_position?`('x,y'), `brush_size?`, `brush_end_position?`, `existing_instance_ids?`(csv), `new_instances_count?`, `instances_z_order?`, `instances_size?`, `row_count?`, `column_count?`, `instances_rotation?`, `instances_opacity?` | Paint/move/erase 2D instances via brush | yes |
| `put_3d_instances` | `scene_name*`, `object_name?`, `layer_name*`, `brush_kind*`, `brush_position?`, `brush_size?`, `brush_end_position?`, `existing_instance_ids?`, `new_instances_count?`, `instances_size?`('w;h;d'), `instances_rotation?`(3-axis) | Same as 2D but with depth + 3-axis rotation | yes |
| `read_scene_events` | `scene_name*` | Scene events rendered as `eventsAsText` | no |
| `add_scene_events` / `generate_events` | `scene_name*`, `events_description?`, `event_batches:[{eventsDescription,placementRelation,placementTargetEventId,placementExpectedParentEventId,placementRationale}]`, `objects_list?`, `placement_hint?` | Generate events from NL (delegates to backend `generateEvents`/`/ai-generated-event`) and insert; returns events text + `aiGeneratedEventId` | yes |
| `create_scene` | `scene_name*`, `include_ui_layer?`, `background_color?`, `is_first_scene?` | Create a layout | yes |
| `delete_scene` | `scene_name*` | Delete a layout | yes |
| `inspect_scene_properties_layers_effects` | `scene_name*` | Scene properties, layers, layer effects, object groups | no |
| `change_scene_properties_layers_effects_groups` | `scene_name*`, `changed_properties?`, `changed_layers?`, `changed_layer_effects?`, `changed_groups?` | Edit scene props/layers/effects/groups in one call | yes |
| `add_or_edit_variable` | `variable_scope*`('global'\|'scene'\|'object'\|'group'), `scene_name?`, `object_name?`, `variables:[{variable_name_or_path,value,variable_type,delete_this_variable?}]` OR legacy single `variable_name_or_path?`/`value?`/`variable_type?` | Create/update/delete one or many variables; nested paths + typed values | yes |
| `inspect_variables` | `variable_scope?`, `scene_name?`, `object_name?`, `variable_names_or_paths?:[]` | Return variables as `SimplifiedVariable` entries | no |
| `read_full_docs` | `extension_names` | **Backend-handled**; client no-op failure ("continue with existing knowledge") | no |
| `search_docs` | `query` (server-side) | **Backend-handled** docs search; client no-op failure | no |
| `create_or_update_plan` | (server-side) | **Backend-only** orchestrator plan; no `renderForEditor`; plan rendered by `OrchestratorPlan` | no |
| `report_fulfilment_problem` | (server-side) | **Backend-only** telemetry; client failure | no |
| `run_explorer_agent` | `short_title?`, (server-side) | Spawn server-side explorer sub-agent; client failure, renders chat title | no |
| `run_edit_agent` | `short_title?`, (server-side) | Spawn server-side edit sub-agent; client failure, renders chat title | yes |
| `read_game_project_json` | (args) | Client no-op (`{success:true}`); backend reads from project JSON sent alongside | no |
| `search_object_asset_store` | (server-side) | **Backend-handled** asset search; client failure | no |

### `editorFunctionsWithoutProject` (no project) — registry `index.js:6397`
| Tool | Signature | Purpose | modifies |
|---|---|---|---|
| `initialize_project` | `project_name*`, `template_slug*`, `also_read_existing_events?` | Create initial project from example template (or empty); sets `meta.createdProject` | yes |
| `get_game_starter_summary` | `template_slug?`, (server-side) | **Backend-handled** starter-template review for planning; client failure, renders chat title | no |

**Wire output** (`AiRequestUtils.js:327`): each finished result → `{type:'function_call_output', call_id, output: JSON.stringify({success, ...output})}` — the entire `EditorFunctionGenericOutput` (message + payload fields: `properties`/`behaviors`/`variables`/`instances`/`layers`/`objectSizeInfo`/`hints`/`eventsAsText`/`meta`…) is JSON-stringified.

---

## 6. Auth

### How `getAuthorizationHeader`/`userId` work
- **Token source** (`Authentication.js:578-583`): `getAuthorizationHeader = async () => 'Bearer ' + await currentUser.getIdToken()` — a real Firebase JWT. **Throws `'User is not authenticated.'` if `auth.currentUser` is null** (`:580`). `isAuthenticated()` = `!!auth.currentUser`.
- **Firebase dependency**: `Authentication`'s constructor unconditionally `initializeApp(GDevelopFirebaseConfig)` + `getAuth(app)` and tracks the user via `onAuthStateChanged`.
- **Provider wiring**: `AuthenticatedUserProvider` owns the `Authentication` instance and sets `context.getAuthorizationHeader = () => this.props.authentication.getAuthorizationHeader()` (`Provider.js:274-275`). It fetches the GDevelop profile via `getUserProfile` → `GET {GDevelopUserApi.baseUrl}/user/{currentUser.uid}` and stores it as `profile`.
- **`userId` is always `profile.id`** (the GDevelop user id from the User API, not the raw Firebase uid — they coincide for real accounts). Every Generation call takes `getAuthorizationHeader` as its first arg, `await`s it, sends `headers:{Authorization}` + `params:{userId}`.
- **Gating** keys off `profile` being non-null (and `getAuthorizationHeader()` resolving), not on `authenticated`/`firebaseUser`. Context default `getAuthorizationHeader` rejects `'Unimplemented'` until the provider overrides it.

### Ranked options to stub/bypass auth locally
1. **(Best, least code) Inject a fake `AuthenticatedUser` via context.** Provide `authenticated:true`, non-null `profile` (`{id:'local-user', email, …}`), `firebaseUser:{uid:'local-user'}`, and `getAuthorizationHeader: () => Promise.resolve('Bearer local-dev')`. The Ask AI path only checks `!profile` and forwards whatever the header returns — fully bypasses Firebase. Templates exist: `fixtures/GDevelopServicesTestData/index.js` (`defaultAuthenticatedUserWithNoSubscription`, `fakeSilverAuthenticatedUser`) use `getAuthorizationHeader: () => Promise.resolve('fake-authorization-header')` (note: non-`Bearer` works in tests, confirming the backend can accept any header). **`profile` must be set or `AskAiEditorContainer.js:497` opens the create-account dialog and aborts.**
2. **(Surgical) Stub the `Authentication` methods.** Make `getAuthorizationHeader()` return a constant, `isAuthenticated()→true`, `getFirebaseUser()→{uid:'local-user'}`, `getUserProfile()→` synthetic `Profile`. Keeps provider plumbing intact; slightly more surface because `getUserProfile` currently hits `GDevelopUserApi /user/{uid}`.
3. **(Server-side only — insufficient alone) Have the shim ignore the Authorization header and any `userId`.** The client still throws `'User is not authenticated.'` if `currentUser` is null, so this MUST be combined with option 1 or 2. Once combined, the shim can ignore both the header and credit checks.

Pick a stable `profile.id` (e.g. `'local-user'`); it is the `userId` the shim receives and keys history on.

---

## 7. UI & gating

Three independent layers, all from `AuthenticatedUserContext`:

1. **AUTHENTICATION (hard gate)** — every send path early-returns when `profile` is falsy: `AskAiEditorContainer.js:497-501` (`if(!profile){ onOpenCreateAccountDialog(); startNewAiRequest(null); return; }`), `:656`/`:1049`/`:1210` (send/feedback/select), `:943-951` (mount effect resets selection when `!profile`); `AskAiStandAloneForm.js:254-258`/`:432`. **Minimal guard to satisfy: a truthy `profile` with an `id` + a `getAuthorizationHeader` that resolves.**
2. **CREDITS/QUOTA (soft gate)** — derived from `limits`: `availableCredits = limits ? limits.credits.userBalance.amount : 0`; `quota = limits.quotas['consumed-ai-credits'] || null`; `aiRequestPriceInCredits = limits.credits.prices['ai-request'].priceInCredits`. The blocking branch (`AskAiEditorContainer.js:513-525`, `:701-719`; `AskAiStandAloneForm.js:277-289`) only fires when `quota && quota.limitReached && aiRequestPriceInCredits`: then `payWithCredits=true` and it returns early if `!automaticallyUseCreditsForAiRequests || availableCredits < price`. **With no quota or unexhausted quota the request is sent free (`payWithCredits=false`, `payWithAiCredits=true`).** UI mirror at `AiRequestChat/index.js:731-737` swaps the form for a "ran out of credits" prompt. **Minimal guard: leave `limits` null OR provide `quota.limitReached=false`.**
3. **PRESETS (not a blocker)** — `fetchAiSettings` (`Generation.js:997`) does an **unauthenticated** `GET {GDevelopAiCdn.baseUrl}/ai-settings-v2.json` (env = `Window.isDev() ? 'staging' : 'live'`). Missing/failed → `getAiConfigurationPresetsWithAvailability` returns `[]` (`AiConfiguration.js:22`), `getDefaultAiConfigurationPresetId` → `'default'` (`:64`), UI sends `aiConfiguration:{presetId:'default'}` and renders zero preset options. Non-default presets are also disabled by `limits.capabilities.ai.availablePresets`.

Other notes: subscription (`hasValidSubscriptionPlan`/`canUpgradeSubscription`) only affects upsell copy, never whether a request is allowed. The classroom `limits.capabilities.classrooms.hideAskAi` hides **only** the standalone form (`AskAiStandAloneForm.js:220-223`), not the in-editor container. `getPriceAndRequestsTextAndTooltip` returns a bare placeholder div when `!quota || !price` (no crash). With a fake user, `limits`/credits calls (same `getAuthorizationHeader`) may fail; code tolerates null `limits`, but you may want the shim to return a fake `limits` so the price display renders.

---

## 8. Events/project pipeline

### Serialization (`gameProjectJson` is the SimplifiedProject, not the full project)
- The IDE sends a **reduced `SimplifiedProject`** (`makeSimplifiedProjectBuilder().getSimplifiedProject`, built at `UseGenerateEvents.js:71-77`) under the field name `gameProjectJson` — NOT a full `gd.Project` serialization. Plus a project-specific extensions summary and (when `toolOptions.includeEventsJson`) the scene events serialized via `serializeToJSON`.
- **Serializer bridge** (`Utils/Serializer.js`): `serializeToJSObject/serializeToJSON` = `new gd.SerializerElement` → `obj.serializeTo(el)` → `gd.Serializer.toJSON(el)` → `JSON.parse` (free `el`). `unserializeFromJSObject` = `gd.Serializer.fromJSObject(object)` → `obj.unserializeFrom(project, element)` → `element.delete()`. A canonical mode (`gd.Serializer.setCanonicalMode`) forces default values/alphabetical keys for minimal diffs.

### Presigned-URL key mechanism
- `prepareAiUserContent` (`PrepareAiUserContent.js`) SHA-256-hashes each blob, and **conditionally uploads** to S3 presigned URLs only when content exceeds a size threshold (~10 KB project, ~9 KB events); uploads are cached 30 min keyed by hash.
- Flow: `createAiUserContentPresignedUrls` (`Generation.js:908`) returns signed PUT URLs + `*UserRelativeKey` per blob → `axios.put(signedUrl, simplifiedProjectJson)` (`PrepareAiUserContent.js:181`) → request bodies (endpoints 4/5/9/11) send **exactly one** of inline `gameProjectJson` OR `gameProjectJsonUserRelativeKey` (the other null). Below threshold the inline path is used.

### Applying AI changes
**Events** (the `/ai-generated-event` path): backend returns `AiGeneratedEvent.changes[]` (each: `operationName`, `operationTargetEvent`, `generatedEvents` = serialized GDevelop events JSON), plus validity flags (`isEventsJsonValid`/`areEventsValid`), `undeclaredVariables`, `missingObjectBehaviors`, `missingResources`, `diagnosticLines`. `UseGenerateEvents` polls `getAiGeneratedEvent` while `status==='working'` with exponential backoff (start 1000 ms, cap 5000 ms, total budget 60 000 ms; `suspended`→aborted). Then `EditorFunctions/index.js (~4531-4704)` validates, ensures extensions installed, runs `addUndeclaredVariables`/`addObjectUndeclaredVariables`/`addMissingObjectBehaviors`, then `applyEventsChanges(project, currentSceneEvents, changes, aiGeneratedEvent.id)` (`ApplyEventsChanges.js:295`):
- JSON.parse each `change.generatedEvents` → `new gd.EventsList()` → `unserializeFromJSObject(list, content, 'unserializeFrom', project)` (`:393-401`); tag each inserted event `setAiGeneratedEventId(id)`.
- Resolve targets by `aiGeneratedEventId` (refuse if ambiguous) or `parseEventPath('event-X.Y.Z')`.
- Order operations reverse-lexicographically (deeper/later indices first; edits before insertions; dedup deletes). Operations: `insert_and_replace_event`, `replace_entire_event_and_sub_events`, `replace_event_but_keep_existing_sub_events`, `insert_before_event`, `insert_after_event`, `insert_as_sub_event`, `insert_actions_conditions_at_end`/`at_start`, `replace_all_actions`, `replace_all_conditions`, `delete_event`, `insert_at_end`.
- Mutate the WASM tree via `insertEvents`/`removeEventAt`/instruction copies; temp lists freed in `finally`. On success calls `onSceneEventsModifiedOutsideEditor` and installs missing resources.

**Object/scene/behavior creation tools** mutate the WASM project **directly, with no backend round-trip** (`insertNewObject`, `insertNewLayout`/`insertNewLayer`/`setBackgroundColor`/`setFirstLayout`, refactorers `WholeProjectRefactorer`/`MetadataProvider`/`ObjectRefactorer`). These are inherently provider-agnostic.

---

## 9. Integration plan

### Strategy A — local backend shim + `baseUrl` override
Implement the Generation endpoints in a local OpenAI-compatible shim and repoint `GDevelopGenerationApi.baseUrl` to it.
- **Pros**: single, idiomatic seam; the entire client state machine (polling, merge, agentic loop, modes, sub-agents) works unchanged; no per-component edits; future phases just add endpoints to the same shim.
- **Cons**: must reproduce the exact `AiRequest` schema, `outputFromMessageId` incremental contract, status vocabulary, and (for agent/orchestrator) sub-agent fan-out; must wrap synchronous LLM calls in an async job so `GET status` reports `working`→`ready`; should serve/accept presigned URLs (or stay under the inline size threshold).

### Strategy B — in-frontend interception in `Generation.js`
Replace the bodies of `createAiRequest`/`getAiRequest`/`addMessageToAiRequest` (etc.) to call an OpenAI provider directly and synthesize `AiRequest` objects in-process.
- **Pros**: no separate server; no auth/presigned plumbing needed (can short-circuit).
- **Cons**: must reimplement the async/polling illusion inside the client (timers/state), touches many functions, risks diverging from the schema the rest of the UI depends on; harder to extend to agent/events/asset endpoints; more files edited = larger blast radius.

### Recommendation
**Use Strategy A for Phase 1 (chat-only).** It isolates all provider coupling behind one URL and one schema contract, leaving `AiRequestContext`/`Utils`/`EditorFunctions` untouched, and extends cleanly:
- **Phase 2 (project-gen)**: add `POST/GET /ai-generated-event` + presigned-URL handling (or accept inline) to the shim.
- **Phase 3 (tools)**: have the shim's model emit `function_call` items in `agent` mode using the exact tool names/arg field names from §5; the client already executes them locally.
- **Phase 4 (agent/orchestrator)**: add `getAiRequestStatuses` batch support and, for orchestrator, the sub-agent orchestration layer (create child `AiRequest`s, embed `subAgentAiRequestId`, append `function_call_output` to the parent). Without that layer, orchestrator collapses to single-agent — so for early phases force `mode='agent'`.
- **Phase 5 (assets)**: add `POST /asset-search` and `POST /resource-search`.

### Exact override point for `GDevelopGenerationApi.baseUrl`
`Utils/GDevelopServices/ApiConfigs.js:111-115`:
```js
export const GDevelopGenerationApi = {
  baseUrl: ((isDev
    ? 'https://api-dev.gdevelop.io/generation'
    : 'https://api.gdevelop.io/generation'): string),
};
```
There is **no env-var seam today** (zero `REACT_APP_` matches; `.env` only has `EXTEND_ESLINT=true`; `isDev` from `electron-is-dev`/`NODE_ENV`). `baseUrl` is captured at module-import time into `axios.create({baseURL})` (`Generation.js:274`) and read inline at `:295`/`:335`, so a runtime preference would not retroactively update them. Cleanest override options, in order: (1) hardcode the strings here to the local shim — one file, smallest blast radius; (2) introduce `process.env.REACT_APP_GENERATION_API_URL || (isDev?…:…)` here and add it to `.env` (idiomatic CRA, requires rebuild); (3) NOT viable as a live preference without refactoring the module-level capture. **Also repoint `GDevelopAiCdn.baseUrl` (`ApiConfigs.js:117-122`)** if you want named presets, otherwise the selector falls back to `'default'` harmlessly.

---

## 10. Phase breakdown

| Phase | Goal | Endpoints needed | Key components |
|---|---|---|---|
| **1** | Chat-only | `POST /ai-request` (mode `chat`), `GET /ai-request/{id}` (poll to `ready`, honor `outputFromMessageId`), `POST .../action/add-message`. Recommended: CDN `ai-settings-v2.json` (presets), `GET /ai-request` (history). | `AiRequestContext` (polling/merge), `AskAiEditorContainer`/`AskAiStandAloneForm` (gates), `AiRequestChat`, `Generation.js`, `ApiConfigs.js` (override) |
| **2** | Project generation (events) | + `POST /ai-generated-event`, `GET /ai-generated-event/{id}`, `POST /ai-user-content/action/create-presigned-urls` (+ S3 PUT) **or** stay inline | `UseGenerateEvents`, `PrepareAiUserContent`, `ApplyEventsChanges`, `Serializer`, events-generation EditorFunction (`index.js ~4408-4718`) |
| **3** | Tools (single-agent function calls) | Reuse Phase-1 endpoints with mode `agent`; model must emit `function_call` items matching §5 tool names/args | `EditorFunctions/index.js` registries, `EditorFunctionCallRunner`, `useProcessFunctionCalls` (`Utils.js`), `getFunctionCallsToProcess`/`getFunctionCallOutputsFromEditorFunctionCallResults` (`AiRequestUtils.js`) |
| **4** | Agent / orchestrator (sub-agents) | + `GET /ai-request?ids=…&include=status` (batched sub-agent polling); server-side sub-agent orchestration (child `AiRequest`s, `subAgentAiRequestId`, parent `function_call_output`); `action/suspend` | `useActivatePendingSubAgents`/`useLoadSubAgentRequests` (`Utils.js`), `activateSubAgent`/`removeSubAgentIfDone` (`AiRequestContext.js`), `OrchestratorPlan` |
| **5** | Assets/resources | + `POST /asset-search`, `POST /resource-search` (drive `create_object` asset install, `search_object_asset_store`, resource search) | asset-store install callbacks in `create_object` (`searchAndInstallAsset`/`searchAndInstallResources`/`ensureExtensionInstalled`) |

---

## 11. Open questions / risks

- **Schema is load-bearing and entirely server-owned.** The client has no LLM coupling and no tool JSON-schemas; it depends on the exact `AiRequest` shape (`status` ∈ `working|ready|error|suspended`, `mode`, `output[]` of `message`/`function_call`/`function_call_output`/`reasoning`, `messageId`, `call_id`, `subAgentAiRequestId`, `short_title`, `suggestions`, `projectVersionId{Before,After}Message`). A local provider must reproduce this precisely or the merge/poll/agentic-loop helpers break. This is the largest integration cost — bigger than auth/credit gates.
- **Incremental-fetch contract.** `GET /ai-request/{id}?outputFromMessageId=X` MUST echo X as `output[0]` then newer messages; otherwise `mergeIncrementalAiRequest` silently treats it as a full output and `aiRequestPollSawActivity` miscounts.
- **Async illusion.** The client assumes an async server that holds `working` across turns. A synchronous OpenAI request/response needs a job/queue wrapper so status can report `working`→`ready`.
- **Sub-agent orchestration has no OpenAI equivalent.** Orchestrator mode requires the backend to create child requests, embed `subAgentAiRequestId`, run their tools, and append a `function_call_output` to the parent. A local provider with no sub-agent concept must rebuild this or force `mode='agent'`. The client always sends `orchestrator` today (`Utils.js:97`) — Phase ≤3 should override to `agent`.
- **Tool schemas must be hand-recreated.** The §5 arg lists are reverse-engineered from `SafeExtractor` calls; they lack the backend's descriptions, enum constraints, and true required/optional flags. Many args are **stringly-typed** (`brush_position`='x,y', `instances_size`='w;h;d', `changed_properties` values always strings) — the local schema must mirror these or extractors silently drop values. Dispatch fails with "Unknown function" on any name mismatch.
- **Backend-only tool stubs.** `run_explorer_agent`, `run_edit_agent`, `search_object_asset_store`, `read_game_project_json`, `read_full_docs`, `search_docs`, `create_or_update_plan`, `report_fulfilment_problem`, `get_game_starter_summary` have client no-op/failure launchers; their real logic (asset search, docs RAG, planning, sub-agents, project-JSON reads) lives server-side and is NOT in this repo path — replacing the backend means re-implementing all of them.
- **Events generation is fully server-side.** The backend generates AND validates the GDevelop events JSON; the model must emit events in GDevelop's exact serialized format, tagged so `unserializeFromJSObject(project)` succeeds against local platform metadata. `add_scene_events`/`generate_events` depend on the `generateEvents` service — a major dependency, not local.
- **Presigned-URL trap.** When project JSON is large the client sends only `*UserRelativeKey` and no inline JSON. A shim must either serve presigned PUTs + resolve keys, or ensure the inline path (under ~10 KB) is taken. Unverified: whether `createAiRequest` tolerates a null `gameProjectJsonUserRelativeKey` if presigned-upload is stubbed out.
- **`SimplifiedProject` fidelity.** What the model reasons over is the reduced representation, not the canonical project — lower fidelity than a full serialization.
- **Server-side re-validation (open).** The backend likely re-checks quota/credits regardless of `payWithCredits=false`; bypassing the frontend gate is only sufficient because the local shim is yours and can ignore those fields. `toolsVersion='v5'` and `aiConfiguration.presetId` select server-side tool defs/model — a shim must map or ignore them.
- **`gdevelopVersionWithHash`** is sent in most POST bodies; the shim must accept any value (no version enforcement).
- **Auth is Firebase-hard.** Faking `profile` without a matching auth provider may require editing `AuthenticatedUserProvider`/`Authentication`, not just the Ask AI files; `getAuthorizationHeader` throws if `currentUser` is null. Pick a stable fake `profile.id` so history keys consistently.