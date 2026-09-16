// Offline diagnostic harness: never call original fetch. Modes are test-only;
// the paid diagnostic does not accept an alternate transport or a test-mode flag.
import assert from 'node:assert/strict';
let calls = 0;
globalThis.fetch = async (url, init) => {
  assert.equal(++calls, 1, 'No SDK retry or second physical request is permitted');
  assert.equal(String(url), 'https://api.anthropic.com/v1/messages');
  assert.equal(init.redirect, 'error');
  const payload = JSON.parse(init.body);
  assert.equal(payload.model, 'claude-sonnet-5');
  assert.equal(payload.max_tokens, 128);
  assert.equal(payload.stream, true);
  assert.equal(payload.thinking.type, 'adaptive');
  assert.equal(payload.output_config.effort, 'high');
  assert.equal(payload.tools?.length ?? 0, 0);
  const mode = process.env.CVENT_OFFLINE_SMOKE_CASE || 'success';
  const privateSentinel = 'PRIVATE_PROVIDER_BODY_MUST_NOT_APPEAR';
  if (mode.startsWith('http_')) return new Response(JSON.stringify({ type: 'error',
    error: { type: 'invalid_request_error', message: privateSentinel } }), {
    status: Number(mode.slice(5)), headers: { 'content-type': 'application/json', 'x-private': privateSentinel },
  });
  if (mode === 'transport') throw new TypeError(privateSentinel);
  if (mode === 'timeout') throw new DOMException(privateSentinel, 'TimeoutError');
  if (mode === 'no_body') return new Response(null, { status: 200 });
  const events = [
    ['message_start', { type: 'message_start', message: { id: 'offline', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }],
    ['message_stop', { type: 'message_stop' }],
  ];
  if (mode === 'usage_categories') {
    Object.assign(events[0][1].message.usage, {cache_read_input_tokens: 20, cache_creation_input_tokens: 30});
    events.find(([name]) => name === 'message_delta')[1].usage = {
      output_tokens: 4, output_tokens_details: {thinking_tokens: 2},
    };
  }
  if (mode.startsWith('malformed_')) {
    const usage = events.find(([name]) => name === 'message_delta')[1].usage;
    usage.output_tokens = {malformed_negative: -1, malformed_fraction: 1.5,
      malformed_string: '1', malformed_null: null}[mode];
  }
  if (mode === 'truncated') events.pop();
  if (mode === 'missing_usage') delete events.find(([name]) => name === 'message_delta')[1].usage;
  if (mode === 'sse_error') events.splice(1, events.length, ['error', { type: 'error',
    error: { type: 'overloaded_error', message: privateSentinel } }]);
  return new Response(events.map(([name, value]) => `event: ${name}\ndata: ${JSON.stringify(value)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
};
