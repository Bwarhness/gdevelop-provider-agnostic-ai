// Phase 2: events / game-logic generation.
// Translates an /ai-generated-event request into a prompt for the LLM, asking it to
// emit GDevelop's serialized events JSON, using the real instruction catalog
// (instruction-catalog.json, extracted from the IDE's WASM) so type.value + parameter
// arrays are valid. The IDE then validates via WASM (ApplyEventsChanges).
import { readFileSync, existsSync } from 'fs';

let CATALOG = [];
let CATALOG_INDEX = new Map(); // type.value -> { kinds:Set, entries:[entry...] }
export function loadCatalog(path) {
  try {
    if (existsSync(path)) CATALOG = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    /* ignore */
  }
  CATALOG_INDEX = new Map();
  for (const entry of CATALOG) {
    if (!entry || !entry.type) continue;
    let rec = CATALOG_INDEX.get(entry.type);
    if (!rec) {
      rec = { kinds: new Set(), entries: [] };
      CATALOG_INDEX.set(entry.type, rec);
    }
    rec.kinds.add(entry.kind);
    rec.entries.push(entry);
  }
  return CATALOG.length;
}

// Validate generated events against the catalog. Returns an array of human-readable
// problem strings (empty = valid). Catches the gross errors that otherwise reach the IDE
// as red-underlined instructions: unknown types, condition/action mix-ups, wrong arity.
export function validateEvents(events, path = 'events') {
  const problems = [];
  if (!Array.isArray(events)) {
    return [`${path}: expected an array of event objects`];
  }
  events.forEach((ev, i) => {
    if (!ev || typeof ev !== 'object') {
      problems.push(`${path}[${i}]: not an object`);
      return;
    }
    const checkList = (list, kind) => {
      if (list == null) return;
      if (!Array.isArray(list)) {
        problems.push(`${path}[${i}].${kind}s: must be an array`);
        return;
      }
      list.forEach((instr, j) => {
        const loc = `${path}[${i}].${kind}s[${j}]`;
        const typeValue = instr && instr.type && instr.type.value;
        if (!typeValue) {
          problems.push(`${loc}: missing type.value`);
          return;
        }
        const rec = CATALOG_INDEX.get(typeValue);
        if (!rec) {
          problems.push(`${loc}: unknown instruction type "${typeValue}" (not in catalog)`);
          return;
        }
        if (!rec.kinds.has(kind)) {
          const has = [...rec.kinds].join('/');
          problems.push(`${loc}: "${typeValue}" is a ${has}, not a ${kind}. Use it under "${has}s" instead.`);
          return;
        }
        const entry = rec.entries.find(e => e.kind === kind) || rec.entries[0];
        const max = (entry.params || []).length;
        const got = Array.isArray(instr.parameters) ? instr.parameters.length : -1;
        // Only flag "too many" (unambiguously wrong) — too-few may be legit omitted
        // optionals and is caught more precisely by the IDE's WASM validation.
        if (got < 0) {
          problems.push(`${loc} ("${typeValue}"): "parameters" must be an array`);
        } else if (got > max) {
          problems.push(
            `${loc} ("${typeValue}"): too many parameters (${got} given, ${max} slots). Slots: ${describeSlots(entry)}`
          );
        }
      });
    };
    checkList(ev.conditions, 'condition');
    checkList(ev.actions, 'action');
    if (ev.events) problems.push(...validateEvents(ev.events, `${loc(path, i)}.events`));
  });
  return problems;
}
function loc(path, i) {
  return `${path}[${i}]`;
}

// Build a compact instruction reference relevant to the scene. Includes free
// (global) instructions, base-object + Sprite instructions, and behavior
// instructions for any behavior type referenced in the project JSON.
export function buildInstructionReference(gameProjectJson, objectsList = '') {
  const projStr = `${gameProjectJson || ''}\n${objectsList || ''}`;
  const hasContext = projStr.trim().length > 0;
  const relevant = CATALOG.filter(i => {
    if (i.scope === 'free') return true;
    if (i.scope === 'object:base') return true;
    if (i.scope.startsWith('object:')) {
      // Object-type instructions (e.g. Text's "Change the text") for object types present
      // in the scene. Without context, include the common ones so basics still work.
      const ot = i.scope.slice('object:'.length);
      return hasContext ? projStr.includes(ot) : ot === 'Sprite' || ot === 'TextObject::Text';
    }
    if (i.scope.startsWith('behavior:')) {
      const bt = i.scope.slice('behavior:'.length);
      // Capability behaviors (text, effects, opacity, scale, flip, …) are implicit on the
      // objects that support them, so always offer them; other behaviors only if referenced.
      if (/Capability/.test(bt)) return true;
      return projStr.includes(bt);
    }
    return false;
  });
  // AXI-style: high-signal, token-efficient. Each line carries what the instruction DOES
  // (its sentence, with _PARAM0_ markers mapping meaning to slot position) plus the typed
  // slots — so the model can pick the right type and fill params correctly, not guess.
  //   <type> [c|a] <sentence> :: <slots>
  const fmt = i => {
    const tag = i.kind === 'condition' ? 'c' : 'a';
    const sentence = cleanSentence(i.sentence) || cleanSentence(i.fullName) || '';
    return `${i.type} [${tag}]${sentence ? ' ' + sentence : ''} :: ${describeSlots(i)}`;
  };
  return relevant.map(fmt).join('\n');
}

// Collapse whitespace/newlines and cap length so one instruction = one tidy line.
function cleanSentence(s) {
  if (!s) return '';
  return String(s).replace(/\s+/g, ' ').trim().slice(0, 120);
}

