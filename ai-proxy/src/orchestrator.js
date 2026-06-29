// Phase 4: orchestrator + sub-agents.
// The orchestrator is a top-level agent whose only tools delegate work to sub-agents
// (run_edit_agent / run_explorer_agent). Each delegation spawns a child AiRequest that
// the GDevelop IDE polls and whose tool calls the IDE executes on the real project.
// When a child finishes, the proxy appends a function_call_output to the parent.

export const DELEGATION_TOOLS = new Set(['run_edit_agent', 'run_explorer_agent']);

export const ORCHESTRATOR_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'run_edit_agent',
      description:
        'Delegate one concrete building/editing task to an edit sub-agent that can create/modify scenes, objects (with assets), behaviors, variables, instances, and events on the real project. Use this for every step that changes the game. Run focused steps one at a time and check the result before the next.',
      parameters: {
        type: 'object',
        properties: {
          short_title: { type: 'string', description: 'A 2-5 word title for this task, shown to the user (e.g. "Create player").' },
          prompt: { type: 'string', description: 'A clear, self-contained instruction for the sub-agent describing exactly what to build or change, referencing existing scene/object/behavior names where relevant.' },
        },
        required: ['short_title', 'prompt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_explorer_agent',
      description:
        'Delegate a READ-ONLY investigation to an explorer sub-agent (inspect scenes, objects, behaviors, variables, events). Use this to gather information before deciding what to build. It does not modify the project.',
      parameters: {
        type: 'object',
        properties: {
          short_title: { type: 'string', description: 'A 2-5 word title, shown to the user (e.g. "Inspect scene").' },
          prompt: { type: 'string', description: 'What to investigate and report back.' },
        },
        required: ['short_title', 'prompt'],
      },
    },
  },
];

export const ORCHESTRATOR_SYSTEM_PROMPT =
  process.env.ORCHESTRATOR_SYSTEM_PROMPT ||
  `You are the orchestrator of GDevelop's AI game builder. You DO NOT edit the project directly — you break the user's request into focused steps and delegate each one to a sub-agent.

- For any step that builds or changes the game (create a scene, add an object with art, add a behavior, add events/logic, place instances, set properties), call run_edit_agent with a precise, self-contained 'prompt' and a short_title.
- To investigate the current project before acting, call run_explorer_agent.
- Work step by step: delegate one task, read its result, then decide the next task. Group obviously-related work into a single edit task when sensible, but keep each delegated task focused and achievable.
- If no project exists yet, your first edit task should create the project and its first scene.
- When the whole request is complete, reply with a short plain-text summary of what was built. Do NOT claim work you did not delegate.`;

export const EXPLORER_SYSTEM_PROMPT =
  `You are a read-only explorer sub-agent in GDevelop. Investigate the project using the inspection tools (inspect_object_properties, inspect_scene_properties_layers_effects, inspect_behavior_properties, inspect_variables, describe_instances, read_scene_events) and then reply with a concise text report of your findings. Do NOT modify the project.`;

// Tool names that only read (used to restrict the explorer sub-agent).
export const READ_ONLY_TOOL_NAMES = new Set([
  'inspect_object_properties',
  'inspect_scene_properties_layers_effects',
  'inspect_behavior_properties',
  'inspect_variables',
  'describe_instances',
  'read_scene_events',
]);

export function readOnlyTools(allTools) {
  return allTools.filter(t => t.function && READ_ONLY_TOOL_NAMES.has(t.function.name));
}

export function safeJsonParse(s) {
  try { return JSON.parse(s); } catch (e) { return {}; }
}
