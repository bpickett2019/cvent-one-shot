/** Job-scoped client. Never exposes allowance administration as an agent tool. */
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

export const PRICING = 'sonnet-4-6-sdk-0.84.4-standard-5m-v1';
export const PIN = { provider: 'anthropic', id: 'claude-sonnet-4-6' };

export function stopMarker(directory, code) {
  const safeCode = /^[A-Z][A-Z0-9_]{0,100}$/.test(code) ? code : 'MODEL_ADMISSION_FAILURE';
  globalThis[Symbol.for('cvent.benchmark.stop')] = safeCode;
  const file = join(directory, `model-admission-stop-${process.pid}.json`);
  writeFileSync(file + '.tmp', JSON.stringify({ reason: safeCode, at: new Date().toISOString() }), { mode: 0o600 });
  renameSync(file + '.tmp', file);
}

export function assertNotStopped(directory) {
  const stopped = globalThis[Symbol.for('cvent.benchmark.stop')];
  if (stopped) throw Object.assign(new Error('Benchmark paused'), { code: stopped });
  try {
    const marker = JSON.parse(readFileSync(join(directory, `model-admission-stop-${process.pid}.json`), 'utf8'));
    throw Object.assign(new Error('Benchmark paused'), { code: marker.reason });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

export function createBenchmarkClient({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const directory = env.CVENT_JOB_DIR;
  if (!directory || !env.CVENT_MODEL_TOKEN || !env.CVENT_MODEL_EXECUTION_ID || !env.CVENT_JOB_ID)
    throw new Error('Benchmark capability missing');
  const endpoint = new URL(env.CVENT_MODEL_ADMISSION_URL);
  if (endpoint.href !== 'http://127.0.0.1:8877/internal/model-benchmark') throw new Error('Admission endpoint rejected');
  const call = async (operation, data = {}) => {
    const response = await fetchImpl(endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { 'content-type': 'application/json', 'x-cvent-model-token': env.CVENT_MODEL_TOKEN },
      body: JSON.stringify({ jobId: env.CVENT_JOB_ID, executionId: env.CVENT_MODEL_EXECUTION_ID, operation, data }) });
    const result = await response.json();
    if (!response.ok || !result.ok) throw Object.assign(new Error('Benchmark admission rejected'), {
      code: /^[A-Z][A-Z0-9_]{0,100}$/.test(result.code) ? result.code : 'ADMISSION_RPC_FAILED',
      definitelyNotDispatched: result.definitelyNotDispatched === true,
    });
    return result.result;
  };
  return {
    call,
    reserve: meta => call('reserve', meta),
    beginDispatch: id => call('dispatch', { id }),
    settle: (id, value) => call('settle', { id, ...value }),
    uncertain: id => call('uncertain', { id }),
    cancelUndispatched: id => call('cancel', { id }),
    denied: async code => {
      stopMarker(directory, code); // Remains authoritative if controller RPC fails.
      await call('denied', { code });
    },
  };
}

export function quoteBenchmark(model, _context, _options, { body } = {}) {
  if (model.provider !== PIN.provider || model.id !== PIN.id || model.contextWindow !== 1_000_000 || model.maxTokens !== 128_000 ||
      model.cost.input !== 3 || model.cost.output !== 15 || model.cost.cacheRead !== .3 || model.cost.cacheWrite !== 3.75)
    throw Object.assign(new Error('Pricing/catalog changed'), { code: 'PRICING_OR_MODEL_MISMATCH' });
  if (typeof body !== 'string') throw Object.assign(new Error('Uninspected transport body'), { code: 'UNSUPPORTED_PROVIDER_TRANSPORT' });
  const payload = JSON.parse(body);
  if (payload.model !== PIN.id || payload.stream !== true || !Number.isSafeInteger(payload.max_tokens) ||
      payload.max_tokens <= 0 || payload.max_tokens > model.maxTokens)
    throw Object.assign(new Error('Unsupported payload'), { code: 'UNSUPPORTED_PROVIDER_PAYLOAD' });
  // This rate basis supports standard 5-minute caching only, not premium service
  // tiers, server tools or externally injected inference. No payload is persisted.
  const inspect = value => {
    if (!value || typeof value !== 'object') return;
    if (value.cache_control?.ttl && value.cache_control.ttl !== '5m') throw new Error('Unsupported cache pricing');
    for (const child of Object.values(value)) if (typeof child === 'object') inspect(child);
  };
  inspect(payload);
  if (payload.service_tier && payload.service_tier !== 'auto' || payload.tools?.some(t => t.type && t.type !== 'custom'))
    throw Object.assign(new Error('Unsupported paid auxiliary capability'), { code: 'AUXILIARY_INFERENCE_DISABLED' });
  // Deliberately simple conservative headroom: full accepted model input window
  // priced as a cache write, plus the actual allowed output (including thinking).
  // We do not assume a cache hit or use average output as a spending guarantee.
  const upperMicro = Math.ceil(model.contextWindow * 3.75 + payload.max_tokens * 15);
  return { expectedMicro: upperMicro, upperMicro, pricingVersion: PRICING };
}
