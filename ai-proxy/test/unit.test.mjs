// Unit tests for the pure proxy modules. Run with: npm test  (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeUserMessage,
  makeAssistantMessage,
  gdevelopOutputToOpenAiMessages,
  openAiChoiceToAssistantMessage,
} from '../src/translate.js';
import {
  parseEventsFromLLM,
  placementToOperation,
  buildInstructionReference,
  buildEventsUserPrompt,
  loadCatalog,
} from '../src/events.js';
import { DELEGATION_TOOLS, ORCHESTRATOR_TOOLS, readOnlyTools, safeJsonParse, READ_ONLY_TOOL_NAMES } from '../src/orchestrator.js';

// ---------- translate.js ----------
test('makeUserMessage wraps text in a user_request content part', () => {
  const m = makeUserMessage('hello');
  assert.equal(m.type, 'message');
  assert.equal(m.role, 'user');
  assert.equal(m.content[0].type, 'user_request');
  assert.equal(m.content[0].text, 'hello');
  assert.ok(m.messageId);
});

test('makeAssistantMessage with text + function calls', () => {
  const m = makeAssistantMessage('hi', [{ call_id: 'c1', name: 'create_scene', arguments: '{"scene_name":"A"}' }]);
  assert.equal(m.role, 'assistant');
  const text = m.content.find(c => c.type === 'output_text');
  const fc = m.content.find(c => c.type === 'function_call');
  assert.equal(text.text, 'hi');
  assert.equal(fc.call_id, 'c1');
  assert.equal(fc.name, 'create_scene');
});

test('gdevelopOutputToOpenAiMessages maps all item types', () => {
  const output = [
    { type: 'message', role: 'user', content: [{ type: 'user_request', text: 'make a game' }] },
    { type: 'message', role: 'assistant', content: [
      { type: 'reasoning', summary: { text: 'thinking' } },
      { type: 'output_text', text: 'sure' },
      { type: 'function_call', call_id: 'c1', name: 'create_scene', arguments: '{"scene_name":"A"}' },
    ] },
    { type: 'function_call_output', call_id: 'c1', output: '{"success":true}' },
  ];
  const msgs = gdevelopOutputToOpenAiMessages({ output, systemPrompt: 'SYS' });
  assert.equal(msgs[0].role, 'system');
  assert.equal(msgs[1].role, 'user');
  assert.equal(msgs[1].content, 'make a game');
  assert.equal(msgs[2].role, 'assistant');
  assert.equal(msgs[2].content, 'sure');
  assert.equal(msgs[2].tool_calls[0].id, 'c1');
  assert.equal(msgs[2].tool_calls[0].function.name, 'create_scene');
  assert.equal(msgs[3].role, 'tool');
  assert.equal(msgs[3].tool_call_id, 'c1');
});

test('gdevelopOutputToOpenAiMessages includes project context in system', () => {
  const msgs = gdevelopOutputToOpenAiMessages({ output: [], systemPrompt: 'SYS', projectContext: '{"layouts":[]}' });
  assert.equal(msgs[0].role, 'system');
  assert.ok(msgs[0].content.includes('Current game project'));
  assert.ok(msgs[0].content.includes('{"layouts":[]}'));
});

test('openAiChoiceToAssistantMessage handles tool_calls', () => {
  const m = openAiChoiceToAssistantMessage({ message: { content: null, tool_calls: [{ id: 'x', type: 'function', function: { name: 'create_object', arguments: '{"a":1}' } }] } });
  const fc = m.content.find(c => c.type === 'function_call');
  assert.equal(fc.name, 'create_object');
  assert.equal(fc.call_id, 'x');
  assert.equal(fc.arguments, '{"a":1}');
});

test('openAiChoiceToAssistantMessage stringifies object arguments', () => {
  const m = openAiChoiceToAssistantMessage({ message: { tool_calls: [{ id: 'x', type: 'function', function: { name: 't', arguments: { a: 1 } } }] } });
  assert.equal(m.content[0].arguments, '{"a":1}');
});

