import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { createGuardedStream, installGuardedRuntime } from '../scripts/model_request_guard.mjs';
import { quoteBenchmark } from '../scripts/benchmark_client.mjs';

// Supplied by the Python harness after locating the installed Pi package. Never
// read operator auth; all credentials/models storage in this test are in memory.
const sdkEntry = process.argv[2];
const require = createRequire(sdkEntry);
const aiEntry = require.resolve.paths('@earendil-works/pi-ai')
  .map(base => path.join(base, '@earendil-works/pi-ai/dist/index.js')).find(existsSync);
assert(aiEntry, 'Installed Pi AI module is required');
const ai = await import(pathToFileURL(aiEntry).href);
const sdk = await import(pathToFileURL(sdkEntry).href);
const createEventStream = ai.createAssistantMessageEventStream;
const model = { provider: 'anthropic', id: 'test', api: 'anthropic-messages' };
const endpoint = 'https://provider.invalid/v1/messages';
const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
  cost: { input: .001, output: .001, cacheRead: 0, cacheWrite: 0, total: .002 } };
const message = { role: 'assistant', provider: model.provider, model: model.id, api: model.api,
  content: [{ type: 'text', text: 'OK' }], usage, stopReason: 'stop', timestamp: Date.now() };

function fixture({ beforeDispatch, denyReserve = false, fetchImpl, reply = message } = {}) {
  const requests = new Map(), stops = [];
  let network = 0;
  const admission = {
    async reserve(meta) {
      if (denyReserve) throw Object.assign(new Error('USER pause'), { code: 'MODEL_PAUSED_USER' });
      requests.set(meta.id, { meta, state: 'RESERVED' });
    },
    async beginDispatch(id) {
      if (beforeDispatch) await beforeDispatch();
      requests.get(id).state = 'DISPATCHED';
    },
    async settle(id, value) { requests.get(id).state = 'SETTLED'; requests.get(id).settlement = value; },
    async uncertain(id) { requests.get(id).state = 'UNCERTAIN'; },
    async cancelUndispatched(id) { requests.get(id).state = 'CANCELLED'; },
    async denied(reason) { stops.push(reason); },
  };
  const config = { createEventStream, admission, pinnedModel: model, allowedEndpoints: [endpoint],
    quote: async () => ({ expectedMicro: 1000, upperMicro: 10000, pricingVersion: 'test' }),
    fetchImpl: async (...args) => { network++; return fetchImpl ? fetchImpl(...args) : new Response('unused', { status: 200 }); },
  };
  const fake = (m, context, options) => {
    const output = createEventStream();
    void (async () => {
      try {
        await options.fetch(endpoint, { method: 'POST', headers: { authorization: 'DO_NOT_STORE' }, body: 'private prompt' });
        output.push(reply.stopReason === 'error' ? { type: 'error', reason: 'error', error: reply }
          : { type: 'done', reason: 'stop', message: reply }); output.end(reply);
      } catch (error) {
        const failed = { ...message, stopReason: 'error', errorMessage: String(error), usage: { ...usage, totalTokens: 0, input: 0, output: 0 } };
        output.push({ type: 'error', reason: 'error', error: failed }); output.end(failed);
      }
    })();
    return output;
  };
  return { config, fake, requests, stops, network: () => network };
}

