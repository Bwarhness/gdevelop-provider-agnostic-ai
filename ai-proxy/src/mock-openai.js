// Minimal mock of an OpenAI-compatible /chat/completions endpoint, for testing
// the proxy without a real provider/API key. Echoes a deterministic reply that
// quotes the last user message and lists how many messages it received.
import express from 'express';

const PORT = parseInt(process.env.MOCK_PORT || '5099', 10);
const app = express();
app.use(express.json({ limit: '96mb' }));

app.post('/v1/chat/completions', (req, res) => {
  const messages = req.body.messages || [];
  const tools = req.body.tools || [];
  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  const sys = messages.find(m => m.role === 'system');
  const hasToolResult = messages.some(m => m.role === 'tool');
  const userText = ((lastUser && lastUser.content) || '').toLowerCase();

  const make = (message, finish = 'stop') => ({
    id: 'chatcmpl-mock',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: req.body.model || 'mock-model',
    choices: [{ index: 0, message, finish_reason: finish }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  });

  // AGENT MODE: tools available and we haven't executed one yet -> emit a tool call.
  if (tools.length && !hasToolResult) {
    const has = name => tools.some(t => t.function && t.function.name === name);
    let call = null;
    const projectInContext = !!sys && /# Current game project/.test(sys.content || '');
    if (!projectInContext && has('initialize_project')) {
      call = { name: 'initialize_project', arguments: JSON.stringify({ project_name: 'TestGame', template_slug: 'empty' }) };
    } else if (/scene/.test(userText) && has('create_scene')) {
      call = { name: 'create_scene', arguments: JSON.stringify({ scene_name: 'Level1', is_first_scene: true }) };
    } else if (has('create_scene')) {
      call = { name: 'create_scene', arguments: JSON.stringify({ scene_name: 'Level1' }) };
    }
    if (call) {
      return res.json(
        make(
          {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'call_mock_1', type: 'function', function: call }],
          },
          'tool_calls'
        )
      );
    }
  }

  // CHAT (or post-tool) -> final text.
  const reply = hasToolResult
    ? `**Mock agent done.** I executed the tool and the editor applied it. The project now reflects your request.`
    : `**Mock LLM reply.** I received ${messages.length} message(s)` +
      (sys ? ` (incl. a ${sys.content.length}-char system prompt)` : '') +
      `.\n\nYou asked: "${(lastUser && lastUser.content) || '(none)'}".\n\n` +
      `In GDevelop, here's a concrete starting point: add a Sprite object, give it the ` +
      `Platformer Character behavior, and create events that map the arrow keys to movement.`;
  res.json(make({ role: 'assistant', content: reply }));
});

app.get('/', (_req, res) => res.json({ ok: true, service: 'mock-openai' }));
app.listen(PORT, () => console.log(`[mock-openai] listening on http://localhost:${PORT}/v1`));