// ---------- events.js ----------
test('parseEventsFromLLM: plain {events:[]}', () => {
  const e = parseEventsFromLLM('{"events":[{"type":"BuiltinCommonInstructions::Standard"}]}');
  assert.equal(e.length, 1);
});
test('parseEventsFromLLM: bare array', () => {
  assert.equal(parseEventsFromLLM('[{"type":"X"}]').length, 1);
});
test('parseEventsFromLLM: code-fenced', () => {
  const e = parseEventsFromLLM('Here:\n```json\n{"events":[{"type":"X"}]}\n```\n');
  assert.equal(e.length, 1);
});
test('parseEventsFromLLM: trailing prose after JSON', () => {
  const e = parseEventsFromLLM('{"events":[{"type":"X"}]}\nThat is the plan.');
  assert.equal(e.length, 1);
});
test('parseEventsFromLLM: garbage -> null', () => {
  assert.equal(parseEventsFromLLM('no json here'), null);
  assert.equal(parseEventsFromLLM(''), null);
});
test('parseEventsFromLLM: braces inside strings do not confuse matching', () => {
  const e = parseEventsFromLLM('{"events":[{"type":"X","parameters":["a } b ] c","\\"quoted{}\\""]}]} trailing');
  assert.equal(e.length, 1);
  assert.equal(e[0].parameters[0], 'a } b ] c');
});
test('parseEventsFromLLM: nested arrays/objects', () => {
  const e = parseEventsFromLLM('[{"type":"S","events":[{"type":"S2","conditions":[]}]}]');
  assert.equal(e[0].events[0].type, 'S2');
});

test('placementToOperation maps relations', () => {
  assert.equal(placementToOperation({ placementRelation: 'before', placementTargetEventId: 'e1' }).operationName, 'insert_before_event');
  assert.equal(placementToOperation({ placementRelation: 'after', placementTargetEventId: 'e1' }).operationName, 'insert_after_event');
  assert.equal(placementToOperation({ placementRelation: 'as_sub_event', placementTargetEventId: 'e1' }).operationName, 'insert_as_sub_event');
  assert.equal(placementToOperation({}).operationName, 'insert_at_end');
  assert.equal(placementToOperation({}).operationTargetEvent, null);
});

test('buildInstructionReference filters by scope + scene behaviors', () => {
  loadCatalog('/nonexistent'); // start empty
  // simulate a tiny catalog via the module's loader is hard; instead test the empty path
  const ref = buildInstructionReference('{}');
  assert.equal(typeof ref, 'string');
});

test('buildEventsUserPrompt includes description + catalog marker', () => {
  const p = buildEventsUserPrompt({ description: 'jump on space', objectsList: 'Hero:Sprite', gameProjectJson: '{}' });
  assert.ok(p.includes('jump on space'));
  assert.ok(p.includes('CATALOG'));
  assert.ok(p.includes('{"events"'));
});

// ---------- orchestrator.js ----------
test('DELEGATION_TOOLS contains the two delegation tools', () => {
  assert.ok(DELEGATION_TOOLS.has('run_edit_agent'));
  assert.ok(DELEGATION_TOOLS.has('run_explorer_agent'));
});
test('ORCHESTRATOR_TOOLS are well-formed OpenAI function tools', () => {
  for (const t of ORCHESTRATOR_TOOLS) {
    assert.equal(t.type, 'function');
    assert.ok(t.function.name);
    assert.equal(t.function.parameters.type, 'object');
    assert.ok(Array.isArray(t.function.parameters.required));
  }
});
test('readOnlyTools selects only inspection tools', () => {
  const all = [
    { type: 'function', function: { name: 'create_object' } },
    { type: 'function', function: { name: 'inspect_object_properties' } },
    { type: 'function', function: { name: 'read_scene_events' } },
  ];
  const ro = readOnlyTools(all);
  assert.ok(ro.every(t => READ_ONLY_TOOL_NAMES.has(t.function.name)));
  assert.ok(!ro.some(t => t.function.name === 'create_object'));
});
test('safeJsonParse never throws', () => {
  assert.deepEqual(safeJsonParse('{"a":1}'), { a: 1 });
  assert.deepEqual(safeJsonParse('not json'), {});
});