// Compact, typed description of an instruction's parameter slots (shared by the reference
// and validation error messages). codeOnly slots are shown as "" (the model must pass "").
export function describeSlots(entry) {
  const params = entry.params || [];
  if (!params.length) return '(no params)';
  return params
    .map((p, idx) => {
      if (p.codeOnly) return `${idx}:""`;
      let s = `${idx}:${p.type}`;
      if (p.extraInfo) s += `=${p.extraInfo}`;
      if (p.optional) s += '?';
      return s;
    })
    .join(' ');
}

export const EVENTS_SYSTEM_PROMPT = `You generate GDevelop game logic as SERIALIZED EVENTS JSON. You will be given a natural-language description of the logic to add, the scene's objects (with their behaviors), and a CATALOG of the exact instruction types you may use.

Output ONLY a JSON object: {"events": [ ...event objects... ]}. No prose, no markdown fences.

EVENT object shape:
{
  "type": "BuiltinCommonInstructions::Standard",   // or ::While, ::Repeat, ::ForEach, ::Group, ::Comment
  "conditions": [ <instruction>, ... ],
  "actions":    [ <instruction>, ... ],
  "events":     [ <sub-event>, ... ]               // optional nested events
}
INSTRUCTION shape:
{ "type": { "value": "<EXACT_TYPE_FROM_CATALOG>" }, "parameters": [ "<p0>", "<p1>", ... ] }

CATALOG format — each line is one instruction:
  <TYPE> [c|a] <what it does, with _PARAM0_/_PARAM1_ marking where each parameter goes> :: <slots>
  * [c] = usable as a CONDITION, [a] = usable as an ACTION. A type may appear as both.
  * <slots> lists each parameter slot as "index:type" in order, e.g. "0:object 1:behavior=PlatformBehavior::PlatformerObjectBehavior 2:expression". A "?" suffix means the slot is optional (may be omitted). A slot shown as i:"" is code-only — pass "".
  Read the sentence to understand the instruction and which value each slot expects (it names _PARAM0_, _PARAM1_, … in place).

CRITICAL RULES:
- Use ONLY 'type.value' strings listed in the CATALOG. Use a type as a condition only if its line shows [c]; as an action only if it shows [a].
- Pick the instruction whose sentence MATCHES the intent. Do NOT invent types or reuse a remembered name that is not in the CATALOG. To change a Text object's displayed text use the action whose sentence is about the object's text, NOT a "variable" action.
- The "parameters" array MUST have exactly one string per param slot shown for that instruction, IN ORDER.
  * A slot shown as i:"" is code-only — put an empty string "".
  * <object> → the object's name (from the scene objects list).
  * <behavior=SomeType> → the NAME of that behavior on the object (from the scene objects list), NOT the type.
  * <expression>/<number> → a number or a GDevelop expression string (e.g. "100", "Player.X()+5").
  * <string> → a literal in double quotes inside the string when it's an expression-string, e.g. "\\"hello\\"".
  * <operator=number> → one of "=", "+", "-", "*", "/". <relationalOperator> → "=", "<", ">", "<=", ">=", "!=".
  * <key> → a key name like "Space", "Left", "Right", "Up", "Down", "a".
  * <layer> → "" for the base layer unless a specific layer is named.
- Keep it minimal and correct. Prefer a few standard events over complex nesting.
- Only reference objects that exist in the scene. Only use behaviors that the object actually has.`;

// Build the user prompt for one events-generation request.
export function buildEventsUserPrompt({ description, objectsList, existingEventsAsText, gameProjectJson }) {
  const reference = buildInstructionReference(gameProjectJson, objectsList);
  let prompt = `Add this game logic to the scene:\n"${description}"\n\n`;
  if (objectsList) prompt += `Scene objects (name:type and behaviors): ${objectsList}\n`;
  if (gameProjectJson) prompt += `\nScene/project JSON (for object types, behavior names, variables):\n${gameProjectJson}\n`;
  if (existingEventsAsText && existingEventsAsText.trim())
    prompt += `\nExisting events (do not duplicate):\n${existingEventsAsText}\n`;
  prompt += `\nCATALOG of allowed instructions — "<TYPE> [c|a] <what it does> :: <slots>":\n${reference}\n`;
  prompt += `\nReturn {"events": [...]} now.`;
  return prompt;
}

// Parse the LLM output into an events array (tolerates code fences / surrounding text).
// O(n), string/escape-aware brace matching — no quadratic backtracking.
export function parseEventsFromLLM(text) {
  if (!text) return null;
  const MAX = 4_000_000; // cap to avoid pathological inputs blocking the loop
  let s = String(text).trim().slice(0, MAX);
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();

  const o = s.indexOf('{');
  const a = s.indexOf('[');
  const start = o < 0 ? a : a < 0 ? o : Math.min(o, a);
  if (start < 0) return null;

  // Find the matching close bracket for the opener at `start`.
  let depth = 0;
  let inStr = false;
  let esc = false;
  let end = -1;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  const candidate = end >= 0 ? s.slice(start, end + 1) : s.slice(start);
  try {
    const parsed = JSON.parse(candidate);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.events)) return parsed.events;
  } catch (e) {
    /* malformed */
  }
  return null;
}

// Map a batch placement to an operationName + target.
export function placementToOperation(batch) {
  const rel = (batch && batch.placementRelation) || 'at_end';
  const target = (batch && batch.placementTargetEventId) || null;
  switch (rel) {
    case 'before':
      return { operationName: 'insert_before_event', operationTargetEvent: target };
    case 'after':
      return { operationName: 'insert_after_event', operationTargetEvent: target };
    case 'as_sub_event':
      return { operationName: 'insert_as_sub_event', operationTargetEvent: target };
    default:
      return { operationName: 'insert_at_end', operationTargetEvent: null };
  }
}
