#!/usr/bin/env node
/** Selected benchmark only: same Pi/Ego tools and compaction, guarded Anthropic. */
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installGuardedRuntime } from './model_request_guard.mjs';
import { assertNotStopped, createBenchmarkClient, PIN, quoteBenchmark, stopMarker } from './benchmark_client.mjs';

let host;
let stage = 'PIN';
try {
  if (process.env.CVENT_MODEL_BENCHMARK !== '1' || process.env.CVENT_EXECUTION_MODE !== 'simple' ||
      process.env.CVENT_PI_PROVIDER !== PIN.provider || process.env.CVENT_PI_MODEL !== PIN.id ||
      process.env.CVENT_PI_THINKING !== 'high' || process.env.CVENT_PI_VERSION !== '0.84.4')
    throw new Error('Benchmark runtime pin mismatch');
  const cwd = realpathSync(process.cwd());
  if (cwd !== process.env.CVENT_JOB_DIR || cwd !== realpathSync(process.env.CVENT_JOB_DIR)) throw new Error('Job directory must be canonical and match cwd');
  const agentDir = realpathSync(process.env.PI_CODING_AGENT_DIR);
  if (agentDir !== join(cwd, 'pi-config')) throw new Error('Job config directory mismatch');
  const repo = dirname(dirname(fileURLToPath(import.meta.url)));
  const sdkEntry = realpathSync(process.env.CVENT_PI_SDK_ENTRY);
  const manifest = JSON.parse(readFileSync(join(dirname(sdkEntry), '../package.json'), 'utf8'));
  if (manifest.name !== '@earendil-works/pi-coding-agent' || manifest.version !== '0.84.4') throw new Error('Installed SDK pin mismatch');
  stage = 'SDK_LOAD';
  const sdk = await import(pathToFileURL(sdkEntry).href);
  const require = createRequire(sdkEntry);
  const aiEntry = require.resolve.paths('@earendil-works/pi-ai')
    .map(base => join(base, '@earendil-works/pi-ai/dist/index.js')).find(existsSync);
  if (!aiEntry) throw new Error('Installed AI SDK unavailable');
  const ai = await import(pathToFileURL(aiEntry).href);
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  const settings = JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8'));
  const settingsManager = sdk.SettingsManager.inMemory({ ...settings, defaultProvider: PIN.provider,
    defaultModel: PIN.id, defaultThinkingLevel: 'high', defaultProjectTrust: 'never', enableInstallTelemetry: false });
  stage = 'MODEL_LOAD';
  const runtime = await sdk.ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(), modelsPath: null,
    allowModelNetwork: false });
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('Benchmark API key absent');
  await runtime.setRuntimeApiKey(PIN.provider, process.env.ANTHROPIC_API_KEY);
  const model = runtime.getModel(PIN.provider, PIN.id);
  if (!model) throw new Error('Pinned model unavailable');
  const admission = createBenchmarkClient();
  let purpose = 'configuration';
  installGuardedRuntime(runtime, { createEventStream: ai.createAssistantMessageEventStream,
    admission, pinnedModel: PIN, allowedEndpoints: ['https://api.anthropic.com/v1/messages'],
    quote: quoteBenchmark, requireAnthropicReceipt: true,
    purpose: () => purpose, beforeRequest: () => assertNotStopped(cwd) });
  const args = process.argv.slice(2);
  if (args[0] !== '--job') throw new Error('Inference probes and other entry modes are disabled');
  const sessionDir = join(cwd, 'pi-sessions');
  let sessionManager, prompt;
  if (args[1] === '--session') {
    if (args.length !== 4) throw new Error('Invalid resume arguments');
    const file = realpathSync(args[2]);
    if (dirname(file) !== realpathSync(sessionDir)) throw new Error('Session outside job');
    sessionManager = sdk.SessionManager.open(file, sessionDir);
    prompt = args[3];
  } else {
    if (args.length !== 2) throw new Error('Invalid job arguments');
    sessionManager = sdk.SessionManager.create(cwd, sessionDir);
    prompt = args[1];
  }
  stage = 'REGISTER';
  await admission.call('register', { sessionId: sessionManager.getSessionId() });
  sessionManager.appendSessionInfo(`cvent-${process.env.CVENT_JOB_ID}`);
  const tools = ['read', 'bash', 'cvent_open_event', 'cvent_login_handoff', 'cvent_job_update', 'cvent_finish'];
  const createRuntime = async ({ cwd: nextCwd, sessionManager: manager, sessionStartEvent }) => {
    if (realpathSync(nextCwd) !== cwd || manager !== sessionManager) throw new Error('Session replacement is not enabled in benchmark');
    stage = 'SERVICES';
    const services = await sdk.createAgentSessionServices({ cwd, agentDir, modelRuntime: runtime, settingsManager,
      resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        additionalExtensionPaths: [join(repo, 'extensions/cvent-job-tools.ts')],
        additionalSkillPaths: [join(repo, 'skills/ego-browser/SKILL.md')] } });
    const loaded = services.resourceLoader.getExtensions();
    if (loaded.errors.length || loaded.extensions.length !== 1) throw new Error('Required capability extension failed');
    stage = 'SESSION';
    const result = await sdk.createAgentSessionFromServices({ services, sessionManager: manager, sessionStartEvent,
      model, thinkingLevel: 'high', noTools: 'builtin', tools });
    if (result.session.model?.provider !== PIN.provider || result.session.model?.id !== PIN.id || result.session.thinkingLevel !== 'high')
      throw new Error('Model/reasoning fallback prohibited');
    result.session.subscribe(event => {
      if (event.type === 'compaction_start') purpose = 'compaction';
      if (event.type === 'compaction_end') purpose = 'configuration';
      if (event.type === 'auto_retry_start') purpose = 'retry';
      if (event.type === 'auto_retry_end') purpose = 'configuration';
    });
    return { ...result, services, diagnostics: services.diagnostics };
  };
  host = await sdk.createAgentSessionRuntime(createRuntime, { cwd, agentDir, sessionManager });
  stage = 'PRINT';
  await sdk.runPrintMode(host, { mode: 'json', initialMessage: prompt, initialImages: [], messages: [] });
  host = undefined;
  assertNotStopped(cwd);
} catch (error) {
  if (host) await host.dispose().catch(() => {});
  try { stopMarker(process.env.CVENT_JOB_DIR, error.code || 'GUARDED_RUNTIME_FAILED'); } catch { /* process exit also fails closed */ }
  // No payloads, API keys or provider errors in the launcher diagnostic.
  console.log(JSON.stringify({ ok: false, classification: 'guarded_runtime_failed', stage, errorType: error?.constructor?.name || 'Error' }));
  process.exitCode = 1;
}