{
  const f = fixture();
  const result = await createGuardedStream({ ...f.config, stream: f.fake })(model, { messages: [] }, { reasoning: 'high' }).result();
  assert.equal(result.stopReason, 'stop');
  assert.equal(f.network(), 1);
  const request = [...f.requests.values()][0];
  assert.equal(request.state, 'SETTLED');
  assert.equal(request.settlement.costMicro, 2000);
  assert(!JSON.stringify([...f.requests.values()]).includes('DO_NOT_STORE'));
  assert(!JSON.stringify([...f.requests.values()]).includes('private prompt'));
}
{
  const f = fixture({ denyReserve: true });
  const result = await createGuardedStream({ ...f.config, stream: f.fake })(model, { messages: [] }).result();
  assert.equal(result.stopReason, 'error');
  assert.equal(f.network(), 0);
  assert.equal(f.requests.size, 0);
}
{
  const f = fixture({ beforeDispatch: () => { throw Object.assign(new Error('handoff won'), { code: 'MODEL_PAUSED_USER', definitelyNotDispatched: true }); } });
  const result = await createGuardedStream({ ...f.config, stream: f.fake })(model, { messages: [] }).result();
  assert.equal(result.stopReason, 'error'); assert.equal(f.network(), 0);
  assert.equal([...f.requests.values()][0].state, 'CANCELLED');
}
{
  const f = fixture({ beforeDispatch: () => { throw new Error('RPC connection lost after possible commit'); } });
  await createGuardedStream({ ...f.config, stream: f.fake })(model, { messages: [] }).result();
  assert.equal(f.network(), 0);
  assert.equal([...f.requests.values()][0].state, 'UNCERTAIN');
}
{
  const f = fixture({ fetchImpl: () => { throw new Error('connection reset SECRET'); } });
  const result = await createGuardedStream({ ...f.config, stream: f.fake })(model, { messages: [] }).result();
  assert.equal(f.network(), 1);
  assert.equal([...f.requests.values()][0].state, 'UNCERTAIN');
  assert(!result.errorMessage.includes('SECRET'));
}
{
  const f = fixture();
  let seenOptions;
  const wrapped = createGuardedStream({ ...f.config, stream: (m, c, o) => { seenOptions = o; return f.fake(m, c, o); } });
  await wrapped(model, { messages: [] }, { reasoning: 'high', maxTokens: 5000, transport: 'websocket', maxRetries: 9 }).result();
  assert.equal(seenOptions.reasoning, 'high'); assert.equal(seenOptions.maxTokens, 5000);
  assert.equal(seenOptions.transport, 'sse'); assert.equal(seenOptions.maxRetries, 0);
}
{
  const f = fixture();
  const result = await createGuardedStream({ ...f.config, stream: f.fake })({ ...model, id: 'other' }, { messages: [] }).result();
  assert.equal(f.network(), 0); assert.match(result.errorMessage, /MODEL_PIN_MISMATCH/);
}
{
  const f = fixture();
  const result = await createGuardedStream({ ...f.config, quote: async () => null, stream: f.fake })(model, { messages: [] }).result();
  assert.equal(result.stopReason, 'error'); assert.equal(f.network(), 0);
}
{
  const f = fixture();
  const bypass = () => { const out = createEventStream(); out.push({ type: 'done', reason: 'stop', message }); out.end(message); return out; };
  const result = await createGuardedStream({ ...f.config, stream: bypass })(model, { messages: [] }).result();
  assert.match(result.errorMessage, /TRANSPORT_NOT_OBSERVED/);
}

{
  const f = fixture({ reply: { ...message, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
    totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } });
  const result = await createGuardedStream({ ...f.config, stream: f.fake })(model, { messages: [] }).result();
  assert.match(result.errorMessage, /USAGE_RECONCILIATION_REQUIRED/);
  assert.equal([...f.requests.values()][0].state, 'UNCERTAIN');
}
{
  const f = fixture({ fetchImpl: () => new Response('error', { status: 500 }) });
  const result = await createGuardedStream({ ...f.config, stream: f.fake })(model, { messages: [] }).result();
  assert.equal(result.stopReason, 'error');
  assert.equal([...f.requests.values()][0].state, 'UNCERTAIN');
}
{
  const f = fixture();
  f.config.admission.settle = () => { throw new Error('controller unavailable'); };
  const result = await createGuardedStream({ ...f.config, stream: f.fake })(model, { messages: [] }).result();
  assert.equal(result.stopReason, 'error');
  assert.equal([...f.requests.values()][0].state, 'UNCERTAIN');
}
{
  const f = fixture();
  const result = await createGuardedStream({ ...f.config, allowedEndpoints: ['https://different.invalid/messages'],
    stream: f.fake })(model, { messages: [] }).result();
  assert.match(result.errorMessage, /UNSUPPORTED_PROVIDER_TRANSPORT/);
  assert.equal(f.network(), 0);
}
{
  const f = fixture();
  const result = await createGuardedStream({ ...f.config, stream: f.fake })(model, { messages: [] },
    { signal: AbortSignal.abort() }).result();
  assert.equal(result.stopReason, 'error'); assert.equal(f.network(), 0); assert.equal(f.requests.size, 0);
}

