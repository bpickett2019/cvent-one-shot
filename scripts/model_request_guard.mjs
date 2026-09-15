/** Fail-closed provider transport wrapper; no credentials or prompts are recorded.
 *
 * Install on the JOB-LOCAL ModelRuntime before createAgentSessionFromServices.
 * Both ordinary Pi turns and Pi 0.84.4 compaction/branch summaries use that runtime's
 * stream path. Do not use before_provider_request extension exceptions as a gate:
 * Pi logs/swallow those exceptions. The serialized Anthropic launcher wires this
 * wrapper to a controller-owned admission client; other launchers are unchanged.
 *
 * admission is a trusted controller client, NOT an LLM tool. It supplies:
 * reserve(metadata), beginDispatch(id), settle(id, {costMicro, usage}),
 * uncertain(id), cancelUndispatched(id), denied(code).
 * quote(model, context, options) supplies versioned expected/upper micro-USD.
 * Actual usage cost comes from the SDK; unpriced/missing usage keeps exposure.
 */
import { randomUUID } from 'node:crypto';

const SUPPORTED = new Map([
  ['anthropic', 'anthropic-messages'],
  ['openai-codex', 'openai-codex-responses'],
]);
const USAGE_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'];
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,100}$/;

function code(error, fallback) {
  return typeof error?.code === 'string' && SAFE_CODE.test(error.code) ? error.code : fallback;
}
function guardError(model, errorCode) {
  return { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'error', errorMessage: `MODEL_ADMISSION_STOP: ${errorCode}`, timestamp: Date.now() };
}
function validUsage(message) {
  const usage = message?.usage;
  if (!usage || USAGE_KEYS.some(k => !Number.isSafeInteger(usage[k]) || usage[k] < 0)) return null;
  if (usage.totalTokens !== usage.input + usage.output + usage.cacheRead + usage.cacheWrite) return null;
  // These supported paid models must have priced, internally consistent usage.
  // Synthetic all-zero usage is not a billing receipt, even on a nominal done event.
  if (usage.totalTokens === 0 || !Number.isFinite(usage.cost?.total) || usage.cost.total <= 0) return null;
  const parts = ['input', 'output', 'cacheRead', 'cacheWrite'].map(k => usage.cost[k]);
  if (parts.some(v => !Number.isFinite(v) || v < 0) ||
      Math.abs(parts.reduce((a, b) => a + b, 0) - usage.cost.total) > 1e-9) return null;
  const costMicro = Math.ceil(usage.cost.total * 1_000_000);
  if (!Number.isSafeInteger(costMicro)) return null;
  return { costMicro, usage: Object.fromEntries(USAGE_KEYS.map(k => [k, usage[k]])) };
}

function observeAnthropicReceipt(response, attempt) {
  const decoder = new TextDecoder();
  let buffer = '';
  attempt.receipt = { start: false, delta: false, stop: false, valid: true, usage: {} };
  const consume = text => {
    buffer = (buffer + text).replace(/\r\n/g, '\n');
    let end;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
      const name = frame.match(/^event:\s*(\S+)/m)?.[1];
      if (!['message_start', 'message_delta', 'message_stop'].includes(name)) continue;
      try {
        const event = JSON.parse(frame.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('\n'));
        if (name === 'message_start') { attempt.receipt.start = true; Object.assign(attempt.receipt.usage, event.message?.usage); }
        if (name === 'message_delta') { attempt.receipt.delta = Number.isSafeInteger(event.usage?.output_tokens); Object.assign(attempt.receipt.usage, event.usage); }
        if (name === 'message_stop') attempt.receipt.stop = true;
      } catch { attempt.receipt.valid = false; }
    }
    if (buffer.length > 2 * 1024 * 1024) { buffer = ''; attempt.receipt.valid = false; }
  };
  if (!response.body) { attempt.receipt.valid = false; return response; }
  return new Response(response.body.pipeThrough(new TransformStream({
    transform(chunk, controller) { consume(decoder.decode(chunk, { stream: true })); controller.enqueue(chunk); },
    flush() { consume(decoder.decode()); },
  })), { status: response.status, statusText: response.statusText, headers: response.headers });
}

