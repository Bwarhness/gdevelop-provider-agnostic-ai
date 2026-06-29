// Emulates the GDevelop IDE driving orchestrator mode + sub-agents, end-to-end,
// against the local proxy. Verifies: orchestrator delegates via run_edit_agent ->
// the proxy spawns a child -> the (emulated) IDE runs the child's tools and posts
// back -> the child finishes -> the proxy reports to the parent -> orchestrator
// continues -> final summary.
const BASE = 'http://localhost:4000';
const U = '?userId=local-ai-user';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const post = async (p, b) => (await fetch(BASE + p + U, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).json();
const get = async p => (await fetch(BASE + p + U)).json();
const calls = req => { const a = []; for (const m of req.output || []) if (m.role === 'assistant') for (const c of m.content || []) if (c.type === 'function_call') a.push(c); return a; };
const doneIds = req => new Set((req.output || []).filter(m => m.type === 'function_call_output').map(m => m.call_id));
const pendingSub = req => { const d = doneIds(req); return calls(req).filter(c => c.subAgentAiRequestId && !d.has(c.call_id)); };
const pendingChildTools = req => { const d = doneIds(req); return calls(req).filter(c => !c.subAgentAiRequestId && !d.has(c.call_id)); };
const lastText = req => { const a = [...(req.output || [])].reverse().find(m => m.role === 'assistant'); return a ? (a.content || []).filter(c => c.type === 'output_text').map(c => c.text).join(' ') : ''; };
const waitSettled = async id => { for (let i = 0; i < 150; i++) { const r = await get(`/ai-request/${id}`); if (r.status === 'ready' || r.status === 'error') return r; await sleep(500); } return get(`/ai-request/${id}`); };

(async () => {
  const project = '{"layouts":[{"name":"Game"}]}';
  let parent = await post('/ai-request', { userRequest: 'Build a tiny game: create a scene called Arena, add a Player object and an Enemy object to it.', mode: 'orchestrator', aiConfiguration: { presetId: 'orchestrator' }, toolsVersion: 'v5', payWithCredits: false, gameProjectJson: project });
  const pid = parent.id;
  console.log('orchestrator request:', pid);
  const active = new Set();
  const seenDeleg = new Set();

  for (let step = 0; step < 50; step++) {
    parent = await waitSettled(pid);
    if (parent.status === 'error') { console.log('PARENT ERROR:', parent.error && parent.error.message); break; }

    // log new delegations
    for (const c of calls(parent)) if (c.subAgentAiRequestId && !seenDeleg.has(c.call_id)) { seenDeleg.add(c.call_id); active.add(c.subAgentAiRequestId); console.log(`  [orchestrator] delegate ${c.name}: "${c.short_title || ''}" -> child ${c.subAgentAiRequestId.slice(-6)}`); }

    // drive each active child like the IDE would
    for (const cid of [...active]) {
      const child = await waitSettled(cid);
      if (child.status === 'error') { console.log(`    [child ${cid.slice(-6)}] ERROR`); active.delete(cid); continue; }
      const tools = pendingChildTools(child);
      if (tools.length) {
        for (const t of tools) console.log(`    [child ${cid.slice(-6)}] tool ${t.name} ${String(t.arguments).slice(0, 70)}`);
        const outs = tools.map(t => ({ type: 'function_call_output', call_id: t.call_id, output: JSON.stringify({ success: true, message: 'executed ' + t.name }) }));
        await post(`/ai-request/${cid}/action/add-message`, { functionCallOutputs: outs, mode: 'agent', toolsVersion: 'v5', payWithCredits: false, gameProjectJson: project });
      } else {
        console.log(`    [child ${cid.slice(-6)}] done: "${lastText(child).slice(0, 70)}"`);
        active.delete(cid);
      }
    }

    // parent finished?
    const p2 = await get(`/ai-request/${pid}`);
    if (p2.status === 'ready' && pendingSub(p2).length === 0 && active.size === 0 && pendingChildTools(p2).length === 0) {
      const txt = lastText(p2);
      if (txt) { console.log('\n=== ORCHESTRATOR DONE ===\n' + txt); break; }
    }
    await sleep(400);
  }
})().catch(e => { console.error('FATAL', e); process.exit(1); });