// Real installed SDK's Anthropic adapter + compaction request choke point, using
// a fake fetch. Any accidental unguarded global networking fails this test.
const originalFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error('UNGUARDED_NETWORK_FORBIDDEN'); };
try {
  const runtime = await sdk.ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(), modelsPath: null,
    allowModelNetwork: false, refreshOnCreate: false });
  await runtime.setRuntimeApiKey('anthropic', 'offline-test-not-a-real-key');
  const actualModel = runtime.getModel('anthropic', 'claude-sonnet-5');
  assert(actualModel);
  const wire={model:actualModel.id,stream:true,max_tokens:64,messages:[{role:'user',content:'Reply only OK.'}]};
  const quote=payload=>quoteBenchmark(actualModel,{}, {}, {body:JSON.stringify(payload)});
  assert.equal(quote(wire).upperMicro,2000640);
  assert.equal(quote({...wire,cache_control:{type:'ephemeral'}}).upperMicro,2500640);
  assert.equal(quote({...wire,system:[{type:'text',text:'Cache fixture',cache_control:{type:'ephemeral',ttl:'5m'}}]}).upperMicro,2500640);
  assert.equal(quote({...wire,messages:[{role:'user',content:[{type:'text',text:'OK',cache_control:{type:'ephemeral'}}]}]}).upperMicro,2500640);
  assert.equal(quote({...wire,tools:[{name:'fixture',input_schema:{type:'object'},cache_control:{type:'ephemeral'}}]}).upperMicro,2500640);
  assert.equal(quote({...wire,max_tokens:128000,cache_control:{type:'ephemeral'}}).upperMicro,3780000);
  assert.throws(()=>quote({...wire,cache_control:{type:'ephemeral',ttl:'1h'}}),/Unsupported cache pricing/);
  assert.throws(()=>quote({...wire,tools:[{type:'web_search_20250305',name:'web_search'}]}),/auxiliary/);
  assert.throws(()=>quoteBenchmark(runtime.getModel('anthropic','claude-sonnet-4-6'),{}, {},{body:JSON.stringify(wire)}),/Pricing\/catalog changed/);
  assert.throws(()=>quoteBenchmark({...actualModel,cost:{...actualModel.cost,input:2.01}}, {}, {},{body:JSON.stringify(wire)}),/Pricing\/catalog changed/);
  const f = fixture();
  const sse = [
    ['message_start', { type: 'message_start', message: { id: 'offline', type: 'message', role: 'assistant', model: actualModel.id,
      content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }],
    ['message_stop', { type: 'message_stop' }],
  ].map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
  let actualRequests = 0;
  installGuardedRuntime(runtime, { ...f.config, pinnedModel: actualModel,
    quote: quoteBenchmark, requireAnthropicReceipt: true,
    allowedEndpoints: ['https://api.anthropic.com/v1/messages'],
    fetchImpl: async (_url, options) => {
      actualRequests++;
      assert.equal(options.redirect, 'error');
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const context = { systemPrompt: 'Offline test', messages: [{ role: 'user', content: 'READY', timestamp: Date.now() }] };
  const ordinary = await runtime.completeSimple(actualModel, context, { reasoning: 'high', maxTokens: 128 });
  assert.equal(ordinary.stopReason, 'stop', ordinary.errorMessage);
  const compaction = await import(pathToFileURL(path.join(path.dirname(sdkEntry), 'core/compaction/compaction.js')).href);
  const summary = await compaction.completeSummarization(actualModel, context, { maxTokens: 128 },
    runtime.streamSimple.bind(runtime), { enabled: false, maxRetries: 0 });
  assert.equal(summary.stopReason, 'stop', summary.errorMessage);
  assert.equal(actualRequests, 2);
  assert.equal(f.requests.size, 2);
  assert([...f.requests.values()].every(r => r.state === 'SETTLED'));
  // A pause must also block the compaction path, not only ordinary prompts.
  f.config.admission.reserve = async () => { throw Object.assign(new Error('paused'), { code: 'MODEL_PAUSED_USER' }); };
  const blocked = await compaction.completeSummarization(actualModel, context, { maxTokens: 128 },
    runtime.streamSimple.bind(runtime), { enabled: false, maxRetries: 0 });
  assert.equal(blocked.stopReason, 'error');
  assert.equal(actualRequests, 2);
  // Explicit subsequent/retry attempts under USER ownership must also stop
  // before fetch, not merely the native compaction attempt above.
  for (let retry = 0; retry < 3; retry++) {
    const denied = await runtime.completeSimple(actualModel, context, { reasoning: 'high', maxTokens: 128 });
    assert.equal(denied.stopReason, 'error');
  }
  assert.equal(actualRequests, 2, 'USER ownership must block every retry before fetch');
  f.config.admission.reserve = async () => { throw Object.assign(new Error('auth wait'), { code: 'MODEL_PAUSED_AUTH' }); };
  for (let retry = 0; retry < 3; retry++) {
    const denied = await runtime.completeSimple(actualModel, context, { reasoning: 'high', maxTokens: 128 });
    assert.equal(denied.stopReason, 'error');
  }
  const deniedSummary = await compaction.completeSummarization(actualModel, context, { maxTokens: 128 },
    runtime.streamSimple.bind(runtime), { enabled: true, maxRetries: 2, baseDelayMs: 1 });
  assert.equal(deniedSummary.stopReason, 'error');
  assert.equal(actualRequests, 2, 'Auth waiting must block ordinary inference, retries and compaction');
  // Exact proposed micro profile through the SAME guard and installed adapter.
  // This proves one offline invocation, not a restart-durable live request cap.
  const microRuntime=await sdk.ModelRuntime.create({credentials:new ai.InMemoryCredentialStore(),modelsPath:null,allowModelNetwork:false});
  await microRuntime.setRuntimeApiKey('anthropic','offline-test-not-a-real-key');
  const micro=fixture();let microCalls=0;
  installGuardedRuntime(microRuntime,{...micro.config,pinnedModel:actualModel,quote:quoteBenchmark,requireAnthropicReceipt:true,
    allowedEndpoints:['https://api.anthropic.com/v1/messages'],fetchImpl:async(_url,options)=>{
      microCalls++;
      const payload=JSON.parse(options.body);
      assert.equal(payload.model,'claude-sonnet-5');
      assert.equal(payload.max_tokens,64);
      assert.equal(payload.thinking.type,'adaptive');
      assert.equal(payload.output_config.effort,'low');
      assert.equal(payload.system,undefined);assert.equal(payload.tools,undefined);
      assert.deepEqual(payload.messages,[{role:'user',content:'Reply only OK.'}]);
      assert(!JSON.stringify(payload).includes('cache_control'));
      return new Response(sse,{status:200,headers:{'content-type':'text/event-stream'}});
    }});
  const microResult=await microRuntime.completeSimple(actualModel,{messages:[{role:'user',content:'Reply only OK.',timestamp:0}]},
    {reasoning:'low',maxTokens:64,cacheRetention:'none',maxRetries:0,transport:'sse'});
  assert.equal(microResult.stopReason,'stop',microResult.errorMessage);
  assert.equal(microCalls,1);assert.equal(micro.requests.size,1);
  const microRequest=[...micro.requests.values()][0];
  assert.equal(microRequest.meta.upperMicro,2000640);
  assert.equal(microRequest.state,'SETTLED');
  assert.equal(microRequest.settlement.costMicro,30);
  console.log('Guarded Sonnet 5 transport, cache/no-cache pricing, low-effort micro profile and compaction PASS; zero real network.');
} finally {
  globalThis.fetch = originalFetch;
}