function receiptMatches(attempt, usage) {
  const receipt = attempt?.receipt;
  if (!receipt?.valid || !receipt.start || !receipt.delta || !receipt.stop) return false;
  const raw = receipt.usage;
  return usage.input === raw.input_tokens && usage.output === raw.output_tokens &&
    usage.cacheRead === (raw.cache_read_input_tokens ?? 0) && usage.cacheWrite === (raw.cache_creation_input_tokens ?? 0);
}

export function createGuardedStream({ stream, createEventStream, admission, quote, pinnedModel,
  allowedEndpoints, fetchImpl = globalThis.fetch, purpose = () => 'configuration', beforeRequest = async () => {},
  requireAnthropicReceipt = false }) {
  for (const name of ['reserve', 'beginDispatch', 'settle', 'uncertain', 'cancelUndispatched', 'denied']) {
    if (typeof admission?.[name] !== 'function') throw new Error('Incomplete request-admission client');
  }
  if (typeof quote !== 'function' || typeof stream !== 'function' || typeof createEventStream !== 'function')
    throw new Error('Missing guarded runtime dependency');
  const endpoints = new Set(allowedEndpoints.map(value => {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
      throw new Error('Provider endpoint must be a fixed HTTPS URL without credentials/query');
    return url.href;
  }));
  if (!endpoints.size) throw new Error('Explicit provider endpoint allowlist required');

  return (model, context, options = {}) => {
    const output = createEventStream();
    void (async () => {
      const attempts = [];
      let latestResponse;
      let finalEvent;
      let transportFailure;
      let stopped = false;
      const stop = async reason => {
        stopped = true;
        await admission.denied(reason);
      };
      const uncertain = async attempt => {
        if (attempt.terminal) return;
        if (!attempt.dispatched) await admission.cancelUndispatched(attempt.id);
        else await admission.uncertain(attempt.id);
        attempt.terminal = true;
      };
      try {
        await beforeRequest();
        if (model.provider !== pinnedModel.provider || model.id !== pinnedModel.id ||
            SUPPORTED.get(model.provider) !== model.api) {
          const error = new Error('Pinned provider/model/API mismatch');
          error.code = 'MODEL_PIN_MISMATCH'; throw error;
        }
        // SSE ensures every physical Codex inference request crosses guarded fetch.
        // Preserve model, reasoning, context and output allowance. Bound SDK retries
        // here; Pi-level retries are independently admitted on subsequent calls.
        const guardedOptions = { ...options, transport: 'sse', maxRetries: 0,
          fetch: async (input, init = {}) => {
            try {
              if (stopped) throw Object.assign(new Error('Admission stopped'), { code: 'ADMISSION_ALREADY_STOPPED' });
              const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
              const method = String(init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
              if (!endpoints.has(url.href) || method !== 'POST') {
                await stop('UNSUPPORTED_PROVIDER_TRANSPORT');
                throw Object.assign(new Error('Unsupported provider transport'), { code: 'UNSUPPORTED_PROVIDER_TRANSPORT' });
              }
              (init.signal ?? options.signal)?.throwIfAborted();
              // Estimate in memory only. Never send payloads/auth headers to accounting.
              const estimate = await quote(model, context, options, { body: init.body });
              if (!estimate || !Number.isSafeInteger(estimate.expectedMicro) || estimate.expectedMicro < 0 ||
                  !Number.isSafeInteger(estimate.upperMicro) || estimate.upperMicro <= 0 ||
                  estimate.expectedMicro > estimate.upperMicro || typeof estimate.pricingVersion !== 'string')
                throw Object.assign(new Error('Missing conservative pricing'), { code: 'INVALID_COST_ESTIMATE' });
              const id = randomUUID();
              await admission.reserve({ id, provider: model.provider, model: model.id, purpose: purpose(),
                expectedMicro: estimate.expectedMicro, upperMicro: estimate.upperMicro, pricingVersion: estimate.pricingVersion });
              const attempt = { id, dispatchStarted: false, dispatched: false, terminal: false, started: performance.now() };
              attempts.push(attempt);
              try {
                (init.signal ?? options.signal)?.throwIfAborted();
                attempt.dispatchStarted = true;
                await admission.beginDispatch(id);
                attempt.dispatched = true;
                // Treat accepted dispatch as in-flight even if handoff starts now.
                // Disable automatic redirects: a redirected POST cannot bypass admission.
                const response = await fetchImpl(input, { ...init, redirect: 'error' });
                attempt.ok = response.ok;
                latestResponse = attempt;
                if (!response.ok) await uncertain(attempt);
                return requireAnthropicReceipt && response.ok ? observeAnthropicReceipt(response, attempt) : response;
              } catch (error) {
                // A failed dispatch RPC can have committed remotely. Until controller
                // reconciliation proves otherwise, never assume no dispatch occurred.
                if (!attempt.dispatched && attempt.dispatchStarted && error?.definitelyNotDispatched !== true) {
                  attempt.dispatched = true;
                }
                await uncertain(attempt);
                throw error;
              }
            } catch (error) {
              transportFailure = error;
              try { await stop(code(error, 'ADMISSION_OR_TRANSPORT_FAILURE')); } catch { stopped = true; }
              throw error;
            }
          },
        };
        const source = await stream(model, context, guardedOptions);
        for await (const event of source) {
          if (event.type === 'done' || event.type === 'error') {
            if (finalEvent) throw new Error('Multiple terminal provider events');
            finalEvent = event;
          } else {
            if (finalEvent) throw new Error('Provider event after terminal event');
            output.push(event);
          }
        }
        if (transportFailure) throw transportFailure;
        if (!finalEvent) throw new Error('Provider stream ended without terminal usage');
        if (!attempts.length) throw Object.assign(new Error('Provider bypassed guarded fetch'), { code: 'TRANSPORT_NOT_OBSERVED' });
        const message = finalEvent.type === 'done' ? finalEvent.message : finalEvent.error;
        // A partial error/aborted stream is not a final usage receipt.
        const settlement = finalEvent.type === 'done' && (!requireAnthropicReceipt || receiptMatches(latestResponse, message?.usage ?? {}))
          ? validUsage(message) : null;
        if (latestResponse?.ok && !latestResponse.terminal && settlement) {
          await admission.settle(latestResponse.id, { ...settlement,
            durationMs: Math.ceil(performance.now() - latestResponse.started), stopReason: message.stopReason });
          latestResponse.terminal = true;
          latestResponse.settled = true;
        }
        for (const attempt of attempts) await uncertain(attempt);
        if (attempts.some(attempt => !attempt.settled)) {
          await stop('USAGE_RECONCILIATION_REQUIRED');
          throw Object.assign(new Error('Usage not fully settled'), { code: 'USAGE_RECONCILIATION_REQUIRED' });
        }
        output.push(finalEvent);
        output.end(message);
      } catch (error) {
        for (const attempt of attempts) {
          try { await uncertain(attempt); } catch { /* reservation remains held server-side */ }
        }
        const reason = code(error, 'ADMISSION_OR_PROVIDER_FAILURE');
        try { await stop(reason); } catch { /* do not fall back to unguarded execution */ }
        const message = guardError(model, reason);
        output.push({ type: 'error', reason: 'error', error: message });
        output.end(message);
      }
    })();
    return output;
  };
}

export function installGuardedRuntime(runtime, config) {
  // Public ModelRuntime complete()/completeSimple() delegate to these methods.
  // Install before SDK session construction; never modify a global Pi install.
  for (const method of ['stream', 'streamSimple']) {
    runtime[method] = createGuardedStream({ ...config, stream: runtime[method].bind(runtime) });
  }
  // Current jobs do not use deferred inference; refuse rather than bypass guard.
  runtime.fetchDeferred = async () => { throw new Error('Deferred inference is not admitted'); };
  runtime.cancelDeferred = async () => { throw new Error('Deferred inference is not enabled'); };
  return runtime;
}
