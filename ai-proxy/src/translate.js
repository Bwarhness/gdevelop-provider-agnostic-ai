// Translation between GDevelop's Generation-API message format (an
// OpenAI-Responses-API-style `output[]` array) and OpenAI Chat Completions.
//
// GDevelop `output[]` items we care about:
//   - { type:'message', role:'user',      content:[{type:'user_request', text}] }
//   - { type:'message', role:'assistant', content:[{type:'output_text', text}, {type:'reasoning',...}, {type:'function_call', call_id, name, arguments}] }
//   - { type:'function_call_output', call_id, output }
//
// This module is intentionally tool-aware (function_call / function_call_output)
// so the same code serves Phase 1 (chat) and Phase 3 (tools).

let messageCounter = 0;

/** Generate a stable-ish unique message id. */
export function newMessageId(prefix = 'msg') {
  messageCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${messageCounter}`;
}

/** Build a GDevelop user message wrapping the raw prompt text. */
export function makeUserMessage(text) {
  return {
    type: 'message',
    status: 'completed',
    role: 'user',
    content: [{ type: 'user_request', status: 'completed', text: text || '' }],
    messageId: newMessageId('user'),
  };
}

/** Build a GDevelop assistant message from plain text (+ optional function calls + reasoning). */
export function makeAssistantMessage(text, functionCalls = [], reasoning = '') {
  const content = [];
  // Reasoning first so the IDE renders the "thinking" above the answer. Storing it also
  // lets us replay reasoning_content for models that require it on tool-call turns
  // (e.g. Xiaomi MiMo / GLM 'zai' format: requiresReasoningContentForToolCalls).
  if (reasoning && reasoning.length) {
    content.push({
      type: 'reasoning',
      status: 'completed',
      summary: { type: 'summary_text', text: reasoning },
    });
  }
  if (text && text.length) {
    content.push({
      type: 'output_text',
      status: 'completed',
      text,
      annotations: [],
    });
  }
  for (const fc of functionCalls) {
    content.push({
      type: 'function_call',
      status: 'completed',
      call_id: fc.call_id,
      name: fc.name,
      arguments: fc.arguments, // JSON string
    });
  }
  return {
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content,
    messageId: newMessageId('assistant'),
  };
}

/** Extract concatenated text from a GDevelop message's content parts. */
function textFromContent(content, types) {
  return (content || [])
    .filter(c => types.includes(c.type))
    .map(c => c.text)
    .filter(Boolean)
    .join('\n');
}

/**
 * Convert a GDevelop `output[]` array into an OpenAI Chat Completions `messages[]`
 * array. A system message (system prompt + optional project context) is prepended.
 */
export function gdevelopOutputToOpenAiMessages({
  output,
  systemPrompt,
  projectContext,
}) {
  const messages = [];

  let system = systemPrompt || '';
  if (projectContext && projectContext.trim()) {
    system +=
      '\n\n# Current game project (GDevelop SimplifiedProject JSON)\n' +
      'Use this as context about the user\'s game when relevant.\n\n' +
      '```json\n' +
      projectContext +
      '\n```';
  }
  if (system.trim()) messages.push({ role: 'system', content: system });

  for (const item of output || []) {
    if (!item || typeof item !== 'object') continue;

    if (item.type === 'function_call_output') {
      messages.push({
        role: 'tool',
        tool_call_id: item.call_id,
        content:
          typeof item.output === 'string'
            ? item.output
            : JSON.stringify(item.output),
      });
      continue;
    }

    if (item.type === 'message' && item.role === 'user') {
      const text = textFromContent(item.content, [
        'user_request',
        'output_text',
        'text',
      ]);
      if (text) messages.push({ role: 'user', content: text });
      continue;
    }

    if (item.type === 'message' && item.role === 'assistant') {
      const text = textFromContent(item.content, ['output_text', 'text']);
      const toolCalls = (item.content || [])
        .filter(c => c.type === 'function_call')
        .map(c => ({
          id: c.call_id,
          type: 'function',
          function: { name: c.name, arguments: c.arguments },
        }));
      const msg = { role: 'assistant', content: text || '' };
      if (toolCalls.length) {
        msg.tool_calls = toolCalls;
        if (!text) msg.content = null;
        // Replay the model's own reasoning on tool-call turns — some reasoning models
        // (Xiaomi MiMo, GLM 'zai' format) reject tool-call history that lacks it.
        const reasoning = (item.content || [])
          .filter(c => c.type === 'reasoning')
          .map(c => (c.summary && c.summary.text) || '')
          .filter(Boolean)
          .join('\n');
        if (reasoning) msg.reasoning_content = reasoning;
      }
      messages.push(msg);
      continue;
    }

    // Top-level function_call item (some shapes place it outside a message).
    if (item.type === 'function_call') {
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: item.call_id,
            type: 'function',
            function: { name: item.name, arguments: item.arguments },
          },
        ],
      });
    }
  }

  return messages;
}

/**
 * Convert an OpenAI Chat Completions response choice into a GDevelop assistant
 * message. Handles both plain text and tool_calls.
 */
export function openAiChoiceToAssistantMessage(choice) {
  const message = (choice && choice.message) || {};
  const text = message.content || '';
  // Reasoning models expose the chain-of-thought under varying field names.
  const reasoning =
    (typeof message.reasoning_content === 'string' && message.reasoning_content) ||
    (typeof message.reasoning === 'string' && message.reasoning) ||
    '';
  const functionCalls = (message.tool_calls || [])
    .filter(tc => tc.type === 'function' && tc.function)
    .map(tc => ({
      call_id: tc.id || newMessageId('call'),
      name: tc.function.name,
      arguments:
        typeof tc.function.arguments === 'string'
          ? tc.function.arguments
          : JSON.stringify(tc.function.arguments || {}),
    }));
  return makeAssistantMessage(text, functionCalls, reasoning);
}
