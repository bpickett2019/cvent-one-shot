// Explicit, no-tools, no-Cvent diagnostic. Invoked only by benchmark_smoke.py.
import { createInterface } from 'node:readline';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installGuardedRuntime } from './model_request_guard.mjs';
import { PIN, quoteBenchmark } from './benchmark_client.mjs';
if (process.env.CVENT_NO_CVENT_PAID_SMOKE !== '1') throw new Error('Explicit diagnostic required');
const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
async function call(operation, data = {}) {
  console.log(JSON.stringify({ operation, data }));
  const { value, done } = await lines.next();
  if (done) throw new Error('Diagnostic controller disconnected');
  const reply = JSON.parse(value);
  if (!reply.ok) throw Object.assign(new Error(reply.code), { code: reply.code, definitelyNotDispatched: operation === 'dispatch' });
  return reply;
}
try {
  const entry = process.env.CVENT_PI_SDK_ENTRY, require = createRequire(entry);
  const aiEntry = require.resolve.paths('@earendil-works/pi-ai').map(p => join(p, '@earendil-works/pi-ai/dist/index.js')).find(existsSync);
  const ai = await import(pathToFileURL(aiEntry).href), sdk = await import(pathToFileURL(entry).href);
  const runtime = await sdk.ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
  await runtime.setRuntimeApiKey(PIN.provider, process.env.ANTHROPIC_API_KEY);
  const model = runtime.getModel(PIN.provider, PIN.id);
  let networkCalls = 0;
  installGuardedRuntime(runtime, {
    createEventStream: ai.createAssistantMessageEventStream, pinnedModel: PIN, quote: quoteBenchmark,
    allowedEndpoints: ['https://api.anthropic.com/v1/messages'], requireAnthropicReceipt: true,
    fetchImpl: (...args) => { networkCalls++; return fetch(...args); },
    admission: {
      reserve: data => call('reserve', data), beginDispatch: id => call('dispatch', { id }),
      settle: (id, value) => call('settle', { id, ...value }),
      uncertain: id => call('uncertain', { id }), cancelUndispatched: id => call('cancel', { id }),
      denied: code => call('denied', { code }),
    },
  });
  const context = { systemPrompt: 'No tools are available. This is an accounting diagnostic. Reply only OK.',
    messages: [{ role: 'user', content: 'Reply OK.', timestamp: Date.now() }] };
  const options = { reasoning: 'high', maxTokens: 128, signal: AbortSignal.timeout(60000) };
  const first = await runtime.completeSimple(model, context, options);
  if (first.stopReason === 'error' || first.stopReason === 'aborted') throw new Error('No settled provider response');
  await call('reopen_and_reduce_test_allowance');
  const second = await runtime.completeSimple(model, context, { ...options, signal: AbortSignal.timeout(60000) });
  console.log(JSON.stringify({ operation: 'finished', data: { networkCalls, firstStopReason: first.stopReason,
    secondBlocked: second.stopReason === 'error' && networkCalls === 1 } }));
} catch (error) {
  console.log(JSON.stringify({ operation: 'failed', data: { errorType: error?.constructor?.name || 'Error' } }));
  process.exitCode = 1;
}
process.stdin.destroy();
