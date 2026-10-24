import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The AI features against a stand-in client that records each request: the right model, the safety fallback, the
// structured output schema, grounding facts in the prompt, and the chat's tool loop with results sent back.
const dir = mkdtempSync(join(tmpdir(), 'monitor-ai-'));
process.env.MONITOR_DATA_DIR = dir;
const { seedDemo } = await import('../server/seed.js');
const { simulate } = await import('../server/simulator.js');
const { analyzeAll } = await import('../server/ml/analyze.js');
const ai = await import('../server/ai/claude.js');
const { db, one, all } = await import('../server/db.js');
seedDemo(); simulate(); analyzeAll();
after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

const requests = []; let answers = [];
ai.setAiClient({ beta: { messages: { create: async params => { requests.push(structuredClone(params)); const a = answers.shift(); return typeof a === 'function' ? a(params) : a; } } } });
const textReply = (text, extra = {}) => ({ model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text }], ...extra });
const user = one("SELECT * FROM users WHERE email='engineer@monitor.test'");
const finding = () => one("SELECT f.* FROM findings f JOIN machines m ON m.id=f.machine_id WHERE m.tag='IMM-02' AND f.kind='degrading'");

test('explain: structured output from Claude, grounded in the machine facts, cached', async () => {
  const value = { summary: 'Oil is 7 °C above normal and rising 2.6 °C/day.', likelyCauses: [{ cause: 'Fouled oil cooler', evidence: 'Cooling water is normal while oil rises', likelihood: 'high' }], checkFirst: ['Cooler delta-T'], safety: ['Lock out first'], urgency: 'this_week' };
  answers = [textReply(JSON.stringify(value))];
  const e = await ai.explainFinding(finding());
  assert.equal(e.source, 'ai'); assert.equal(e.summary, value.summary); assert.equal(e.likelyCauses[0].likelihood, 'high');
  const req = requests.at(-1);
  assert.equal(req.model, 'claude-opus-5-5'); assert.deepEqual(req.betas, ['server-side-fallback-2026-07-01']); assert.equal(req.fallbacks, 'default');
  assert.equal(req.output_config.format.type, 'json_schema'); assert.equal(req.thinking, undefined);
  assert.match(req.messages[0].content, /Machine IMM-02/); assert.match(req.messages[0].content, /Hydraulic oil temperature \[hydraulic_oil_temp\]/); assert.match(req.messages[0].content, /trend \+\d/);
  const n = requests.length; await ai.explainFinding(finding());
  assert.equal(requests.length, n, 'served from cache');
});

test('explain: a refusal falls back to the standard explanation with a note', async () => {
  answers = [{ model: 'claude-opus-5-5', stop_reason: 'refusal', content: [] }];
  const e = await ai.explainFinding(finding(), { refresh: true });
  assert.equal(e.source, 'standard'); assert.match(e.note, /not available/);
});

test('ticket draft and report from Claude', async () => {
  answers = [textReply(JSON.stringify({ title: 'IMM-02 hydraulic oil overheating trend', symptoms: 'Oil 52 °C, +2.6 °C/day', failureCategory: 'hydraulic', priority: 'medium', machineState: 'running', suggestedActions: ['Check cooler'], partsToCheck: ['Oil cooler'] }))];
  const tid = await ai.draftTicket(finding(), user);
  const t = one('SELECT * FROM ticket_drafts WHERE id=?', tid);
  assert.equal(t.source, 'ai'); assert.equal(JSON.parse(t.draft_json).partsToCheck[0], 'Oil cooler');
  answers = [textReply('## Summary\nIMM-02 needs attention.')];
  const rid = await ai.writeReport('shift', user);
  const r = one('SELECT * FROM reports WHERE id=?', rid);
  assert.equal(r.source, 'ai'); assert.match(r.body, /IMM-02 needs attention/);
  assert.match(requests.at(-1).messages[0].content, /Machine CH-01/);
});

test('chat: looks data up with tools, sends results back, stores the conversation append-only', async () => {
  answers = [
    { model: 'claude-opus-5-5', stop_reason: 'tool_use', content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'tool_use', id: 'tu1', name: 'machine_status', input: { tag: 'imm-02' } }, { type: 'tool_use', id: 'tu2', name: 'signal_history', input: { tag: 'IMM-02', signal: 'nope', hours: 24 } }] },
    params => {
      const results = params.messages.at(-1).content;
      assert.equal(results.length, 2);
      assert.match(results[0].content, /Machine IMM-02/); assert.equal(results[0].is_error, undefined);
      assert.equal(results[1].is_error, true); assert.match(results[1].content, /has no signal "nope"/);
      assert.equal(params.messages[1].content[0].type, 'thinking', 'thinking block passed back unchanged');
      return textReply('IMM-02 oil is rising 2.6 °C/day; check the cooler.');
    },
  ];
  const out = await ai.chat(user, 'Why is IMM-02 getting hot?');
  assert.equal(out.notice, null);
  const req = requests.at(-2);
  assert.deepEqual(req.tools.map(t => t.name), ['list_machines', 'machine_status', 'signal_history', 'list_findings', 'search_manuals']);
  assert.deepEqual(req.cache_control, { type: 'ephemeral' });
  const view = ai.chatView(user.id);
  assert.equal(view.messages.length, 2); assert.equal(view.messages[1].text, 'IMM-02 oil is rising 2.6 °C/day; check the cooler.');
  assert.deepEqual(view.messages[1].lookups, ['machine_status imm-02', 'signal_history IMM-02 nope']);
  assert.equal(all('SELECT * FROM chat_messages WHERE user_id=?', user.id).length, 4);
  ai.newConversation(user.id);
  assert.equal(ai.chatView(user.id).messages.length, 0);
});

test('chat tools answer from the data', () => {
  const machines = ai.runTool('list_machines', {});
  assert.equal(machines.length, 6); assert.ok(machines.find(m => m.tag === 'IMM-02').activeFindings >= 1);
  const h = ai.runTool('signal_history', { tag: 'CH-01', signal: 'supply_temp', hours: 3 });
  assert.equal(h.bucketMinutes, 10); assert.ok(h.buckets.some(b => b.max > 16));
  assert.ok(ai.runTool('list_findings', { tag: 'IMM-02' }).every(f => f.machine === 'IMM-02'));
  assert.throws(() => ai.runTool('machine_status', { tag: 'XX-9' }), /No machine with tag/);
});
