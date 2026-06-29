// Phase 2: events / game-logic generation.
// Translates an /ai-generated-event request into a prompt for the LLM, asking it to
// emit GDevelop's serialized events JSON, using the real instruction catalog
// (instruction-catalog.json, extracted from the IDE's WASM) so type.value + parameter
// arrays are valid. The IDE then validates via WASM (ApplyEventsChanges).
import { readFileSync, existsSync } from 'fs';

let CATALOG = [];
export function loadCatalog(path) {
  try {
    if (existsSync(path)) CATALOG = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    /* ignore */
  }
  return CATALOG.length;
}

// Build a compact instruction reference relevant to the scene. Includes free
// (global) instructions, base-object + Sprite instructions, and behavior
// instructions for any behavior type referenced in the project JSON.
export function buildInstructionReference(gameProjectJson) {
  const projStr = gameProjectJson || '';
  const relevant = CATALOG.filter(i => {
    if (i.scope === 'free') return true;
    if (i.scope === 'object:base' || i.scope === 'object:Sprite') return true;
    if (i.scope.startsWith('behavior:')) {
      const bt = i.scope.slice('behavior:'.length);
      return projStr.includes(bt);
    }
    return false;
  });
  const fmt = i => {
    const slots = i.params
      .map((p, idx) => {
        if (p.codeOnly) return `${idx}:""`;
        let s = `${idx}:<${p.type}`;
        if (p.extraInfo) s += `=${p.extraInfo}`;
        s += '>';
        return s;
      })
      .join(' ');
    return `${i.kind} ${i.type} | params: [${slots}]`;
  };
  // Cap to keep the prompt bounded; free + base/sprite + scene behaviors is usually < 500.
  return relevant.map(fmt).join('\n');
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

CRITICAL RULES:
- Use ONLY 'type.value' strings listed in the CATALOG. Conditions must come from 'condition' entries, actions from 'action' entries.
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
  const reference = buildInstructionReference(gameProjectJson);
  let prompt = `Add this game logic to the scene:\n"${description}"\n\n`;
  if (objectsList) prompt += `Scene objects (name:type and behaviors): ${objectsList}\n`;
  if (gameProjectJson) prompt += `\nScene/project JSON (for object types, behavior names, variables):\n${gameProjectJson}\n`;
  if (existingEventsAsText && existingEventsAsText.trim())
    prompt += `\nExisting events (do not duplicate):\n${existingEventsAsText}\n`;
  prompt += `\nCATALOG of allowed instructions (type | param slots):\n${reference}\n`;
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
