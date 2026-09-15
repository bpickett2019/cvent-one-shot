/** Test-only preload: intercept ALL fetches; never permit actual networking. */
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
const scenario = process.env.OFFLINE_SCENARIO;
let count = 0;
const events = join(process.env.CVENT_JOB_DIR, 'offline-network.jsonl');
globalThis.fetch = async (input, options = {}) => {
  const url = String(input);
  if (url === 'http://127.0.0.1:8877/internal/model-benchmark') {
    const payload = JSON.parse(options.body);
    appendFileSync(events, JSON.stringify({ kind: 'controller', operation: payload.operation })+'\n');
    const completed = spawnSync(process.env.CVENT_PYTHON, [join(process.env.CVENT_REPO_ROOT, 'tests/benchmark_rpc_offline.py')], {
      input: options.body, encoding: 'utf8', timeout: 15000,
      env: { ...process.env, OFFLINE_GUARD_PID: String(process.pid) }, cwd: process.env.CVENT_REPO_ROOT,
    });
    if (completed.status !== 0) throw new Error('Offline controller bridge failed: '+completed.stderr);
    const reply = JSON.parse(completed.stdout.trim());
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json' } });
  }
  if (url !== 'https://api.anthropic.com/v1/messages') throw new Error('UNGUARDED_NETWORK_FORBIDDEN');
  count++;
  appendFileSync(events, JSON.stringify({ kind: 'provider', count })+'\n');
  const request = JSON.parse(options.body);
  const summary = !request.tools?.length;
  let block = { type: 'text', text: summary ? '## Progress\nVerified fixture read. Continue remaining work.' : 'Offline fixture finished.' };
  if (scenario === 'failures') {
    block = count % 2 ? { type: 'tool_use', id: 'offline_'+count, name: 'bash', input: { command: `invalid-${count}` } }
      : { type: 'tool_use', id: 'offline_'+count, name: 'read', input: { path: 'state.json' } };
  } else if (scenario.startsWith('compaction') && count === 1) {
    block = { type: 'tool_use', id: 'offline_read', name: 'read', input: { path: 'state.json' } };
  }
  const longTurn = scenario.startsWith('compaction') && count === 1;
  const inputTokens = longTurn ? 970000 : 10;
  const blockIndex = longTurn ? 1 : 0;
  const sse = [
    ['message_start', { type: 'message_start', message: { id: 'offline_'+count, type: 'message', role: 'assistant', model: request.model,
      content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }],
    ...(longTurn ? [
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'fixture '.repeat(11000) } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ] : []),
    ['content_block_start', { type: 'content_block_start', index: blockIndex, content_block: block.type === 'text' ? { type: 'text', text: '' } : { ...block, input: {} } }],
    ['content_block_delta', { type: 'content_block_delta', index: blockIndex, delta: block.type === 'text' ? { type: 'text_delta', text: block.text } : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } }],
    ['content_block_stop', { type: 'content_block_stop', index: blockIndex }],
    ...(scenario === 'missing_usage' ? [] : [
      ['message_delta', { type: 'message_delta', delta: { stop_reason: block.type === 'text' ? 'end_turn' : 'tool_use', stop_sequence: null }, usage: { output_tokens: longTurn ? 22000 : 1 } }],
      ['message_stop', { type: 'message_stop' }],
    ]),
  ].map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
  return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
};
