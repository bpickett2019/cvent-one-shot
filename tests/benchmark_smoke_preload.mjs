// Offline diagnostic harness: never call original fetch.
globalThis.fetch = async url => {
  if (String(url) !== 'https://api.anthropic.com/v1/messages') throw new Error('Offline network denied');
  const events = [
    ['message_start', { type: 'message_start', message: { id: 'offline', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }],
    ['message_stop', { type: 'message_stop' }],
  ];
  return new Response(events.map(([name, value]) => `event: ${name}\ndata: ${JSON.stringify(value)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
};
