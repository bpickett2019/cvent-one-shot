import { execFile } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { open, readFile, realpath, rename, mkdir, appendFile, lstat, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Type } from "typebox";
import { retainJobContext, ValidatedRRCache, BrowserRecoveryBudget, firstIncompleteDomain, staleRefWithoutWrite, adapterNeedsNativeFallback, DomainProgressGuard } from "./prewrite-orchestration.mjs";

import { isDataAction, validateAtomicSteps, planNativeRound } from "../ego_round_validation.mjs";

const SIMPLE = process.env.CVENT_EXECUTION_MODE === "simple";
const BENCHMARK = process.env.CVENT_MODEL_BENCHMARK === "1";
const rrCache = new ValidatedRRCache();
const recoveryBudget = new BrowserRecoveryBudget();
let preparedRR: any = null;

const BROWSER_OPERATION_NAMES = [
  "probe", "recover", "authStatus", "authorizeTarget", "openAuthorizedEvent", "snapshotText", "screenshot", "readTarget", "sectionState", "controlInventory", "pageInfo", "scanEventList",
  "actions", "scroll", "click", "activate", "visualClick", "visualDoubleClick", "fill", "type", "typeText", "navigate", "wait", "hover", "selectOption", "setChecked", "press", "search", "selectText", "drag", "visualDrag", "uploadDiscountImport",
];
const PI_BROWSER_OPERATION_NAMES = BROWSER_OPERATION_NAMES;
const EGO_ACTION_OPERATIONS = ["pageInfo", "snapshotText", "screenshot", "readTarget", "sectionState", "controlInventory", "scroll", "click", "activate", "visualClick", "visualDoubleClick", "fill", "type", "typeText", "navigate", "wait", "hover", "selectOption", "setChecked", "press", "search", "selectText", "drag", "visualDrag", "uploadDiscountImport"] as const;
const TRUSTED_SECTION_PROCEDURES: Record<string, string> = {
  admission_items: "configureAdmissionItems", registration_types: "configureRegistrationTypes",
};
const BROWSER_OPERATIONS = new Set(BROWSER_OPERATION_NAMES);
const READ_ONLY_OPERATIONS = new Set([
  "probe", "recover", "authStatus", "authorizeTarget", "openAuthorizedEvent", "snapshotText", "screenshot", "readTarget", "sectionState", "controlInventory", "pageInfo", "scanEventList",
  "scroll", "navigate", "wait", "hover", "search", "selectText",]);
const ALLOWED_KEYS = new Set([
  "Enter", "Escape", "Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "Backspace", "Delete", "Home", "End", "PageUp", "PageDown", "Space",
]);
const DOMAIN_NAMES = [
  "event_settings", "site_designer", "registration_paths", "registration_types",
  "admission_items", "optional_items", "pricing", "discounts_vouchers",
  "questions", "sessions", "integrations", "communications", "badges_onsite", "associations", "final_qa",
] as const;
const DOMAINS = new Set<string>(DOMAIN_NAMES);
const JOB_STAGES = ["starting", "target_discovery", ...DOMAIN_NAMES] as const;
const literalUnion = (values: readonly string[]) => Type.Union(values.map((value) => Type.Literal(value)) as any);
const ARTIFACTS: Record<string, string> = {
  state: "state.json",
  auth_metadata: "auth-settings.json",
  target_lock: "authorized-target.json",
  activity: "activity.log",
  write_audit: "scope-write-audit.jsonl",
  browser_failure: "last-browser-failure-result.json",
  final_report: "final-report.json",
  domain_results: "domain-results.json",
  inspection_summary: "input.inspection-summary.json",
  browser_runtime: "browser-runtime.json",
  performance: "performance-summary.json",
};
const ALLOWED_TOOLS = new Set(SIMPLE ? ["read", "bash", "cvent_open_event", "cvent_login_handoff", "cvent_job_update", "cvent_finish"] : [
  "read", "bash",
  "cvent_prepare_rr", "cvent_expectations", "cvent_plan", "cvent_job_read",
  "cvent_job_update", "cvent_record_domain", "cvent_verify_domain", "cvent_browser", "cvent_section_state", "cvent_execute_section",
  "cvent_login_handoff", "cvent_snapshot_chunk", "cvent_finish",
]);
const MAX_TEXT_BYTES = 48 * 1024;
const SIMPLE_PREVIEW_BYTES = 12 * 1024;

// Application circuit breaker, not an invoice cap. Checked between tool batches;
// never kill an in-flight Save or erase pending readback/uncertainty evidence.
export class UsageBudget {
  totals: Record<string, number>;
  repeatedError = "";
  repeatedErrorCount = 0;
  limits: { calls: number; tokens: number; apiUsd: number };
  constructor(saved: Record<string, number> = {}, env = process.env) {
    const positive = (name: string, fallback: number) => {
      const n = Number(env[name] ?? fallback);
      if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive finite number`);
      return n;
    };
    this.limits = { calls: positive("CVENT_MAX_MODEL_CALLS", 250), tokens: positive("CVENT_MAX_TOTAL_TOKENS", 20000000), apiUsd: positive("CVENT_MAX_API_COST_USD", 15) };
    this.totals = Object.fromEntries(["calls", "input", "output", "cacheRead", "cacheWrite", "totalTokens", "estimatedApiUsd", "estimatedSubscriptionEquivalentUsd"].map(k => [k, Number(saved[k]) || 0]));
  }
  record(message: any) {
    const usage = message.usage ?? {};
    const n = (value: any) => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
    this.totals.calls++;
    for (const key of ["input", "output", "cacheRead", "cacheWrite"]) this.totals[key] += n(usage[key]);
    this.totals.totalTokens += n(usage.totalTokens) || ["input", "output", "cacheRead", "cacheWrite"].reduce((sum, key) => sum + n(usage[key]), 0);
    const bucket = message.provider === "openai-codex" ? "estimatedSubscriptionEquivalentUsd" : "estimatedApiUsd";
    this.totals[bucket] += n(usage.cost?.total);
  }
  toolResult(name: string, result: any, isError: boolean) {
    if (!isError) { this.repeatedError = ""; this.repeatedErrorCount = 0; return; }
    const key = createHash("sha256").update(name + JSON.stringify(result?.content ?? result)).digest("hex");
    this.repeatedErrorCount = key === this.repeatedError ? this.repeatedErrorCount + 1 : 1;
    this.repeatedError = key;
  }
  reason(): string | null {
    if (this.repeatedErrorCount >= 3) return "Three identical consecutive tool failures; operator review required before more model calls";
    if (this.totals.calls >= this.limits.calls) return `Model-call checkpoint reached (${this.limits.calls})`;
    if (this.totals.totalTokens >= this.limits.tokens) return `Cumulative token checkpoint reached (${this.limits.tokens}, including cached tokens)`;
    if (this.totals.estimatedApiUsd >= this.limits.apiUsd) return `Estimated API spend checkpoint reached ($${this.limits.apiUsd}; not an invoice total)`;
    return null;
  }
}
const SNAPSHOT_CHUNK_BYTES = 36 * 1024;
const MAX_CHILD_OUTPUT = 8 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
const SNAPSHOT_PENDING = join(resolve(requiredEnvironment("CVENT_JOB_DIR")), "browser-snapshot-pending.json");
const WRITE_READBACK_PENDING = join(resolve(requiredEnvironment("CVENT_JOB_DIR")), "browser-write-readback-required.json");
const PERFORMANCE_EVENTS = join(resolve(requiredEnvironment("CVENT_JOB_DIR")), "performance-events.jsonl");
const ROUTE_CACHE = join(resolve(requiredEnvironment("CVENT_JOB_DIR")), "cvent-route-cache.json");
const DOMAIN_PROGRESS = join(resolve(requiredEnvironment("CVENT_JOB_DIR")), "domain-progress.json");
const NATIVE_FALLBACK = join(resolve(requiredEnvironment("CVENT_JOB_DIR")), "native-ego-fallback-required.json");
const queues = new Map<string, Promise<unknown>>();
const extensionStarted = performance.now();
let firstBrowserActionRecorded = false;
type TurnProgress = {
  turnIndex: number; section: string; browserOperations: number; browserActions: number; egoRounds: number;
  toolNames: string[]; requiredVerification: boolean; ambiguityResolved: boolean; humanOrSecurityBoundary: boolean;
  repeatedRead: boolean; meaningfulProgress: boolean; progressReasons: string[]; modelDurationMs: number; toolCalls: Map<string, { name: string; args: any }>;
};
let activeTurnProgress: TurnProgress | null = null;
const domainProgress = new DomainProgressGuard(3);
const domainPageUrls = new Map<string, string>();
const domainSeenPages = new Set<string>();

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Required server capability ${name} is absent`);
  return value;
}

const jobDir = resolve(requiredEnvironment("CVENT_JOB_DIR"));
const repoRoot = resolve(requiredEnvironment("CVENT_REPO_ROOT"));
const runtimePath = join(jobDir, "browser-runtime.json");
const python = process.env.CVENT_PYTHON || "python3";

async function benchmarkCall(operation: string, data: Record<string, unknown>) {
  try {
    const { createBenchmarkClient } = await import(join(repoRoot, "scripts/benchmark_client.mjs"));
    return await createBenchmarkClient().call(operation, data);
  } catch (error) {
    // Pi notification-hook exceptions are fail-open. Persist a stop which the
    // guarded runtime checks BEFORE any provider/compaction request instead.
    (globalThis as any)[Symbol.for("cvent.benchmark.stop")] = "BENCHMARK_CONTROL_UNAVAILABLE";
    await atomicJson(join(jobDir, `model-admission-stop-${process.pid}.json`), {
      reason: "BENCHMARK_CONTROL_UNAVAILABLE", at: new Date().toISOString(),
    });
    throw error;
  }
}

function assertFixedJobPath(path: string): string {
  const absolute = resolve(path);
  if (absolute !== jobDir && !absolute.startsWith(jobDir + "/")) {
    throw new Error("Capability denied: path is outside this job workspace");
  }
  return absolute;
}

function cleanText(value: unknown, max = 4000): string {
  const text = String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim();
  return text.slice(0, max);
}

function redact(text: string): string {
  let value = text.replace(/((?:ANTHROPIC_API_KEY|CVENT_LEASE_TOKEN|ENTRA_CLIENT_SECRET|CVENT_SESSION_SECRET)\s*[=:]\s*)\S+/gi, "$1[REDACTED]");
  for (const name of ["ANTHROPIC_API_KEY", "CVENT_LEASE_TOKEN", "ENTRA_CLIENT_SECRET", "CVENT_SESSION_SECRET", "AZURE_CLIENT_SECRET"]) {
    const secret = process.env[name];
    if (secret && secret.length >= 8) value = value.split(secret).join("[REDACTED]");
  }
  return value.slice(-MAX_TEXT_BYTES);
}

function toolText(value: unknown): { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> } {
  let text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) {
    text = utf8Chunks(text, MAX_TEXT_BYTES)[0] +
      "\n[Capability output stopped at 48KB; request a narrower domain/page. No source read was shortened.]";
  }
  return { content: [{ type: "text", text }], details: {} };
}

async function toolBrowserResult(value: any): Promise<any> {
  const base = toolText(value);
  const paths = new Set<string>();
  const visit = (item: any): void => {
    if (!item || typeof item !== "object") return;
    if (typeof item.screenshotPath === "string") paths.add(item.screenshotPath);
    for (const child of Object.values(item)) visit(child);
  };
  visit(value);
  for (const candidate of [...paths].slice(-2)) {
    const path = assertFixedJobPath(candidate);
    const image = await readJobFile(path, 12 * 1024 * 1024);
    base.content.push({ type: "image", data: image.toString("base64"), mimeType: "image/png" } as any);
  }
  return base;
}

function safeChildEnvironment(kind: "browser" | "prepare"): NodeJS.ProcessEnv {
  const names = ["PATH", "LANG", "LC_ALL", "TZ"];
  const environment: NodeJS.ProcessEnv = {};
  for (const name of names) if (process.env[name]) environment[name] = process.env[name];
  environment.CVENT_REPO_ROOT = repoRoot;
  environment.CVENT_JOB_DIR = jobDir;
  for (const name of [
    "CVENT_ENV", "CVENT_DATA_ROOT", "CVENT_JOB_ID", "CVENT_WORKSPACE_ID", "CVENT_WORKER_SLOT",
    "CVENT_STEEL_API_ORIGIN", "CVENT_CDP_ORIGIN", "CVENT_AUTHORIZED_EVENT_ID",
    "CVENT_AUTHORIZED_EVENT_NAME", "CVENT_AUTHORIZED_EVENT_KEY", "CVENT_AUTHORIZED_EVENT_CODE", "CVENT_WRITABLE_EVENT_STATUSES",
  ]) if (process.env[name]) environment[name] = process.env[name];
  if (kind === "browser") {
    environment.CVENT_LEASE_VALIDATE_URL = requiredEnvironment("CVENT_LEASE_VALIDATE_URL");
    environment.CVENT_LEASE_TOKEN = requiredEnvironment("CVENT_LEASE_TOKEN");
  }
  return environment;
}

function runFixed(executable: string, args: string[], kind: "browser" | "prepare", signal?: AbortSignal, timeout = 120000): Promise<{ stdout: string; stderr: string }> {
  const started = performance.now();
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(executable, args, {
      cwd: repoRoot,
      env: safeChildEnvironment(kind),
      timeout,
      maxBuffer: MAX_CHILD_OUTPUT,
      signal,
      windowsHide: true,
    }, async (error, stdout, stderr) => {
      if (error) {
        let structuredError = "";
        if (kind === "browser") {
          try {
            const line = String(stdout).split(/\r?\n/).reverse().find(value => value.startsWith("BROWSER_ROUTER_RESULT="));
            if (line) structuredError = String(JSON.parse(line.slice("BROWSER_ROUTER_RESULT=".length)).error ?? "");
          } catch { /* Preserve the original helper diagnostic if malformed. */ }
        }
        const message = redact(structuredError || `${error.message}\n${stderr || stdout}`);
        if (kind === "browser") {
          const operation = args[args.indexOf("--operation") + 1] || "unknown";
          if (!SIMPLE) recoveryBudget.failure(operation, message);
          try {
            const partial = message.includes("last-browser-failure-result.json")
              ? await readJson(join(jobDir, "last-browser-failure-result.json"), {}) : {};
            await appendPerformance("browser_operation_failed", started, { operation, error: message, pid: process.pid,
              egoExecutionRound: ["script", "actions"].includes(operation),
              actionCount: partial.completedActions?.length ?? 0, actionCountUnknown: !partial.completedActions,
              writesAttempted: partial.writesAttempted ?? null });
            await appendActivity(`Browser operation ${operation} failed: ${message.slice(-900)}`);
            if (recoveryBudget.firstFailure) await atomicJson(join(jobDir, `first-browser-failure-${process.pid}.json`), recoveryBudget.firstFailure);
            if (recoveryBudget.terminalFailure) await atomicJson(join(jobDir, `controller-failure-${process.pid}.json`), recoveryBudget.terminalFailure);
          } catch { /* Preserve the actual helper error if telemetry fails. */ }
        }
        rejectPromise(new Error(message));
        return;
      }
      resolvePromise({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

async function settleAuthenticatedProfile(initial: any, read: () => Promise<any>, pause: () => Promise<void>): Promise<any> {
  let auth = initial;
  // A restored, correctly bound profile can reach the SPA before rendering
  // finishes. Poll only reads, and never waive profile or account checks.
  for (let attempt = 0; attempt < 8 && !auth.authenticated && auth.persistedProfile === true &&
       auth.profileMatch === true && auth.accountContextMatch === true; attempt++) {
    await pause();
    auth = await read();
  }
  return auth;
}

async function withQueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolvePromise) => { release = resolvePromise; });
  const tail = previous.catch(() => undefined).then(() => current);
  queues.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (queues.get(key) === tail) queues.delete(key);
  }
}

async function assertPrivateJobRoot(): Promise<void> {
  const canonical = await realpath(jobDir);
  if (canonical !== jobDir) throw new Error("Capability denied: job workspace may not be a symlink");
}

async function readJobFile(path: string, maxBytes = MAX_CHILD_OUTPUT): Promise<Buffer> {
  await assertPrivateJobRoot();
  const target = assertFixedJobPath(path);
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Capability denied: job artifact must be a regular non-symlink file");
  if (info.size > maxBytes) throw new Error("Capability denied: job artifact exceeds its read limit");
  return readFile(target);
}

async function readJson(path: string, fallback: unknown = {}): Promise<any> {
  try { return JSON.parse((await readJobFile(path)).toString("utf8")); }
  catch (error: any) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await assertPrivateJobRoot();
  const target = assertFixedJobPath(path);
  await mkdir(jobDir, { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value, null, 2) + "\n", "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, target);
}

async function assertSafeArtifactTarget(path: string): Promise<string> {
  await assertPrivateJobRoot();
  const target = assertFixedJobPath(path);
  try {
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Capability denied: job artifact target is not a regular file");
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
  return target;
}

async function appendPerformance(kind: string, startedMs: number, details: Record<string, unknown> = {}): Promise<void> {
  const target = await assertSafeArtifactTarget(PERFORMANCE_EVENTS);
  const payload = { timestamp: new Date().toISOString(), kind, durationMs: Math.max(0, Math.round((performance.now() - startedMs) * 10) / 10), ...details };
  await appendFile(target, `${JSON.stringify(payload)}\n`, { encoding: "utf8", mode: 0o600 });
}

async function appendActivity(message: string): Promise<void> {
  const safe = cleanText(message, 1200).replace(/[\r\n]+/g, " ");
  if (!safe) return;
  const target = await assertSafeArtifactTarget(join(jobDir, "activity.log"));
  await appendFile(target, `${new Date().toISOString()}  ${safe}\n`, { encoding: "utf8", mode: 0o600 });
}

async function updateBrowserProgress(action: string): Promise<void> {
  return withQueue("job-files", async () => {
    const path = join(jobDir, "state.json");
    const state = await readJson(path, {});
    state.current_action = cleanText(action, 1200);
    state.updated_at = new Date().toISOString();
    await atomicJson(path, state);
  });
}

async function readJsonLines(path: string): Promise<any[]> {
  try {
    return (await readJobFile(path)).toString("utf8").split(/\r?\n/).filter(Boolean).flatMap(line => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  } catch (error: any) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function resumeDomain(): Promise<string | null> {
  const [plan, results, verification, state] = await Promise.all([
    readJson(join(jobDir, "configuration-plan.json"), { mission: [] }),
    readJson(join(jobDir, "domain-results.json"), { domains: {} }),
    readJson(join(jobDir, "final-verification.json"), { domains: {} }),
    readJson(join(jobDir, "state.json"), {}),
  ]);
  return firstIncompleteDomain(plan, results, verification, state);
}

async function assessedDomains(): Promise<string[]> {
  const [plan, results, verification, state] = await Promise.all([
    readJson(join(jobDir, "configuration-plan.json"), { mission: [] }),
    readJson(join(jobDir, "domain-results.json"), { domains: {} }),
    readJson(join(jobDir, "final-verification.json"), { domains: {} }),
    readJson(join(jobDir, "state.json"), {}),
  ]);
  return (plan.mission ?? []).map((item: any) => item.domain).filter((domain: string) =>
    firstIncompleteDomain({ mission: [{ domain }] }, results, verification, state) === null);
}

async function browserAuthorizationState(): Promise<{ runtimeId: string; targetState: "bound" | "unbound" }> {
  const runtime = await readJson(runtimePath, {}), lock = await readJson(join(jobDir, "authorized-target.json"), {});
  const bound = Boolean(runtime.browserRuntimeId && lock.browser_runtime_id === runtime.browserRuntimeId &&
    String(lock.event_key ?? "").toLowerCase() === String(runtime.authorizedEventKey ?? "").toLowerCase());
  return { runtimeId: String(runtime.browserRuntimeId ?? "unknown"), targetState: bound ? "bound" : "unbound" };
}

async function domainTelemetry(domain: string): Promise<{ browserOperations: number; writes: number; saves: number; readbacks: number }> {
  const events = await readJsonLines(PERFORMANCE_EVENTS);
  const operations = events.filter(event => event.kind === "browser_operation" && event.section === domain);
  const totals = { browserOperations: operations.length, writes: 0, saves: 0, readbacks: 0 };
  for (const event of operations) {
    totals.writes += Number(event.writes ?? 0); totals.saves += Number(event.saves ?? 0); totals.readbacks += Number(event.readbacks ?? 0);
  }
  return totals;
}

function strategyOperation(operation: string, objective = ""): boolean {
  return ["snapshotText", "screenshot", "sectionState", "navigate", "openAuthorizedEvent", "recover"].includes(operation) ||
    /fresh snapshot|\.snapshot\(|\.screenshot\(|snapshotText\(|new locator|direct navigation|\.goto\(|visual|hold|independent item|strategy/i.test(objective);
}

async function assertDomainStrategy(domain: string, operation: string, objective = ""): Promise<void> {
  const persisted = await readJson(DOMAIN_PROGRESS, { domains: {} });
  const required = domainProgress.requireStrategy(domain) || persisted.domains?.[domain]?.strategyRequired === true;
  if (!required) return;
  if (!strategyOperation(operation, objective)) throw new Error(`DOMAIN_PROGRESS_STALLED: ${domain} has 3 consecutive zero-progress rounds. Change strategy with a fresh semantic snapshot, new locator/direct route, visual Ego, an item hold, or another independent item.`);
  const strategy = cleanText(`${operation}: ${objective}`, 500);
  if (persisted.domains?.[domain]?.strategy === strategy)
    throw new Error(`DOMAIN_PROGRESS_STALLED: ${domain} already tried this strategy without progress. Choose a different locator, legitimate route, visual inspection, or hold one item and continue.`);
  domainProgress.strategyChanged(domain);
  persisted.domains ??= {}; persisted.domains[domain] = { ...(persisted.domains[domain] ?? {}), consecutiveZeroProgressRounds: 0,
    strategyRequired: false, strategyChangedAt: new Date().toISOString(), strategy };
  persisted.updatedAt = new Date().toISOString(); await atomicJson(DOMAIN_PROGRESS, persisted);
  await appendActivity(`DOMAIN_PROGRESS_STRATEGY_CHANGED ${domain}: ${cleanText(`${operation} ${objective}`, 500)}`);
}

async function recordDomainRoundProgress(domain: string, result: any, objective = ""): Promise<any> {
  const pageUrl = cleanText(result?.page?.url, 4000);
  const previousUrl = domainPageUrls.get(domain) ?? "";
  const pageChanged = Boolean(pageUrl && previousUrl && pageUrl !== previousUrl);
  const pageIdentity = `${domain}\u0000${pageUrl}`;
  const newRelevantPage = Boolean(pageUrl && !domainSeenPages.has(pageIdentity));
  if (pageUrl) { domainPageUrls.set(domain, pageUrl); domainSeenPages.add(pageIdentity); }
  const writes = Number(result?.writesAttempted ?? result?.mutationCount ?? 0), saves = Number(result?.saves ?? 0), readbacks = Number(result?.readbacks ?? 0);
  const observations = JSON.stringify(result?.logs ?? result?.snapshot ?? "");
  const controls = [...observations.matchAll(/(?:textbox|combobox|checkbox|radio|button) \\"([^\\"]+)\\"/g)].map(match => match[1]);
  let newControl = false;
  for (const control of controls) {
    const key = `${domain}\u0000control:${control}`;
    if (!domainSeenPages.has(key)) { domainSeenPages.add(key); newControl = true; }
  }
  const meaningful = writes > 0 || saves > 0 || readbacks > 0 || newControl || newRelevantPage || (pageChanged && newRelevantPage) || ["CONFIGURED", "ALREADY_CORRECT"].includes(String(result?.status));
  const progress = domainProgress.observe(domain, meaningful);
  const persisted = await readJson(DOMAIN_PROGRESS, { schemaVersion: 1, domains: {} }); persisted.domains ??= {};
  persisted.domains[domain] = { ...(persisted.domains[domain] ?? {}), consecutiveZeroProgressRounds: progress.consecutive, maximumConsecutiveZeroProgressRounds: progress.maximum,
    strategyRequired: progress.strategyRequired, meaningful: progress.meaningful, lastObjective: cleanText(objective, 500), updatedAt: new Date().toISOString() };
  persisted.updatedAt = new Date().toISOString(); await atomicJson(DOMAIN_PROGRESS, persisted);
  if (progress.stalled) {
    await appendActivity(`DOMAIN_PROGRESS_STALLED ${domain}: 3 consecutive rounds without meaningful progress; strategy change required`);
    result.domainProgress = { status: "DOMAIN_PROGRESS_STALLED", consecutiveZeroProgressRounds: progress.consecutive,
      instruction: "Do not repeat this inspection. Use a fresh semantic snapshot, discard stale refs, choose a new/direct locator, switch to visual Ego, hold only the problematic item, or move to another independent item." };
  } else result.domainProgress = { status: progress.meaningful ? "PROGRESSED" : "NO_PROGRESS", consecutiveZeroProgressRounds: progress.consecutive };
  if (activeTurnProgress && progress.meaningful) { activeTurnProgress.meaningfulProgress = true; activeTurnProgress.progressReasons.push("domain_round"); }
  return result;
}

async function markNativeFallback(domain: string, result: any): Promise<void> {
  await atomicJson(NATIVE_FALLBACK, { schemaVersion: 1, domain, reason: result.status, writes: Number(result.mutationCount ?? 0),
    requiredAt: new Date().toISOString(), instruction: "Native Ego must inspect the live controls before this domain can be completed or held." });
}

async function clearNativeFallback(domain: string): Promise<void> {
  const marker = await readJson(NATIVE_FALLBACK, null);
  if (!marker || marker.domain !== domain) return;
  try { await unlink(NATIVE_FALLBACK); } catch (error: any) { if (error?.code !== "ENOENT") throw error; }
  await appendActivity(`Native Ego fallback entered for ${domain} after trusted adapter limitation`);
}

function hash(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

async function verifiedCompiledExpectations(): Promise<any> {
  const revision = async () => {
    await assertPrivateJobRoot();
    const files = await Promise.all(["input.xlsx", "expected-domains.json", "rr-validation.json", "configuration-plan.json"].map(async (name) => {
      const info = await lstat(join(jobDir, name));
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("RR artifacts must be regular private job files");
      return [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs];
    }));
    return JSON.stringify([files, requiredEnvironment("CVENT_AUTHORIZED_EVENT_KEY"), requiredEnvironment("CVENT_AUTHORIZED_EVENT_ID"), requiredEnvironment("CVENT_AUTHORIZED_EVENT_NAME")]);
  };
  return rrCache.get(revision, async () => {
  const input = await readJobFile(join(jobDir, "input.xlsx"), 25 * 1024 * 1024);
  const expected = await readJson(join(jobDir, "expected-domains.json"), null);
  const validation = await readJson(join(jobDir, "rr-validation.json"), null);
  const plan = await readJson(join(jobDir, "configuration-plan.json"), null);
  if (!expected || !validation || !plan) throw new Error("Write blocked: compile and independently validate the current RR with cvent_prepare_rr first");
  if (expected.rr?.sha256 !== hash(input) || expected.rr?.authority !== "uploaded_rr" ||
      expected.target?.eventKey !== requiredEnvironment("CVENT_AUTHORIZED_EVENT_KEY") ||
      expected.target?.eventId !== requiredEnvironment("CVENT_AUTHORIZED_EVENT_ID") ||
      expected.target?.name !== requiredEnvironment("CVENT_AUTHORIZED_EVENT_NAME") ||
      validation.rrSha256 !== expected.rr?.sha256 || plan.rrSha256 !== expected.rr?.sha256 ||
      plan.target?.eventId !== expected.target?.eventId) {
    throw new Error("Write blocked: compiled RR expectations are stale or belong to another target");
  }
  return expected;
  });
}

async function assertCompiledExpectations(): Promise<void> {
  await verifiedCompiledExpectations();
}

function parseMarker(stdout: string, marker: string): any {
  const line = stdout.split(/\r?\n/).reverse().find((item) => item.startsWith(marker));
  if (!line) throw new Error("Approved helper returned no structured result");
  const result = JSON.parse(line.slice(marker.length));
  if (!result?.ok) throw new Error(redact(result?.error || "Approved helper failed"));
  return result;
}

async function invokeBrowser(operation: string, params: Record<string, unknown>, signal?: AbortSignal, timeoutSeconds = 90): Promise<any> {
  const started = performance.now();
  if (!firstBrowserActionRecorded) {
    firstBrowserActionRecorded = true;
    await appendPerformance("first_browser_action", extensionStarted, { operation });
  }
  await readJobFile(runtimePath, 1024 * 1024);
  const trusted = Object.values(TRUSTED_SECTION_PROCEDURES).includes(operation);
  const coherent = operation === "actions" || operation === "script";
  const timeout = Math.max(1, Math.min(timeoutSeconds, operation === "recover" ? 30 : trusted || coherent ? 900 : 180));
  const boundedParams = { ...params, timeoutSeconds: timeout };
  const output = await runFixed(python, [
    join(repoRoot, "browser_tool.py"), "--runtime", runtimePath, "--tool", "ego",
    "--operation", operation, "--params", JSON.stringify(boundedParams),
  ], "browser", signal, (timeout + (operation === "recover" ? 45 : trusted || coherent ? 30 : 10)) * 1000);
  const result = parseMarker(output.stdout, "BROWSER_ROUTER_RESULT=");
  if (operation === "recover") recoveryBudget.recovered();
  const actionCount = operation === "script" ? Number(result.actionCount ?? 0) : coherent ? (params.steps as any[])?.length ?? 0 : 1;
  if (activeTurnProgress) {
    activeTurnProgress.browserOperations += 1;
    activeTurnProgress.browserActions += actionCount;
    if (coherent) activeTurnProgress.egoRounds += 1;
    if (!activeTurnProgress.section && typeof params.domain === "string") activeTurnProgress.section = params.domain;
    if (Number(result.writesAttempted ?? result.mutationCount ?? 0) > 0 || Number(result.saves ?? 0) > 0 || Number(result.readbacks ?? 0) > 0 || ["openAuthorizedEvent", "recover"].includes(operation)) {
      activeTurnProgress.meaningfulProgress = true; activeTurnProgress.progressReasons.push(operation);
    }
  }
  await appendPerformance("browser_operation", started, { operation, section: params.domain || activeTurnProgress?.section || "", intent: params.intent,
    navigation: ["navigate", "openAuthorizedEvent"].includes(operation), snapshot: operation === "snapshotText", fullSnapshot: operation === "snapshotText",
    egoExecutionRound: coherent, actionCount, writes: Number(result.writesAttempted ?? result.mutationCount ?? 0), saves: Number(result.saves ?? 0),
    readbacks: Number(result.readbacks ?? 0), status: result.status ?? null, pageUrl: result.page?.url ?? null,
    responseBytes: Buffer.byteLength(JSON.stringify(result)) });
  if (["openAuthorizedEvent", "authorizeTarget"].includes(operation) && result.authorizedTarget) {
    const runtimeId = cleanText(result.browserRuntimeId ?? result.authorizedTarget.browser_runtime_id, 200);
    if (result.inventoryRefreshed || result.rebound) await appendActivity(`EVENT_INVENTORY_REFRESHED runtime=${runtimeId} events=${Number(result.inventoryCount ?? result.authenticatedInventory?.length ?? 0)}`);
    await appendActivity(`TARGET_MATCH key=${cleanText(result.authorizedTarget.event_key, 200)} code=${cleanText(result.navigationTarget?.code ?? process.env.CVENT_AUTHORIZED_EVENT_CODE, 200)}`);
    await appendActivity(`TARGET_BOUND runtime=${runtimeId}`);
    await appendActivity("AUTHORIZED_EVENT_OPENED");
  }
  return result;
}

function fixedSectionMenuPath(domain: string): string[] {
  const paths: Record<string, string[]> = {
    optional_items: ["Registration", "Optional Items"], pricing: ["Registration", "Pricing"],
    integrations: ["Integrations"], communications: ["Email"], badges_onsite: ["OnArrival"],
    questions: ["Registration", "Registration Process"], registration_paths: ["Registration", "Registration Process"],
    site_designer: ["Registration", "Registration Overview"],
  };
  return paths[domain] ?? [];
}

function fixedSectionRoutes(): Record<string, string> {
  const key = encodeURIComponent(requiredEnvironment("CVENT_AUTHORIZED_EVENT_KEY"));
  return {
    event_settings: `https://app.cvent.com/Subscribers/Events2/Details/EventDetails/Index?evtstub=${key}`,
    registration_types: `https://app.cvent.com/Subscribers/Events2/Details/RegistrationTypes/Index/View?evtstub=${key}`,
    admission_items: `https://app.cvent.com/Subscribers/Events2/AgendaAndFees/AdmissionItemGrid/Index/?evtstub=${key}`,
    discounts_vouchers: `https://app.cvent.com/Subscribers/Events2/AgendaAndFees/DiscountsGrid?evtstub=${key}`,
  };
}

async function rememberSectionRoute(url: string, explicitDomain?: string): Promise<void> {
  const state = await readJson(join(jobDir, "state.json"), {});
  const domain = String(explicitDomain ?? state.current_stage ?? "");
  if (!DOMAINS.has(domain)) return;
  const parsed = new URL(url);
  const eventKey = requiredEnvironment("CVENT_AUTHORIZED_EVENT_KEY").toLowerCase();
  if (!parsed.hostname.toLowerCase().endsWith("cvent.com") || !parsed.href.toLowerCase().includes(eventKey)) return;
  const routes = await readJson(ROUTE_CACHE, { schemaVersion: 1, routes: {} });
  routes.routes[domain] = { url: parsed.href, verifiedAt: new Date().toISOString(), browserRuntimeId: (await readJson(runtimePath, {})).browserRuntimeId };
  await atomicJson(ROUTE_CACHE, routes);
}

function desiredSectionRecords(domain: string, expected: any): any[] {
  const section = expected.domains?.[domain] ?? {};
  if (domain === "discounts_vouchers") return section.discounts ?? [];
  if (domain === "site_designer") return [...(section.footerLinks ?? []), ...(section.socialLinks ?? []), ...(section.countdownMessages ?? []), ...(section.inlineContentLinks ?? [])];
  if (domain === "event_settings") return Object.entries(section.fields ?? {}).map(([name, field]: any) => ({ matchReference: name.replace(/_/g, " "), fields: { [name]: field } }));
  return section.items ?? section.requirements ?? section.badgeRequirements ?? [];
}

function booleanValue(value: unknown): boolean {
  const normalized = cleanText(value, 40).toLowerCase();
  if (["y", "yes", "true", "active", "activate", "required", "1"].includes(normalized)) return true;
  if (["n", "no", "false", "inactive", "deactivate", "0"].includes(normalized)) return false;
  throw new Error("Verified RR boolean has an unsupported or missing value; refusing to guess");
}

function trustedProcedureRecords(domain: string, expected: any): any[] {
  const section = expected.domains?.[domain] ?? {};
  if (domain === "admission_items") {
    const registrationNames = new Map((expected.domains?.registration_types?.items ?? []).map((item: any) => [
      cleanText(item.fields?.registration_code?.value, 200), cleanText(item.fields?.registration_name?.value, 1000),
    ]));
    const knownRegistrationTypes = [...registrationNames.entries()].map(([code, name]) => ({ code, name }));
    return (section.items ?? []).map((item: any) => ({
      code: cleanText(item.fields?.admission_code?.value ?? item.matchReference, 200),
      name: cleanText(item.fields?.admission_name?.value, 1000),
      source: cleanText(item.fields?.admission_code?.source ?? item.fields?.admission_name?.source, 500),
      registrationTypes: [...new Set(item.registrationTypes ?? [])].map((code: any) => ({
        code: cleanText(code, 200), name: cleanText(registrationNames.get(cleanText(code, 200)) ?? code, 1000),
      })),
      knownRegistrationTypes,
    }));
  }
  if (domain === "registration_types") return (section.items ?? []).map((item: any) => {
    const activationDirective = cleanText(item.fields?.active?.value, 40).toUpperCase();
    if (!["ACTIVATE", "REQUIRED"].includes(activationDirective))
      throw new Error("Verified RR registration activation directive is unsupported; refusing to map it to a Cvent status");
    return {
      code: cleanText(item.fields?.registration_code?.value ?? item.matchReference, 200),
      name: cleanText(item.fields?.registration_name?.value, 1000),
      source: cleanText(item.fields?.registration_code?.source ?? item.fields?.registration_name?.source, 500),
      activationDirective,
      groupRegistration: item.fields?.group_registration?.value == null || cleanText(item.fields.group_registration.value, 40) === ""
        ? null : booleanValue(item.fields.group_registration.value),
      reprintFee: item.fields?.reprint_fee?.value == null ? null : Number(item.fields.reprint_fee.value),
    };
  });
  throw new Error(`No trusted procedure data projection exists for ${domain}`);
}

function verificationItemResults(domainItems: any[], matches: any[], exceptions: any[]): any[] {
  const ids = new Set(domainItems.map(item => item.itemId));
  const matched = new Map<string, any>();
  const held = new Map<string, any>();
  for (const item of matches) {
    if (!ids.has(item.itemId) || matched.has(item.itemId) || !item.cventEvidence?.length)
      throw new Error("Every explicit match needs unique domain identity and actual Cvent evidence");
    matched.set(item.itemId, item);
  }
  for (const item of exceptions) {
    if (!ids.has(item.itemId) || held.has(item.itemId) || matched.has(item.itemId))
      throw new Error("Verification outcomes must be unique and belong to this domain");
    held.set(item.itemId, item);
  }
  return domainItems.map(item => {
    const exception = held.get(item.itemId), match = matched.get(item.itemId);
    if (match && item.status !== "VERIFIED") throw new Error("Unverified RR evidence cannot be marked MATCH");
    return { itemId: item.itemId, rrStatus: item.status,
      status: exception?.status ?? (match ? "MATCH" : item.status === "VERIFIED" ? "NOT_CONFIGURED" : "AMBIGUOUS"),
      ...(match ? { cventEvidence: match.cventEvidence } : { reason: exception?.reason ?? "No explicit item-level Cvent readback was supplied" }) };
  });
}

async function assertSourcesVerified(domain: string, sources: string[]): Promise<void> {
  const validation = await readJson(join(jobDir, "rr-validation.json"), null);
  const verified = new Set((validation?.items ?? []).filter((item: any) => item.domain === domain && item.status === "VERIFIED")
    .map((item: any) => `${item.sourceEvidence.sheet}!${item.sourceEvidence.range}`));
  if (!sources.length || sources.some(source => !verified.has(source)))
    throw new Error("Item held: each write source must exactly match VERIFIED evidence in this domain; continue independent verified items");
}

async function assertDomainEvidenceVerified(domain: string): Promise<void> {
  const validation = await readJson(join(jobDir, "rr-validation.json"), null);
  const unsupported = (validation?.items ?? []).filter((item: any) => item.domain === domain && item.status !== "VERIFIED");
  if (unsupported.length) throw new Error(`Trusted ${domain} procedure blocked: ${unsupported.length} RR evidence items are not independently VERIFIED`);
}

async function replayHolds(domain: string): Promise<any[]> {
  const document = await readJson(join(jobDir, "replay-holds.json"), { holds: [] });
  if (document.eventKey && document.eventKey !== requiredEnvironment("CVENT_AUTHORIZED_EVENT_KEY"))
    throw new Error("Replay-hold evidence belongs to another event");
  return (document.holds ?? []).filter((hold: any) => hold?.domain === domain && hold?.automaticReplayPermitted === false && cleanText(hold?.identity, 500));
}

async function assertNoHeldReplay(domain: string, payload: any): Promise<void> {
  const serialized = JSON.stringify(payload);
  for (const hold of await replayHolds(domain)) {
    const identity = cleanText(hold.identity, 500);
    const pattern = new RegExp(`(^|[^A-Za-z0-9_-])${identity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9_-]|$)`, "i");
    if (pattern.test(serialized)) throw new Error(`MATCH_UNCERTAIN_HUMAN_REVIEW: automatic replay is blocked for held ${domain} identity ${identity}`);
  }
}

function compactSectionComparison(domain: string, expected: any, observed: any): any {
  const rows = observed.rows ?? [];
  const normalizedRows = rows.map((row: any) => ({ ...row, normalized: cleanText(row.text, 10000).toLowerCase().replace(/\s+/g, " ") }));
  const normalizedControls = (observed.controls ?? []).map((control: any) => ({ ...control, normalizedLabel: cleanText(control.label, 1000).toLowerCase().replace(/\s+/g, " ") }));
  const records = desiredSectionRecords(domain, expected);
  const comparisons = records.map((record: any, index: number) => {
    const fields = record.fields ?? {};
    const reference = record.matchReference ?? record.label ?? fields.code?.value ?? fields.registration_code?.value ?? fields.internal_name?.value ?? fields.name?.value ?? record.values?.A ?? record.values?.R ?? [record.registrationType, record.admissionItem].filter(Boolean).join(" / ");
    const desiredName = fields.registration_name?.value ?? fields.admission_name?.value ?? fields.name?.value;
    const needle = cleanText(reference, 1000).toLowerCase();
    const row = needle ? normalizedRows.find((item: any) => item.normalized.includes(needle)) : undefined;
    const control = needle ? normalizedControls.find((item: any) => item.normalizedLabel === needle || item.normalizedLabel.includes(needle)) : undefined;
    const onlyField: any = Object.values(fields)[0];
    const scalarDesired = Object.keys(fields).length === 1 && ![null, undefined, ""].includes(onlyField?.value) ? String(onlyField.value).toLowerCase().trim() : "";
    const controlMatches = control && scalarDesired ? String(control.value ?? "").toLowerCase().trim() === scalarDesired : Boolean(control);
    const nameMatches = !desiredName || (row && row.normalized.includes(cleanText(desiredName, 2000).toLowerCase().replace(/\s+/g, " ")));
    const found = row ?? control;
    return { index, reference, desiredName, status: !found ? "MISSING" : (row ? nameMatches : controlMatches) ? "PRESENT" : "DIFFERS", current: row ? { text: row.text, links: row.links } : control ? { label: control.label, value: control.value, selector: control.selector } : null };
  });
  const counts: Record<string, number> = { PRESENT: 0, DIFFERS: 0, MISSING: 0 };
  for (const item of comparisons) counts[item.status] += 1;
  const fullySummaryComparable = (item: any) => (item.desiredName || domain === "event_settings") && Object.keys(records[item.index]?.fields ?? {}).length <= 2;
  return { domain, counts,
    alreadyCorrect: comparisons.filter((item: any) => item.status === "PRESENT" && fullySummaryComparable(item)).map((item: any) => item.reference).slice(0, 1000),
    locatedNeedsDetailInspection: comparisons.filter((item: any) => item.status === "PRESENT" && !fullySummaryComparable(item)).map((item: any) => item.reference).slice(0, 1000),
    needsConfiguration: comparisons.filter((item: any) => item.status === "DIFFERS").slice(0, 200),
    missing: comparisons.filter((item: any) => item.status === "MISSING").slice(0, 200),
    observed: { url: observed.url, title: observed.title, rowCount: rows.length, controls: (observed.controls ?? []).slice(0, 200), headings: observed.headings, buttons: observed.buttons },
  };
}

function browserParams(operation: string, input: any): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  if (["authorizeTarget", "openAuthorizedEvent"].includes(operation)) {
    params.eventName = requiredEnvironment("CVENT_AUTHORIZED_EVENT_NAME");
    params.eventKey = requiredEnvironment("CVENT_AUTHORIZED_EVENT_KEY");
    params.eventCode = process.env.CVENT_AUTHORIZED_EVENT_CODE ?? "";
  }
  if (["scanEventList", "openAuthorizedEvent"].includes(operation)) {
    params.maxScrolls = Math.max(1, Math.min(Number(input.maxScrolls ?? 30), 60));
  }
  if (operation === "scanEventList") params.exactName = requiredEnvironment("CVENT_AUTHORIZED_EVENT_NAME");
  if (operation === "sectionState") params.domain = cleanText(input.domain, 80);
  if (["click", "activate", "fill", "type", "hover", "selectOption", "setChecked", "press", "search", "selectText", "drag", "wait", "uploadDiscountImport", "readTarget"].includes(operation) && input.target) {
    params.target = cleanText(input.target, 4000);
    if (input.targetContext) params.targetContext = cleanText(input.targetContext, 1000);
    if (Number.isInteger(input.targetIndex)) params.targetIndex = Math.max(0, Math.min(Number(input.targetIndex), 20));
  }
  if (["fill", "type", "typeText", "search"].includes(operation)) params.text = cleanText(input.text, 20000);
  if (["visualClick", "visualDoubleClick", "visualDrag"].includes(operation)) {
    params.x = Number(input.x); params.y = Number(input.y);
    if (operation === "visualDrag") { params.toX = Number(input.toX); params.toY = Number(input.toY); }
  }
  if (operation === "screenshot") params.fullPage = input.fullPage === true;
  if (operation === "selectOption") {
    params.option = cleanText(input.option, 2000);
    params.optionBy = input.optionBy === "value" ? "value" : "label";
  }
  if (operation === "setChecked") params.checked = Boolean(input.checked);
  if (operation === "press") params.key = cleanText(input.key, 40);
  if (operation === "search") params.submit = input.submit !== false;
  if (operation === "drag") params.destination = cleanText(input.destination, 4000);
  if (operation === "uploadDiscountImport") params.artifact = "discount-import.xlsx";
  if (operation === "navigate") {
    params.url = cleanText(input.url, 8000);
    params.waitUntil = ["load", "domcontentloaded", "networkidle"].includes(input.loadState) ? input.loadState : "domcontentloaded";
  }
  if (operation === "scroll") {
    params.deltaY = Math.max(-10000, Math.min(Number(input.deltaY ?? 700), 10000));
    params.settleMs = Math.max(100, Math.min(Number(input.settleMs ?? 500), 5000));
  }
  if (operation === "wait") {
    params.ms = Math.max(50, Math.min(Number(input.ms ?? 1000), 30000));
    if (["load", "domcontentloaded", "networkidle"].includes(input.loadState)) params.loadState = input.loadState;
  }
  params.intent = input.intent;
  if (input.label) params.label = cleanText(input.label, 120);
  if (input.rrSource) params.rrSource = cleanText(input.rrSource, 500);
  return params;
}

function validateGeneralBrowserAction(operation: string, params: any): void {
  if (!BROWSER_OPERATIONS.has(operation)) throw new Error("Capability denied: browser operation is not approved");
  if (!new Set(["read", "write"]).has(params.intent)) throw new Error("Capability denied: explicit read or write intent is required");
  if (READ_ONLY_OPERATIONS.has(operation) && params.intent !== "read") throw new Error(`${operation} is a read-only capability`);
  if (["fill", "type", "typeText", "selectOption", "setChecked", "drag", "visualDrag", "uploadDiscountImport"].includes(operation) && params.intent !== "write") throw new Error(`${operation} requires write intent`);
  if (operation === "press" && !ALLOWED_KEYS.has(String(params.key))) throw new Error("Capability denied: keyboard key is not approved");
  if (operation === "press" && ["Backspace", "Delete"].includes(String(params.key)) && params.intent !== "write") throw new Error(`${params.key} requires write intent`);
  if (operation === "selectOption" && !["label", "value", undefined].includes(params.optionBy)) throw new Error("Capability denied: optionBy must be label or value");
  if (operation === "drag" && !params.destination) throw new Error("Capability denied: drag destination is required");
  if (["visualClick", "visualDoubleClick", "visualDrag"].includes(operation)) {
    for (const coordinate of operation === "visualDrag" ? [params.x, params.y, params.toX, params.toY] : [params.x, params.y]) {
      if (!Number.isFinite(coordinate) || coordinate < 0 || coordinate > 10000) throw new Error("Capability denied: visual action coordinates are invalid");
    }
  }
  if (params.intent === "write" && isDataAction(operation, params) && !cleanText(params.rrSource, 500)) throw new Error("Dynamic Cvent data writes require verified RR source evidence");
}

function validateActionRound(commitMode: string, steps: any[]): void {
  let unverifiedWrite = false;
  let saveObserved = false;
  let refsFresh = true;
  const readbacks = new Set(["readTarget", "sectionState", "controlInventory", "snapshotText", "screenshot"]);
  const ephemeralRef = (value: unknown) => /^(?:@\d+|\[?ref=\d+\]?)$/.test(String(value ?? "").trim());
  for (const step of steps) {
    validateGeneralBrowserAction(String(step.operation), step);
    if (ephemeralRef(step.target) && !refsFresh) throw new Error("STALE_REF_PREVENTED: navigation/Save invalidated prior Ego refs; take a fresh snapshot and re-resolve before continuing");
    if (step.operation === "navigate" && unverifiedWrite) throw new Error("Verify the saved configuration group before navigating within an Ego action round");
    if (step.operation === "navigate") refsFresh = false;
    if (step.operation === "snapshotText") refsFresh = true;
    if (step.intent === "write") {
      unverifiedWrite = true;
      if (["click", "activate", "press", "visualClick"].includes(step.operation) && /save/i.test(String(step.target ?? step.key ?? step.label ?? ""))) {
        saveObserved = true; refsFresh = false;
      }
    } else if (unverifiedWrite && readbacks.has(step.operation) && (commitMode === "autosave" || saveObserved)) {
      unverifiedWrite = false;
      saveObserved = false;
    }
  }
  if (unverifiedWrite) throw new Error("Every saved/autosaved configuration group needs meaningful readback in the same Ego action round");
  if (steps.some(step => step.intent === "write")) validateAtomicSteps(steps.map(step => ({ ...step, data: isDataAction(step.operation, step) })), commitMode);
}


function utf8Chunks(text: string, maxBytes: number): string[] {
  const chunks: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character, "utf8");
    if (current && currentBytes + size > maxBytes) {
      chunks.push(current);
      current = "";
      currentBytes = 0;
    }
    current += character;
    currentBytes += size;
  }
  if (current || chunks.length === 0) chunks.push(current);
  return chunks;
}

async function pendingSnapshot(): Promise<any> {
  return readJson(SNAPSHOT_PENDING, null);
}

async function pendingWriteReadback(): Promise<any> {
  return readJson(WRITE_READBACK_PENDING, null);
}

async function clearWriteReadback(): Promise<void> {
  try {
    const info = await lstat(WRITE_READBACK_PENDING);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Write readback marker is not a regular job artifact");
    await unlink(WRITE_READBACK_PENDING);
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function acknowledgeSimplePersistence(determination: string): Promise<void> {
  const pending = await pendingWriteReadback();
  if (!pending) return;
  const observed = await readJson(join(jobDir, "browser-last-atomic-readback.json"), null);
  if (pending.executionMode !== "simple" || !pending.attempts?.length || observed?.executionMode !== "simple" ||
      observed.browserRuntimeId !== pending.browserRuntimeId || observed.eventKey !== requiredEnvironment("CVENT_AUTHORIZED_EVENT_KEY") ||
      Date.parse(observed.observedAt) < Math.max(...pending.attempts.map((a: any) => Date.parse(a.at)))) {
    throw new Error("Persisted outcome still needs a fresh observation in this event. Inspect/recover the editor; do not replay blindly.");
  }
  for (const attempt of pending.attempts) await appendFile(join(jobDir, "scope-write-audit.jsonl"), JSON.stringify({
    ...attempt, at: new Date().toISOString(), result: "succeeded", resolvedBy: "pi", determination,
    observedAt: observed.observedAt, evidence: observed.evidence,
  }) + "\n", { mode: 0o600 });
  await clearWriteReadback();
  await appendActivity(`Pi verified persisted work: ${cleanText(determination, 1200)}`);
}

async function assertSnapshotConsumed(): Promise<void> {
  const pending = await pendingSnapshot();
  if (pending && pending.complete !== true) {
    throw new Error(`Complete snapshot ${pending.snapshotId} is not fully consumed; request chunk ${pending.nextChunk} before another browser action`);
  }
}

async function saveLargeSnapshot(result: any): Promise<any> {
  const snapshot = result?.snapshot;
  if (typeof snapshot !== "string") return result;
  const bytes = Buffer.byteLength(snapshot, "utf8");
  if (bytes > MAX_SNAPSHOT_BYTES) throw new Error("Complete DOM snapshot exceeds the 2MB fail-closed transport limit");
  const digest = hash(Buffer.from(snapshot, "utf8"));
  result.snapshotMetadata = {
    bytes, sha256: digest, capturedAt: result.observedAt, browserRuntimeId: result.browserRuntimeId,
    workerSlot: Number(requiredEnvironment("CVENT_WORKER_SLOT")), targetId: result.targetId,
    jobId: requiredEnvironment("CVENT_JOB_ID"), workspaceId: requiredEnvironment("CVENT_WORKSPACE_ID"),
    url: result.page?.url, title: result.page?.title,
  };
  if (bytes <= SNAPSHOT_CHUNK_BYTES) return result;
  const id = randomUUID();
  const directory = assertFixedJobPath(join(jobDir, "browser-snapshots"));
  await assertPrivateJobRoot();
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Capability denied: snapshot directory is not private");
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
    await mkdir(directory, { mode: 0o700 });
  }
  const path = assertFixedJobPath(join(directory, `${id}.txt`));
  const handle = await open(path, "wx", 0o600);
  try { await handle.writeFile(snapshot, "utf8"); } finally { await handle.close(); }
  const chunks = utf8Chunks(snapshot, SNAPSHOT_CHUNK_BYTES);
  const transport = {
    ...result.snapshotMetadata, snapshotId: id, totalChunks: chunks.length,
    nextChunk: 1, complete: false,
  };
  await atomicJson(SNAPSHOT_PENDING, transport);
  delete result.snapshot;
  result.completeSnapshot = {
    ...result.snapshotMetadata, snapshotId: id, totalChunks: chunks.length,
    chunkIndex: 0, complete: false, chunkText: chunks[0],
    instruction: "Read every remaining chunk with cvent_snapshot_chunk in strict order before another browser action.",
  };
  return result;
}

export const __capabilityTest = { utf8Chunks, saveLargeSnapshot, pendingSnapshot, assertSnapshotConsumed };

function pageArrays(value: any, offset: number, limit: number): any {
  if (Array.isArray(value)) return value.slice(offset, offset + limit).map((item) => pageArrays(item, 0, limit));
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (Array.isArray(child)) {
      result[key] = child.slice(offset, offset + limit);
      result[`${key}Pagination`] = { offset, returned: Math.min(limit, Math.max(0, child.length - offset)), total: child.length };
    } else result[key] = child;
  }
  return result;
}

const optionalStrings = Type.Optional(Type.Array(Type.String({ maxLength: 2000 }), { maxItems: 200 }));
const browserActionFields = {
  intent: Type.Union([Type.Literal("read"), Type.Literal("write")]),
  target: Type.Optional(Type.String({ maxLength: 4000, description: 'An exact target copied from the latest Ego snapshot (`@123`, `ref=123`, or `[ref=123]`), an exact role:<role>[name="<accessible name>"], or stable CSS returned by compact section state. Prefer fresh snapshot refs. Never invent selector syntax.' })),
  targetContext: Type.Optional(Type.String({ maxLength: 1000 })),
  targetIndex: Type.Optional(Type.Integer({ minimum: 0, maximum: 20 })),
  text: Type.Optional(Type.String({ maxLength: 20000 })),
  option: Type.Optional(Type.String({ maxLength: 2000 })),
  optionBy: Type.Optional(Type.Union([Type.Literal("label"), Type.Literal("value")])),
  checked: Type.Optional(Type.Boolean()),
  key: Type.Optional(literalUnion([...ALLOWED_KEYS])),
  destination: Type.Optional(Type.String({ maxLength: 4000 })),
  url: Type.Optional(Type.String({ maxLength: 8000 })),
  loadState: Type.Optional(Type.Union([Type.Literal("load"), Type.Literal("domcontentloaded"), Type.Literal("networkidle")])),
  deltaY: Type.Optional(Type.Integer({ minimum: -10000, maximum: 10000 })),
  settleMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 5000 })),
  ms: Type.Optional(Type.Integer({ minimum: 50, maximum: 30000 })),
  domain: Type.Optional(literalUnion(DOMAIN_NAMES)),
  rrSource: Type.Optional(Type.String({ maxLength: 500 })),
  x: Type.Optional(Type.Number({ minimum: 0, maximum: 10000 })),
  y: Type.Optional(Type.Number({ minimum: 0, maximum: 10000 })),
  toX: Type.Optional(Type.Number({ minimum: 0, maximum: 10000 })),
  toY: Type.Optional(Type.Number({ minimum: 0, maximum: 10000 })),
  fullPage: Type.Optional(Type.Boolean()),
  label: Type.Optional(Type.String({ maxLength: 120 })),

  timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 300 })),
};
const egoActionSchema = Type.Object({ operation: literalUnion(EGO_ACTION_OPERATIONS), ...browserActionFields });

export default function cventJobTools(pi: any) {
  let turnStarted = 0;
  let firstTokenRecorded = false;
  let usageBudget = new UsageBudget();
  let currentSection = "";
  const sectionTurns = new Map<string, number>();
  const deliveredPlanReads = new Set<string>();
  const safeMetric = async (kind: string, started: number, details: Record<string, unknown> = {}) => {
    try { await appendPerformance(kind, started, details); } catch { /* metrics never block configuration */ }
  };
  const sectionFrom = (toolName: string, args: any): string => {
    let candidate = toolName === "cvent_plan" || toolName === "cvent_expectations" ? args?.section : args?.domain ?? args?.stage;
    if (toolName === "bash") {
      const match = String(args?.command ?? "").match(/^\s*\/\/ cvent: (\{[^\n]+\})/m);
      try { candidate = match ? JSON.parse(match[1]).domain : candidate; } catch { /* tool validation reports malformed metadata */ }
    }
    return DOMAINS.has(String(candidate ?? "")) ? String(candidate) : "";
  };
  const planDeliveryKey = (args: any): string =>
    `${String(args?.section ?? "")}:${Number(args?.offset ?? 0)}:${Number(args?.limit ?? 0)}`;
  pi.on("session_start", async () => {
    pi.setActiveTools([...ALLOWED_TOOLS]);
    usageBudget = new UsageBudget((await readJson(join(jobDir, "token-usage.json"), {})).totals ?? {});
    await safeMetric("pi_session_start", performance.now(), { pid: process.pid });
  });
  pi.on("context", async (event: any) => {
    if (SIMPLE) return; // Normal Pi context/compaction, not controller-owned pruning.
    const messages = event.messages ?? [];
    const filtered = retainJobContext(messages);
    if (filtered === messages) return undefined;
    await safeMetric("context_pruned", performance.now(), { originalMessages: messages.length, retainedMessages: filtered.length });
    return { messages: filtered };
  });
  pi.on("turn_start", (event: any) => {
    turnStarted = performance.now(); firstTokenRecorded = false;
    activeTurnProgress = { turnIndex: Number(event.turnIndex ?? 0), section: currentSection, browserOperations: 0, browserActions: 0, egoRounds: 0,
      toolNames: [], requiredVerification: false, ambiguityResolved: false, humanOrSecurityBoundary: false,
      repeatedRead: false, meaningfulProgress: false, progressReasons: [], modelDurationMs: 0, toolCalls: new Map() };
  });
  pi.on("message_update", async (event: any) => {
    if (!firstTokenRecorded && event.message?.role === "assistant") {
      firstTokenRecorded = true;
      await safeMetric("anthropic_first_token", turnStarted || performance.now());
    }
  });
  pi.on("message_end", async (event: any) => {
    if (event.message?.role !== "assistant") return;
    const usage = event.message.usage ?? {};
    usageBudget.record(event.message);
    await atomicJson(join(jobDir, "token-usage.json"), { totals: usageBudget.totals, limits: usageBudget.limits,
      provider: event.message.provider, model: event.message.model, updatedAt: new Date().toISOString(),
      costBasis: "SDK estimates, not billing; subscription equivalent is not an API charge" });
    const calls = (event.message.content ?? []).filter((item: any) => item.type === "toolCall");
    for (const call of calls) {
      const section = sectionFrom(String(call.name), call.arguments);
      if (section) { currentSection = section; if (activeTurnProgress) activeTurnProgress.section = section; }
    }
    if (activeTurnProgress) {
      activeTurnProgress.toolNames = calls.map((call: any) => String(call.name));
      activeTurnProgress.modelDurationMs = Math.max(0, Math.round((performance.now() - (turnStarted || performance.now())) * 10) / 10);
    }
    await safeMetric("anthropic_response", turnStarted || performance.now(), {
      turnIndex: activeTurnProgress?.turnIndex ?? 0, section: activeTurnProgress?.section || "",
      inputTokens: usage.input ?? 0, outputTokens: usage.output ?? 0,
      cacheReadTokens: usage.cacheRead ?? 0, cacheWriteTokens: usage.cacheWrite ?? 0,
      totalTokens: usage.totalTokens ?? 0,
    });
  });
  pi.on("tool_execution_start", (event: any) => {
    if (!activeTurnProgress) return;
    activeTurnProgress.toolCalls.set(String(event.toolCallId), { name: String(event.toolName), args: event.args ?? {} });
    const section = sectionFrom(String(event.toolName), event.args);
    if (section) { activeTurnProgress.section = section; currentSection = section; }
    if (["cvent_plan", "cvent_expectations"].includes(String(event.toolName))) {
      const key = planDeliveryKey(event.args);
      if (deliveredPlanReads.has(key)) activeTurnProgress.repeatedRead = true;
    }
  });
  pi.on("tool_result", async (event: any) => {
    if (!BENCHMARK || !event.isError) return;
    try {
      const runtime = await readJson(runtimePath, {});
      const message = (event.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
      const lastFailure = event.toolName === "bash" && message.includes("last-browser-failure-result.json")
        ? await readJson(join(jobDir, "last-browser-failure-result.json"), {}) : {};
      const operation = event.toolName === "bash" ? "browser_script" : String(event.toolName);
      const surface = lastFailure.failureSurface ?? runtime.targetBrowserIdentity?.url ?? "unknown";
      const episode = await benchmarkCall("failure", { operation, surface, message });
      if (episode.paused) {
        (globalThis as any)[Symbol.for("cvent.benchmark.stop")] = "BLOCKER_" + episode.blocker;
        await atomicJson(join(jobDir, `model-admission-stop-${process.pid}.json`), {
          reason: "BLOCKER_" + episode.blocker, at: new Date().toISOString(),
        });
      }
    } catch (error) {
      (globalThis as any)[Symbol.for("cvent.benchmark.stop")] = "BENCHMARK_CONTROL_UNAVAILABLE";
      throw error;
    }
    // Successful reads never clear an unresolved episode. Operator review can
    // resolve the scoped blocker; it cannot waive existing mutation uncertainty.
  });
  pi.on("tool_execution_end", (event: any) => {
    usageBudget.toolResult(String(event.toolName), event.result, !!event.isError);
    if (!activeTurnProgress || event.isError) return;
    const call = activeTurnProgress.toolCalls.get(String(event.toolCallId));
    const name = String(call?.name ?? event.toolName ?? "");
    if (["cvent_plan", "cvent_expectations"].includes(name)) {
      const args = call?.args ?? {};
      const key = planDeliveryKey(args);
      if (!deliveredPlanReads.has(key)) activeTurnProgress.ambiguityResolved = true;
      deliveredPlanReads.add(key);
    }
    if (name === "cvent_snapshot_chunk") activeTurnProgress.ambiguityResolved = true;
    if (["cvent_prepare_rr", "cvent_verify_domain", "cvent_finish"].includes(name)) activeTurnProgress.requiredVerification = true;
    if (["cvent_verify_domain", "cvent_record_domain"].includes(name)) { activeTurnProgress.meaningfulProgress = true; activeTurnProgress.progressReasons.push(name); }
    if (name === "cvent_login_handoff") activeTurnProgress.humanOrSecurityBoundary = true;
  });
  pi.on("turn_end", async () => {
    const progress = activeTurnProgress;
    if (!progress) return;
    const zeroProgress = !progress.meaningfulProgress && !progress.ambiguityResolved && !progress.requiredVerification && !progress.humanOrSecurityBoundary;
    let sectionTurn = 0;
    if (DOMAINS.has(progress.section)) {
      sectionTurn = (sectionTurns.get(progress.section) ?? 0) + 1;
      sectionTurns.set(progress.section, sectionTurn);
    }
    const details = { turnIndex: progress.turnIndex, section: progress.section, sectionTurn, browserOperations: progress.browserOperations,
      browserActions: progress.browserActions, egoRounds: progress.egoRounds, toolNames: progress.toolNames,
      modelDurationMs: progress.modelDurationMs, repeatedRead: progress.repeatedRead, meaningfulProgress: progress.meaningfulProgress,
      progressReasons: progress.progressReasons, zeroProgress };
    await safeMetric("model_response_progress", turnStarted || performance.now(), details);
    if (zeroProgress) await safeMetric("MODEL_RESPONSE_WITH_ZERO_PROGRESS", performance.now(), details);
    if (["event_settings", "registration_types", "admission_items", "pricing"].includes(progress.section) && sectionTurn > 3)
      await safeMetric("MODEL_CALL_BUDGET_EXCEEDED", performance.now(), { section: progress.section, sectionTurn, targetMaximum: 3 });
    activeTurnProgress = null;
  });
  pi.on("before_agent_start", async (event: any) => {
    pi.setActiveTools([...ALLOWED_TOOLS]);
    const active = pi.getActiveTools();
    const required = SIMPLE ? [...ALLOWED_TOOLS] : ["read", "bash", "cvent_prepare_rr", "cvent_plan", "cvent_browser", "cvent_finish"];
    const missing = required.filter(name => !active.includes(name));
    await atomicJson(join(jobDir, "pi-capabilities.json"), { activeTools: active, missing, pid: process.pid });
    await atomicJson(join(jobDir, "pi-system-prompt.json"), { systemPrompt: event.systemPrompt });
    if (missing.length) throw new Error(`PI_CAPABILITY_MISMATCH: ${missing.join(", ")}`);
  });
  pi.on("tool_call", async (event: any) => {
    const budgetReason = !BENCHMARK && process.env.CVENT_USAGE_GUARD_ENABLED === "1" ? usageBudget.reason() : null;
    if (budgetReason) {
      await atomicJson(join(jobDir, `usage-budget-stop-${process.pid}.json`), { reason: budgetReason, totals: usageBudget.totals, at: new Date().toISOString() });
      return { block: true, terminate: true, reason: `${budgetReason}. Run is incomplete, not verified. Preserve all pending work and mutation evidence; do not auto-retry.` };
    }
    if (!ALLOWED_TOOLS.has(event.toolName)) {
      return { block: true, reason: "Capability denied: this production agent has no shell or general filesystem tools" };
    }
    if (SIMPLE) return; // Only the browser ownership/lease/target/permanent boundary applies.
    // Reporting a real job-wide blocker must remain available even when the
    // browser circuit breaker is open. It cannot perform browser mutations.
    if (event.toolName === "cvent_finish") return undefined;
    const requestedDomain = sectionFrom(String(event.toolName), event.input);
    if (requestedDomain) {
      const next = await resumeDomain();
      const completed = await assessedDomains();
      const browserWork = event.toolName === "bash" || ["cvent_browser", "cvent_section_state", "cvent_execute_section"].includes(event.toolName);
      if (browserWork && completed.includes(requestedDomain)) {
        return { block: true, reason: `DOMAIN_ALREADY_COMPLETE: ${requestedDomain} is durably checkpointed. Resume ${next ?? "final QA"}; do not replay the completed domain.` };
      }
      if (browserWork) {
        const operation = event.toolName === "bash" ? "bash" : String(event.input?.operation ?? event.toolName);
        const objective = event.toolName === "bash" ? String(event.input?.command ?? "") : String(event.input?.objective ?? "");
        try { await assertDomainStrategy(requestedDomain, operation, objective); }
        catch (error: any) { return { block: true, reason: error.message }; }
      }
      if (event.toolName === "cvent_record_domain" && ["completed", "review_required"].includes(String(event.input?.status))) {
        const fallback = await readJson(NATIVE_FALLBACK, null);
        if (fallback?.domain === requestedDomain) return { block: true, reason: `NATIVE_EGO_REQUIRED: trusted adapter ${fallback.reason} is not a domain conclusion. Inspect ${requestedDomain} with native Ego first.` };
      }
    }
    const decision = recoveryBudget.allow(event.toolName, event.input);
    if (!decision.allowed) {
      if (decision.terminal) await atomicJson(join(jobDir, `controller-failure-${process.pid}.json`), recoveryBudget.terminalFailure);
      return { block: true, terminate: decision.terminal, reason: decision.terminal
        ? "Browser runtime failed; stopping without further actions. The controller has the exact error. Do not reload the RR or reset the profile."
        : "Browser runtime unavailable, not an RR or login failure. Only one cvent_browser recover (intent read) is permitted; do not reread plans or request SSO." };
    }
    if (decision.recovery || (event.toolName === "cvent_browser" && event.input?.operation === "recover")) event.input.timeoutSeconds = 30;
    return undefined;
  });

  pi.registerTool({
    name: "read", label: "Read verified job input or Ego skill",
    description: "Read the Ego skill or this job's verified RR plan/evidence. Supports offset/limit, not secrets or other jobs.",
    promptSnippet: "Read Ego skill and verified job files",
    parameters: Type.Object({ path: Type.String(), offset: Type.Optional(Type.Integer({ minimum: 1 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })), chunk: Type.Optional(Type.Integer({ minimum: 1 })) }),
    async execute(_id: string, params: any) {
      const target = resolve(jobDir, params.path);
      const skill = join(repoRoot, "skills/ego-browser/SKILL.md");
      const allowed = ["configuration-plan.json", "rr-validation.json", "expected-domains.json", "input.inspection.json", "input.inspection-summary.json", "job-prompt.md", "state.json", "activity.log", "scope-write-audit.jsonl", "last-browser-failure-result.json", "browser-last-script-result.json", "final-report.json"];
      const skillReference = SIMPLE && target.startsWith(join(repoRoot, "skills/ego-browser/references") + "/") && target.endsWith(".md");
      const visual = SIMPLE && /^browser-visual-[\w-]+\.png$/.test(target.slice(jobDir.length + 1)) && target.startsWith(jobDir + "/");
      const egoOutput = SIMPLE && /^(?:ego-output-[0-9a-f-]{36}\.txt|ego-result-[0-9a-f-]{36}\.json)$/.test(target.slice(jobDir.length + 1)) && target.startsWith(jobDir + "/");
      if (visual) return { content: [{ type: "image", mimeType: "image/png", data: (await readJobFile(target)).toString("base64") }] };
      if (target !== skill && !skillReference && !egoOutput && !allowed.some(name => target === join(jobDir, name))) throw new Error("Read is limited to the Ego skill and this job's evidence");
      const text = target === skill || skillReference ? await readFile(target, "utf8") : (await readJobFile(target, 25 * 1024 * 1024)).toString("utf8");
      const lines = text.split("\n"), start = (params.offset ?? 1) - 1;
      const chunks = utf8Chunks(lines.slice(start, start + (params.limit ?? 500)).join("\n"), egoOutput ? SIMPLE_PREVIEW_BYTES : MAX_TEXT_BYTES - 1024);
      const chunk = params.chunk ?? 1;
      if (chunk > Math.max(1, chunks.length)) throw new Error("Read chunk is out of range");
      const result = toolText((chunks[chunk - 1] ?? "") + (chunks.length > 1
        ? `\n[Chunk ${chunk}/${chunks.length} of selected lines; ${chunk < chunks.length ? `keep path/offset/limit and use chunk=${chunk + 1} for more` : "selected lines complete"}.]` : ""));
      result.details = { totalLines: lines.length, offset: start + 1, chunk, chunks: chunks.length };
      if (egoOutput) await safeMetric("browser_preview_retrieval", performance.now(), {
        bytes: Buffer.byteLength(JSON.stringify(result.content)), offset: start + 1,
      });
      return result;
    },
  });

  pi.registerTool({
    name: "bash", label: "Ego native browser round",
    description: SIMPLE ? "Run upstream ego-browser nodejs heredocs in the assigned browser. No domain/header/rrSource/atomic-plan metadata required. Pi chooses actions, Save, verification and recovery. Browser-only shell; rr and desired globals expose original workbook evidence and optional parsed expectations." : "Run ego-browser nodejs heredocs using the loaded Ego skill. Browser-only; no general shell. One script can observe, navigate, edit multiple controls, Save and verify. Header: // cvent: {\"domain\":\"event_settings\",\"commitMode\":\"read_only\"}. Use save/autosave and exact rrSources from the verified plan for configuration.",
    promptSnippet: "Execute coherent Ego browser heredocs",
    parameters: Type.Object({ command: Type.String({ maxLength: 50000 }), timeout: Type.Optional(Type.Integer({ minimum: 1, maximum: 780 })) }),
    async execute(_id: string, params: any, signal: AbortSignal) {
      const match = params.command.trim().match(/^ego-browser(?: nodejs)? <<'([A-Za-z][A-Za-z0-9_]*)'\r?\n([\s\S]*)\r?\n\1$/);
      if (!match) throw new Error("Use only ego-browser <<'EOF' ... EOF as documented by the vendored Ego skill");
      if (SIMPLE) return withQueue("browser", async () => {
        const value = await invokeBrowser("script", { script: match[2], intent: "read", timeoutSeconds: params.timeout ?? 300 }, signal, params.timeout ?? 300);
        await appendActivity(`Ego: ${value.actionCount ?? 0} actions, ${value.writesAttempted ?? 0} UI writes, ${value.saves ?? 0} Saves, ${value.readbacks ?? 0} post-commit observations`);
        const { logs, ...rest } = value;
        const result = { logs, ...rest };
        await atomicJson(join(jobDir, "browser-last-script-result.json"), result);
        const text = (logs ?? []).map((v: any) => typeof v === "string" ? v : JSON.stringify(v)).join("\n");
        const artifactId = randomUUID();
        const outputPath = join(jobDir, `ego-output-${artifactId}.txt`);
        const resultPath = join(jobDir, `ego-result-${artifactId}.json`);
        await atomicJson(resultPath, result);
        const file = await open(outputPath, "wx", 0o600);
        try { await file.writeFile(text, "utf8"); } finally { await file.close(); }
        const response = await toolBrowserResult(result);
        const preview = utf8Chunks(text || "(no printed output)", SIMPLE_PREVIEW_BYTES)[0];
        const truncated = Buffer.byteLength(text, "utf8") > SIMPLE_PREVIEW_BYTES;
        await safeMetric("browser_preview", performance.now(), { fullBytes: Buffer.byteLength(text),
          previewBytes: Buffer.byteLength(preview), truncated });
        response.content[0].text = preview + (truncated ? "\n[Preview truncated at 12KB. Full evidence is preserved; read the relevant omitted lines before drawing conclusions.]" : "") +
          `\n[Ego: ${value.actionCount ?? 0} actions, ${value.writesAttempted ?? 0} UI writes, ${value.saves ?? 0} Saves. Full output: ${outputPath}; structured evidence: ${resultPath}; use read offset/limit/chunk.]`;
        return response;
      });
      const header = match[2].match(/^\s*\/\/ cvent: (\{[^\n]+\})/);
      // Unmodified upstream Ego examples are read-only by default. A concise
      // Cvent header is needed only to grant RR-attributed write authority.
      const meta = header ? JSON.parse(header[1]) : { domain: currentSection || "event_settings", commitMode: "read_only", rrSources: [] };
      if (activeTurnProgress && DOMAINS.has(meta.domain)) { activeTurnProgress.section = meta.domain; currentSection = meta.domain; }
      if (!DOMAINS.has(meta.domain) || !["save", "autosave", "read_only"].includes(meta.commitMode)) throw new Error("Invalid Ego round domain/commitMode");
      return withQueue("browser", async () => {
        await assertSnapshotConsumed();
        await assertDomainStrategy(meta.domain, "bash", match[2]);
        const next = await resumeDomain();
        if ((await assessedDomains()).includes(meta.domain))
          throw new Error(`DOMAIN_ALREADY_COMPLETE: ${meta.domain} is checkpointed; resume ${next ?? "final QA"}`);
        const write = meta.commitMode !== "read_only";
        await assertCompiledExpectations();
        if (write) {
          await assertSourcesVerified(meta.domain, meta.rrSources ?? []);
          await assertNoHeldReplay(meta.domain, { sources: meta.rrSources, script: match[2] });
          const validation = await readJson(join(jobDir, "rr-validation.json"), { items: [] });
          try {
            planNativeRound(match[2], { ...meta, intent: "write" }, validation.items.filter((item: any) => item.domain === meta.domain));
          } catch (error) {
            await recordDomainRoundProgress(meta.domain, { writesAttempted: 0 }, "Atomic planning rejected before browser invocation");
            throw error;
          }
        }
        await appendActivity(`${write ? "Configuring" : "Inspecting"} ${meta.domain} with native Ego`);
        let result: any;
        try {
          result = await invokeBrowser("script", { intent: write ? "write" : "read", domain: meta.domain,
            commitMode: meta.commitMode, rrSources: meta.rrSources ?? [], script: match[2] }, signal, params.timeout ?? 180);
        } catch (error: any) {
          if (!staleRefWithoutWrite(error?.message)) {
            await recordDomainRoundProgress(meta.domain, { writesAttempted: 0 }, "Round rejected; repair atomic plan or change inspection strategy");
            throw error;
          }
          const fresh = await saveLargeSnapshot(await invokeBrowser("snapshotText", { intent: "read", domain: meta.domain }, signal, 90));
          await appendActivity(`STALE_REF_RECOVERED ${meta.domain}: discarded ephemeral Ego ref after zero dispatched writes and captured a fresh snapshot`);
          result = { ok: true, status: "STALE_REF_RECOVERED", writesAttempted: 0, saves: 0, readbacks: 0, freshSnapshot: fresh,
            instruction: "Re-resolve the intended control from this fresh snapshot and continue the same domain. No mutation was dispatched." };
        }
        await clearNativeFallback(meta.domain);
        await appendPerformance("ego_execution_round", performance.now(), { domain: meta.domain,
          actionCount: result.actionCount ?? 0, writeCount: result.writesAttempted ?? 0, saves: result.saves ?? 0, readbacks: result.readbacks ?? 0 });
        await appendActivity(`Ego ${meta.domain}: ${result.actionCount ?? 0} actions, ${result.writesAttempted ?? 0} writes, ${result.saves ?? 0} saves, ${result.readbacks ?? 0} readbacks`);
        await recordDomainRoundProgress(meta.domain, result, "native Ego outcome mission");
        return toolBrowserResult(result);
      });
    },
  });

  pi.registerTool({
    name: "cvent_prepare_rr",
    label: "Prepare RR",
    description: "Inspect the uploaded RR and compile its event-configuration requirements using fixed server helpers. Takes no paths or commands.",
    parameters: Type.Object({}),
    async execute(_id: string, _params: unknown, signal: AbortSignal) {
      return withQueue("job-files", async () => {
        try {
          const existing = await verifiedCompiledExpectations();
          const alreadyPrepared = preparedRR === existing;
          if (alreadyPrepared) {
            const next = await resumeDomain();
            return toolText({ ok: true, reusedPreflight: true, alreadyPrepared: true, resumeDomain: next,
              instruction: `The validated RR plan remains current. Continue at ${next ?? "final QA"}; do not repeat setup or a completed domain.` });
          }
          const plan = await readJson(join(jobDir, "configuration-plan.json"), null);
          const validation = await readJson(join(jobDir, "rr-validation.json"), null);
          const firstDomain = plan.mission?.[0]?.domain;
          const nextDomain = await resumeDomain() ?? firstDomain;
          await appendActivity(`RR plan ready: ${existing.counts?.applicableFields ?? 0} RR evidence fields; server preflight reused; resume domain ${nextDomain}`);
          preparedRR = existing;
          return toolText({ ok: true, reusedPreflight: true, counts: existing.counts, target: plan.target,
            mission: plan.mission.map((section: any) => ({ order: section.order, domain: section.domain, verifiedItems: section.verifiedItemIds?.length ?? 0, heldItems: section.heldItems })),
            firstDomain, resumeDomain: nextDomain, completedDomains: await assessedDomains(), items: validation.items.filter((item: any) => item.domain === nextDomain),
            instruction: `Setup is complete. After authentication and exact-event reopening, resume ${nextDomain}; never replay a completed domain.` });
        } catch {
          // Missing or stale artifacts are rebuilt only by the same fixed approved helpers below.
        }
        await assertSafeArtifactTarget(join(jobDir, "input.inspection.json"));
        await assertSafeArtifactTarget(join(jobDir, "input.inspection-summary.json"));
        await assertSafeArtifactTarget(join(jobDir, "expected-domains.json"));
        await assertSafeArtifactTarget(join(jobDir, "rr-validation.json"));
        await assertSafeArtifactTarget(join(jobDir, "configuration-plan.json"));
        await runFixed(python, [join(repoRoot, "inspect_rr.py"), join(jobDir, "input.xlsx"), join(jobDir, "input.inspection.json")], "prepare", signal, 180000);
        const compiled = await runFixed(python, [join(repoRoot, "rr_compiler.py")], "prepare", signal, 180000);
        const validated = await runFixed(python, [join(repoRoot, "rr_validator.py")], "prepare", signal, 180000);
        const result = JSON.parse(compiled.stdout);
        result.validation = JSON.parse(validated.stdout).counts;
        await appendActivity(`RR extracted and independently validated: ${result.counts?.applicableFields ?? 0} writable fields; ${result.validation?.AMBIGUOUS ?? 0} ambiguous`);
        return toolText(result);
      });
    },
  });

  pi.registerTool({
    name: "cvent_expectations",
    label: "Read RR expectations",
    description: "Read normalized requirements from the uploaded RR for one configuration domain, summary, protected actions, or capability gaps. Large record arrays are paged.",
    parameters: Type.Object({
      section: Type.String({ description: "summary, protected, gaps, or a configuration domain name" }),
      offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 10000 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 25 })),
    }),
    async execute(_id: string, params: any) {
      const expected = await readJson(join(jobDir, "expected-domains.json"), null);
      if (!expected) throw new Error("Run cvent_prepare_rr first");
      const section = String(params.section);
      const deliveryKey = planDeliveryKey(params);
      if (deliveredPlanReads.has(deliveryKey)) return toolText({ ok: true, alreadyDelivered: true, section, instruction: "Use the validated RR data already present in the live model context; do not reread it through another wrapper." });
      let value: any;
      if (section === "summary") value = { rr: expected.rr, target: expected.target, counts: expected.counts };
      else if (section === "protected") value = expected.protected;
      else if (section === "gaps") value = expected.capabilityGaps;
      else if (DOMAINS.has(section)) value = expected.domains?.[section];
      else throw new Error("Capability denied: unknown expectation section");
      return toolText(pageArrays(value, params.offset ?? 0, params.limit ?? 10));
    },
  });

  pi.registerTool({
    name: "cvent_plan",
    label: "Read validated configuration plan",
    description: "Read the complete pre-Cvent mission summary or one ordered section with RR source evidence and independent VERIFIED/AMBIGUOUS/NOT_SUPPORTED_BY_RR status.",
    parameters: Type.Object({
      section: Type.String({ description: "summary, mission, or a configuration domain name" }),
      offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 20000 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    }),
    async execute(_id: string, params: any) {
      await verifiedCompiledExpectations();
      const plan = await readJson(join(jobDir, "configuration-plan.json"), null);
      const validation = await readJson(join(jobDir, "rr-validation.json"), null);
      const section = String(params.section);
      const deliveryKey = planDeliveryKey(params);
      if (deliveredPlanReads.has(deliveryKey)) return toolText({ ok: true, alreadyDelivered: true, section, instruction: "Use the validated RR data already present in the live model context; do not reread it through another wrapper." });
      if (section === "summary") return toolText({ counts: validation.counts, target: plan.target, executionRule: plan.executionRule });
      if (section === "mission") return toolText(plan.mission);
      if (!DOMAINS.has(section)) throw new Error("Capability denied: unknown plan section");
      const next = await resumeDomain();
      if ((await assessedDomains()).includes(section) && next && next !== section)
        return toolText({ ok: true, section, checkpoint: "COMPLETE", resumeDomain: next, instruction: `Do not replay ${section}; continue ${next}.` });
      const items = validation.items.filter((item: any) => item.domain === section);
      return toolText(pageArrays(items, params.offset ?? 0, params.limit ?? 25));
    },
  });

  pi.registerTool({
    name: "cvent_job_read",
    label: "Read job artifact",
    description: "Read one fixed safe job artifact: state, auth_metadata, target_lock, activity, write_audit, browser_failure (partial dispatch evidence), final_report, domain_results, inspection_summary, or browser_runtime. No path input is accepted.",
    parameters: Type.Object({
      artifact: Type.String(),
      tailLines: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
    }),
    async execute(_id: string, params: any) {
      const relative = ARTIFACTS[String(params.artifact)];
      if (!relative) throw new Error("Capability denied: artifact is not approved");
      const path = assertFixedJobPath(join(jobDir, relative));
      let text: string;
      try { text = (await readJobFile(path)).toString("utf8"); }
      catch (error: any) {
        if (error?.code === "ENOENT") return toolText({ exists: false, artifact: params.artifact });
        throw error;
      }
      if (["activity", "write_audit"].includes(String(params.artifact))) {
        const lines = text.split(/\r?\n/);
        text = lines.slice(-(params.tailLines ?? 100)).join("\n");
      } else if (params.artifact === "browser_runtime") {
        const value = JSON.parse(text);
        text = JSON.stringify({
          browserRuntimeId: value.browserRuntimeId,
          workerSlot: value.workerSlot,
          viewerUrl: value.viewerUrl,
          authorizedEventName: value.authorizedEventName,
          authorizedEventId: value.authorizedEventId,
          authorizedEventKey: value.authorizedEventKey,
          targetBrowserIdentity: {
            targetId: value.targetBrowserIdentity?.targetId,
            marker: value.targetBrowserIdentity?.marker,
            url: value.targetBrowserIdentity?.url,
            title: value.targetBrowserIdentity?.title,
          },
          verifiedAt: value.verifiedAt,
        }, null, 2);
      }
      return toolText(text);
    },
  });

  pi.registerTool({
    name: "cvent_job_update",
    label: "Update job progress",
    description: "Atomically update only approved progress fields in this job's state and append one safe product-facing log message. Cannot select paths or execute commands.",
    parameters: Type.Object({
      status: Type.Optional(literalUnion(["running", "login_required", "review_required"])),
      stage: Type.Optional(SIMPLE ? Type.String({ maxLength: 80 }) : literalUnion(JOB_STAGES)),
      action: Type.Optional(Type.String({ maxLength: 1200 })),
      completed: Type.Optional(Type.Array(Type.String({ maxLength: SIMPLE ? 500 : 80 }), { maxItems: SIMPLE ? 1000 : 20 })),
      pending: Type.Optional(Type.Array(Type.String({ maxLength: SIMPLE ? 500 : 80 }), { maxItems: SIMPLE ? 1000 : 20 })),
      reviewRequired: optionalStrings,
      verification: Type.Optional(Type.String({ maxLength: 6000, description: "Simple Mode: your determination from fresh persisted readback, not merely 'Save clicked'. Records verification in the audit; no RR cell metadata required." })),
      log: Type.Optional(Type.String({ maxLength: 1200 })),
    }),
    async execute(_id: string, params: any) {
      return withQueue("job-files", async () => {
        const allowedStatuses = new Set(["running", "login_required", "review_required"]);
        if (params.status && !allowedStatuses.has(params.status)) throw new Error("Capability denied: invalid progress status");
        if (SIMPLE) {
          if (params.verification) await acknowledgeSimplePersistence(params.verification);
          const path = join(jobDir, "state.json"), state = await readJson(path, {});
          if (params.status) state.status = params.status;
          if (params.stage) state.current_stage = cleanText(params.stage, 80);
          if (params.action) state.current_action = cleanText(params.action, 1200);
          if (params.completed) state.completed = [...new Set([...(state.completed ?? []), ...params.completed])];
          if (params.pending) state.pending = params.pending;
          if (params.reviewRequired) state.review_required = params.reviewRequired;
          state.updated_at = new Date().toISOString();
          await atomicJson(path, state);
          await appendActivity(params.log || params.action || `Progress: ${state.current_stage}`);
          return toolText({ ok: true, completed: state.completed, pending: state.pending });
        }
        if (params.stage && !DOMAINS.has(params.stage) && !["starting", "target_discovery"].includes(params.stage)) {
          throw new Error("Capability denied: invalid job stage");
        }
        const path = join(jobDir, "state.json");
        const state = await readJson(path, {});
        const completed = await assessedDomains();
        const next = await resumeDomain();
        if (params.status) state.status = params.status;
        let corrected = false;
        if (params.stage) {
          if (completed.includes(params.stage)) { state.current_stage = next ?? "final_qa"; corrected = true; }
          else state.current_stage = params.stage;
        }
        if (params.action) state.current_action = corrected ? `Resume ${next ?? "final QA"}; completed domain ${params.stage} will not be replayed` : cleanText(params.action, 1200);
        state.completed = completed;
        const plan = await readJson(join(jobDir, "configuration-plan.json"), { mission: [] });
        if (plan.mission?.length) state.pending = plan.mission.map((item: any) => item.domain).filter((domain: string) => !completed.includes(domain));
        if (params.reviewRequired) state.review_required = params.reviewRequired.map((item: unknown) => cleanText(item, 2000));
        state.updated_at = new Date().toISOString();
        await atomicJson(path, state);
        await appendPerformance("stage_marker", performance.now(), { stage: state.current_stage, action: state.current_action, status: state.status, correctedCompletedDomainReplay: corrected });
        if (corrected) await appendActivity(`DOMAIN_RESUME_CORRECTED: ${params.stage} is COMPLETE; resuming ${next}`);
        else if (params.log) await appendActivity(params.log);
        return toolText({ ok: true, status: state.status, stage: state.current_stage, action: state.current_action,
          completedDomains: completed, resumeDomain: next, completedDomainReplayPrevented: corrected });
      });
    },
  });

  pi.registerTool({
    name: "cvent_record_domain",
    label: "Record domain result",
    description: "Atomically record factual job-scoped results for one approved domain. This cannot write arbitrary files.",
    parameters: Type.Object({
      domain: literalUnion(DOMAIN_NAMES),
      status: literalUnion(["in_progress", "completed", "review_required", "incomplete"]),
      created: optionalStrings,
      updated: optionalStrings,
      alreadyCorrect: optionalStrings,
      verifiedReads: optionalStrings,
      verifiedWrites: optionalStrings,
      blocked: optionalStrings,
    }),
    async execute(_id: string, params: any) {
      if (!DOMAINS.has(params.domain)) throw new Error("Capability denied: unknown domain");
      if (!["in_progress", "completed", "review_required", "incomplete"].includes(params.status)) throw new Error("Capability denied: invalid domain status");
      return withQueue("job-files", async () => {
        const fallback = await readJson(NATIVE_FALLBACK, null);
        if (fallback?.domain === params.domain && ["completed", "review_required"].includes(params.status))
          throw new Error(`NATIVE_EGO_REQUIRED: ${params.domain} cannot conclude from adapter ${fallback.reason}`);
        const verification = await readJson(join(jobDir, "final-verification.json"), { domains: {} });
        if (["completed", "review_required"].includes(params.status) && !verification.domains?.[params.domain]?.cventEvidence?.length)
          throw new Error("Domain completion requires persisted desired-state verification evidence from cvent_verify_domain");
        const path = join(jobDir, "domain-results.json");
        const document = await readJson(path, { schemaVersion: 1, domains: {} });
        document.domains ??= {};
        const telemetry = await domainTelemetry(params.domain);
        document.domains[params.domain] = {
          ...(document.domains[params.domain] ?? {}), status: params.status,
          checkpoint: ["completed", "review_required"].includes(params.status) ? "COMPLETE" : params.status.toUpperCase(),
          created: params.created ?? [], updated: params.updated ?? [], already_correct: params.alreadyCorrect ?? [],
          verified_reads: params.verifiedReads ?? [], verified_writes: params.verifiedWrites ?? [], blocked: params.blocked ?? [],
          telemetry, updated_at: new Date().toISOString(),
        };
        document.updatedAt = new Date().toISOString();
        await atomicJson(path, document);
        await appendPerformance("domain_result", performance.now(), { domain: params.domain, status: params.status, checkpoint: document.domains[params.domain].checkpoint, ...telemetry });
        return toolText({ ok: true, domain: params.domain, status: params.status, checkpoint: document.domains[params.domain].checkpoint, telemetry });
      });
    },
  });

  pi.registerTool({
    name: "cvent_verify_domain",
    label: "Record RR versus Cvent verification",
    description: "Account for every RR item after fresh Cvent readback. Supply explicit item-level matches with evidence; omitted items remain NOT_CONFIGURED, never implicitly MATCH.",
    parameters: Type.Object({
      domain: literalUnion(DOMAIN_NAMES),
      cventEvidence: Type.Array(Type.String({ maxLength: 3000 }), { minItems: 1, maxItems: 100 }),
      matches: Type.Optional(Type.Array(Type.Object({
        itemId: Type.String({ pattern: "^[0-9a-f]{20}$" }),
        cventEvidence: Type.Array(Type.String({ minLength: 1, maxLength: 3000 }), { minItems: 1, maxItems: 10 }),
      }), { maxItems: 8000 })),
      exceptions: Type.Array(Type.Object({
        itemId: Type.String({ pattern: "^[0-9a-f]{20}$" }),
        status: Type.Union([Type.Literal("NOT_CONFIGURED"), Type.Literal("AMBIGUOUS"), Type.Literal("PROHIBITED")]),
        reason: Type.String({ maxLength: 2000 }),
      }), { maxItems: 500 }),
    }),
    async execute(_id: string, params: any) {
      if (!DOMAINS.has(params.domain)) throw new Error("Capability denied: unknown domain");
      return withQueue("job-files", async () => {
        const validation = await readJson(join(jobDir, "rr-validation.json"), null);
        if (!validation) throw new Error("Run cvent_prepare_rr first");
        const domainItems = validation.items.filter((item: any) => item.domain === params.domain);
        const items = verificationItemResults(domainItems, params.matches ?? [], params.exceptions);
        if (await pendingWriteReadback()) throw new Error("Domain completion requires Save/readback completion; a write-readback marker is still pending");
        const telemetry = await domainTelemetry(params.domain);
        if (telemetry.writes > 0 && (telemetry.saves < 1 || telemetry.readbacks < 1))
          throw new Error("Domain completion requires persisted Save and readback telemetry for dispatched writes");
        const document = await readJson(join(jobDir, "final-verification.json"), { schemaVersion: 1, domains: {} });
        document.domains[params.domain] = {
          verifiedAt: new Date().toISOString(), cventEvidence: params.cventEvidence,
          items,
        };
        document.updatedAt = new Date().toISOString();
        await atomicJson(join(jobDir, "final-verification.json"), document);
        const counts: Record<string, number> = {};
        for (const item of document.domains[params.domain].items) counts[item.status] = (counts[item.status] ?? 0) + 1;
        const resultPath = join(jobDir, "domain-results.json");
        const results = await readJson(resultPath, { schemaVersion: 1, domains: {} }); results.domains ??= {};
        const prior = results.domains[params.domain] ?? {};
        const held = document.domains[params.domain].items.filter((item: any) => item.status !== "MATCH").map((item: any) => `${item.itemId}: ${item.status} - ${item.reason ?? "item exception"}`);
        results.domains[params.domain] = { ...prior, status: held.length ? "review_required" : "completed", checkpoint: "COMPLETE",
          requested_items: domainItems.length, created: prior.created ?? [], updated: prior.updated ?? [], already_correct: prior.already_correct ?? [],
          verified_reads: params.cventEvidence, verified_writes: prior.verified_writes ?? [], held,
          prohibited: document.domains[params.domain].items.filter((item: any) => item.status === "PROHIBITED").map((item: any) => item.itemId),
          telemetry, verified_at: document.domains[params.domain].verifiedAt, updated_at: new Date().toISOString() };
        results.updatedAt = new Date().toISOString(); await atomicJson(resultPath, results);
        const statePath = join(jobDir, "state.json"), state = await readJson(statePath, {});
        state.completed = await assessedDomains();
        const plan = await readJson(join(jobDir, "configuration-plan.json"), { mission: [] });
        state.pending = (plan.mission ?? []).map((item: any) => item.domain).filter((domain: string) => !state.completed.includes(domain));
        const next = await resumeDomain(); state.current_stage = next ?? "final_qa";
        state.current_action = next ? `${params.domain} COMPLETE; continue with ${next}` : "All configured domains assessed; perform final QA";
        state.updated_at = new Date().toISOString(); await atomicJson(statePath, state);
        await appendActivity(`DOMAIN_CHECKPOINT ${params.domain}=COMPLETE; writes=${telemetry.writes}, saves=${telemetry.saves}, readbacks=${telemetry.readbacks}; next=${next ?? "final_qa"}`);
        return toolText({ ok: true, domain: params.domain, checkpoint: "COMPLETE", counts, telemetry, resumeDomain: next });
      });
    },
  });

  if (SIMPLE) pi.registerTool({
    name: "cvent_open_event", label: "Open selected event",
    description: "Open/bind the exact human-selected existing Cvent event once. No inventory cache or lifecycle prerequisite. Cannot choose a different target.",
    parameters: Type.Object({}),
    async execute(_id: string, _params: any, signal: AbortSignal) {
      return withQueue("browser", async () => toolText(await invokeBrowser("openAuthorizedEvent", {
        intent: "read", eventName: requiredEnvironment("CVENT_AUTHORIZED_EVENT_NAME"),
        eventKey: requiredEnvironment("CVENT_AUTHORIZED_EVENT_KEY"), eventCode: process.env.CVENT_AUTHORIZED_EVENT_CODE || "",
      }, signal, 180)));
    },
  });

  pi.registerTool({
    name: "cvent_login_handoff",
    label: "Request Cvent login",
    description: "Open the fixed Cvent subscriber entry point when the browser is blank, detect a login page, and hand this job's existing Steel viewer to the user for SSO/MFA. If already authenticated, return without handing off; otherwise wait until the user returns control.",
    parameters: Type.Object({}),
    async execute(_id: string, _params: unknown, signal: AbortSignal) {
      return withQueue("browser", async () => {
        const gatePath = join(jobDir, "browser-gate.json");
        const statePath = join(jobDir, "state.json");
        const endLoginWait = async (reason: string) => {
          const state = await readJson(statePath, {});
          state.status = "login_required";
          state.current_stage = "login_handoff";
          state.current_action = "Login wait ended. Continue this job to reopen its browser and complete sign-in.";
          state.updated_at = new Date().toISOString();
          await atomicJson(statePath, state);
          await appendActivity(`${reason}; ending Pi run so normal teardown releases the worker`);
          return { ...toolText({ ok: false, loginRequired: true, reason, instruction: state.current_action }), terminate: true };
        };
        const initialGate = await readJson(gatePath, {});
        if (initialGate.ownership === "USER" && initialGate.desiredOwnership === "USER") {
          // Do not repeatedly call pageInfo/authStatus through a USER-owned gate.
          // The controller, not this tool, owns lease teardown and uncertainty QA.
          return endLoginWait("Browser is still handed to the user");
        }
        let pageResult = await invokeBrowser("pageInfo", { intent: "read" }, signal, 45);
        let pageUrl = String(pageResult?.page?.url ?? "");
        let pageTitle = String(pageResult?.page?.title ?? "");
        let host = "";
        try { host = new URL(pageUrl).hostname.toLowerCase(); } catch { /* fixed navigation below */ }
        const recognizedLoginHost = host.endsWith("cvent.com") || host.includes("microsoftonline.com") || host.includes("login.windows.net") || host.includes("login.live.com");
        let modernPageOutsideAuthorizedEvent = false;
        try {
          const parsed = new URL(pageUrl);
          const key = (parsed.searchParams.get("evtstub") ?? parsed.searchParams.get("eventid") ?? parsed.searchParams.get("event") ?? "").toLowerCase();
          modernPageOutsideAuthorizedEvent = host === "events.app.cvent.com" && key !== requiredEnvironment("CVENT_AUTHORIZED_EVENT_KEY").toLowerCase();
        } catch { /* fixed navigation below */ }
        if (!pageUrl || pageUrl === "about:blank" || !recognizedLoginHost || modernPageOutsideAuthorizedEvent) {
          await invokeBrowser("navigate", { intent: "read", url: "https://app.cvent.com/subscribers/default.aspx" }, signal, 60);
          pageResult = await invokeBrowser("pageInfo", { intent: "read" }, signal, 45);
          pageUrl = String(pageResult?.page?.url ?? "");
          pageTitle = String(pageResult?.page?.title ?? "");
          try { host = new URL(pageUrl).hostname.toLowerCase(); } catch { host = ""; }
        }
        let auth = await settleAuthenticatedProfile(
          await invokeBrowser("authStatus", { intent: "read" }, signal, 45),
          () => invokeBrowser("authStatus", { intent: "read" }, signal, 45),
          () => new Promise<void>(resolvePromise => setTimeout(resolvePromise, 500)),
        );
        if (SIMPLE && !auth.authenticated && auth.profileMatch === true && auth.accountContextMatch === true) {
          // A bad Cvent URL is not necessarily an expired login. Normalize the
          // login entry point once before asking the human to authenticate again.
          await invokeBrowser("navigate", { intent: "read", url: "https://app.cvent.com/subscribers/default.aspx" }, signal, 60);
          auth = await settleAuthenticatedProfile(await invokeBrowser("authStatus", { intent: "read" }, signal, 45),
            () => invokeBrowser("authStatus", { intent: "read" }, signal, 45),
            () => new Promise<void>(resolvePromise => setTimeout(resolvePromise, 500)));
        }
        if (auth.authenticated === true && auth.workerSlot === Number(requiredEnvironment("CVENT_WORKER_SLOT"))) {
          await appendActivity("Cvent login already active; verified this worker's isolated persisted profile");
          const authorization = await browserAuthorizationState();
          await appendActivity(`AUTH_STATE=authenticated TARGET_STATE=${authorization.targetState} BROWSER_RUNTIME=${authorization.runtimeId}`);
          return toolText({ ok: true, loginRequired: false, persistedProfileReused: true,
            instruction: "Cvent login already active in this worker's isolated profile; fresh-read a complete snapshot and continue." });
        }

        const gate = await readJson(gatePath, {});
        if (gate.ownership !== "AGENT" || gate.desiredOwnership !== "AGENT" || ![undefined, null, "NONE"].includes(gate.activeActor)) {
          throw new Error("Login handoff requires an idle agent-owned browser gate");
        }
        const state = await readJson(statePath, {});
        if (SIMPLE) state.resume_stage = state.current_stage;
        state.status = "login_required";
        state.current_stage = "login_required";
        state.current_action = "Complete Cvent SSO/MFA in the browser, then return control to the agent";
        state.updated_at = new Date().toISOString();
        await atomicJson(statePath, state);
        gate.ownership = "USER";
        gate.desiredOwnership = "USER";
        gate.activeActor = "USER";
        gate.automationOwner = "USER";
        gate.agentPaused = true;
        gate.pausedPids = [process.pid];
        gate.transition = null;
        gate.updatedAt = new Date().toISOString();
        if (BENCHMARK) await benchmarkCall("handoff", {});
        else await atomicJson(gatePath, gate);
        await appendActivity("Cvent login required; browser control handed to user for SSO/MFA");
        const humanHandoffStarted = performance.now();

        const deadline = Date.now() + 60 * 60 * 1000;
        while (Date.now() < deadline) {
          if (signal?.aborted) throw new Error("Login handoff cancelled");
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
          const current = await readJson(gatePath, {});
          if (current.ownership === "AGENT" && current.desiredOwnership === "AGENT") {
            const resumed = await readJson(statePath, {});
            const next = SIMPLE ? (resumed.resume_stage ?? "running") : await resumeDomain();
            resumed.status = "running";
            resumed.current_stage = next ?? "target_discovery";
            resumed.current_action = `Verifying Cvent login, reopening the exact event, then resuming ${next ?? "the first incomplete domain"}`;
            resumed.updated_at = new Date().toISOString();
            await atomicJson(statePath, resumed);
            await appendActivity(`User returned browser control; authenticated slot profile verified; resume domain ${next ?? "unresolved"}`);
            const authorization = await browserAuthorizationState();
            await appendActivity(`AUTH_STATE=authenticated TARGET_STATE=${authorization.targetState} BROWSER_RUNTIME=${authorization.runtimeId}`);
            await safeMetric("human_handoff", humanHandoffStarted, { boundary: "cvent_sso_mfa", completed: true });
            return toolText({ ok: true, resumed: true, profilePersisted: true, resumeDomain: next,
              instruction: SIMPLE ? "Forge verified this same profile. Observe the current page and continue your own checklist; do not reset progress." : `Forge verified this slot's Cvent login. Reopen the exact selected event, take a fresh snapshot, and resume ${next ?? "the first incomplete domain"}.` });
          }
          if (current.ownership === "NONE") throw new Error("Browser return was blocked; human review is required");
        }
        await safeMetric("human_handoff", humanHandoffStarted, { boundary: "cvent_sso_mfa", completed: false });
        return endLoginWait("Cvent login handoff timed out after 60 minutes");
      });
    },
  });

  pi.registerTool({
    name: "cvent_section_state",
    label: "Read complete Cvent section state",
    description: "Open a cached or proven exact-event section route once, collect compact structured table/form state for all RR records, and return only aggregate matches plus exceptions. Use before any per-record discovery.",
    parameters: Type.Object({ domain: literalUnion(DOMAIN_NAMES) }),
    async execute(_id: string, params: any, signal: AbortSignal) {
      const domain = String(params.domain);
      const next = await resumeDomain();
      if ((await assessedDomains()).includes(domain)) throw new Error(`DOMAIN_ALREADY_COMPLETE: ${domain} is checkpointed; resume ${next ?? "final QA"}`);
      await assertSnapshotConsumed();
      if (await pendingWriteReadback()) throw new Error("Complete pending write readback before changing sections");
      const expected = await verifiedCompiledExpectations();
      const runtime = await readJson(runtimePath, {});
      const cache = await readJson(ROUTE_CACHE, { routes: {} });
      const cached = cache.routes?.[domain];
      const route = cached?.browserRuntimeId === runtime.browserRuntimeId ? cached.url : fixedSectionRoutes()[domain];
      const menuPath = fixedSectionMenuPath(domain);
      if (!route && !menuPath.length) return toolText({ ok: false, domain, exception: "NO_PROVEN_ROUTE", instruction: "Use Pi discovery once; successful exact-event navigation will be cached for this job." });
      return withQueue("browser", async () => {
        const base = route ?? fixedSectionRoutes().event_settings.replace("/Details/EventDetails/Index", "/Overview/Overview/Index/View");
        const navigation = await invokeBrowser("navigate", browserParams("navigate", { intent: "read", url: base, loadState: "domcontentloaded" }), signal, 120);
        for (const label of menuPath) {
          await invokeBrowser("click", browserParams("click", { intent: "read", target: `role:menuitem[name="${label}"]` }), signal, 60);
          await invokeBrowser("wait", browserParams("wait", { intent: "read", ms: 600 }), signal, 30);
        }
        const observed = await invokeBrowser("sectionState", browserParams("sectionState", { intent: "read", domain }), signal, 90);
        await rememberSectionRoute(String(observed.url ?? observed.page?.url ?? base), domain);
        // Browser policy has already proved canonical event identity on this
        // exact route, including legitimate keyless planner transitions.
        const comparison = compactSectionComparison(domain, expected, observed);
        await clearNativeFallback(domain);
        if (activeTurnProgress) { activeTurnProgress.meaningfulProgress = true; activeTurnProgress.progressReasons.push("section_state"); }
        await appendActivity(`Collected complete ${domain} section state in one bounded mission: ${comparison.counts.PRESENT} present, ${comparison.counts.DIFFERS} differing, ${comparison.counts.MISSING} missing`);
        return toolText({ ok: true, route: observed.url ?? observed.page?.url ?? navigation.page?.url ?? base, ...comparison,
          outcomeInstruction: `Configure ${domain} to match verified RR values; update only actual differences, Save, read back, and return item-level exceptions.` });
      });
    },
  });

  pi.registerTool({
    name: "cvent_execute_section",
    label: "Execute trusted Cvent section procedure",
    description: "Run one application-owned, bounded multi-step Ego procedure for an entire RR section. Pi supplies only the section enum; trusted code loads VERIFIED RR data and owns routes, locators, actions, saves, and final readback.",
    parameters: Type.Object({ domain: literalUnion(Object.keys(TRUSTED_SECTION_PROCEDURES)) }),
    async execute(_id: string, params: any, signal: AbortSignal) {
      const domain = String(params.domain);
      const operation = TRUSTED_SECTION_PROCEDURES[domain];
      if (!operation) throw new Error(`No trusted Cvent procedure is registered for ${domain}`);
      const next = await resumeDomain();
      if ((await assessedDomains()).includes(domain)) throw new Error(`DOMAIN_ALREADY_COMPLETE: ${domain} is checkpointed; resume ${next ?? "final QA"}`);
      return withQueue("browser", async () => {
        await assertSnapshotConsumed();
        if (await pendingWriteReadback()) throw new Error("Complete the pending Cvent write readback before starting a trusted section procedure");
        const expected = await verifiedCompiledExpectations();
        await assertDomainEvidenceVerified(domain);
        const holds = await replayHolds(domain);
        const heldIdentities = new Set(holds.map((hold: any) => cleanText(hold.identity, 500).toLowerCase()));
        const records = trustedProcedureRecords(domain, expected).filter((record: any) => !heldIdentities.has(cleanText(record.code, 500).toLowerCase()));
        if (!records.length) return toolText({ ok: true, domain, status: "ALREADY_CORRECT", records: [], replayHolds: holds, detail: "RR contains no non-held records for this section" });
        await updateBrowserProgress(`Running trusted multi-step Ego procedure for ${domain}`);
        const started = performance.now();
        const result = await invokeBrowser(operation, {
          intent: "write", rrSource: `VERIFIED RR domain: ${domain}`, records, timeoutSeconds: 780,
        }, signal, 780);
        await appendPerformance("trusted_section_procedure", started, { domain, operation, records: records.length,
          status: result.status, mutationCount: result.mutationCount ?? 0, metrics: result.metrics, counts: result.counts });
        await atomicJson(join(jobDir, `trusted-${domain}-result.json`), { ...result,
          rrSha256: expected.rr?.sha256, recordedAt: new Date().toISOString() });
        await appendActivity(`Trusted ${domain} Ego mission returned ${result.status}: ${result.records?.length ?? 0} records, ${result.mutationCount ?? 0} mutations`);
        if (adapterNeedsNativeFallback(result)) {
          await markNativeFallback(domain, result);
          const freshSnapshot = await saveLargeSnapshot(await invokeBrowser("snapshotText", { intent: "read", domain }, signal, 90));
          await appendActivity(`ADAPTER_NATIVE_FALLBACK ${domain}: CONTROL_NOT_FOUND with 0 writes; native Ego received a fresh live snapshot`);
          await updateBrowserProgress(`Native Ego taking over ${domain} after optional accelerator limitation`);
          return toolText({ ok: true, domain, replayHolds: holds, ...result, acceleratorOnly: true,
            fallback: "NATIVE_EGO_REQUIRED", freshSnapshot,
            instruction: `The optional accelerator could not locate controls and dispatched 0 writes. Continue ${domain} immediately with native Ego using this fresh snapshot; hold only proven item-level exceptions.` });
        }
        await updateBrowserProgress(result.status === "AUTH_REQUIRED" ? `Cvent authentication required while entering ${domain}` : `Trusted ${domain} mission finished: ${result.status}`);
        return toolText({ ok: true, domain, replayHolds: holds, ...result });
      });
    },
  });

  pi.registerTool({
    name: "cvent_browser",
    label: "General Cvent Ego browser",
    description: "Ego's read/write browser operator for the exact selected Cvent event. Observe once with snapshotText for semantic DOM or screenshot for visual/virtualized UI, then use operation=actions for substantial predictable progress—normally many click/fill/select/keyboard/save/readback steps, potentially across multiple exact records—in one Ego process. Copy refs from the newest snapshot. Primitive operations are exceptional and only for genuinely unpredictable next state. The gateway independently enforces RR provenance, lease/lifecycle, target identity, protected-action blocks, auditing, and uncertain-write holds.",
    parameters: Type.Object({
      operation: Type.Union(PI_BROWSER_OPERATION_NAMES.map((name) => Type.Literal(name))),
      ...browserActionFields,
      objective: Type.Optional(Type.String({ minLength: 1, maxLength: 1200 })),
      commitMode: Type.Optional(Type.Union([Type.Literal("save"), Type.Literal("autosave"), Type.Literal("read_only")])),
      steps: Type.Optional(Type.Array(egoActionSchema, { minItems: 1, maxItems: 80 })),
      maxScrolls: Type.Optional(Type.Integer({ minimum: 1, maximum: 60 })),
    }),
    async execute(_id: string, params: any, signal: AbortSignal) {
      const operation = String(params.operation);
      if (operation !== "actions" && params.intent === "write") throw new Error("ROUND_PLANNING_ERROR: individual mutations are not atomic. Use a native Ego script or actions round containing fresh snapshot, verified data, Save, wait and fresh readback; writes=0.");
      if (operation !== "actions") validateGeneralBrowserAction(operation, params);
      return withQueue("browser", async () => {
        if (operation === "actions") {
          const domain = String(params.domain ?? ""), steps = params.steps as any[] | undefined;
          if (!DOMAINS.has(domain) || !params.objective || !params.commitMode || !steps?.length) throw new Error("A coherent Ego action round requires domain, objective, commitMode, and steps");
          const writeIndexes = steps.flatMap((step, index) => step.intent === "write" ? [index] : []);
          if (params.commitMode === "read_only" && writeIndexes.length) throw new Error("Read-only Ego action round cannot contain writes");
          if (params.commitMode !== "read_only" && !writeIndexes.length) throw new Error("Configuration Ego action round contains no writes");
          validateActionRound(params.commitMode, steps);
          await assertSnapshotConsumed();
          await assertDomainStrategy(domain, "actions", String(params.objective));
          const next = await resumeDomain();
          if ((await assessedDomains()).includes(domain)) throw new Error(`DOMAIN_ALREADY_COMPLETE: ${domain} is checkpointed; resume ${next ?? "final QA"}`);
          if (writeIndexes.length) {
            await assertCompiledExpectations();
            await assertSourcesVerified(domain, writeIndexes.filter(index => isDataAction(steps[index].operation, steps[index])).map(index => steps[index].rrSource));
            await assertNoHeldReplay(domain, params);
            // The router's durable attempt/outcome audit owns atomic-round containment.
            // Do not create a pending-write hold before its pre-dispatch validation.
          }
          await updateBrowserProgress(`Ego executing coherent ${domain} work: ${cleanText(params.objective, 500)}`);
          const boundedSteps = steps.map(step => ({ operation: String(step.operation), ...browserParams(String(step.operation), step) }));
          let result: any;
          try {
            result = await invokeBrowser("actions", { intent: writeIndexes.length ? "write" : "read", domain, objective: cleanText(params.objective, 1200), commitMode: params.commitMode, steps: boundedSteps }, signal, Number(params.timeoutSeconds ?? 780));
          } catch (error: any) {
            if (!staleRefWithoutWrite(error?.message)) throw error;
            const fresh = await saveLargeSnapshot(await invokeBrowser("snapshotText", { intent: "read", domain }, signal, 90));
            await appendActivity(`STALE_REF_RECOVERED ${domain}: zero-write action round received a fresh snapshot for re-resolution`);
            result = { ok: true, status: "STALE_REF_RECOVERED", writesAttempted: 0, saves: 0, readbacks: 0, freshSnapshot: fresh,
              instruction: "Re-resolve from the fresh snapshot and continue; no mutation was dispatched." };
          }
          if (writeIndexes.length) await clearWriteReadback();
          await clearNativeFallback(domain);
          await appendPerformance("ego_execution_round", performance.now(), { domain, actionCount: result.actionCount ?? steps.length, writeCount: result.writesAttempted ?? 0,
            saves: result.saves ?? 0, readbacks: result.readbacks ?? 0, fullSnapshots: steps.filter(step => step.operation === "snapshotText").length });
          await appendPerformance("EGO_ROUND_ACTION_DENSITY", performance.now(), { domain, actionCount: result.actionCount ?? steps.length, writeCount: result.writesAttempted ?? 0, objective: cleanText(params.objective, 500) });
          if (steps.length < 4) await appendPerformance("LOW_ACTION_DENSITY", performance.now(), { domain, actionCount: steps.length, commitMode: params.commitMode, objective: cleanText(params.objective, 500) });
          await appendActivity(`Ego ${domain} round completed ${result.actionCount ?? steps.length} continuous browser actions: ${cleanText(params.objective, 500)}`);
          await recordDomainRoundProgress(domain, result, String(params.objective));
          await updateBrowserProgress(`Ego ${domain} round verified and returned`);
          return toolBrowserResult(result);
        }
        const write = params.intent === "write";
        await updateBrowserProgress(write ? `Validating scoped Cvent write: ${operation}` : `Reading Cvent browser: ${operation}`);
        try {
          await assertSnapshotConsumed();
          const readback = await pendingWriteReadback();
          const readbackOperation = ["snapshotText", "readTarget", "controlInventory"].includes(operation);
          if (readback && ["navigate", "openAuthorizedEvent", "scanEventList"].includes(operation)) {
            throw new Error("Verify pending Cvent configuration changes before leaving the current page");
          }
          if (write) {
            await assertCompiledExpectations();
            if (!params.domain) throw new Error("Every adaptive Cvent write requires its validated RR domain");
            await assertSourcesVerified(String(params.domain), [params.rrSource]);
            await assertNoHeldReplay(String(params.domain), params);
          }
          const input = browserParams(operation, params);
          const timeout = Math.max(1, Math.min(Number(params.timeoutSeconds ?? (operation === "recover" ? 35 : 90)), operation === "recover" ? 35 : 180));
          let result: any;
          try { result = await invokeBrowser(operation, input, signal, timeout); }
          catch (error: any) {
            if (!staleRefWithoutWrite(error?.message)) throw error;
            const fresh = await saveLargeSnapshot(await invokeBrowser("snapshotText", { intent: "read", domain: String(params.domain ?? currentSection) }, signal, 90));
            await appendActivity(`STALE_REF_RECOVERED ${String(params.domain ?? currentSection)}: locator failure had 0 dispatched writes; fresh snapshot captured`);
            return toolBrowserResult({ ok: true, status: "STALE_REF_RECOVERED", writesAttempted: 0, saves: 0, readbacks: 0,
              freshSnapshot: fresh, instruction: "Re-resolve the target from this fresh snapshot and continue." });
          }
          if (operation === "recover") {
            const next = await resumeDomain();
            const opened = await invokeBrowser("openAuthorizedEvent", browserParams("openAuthorizedEvent", { intent: "read", refreshInventory: true }), signal, 120);
            const fresh = await saveLargeSnapshot(await invokeBrowser("snapshotText", { intent: "read", domain: next ?? currentSection }, signal, 90));
            const statePath = join(jobDir, "state.json"), state = await readJson(statePath, {});
            state.current_stage = next ?? state.current_stage; state.current_action = `Browser recovered, exact event reopened, fresh snapshot captured; resume ${next ?? "current domain"}`;
            state.updated_at = new Date().toISOString(); await atomicJson(statePath, state);
            await appendActivity(`BROWSER_RECOVERED: exact event reopened from live/recollected inventory; resuming ${next ?? "current domain"}; completed domains preserved`);
            return toolBrowserResult({ ...result, reopenedEvent: opened.authorizedTarget ?? opened.navigationTarget, freshSnapshot: fresh,
              resumeDomain: next, instruction: `Continue ${next ?? "the first incomplete domain"}; do not restart a completed domain.` });
          }
          if (operation === "openAuthorizedEvent") {
            const next = await resumeDomain();
            const statePath = join(jobDir, "state.json"), state = await readJson(statePath, {});
            state.current_stage = next ?? state.current_stage; state.current_action = `Exact event opened; resume ${next ?? "final QA"}`;
            state.updated_at = new Date().toISOString(); await atomicJson(statePath, state);
            result.resumeDomain = next; result.instruction = `Exact canonical event is open. Take a fresh snapshot and resume ${next ?? "final QA"}; completed domains are checkpointed.`;
          }
          if (operation === "navigate" && params.url) await rememberSectionRoute(String(params.url));
          const packaged = await saveLargeSnapshot(result);
          if (write) {
            const pending = readback ?? {};
            await atomicJson(WRITE_READBACK_PENDING, {
              operations: [...(pending.operations ?? []), operation].slice(-100),
              rrSources: [...(pending.rrSources ?? []), ...(params.rrSource ? [cleanText(params.rrSource, 500)] : [])].slice(-100),
              browserRuntimeId: result.browserRuntimeId, targetId: result.targetId,
              requiredAt: pending.requiredAt ?? new Date().toISOString(), updatedAt: new Date().toISOString(),
            });
          } else if (readback && readbackOperation) {
            const transport = await pendingSnapshot();
            if (!transport || transport.complete === true) await clearWriteReadback();
          }
          if (params.domain && ["snapshotText", "sectionState", "controlInventory", "screenshot", "readTarget"].includes(operation)) await clearNativeFallback(String(params.domain));
          await updateBrowserProgress(write ? `Configuring selected Cvent event: ${operation}` : `Cvent browser read complete: ${operation}`);
          return toolBrowserResult(packaged);
        } catch (error) {
          await updateBrowserProgress(`${write ? "Cvent write" : "Cvent browser read"} blocked safely during ${operation}`);
          throw error;
        }
      });
    },
  });

  pi.registerTool({
    name: "cvent_snapshot_chunk",
    label: "Read complete snapshot chunk",
    description: "Read one transport chunk from a previously captured complete full-page Ego snapshot. Read every chunk before acting; this never triggers a smaller or targeted DOM read.",
    parameters: Type.Object({
      snapshotId: Type.String({ pattern: "^[0-9a-f-]{36}$" }),
      chunkIndex: Type.Integer({ minimum: 0, maximum: 1000 }),
    }),
    async execute(_id: string, params: any) {
      return withQueue("browser", async () => {
        const id = String(params.snapshotId);
        if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("Capability denied: invalid snapshot ID");
        const pending = await pendingSnapshot();
        if (!pending || pending.complete === true || pending.snapshotId !== id) throw new Error("Snapshot is not the active job-scoped transport");
        const runtime = await readJson(runtimePath, null);
        if (!runtime || pending.browserRuntimeId !== runtime.browserRuntimeId || pending.targetId !== runtime.targetBrowserIdentity?.targetId ||
            pending.workerSlot !== Number(requiredEnvironment("CVENT_WORKER_SLOT")) || pending.jobId !== requiredEnvironment("CVENT_JOB_ID") ||
            pending.workspaceId !== requiredEnvironment("CVENT_WORKSPACE_ID")) {
          throw new Error("Snapshot worker/browser/job identity mismatch");
        }
        const path = assertFixedJobPath(join(jobDir, "browser-snapshots", `${id}.txt`));
        const buffer = await readJobFile(path, MAX_SNAPSHOT_BYTES);
        if (buffer.length !== pending.bytes || hash(buffer) !== pending.sha256) throw new Error("Snapshot transport integrity check failed");
        const chunks = utf8Chunks(buffer.toString("utf8"), SNAPSHOT_CHUNK_BYTES);
        if (chunks.length !== pending.totalChunks) throw new Error("Snapshot chunk count changed");
        const index = Number(params.chunkIndex);
        if (index !== pending.nextChunk) throw new Error(`Snapshot chunks must be read exactly once in order; expected ${pending.nextChunk}`);
        const complete = index === chunks.length - 1;
        pending.nextChunk = index + 1;
        pending.complete = complete;
        await atomicJson(SNAPSHOT_PENDING, pending);
        if (complete && await pendingWriteReadback()) await clearWriteReadback();
        return toolText({
          snapshotId: id, chunkIndex: index, totalChunks: chunks.length, complete,
          bytes: pending.bytes, sha256: pending.sha256, capturedAt: pending.capturedAt,
          browserRuntimeId: pending.browserRuntimeId, workerSlot: pending.workerSlot,
          targetId: pending.targetId, jobId: pending.jobId, workspaceId: pending.workspaceId,
          url: pending.url, title: pending.title, chunkText: chunks[index],
        });
      });
    },
  });

  const simpleDomainAssessments = Type.Array(Type.Object({
    domain: Type.String({ minLength: 1, maxLength: 80 }),
    outcome: literalUnion(["verified", "review_required", "prohibited"]),
    allSafeWorkAttempted: Type.Boolean({ description: "True only after attempting every independent permissible requirement in this domain. Unvisited or deferred safe work means false. Exact item-level exceptions need actual attempt evidence; volume and elapsed time are not blockers." }),
    evidence: Type.Array(Type.String({ minLength: 1, maxLength: 3000 }), { minItems: 1, maxItems: 100 }),
  }), { maxItems: 1000, description: "Simple Mode: assess every populated compiled domain plus any additional domains you discover in the original workbook. You choose the categories and order; the compiler is only a coverage floor." });

  pi.registerTool({
    name: "cvent_finish",
    label: "Finish Cvent job",
    description: "Write the final structured job report and end the agent turn. Use only after final QA or a genuine blocker. Cannot publish, mutate Cvent, select paths, or execute commands.",
    parameters: Type.Object({
      status: Type.Union([
        Type.Literal("DRAFT_COMPLETE"), Type.Literal("REVIEW_REQUIRED"), Type.Literal("INCOMPLETE"),
      ], { description: "Final controlled outcome, not an item-level exception" }),
      jobWideBlocker: Type.Optional(literalUnion(["authentication_unavailable", "wrong_event", "lease_lost", "provider_unavailable", "uncertain_mutation", "browser_runtime_failure", "capability_unavailable"])),
      blockerEvidence: Type.Optional(Type.String({ minLength: 10, maxLength: 3000 })),
      unresolvedItems: Type.Array(Type.String({ maxLength: 3000 }), { maxItems: 200 }),
      domainAssessments: SIMPLE ? simpleDomainAssessments : Type.Optional(simpleDomainAssessments),
      realReads: Type.Array(Type.String({ maxLength: 3000 }), { maxItems: 500 }),
      realWrites: Type.Array(Type.String({ maxLength: 3000 }), { maxItems: 500 }),
      guardrails: Type.Object({
        published: Type.Integer({ minimum: 0 }),
        emailsSent: Type.Integer({ minimum: 0 }),
        deletes: Type.Integer({ minimum: 0 }),
        globalMutations: Type.Integer({ minimum: 0 }),
      }),
    }),
    async execute(_id: string, params: any) {
      if (!["DRAFT_COMPLETE", "REVIEW_REQUIRED", "INCOMPLETE"].includes(params.status)) throw new Error("Capability denied: invalid final status");
      if (SIMPLE && params.realReads.length && params.jobWideBlocker !== "uncertain_mutation") await acknowledgeSimplePersistence(params.realReads.join("\n"));
      if (SIMPLE && params.status === "INCOMPLETE" && !params.jobWideBlocker) throw new Error("INCOMPLETE needs a genuine mission-wide blocker, not an individual review item");
      if (await pendingWriteReadback() && params.jobWideBlocker !== "uncertain_mutation") throw new Error("Final report blocked until the required Cvent write readback is complete");
      if (params.jobWideBlocker && (params.status !== "INCOMPLETE" || !params.blockerEvidence)) throw new Error("A genuine job-wide blocker requires INCOMPLETE and exact blocker evidence");
      if ([params.guardrails.published, params.guardrails.emailsSent, params.guardrails.deletes, params.guardrails.globalMutations].some((value) => value !== 0)) {
        throw new Error("Final report blocked: protected actions must remain zero");
      }
      if (params.status === "DRAFT_COMPLETE" && params.unresolvedItems.length) throw new Error("DRAFT_COMPLETE cannot contain unresolved RR configuration items");
      return withQueue("job-files", async () => {
        if (SIMPLE) {
          if (params.realWrites.length && !params.realReads.length) throw new Error("Report the actual persisted verification evidence for your work");
          const stateBeforeFinish = await readJson(join(jobDir, "state.json"), {});
          const pendingChecklist = (stateBeforeFinish.pending ?? []).map((item: unknown) => cleanText(item, 200)).filter(Boolean);
          if (!params.jobWideBlocker && pendingChecklist.length)
            throw new Error(`Do not finish while your own checklist still has pending safe work: ${pendingChecklist.join(", ")}. Continue with Ego until the checklist is empty.`);
          const validation = await readJson(join(jobDir, "rr-validation.json"), { items: [] });
          const requiredCounts = new Map<string, number>();
          for (const item of validation.items ?? []) {
            const domain = String(item?.domain ?? "").trim();
            if (domain) requiredCounts.set(domain, (requiredCounts.get(domain) ?? 0) + 1);
          }
          const assessments = new Map<string, any>();
          for (const assessment of params.domainAssessments ?? []) {
            const domain = String(assessment?.domain ?? "").trim();
            if (!domain || assessments.has(domain)) throw new Error("Each Simple Mode domain assessment must have a unique non-empty domain");
            if (!Array.isArray(assessment.evidence) || !assessment.evidence.length || assessment.evidence.some((item: unknown) => !String(item ?? "").trim()))
              throw new Error(`Domain ${domain} needs actual non-empty Cvent evidence`);
            if (!["verified", "review_required", "prohibited"].includes(assessment.outcome)) throw new Error(`Invalid domain outcome: ${domain}`);
            assessments.set(domain, { domain, outcome: assessment.outcome, all_safe_work_attempted: assessment.allSafeWorkAttempted === true,
              evidence: assessment.evidence, rr_item_count: requiredCounts.get(domain) ?? null });
          }
          if (!params.jobWideBlocker && requiredCounts.size) {
            const outstanding = [...requiredCounts.keys()].filter(domain => !assessments.has(domain));
            if (outstanding.length) throw new Error(`Do not finish early. Inspect and attempt independent safe work in: ${outstanding.join(", ")}. Hold only item-level exceptions, not untouched domains.`);
          }
          if (!params.jobWideBlocker) {
            if (!assessments.size) throw new Error("Assess the original workbook before finishing, even when the optional compiler has no categories");
            const unfinished = [...assessments.values()].filter(assessment => !assessment.all_safe_work_attempted);
            if (unfinished.length) throw new Error(`Unfinished safe work remains in: ${unfinished.map(item => item.domain).join(", ")}. Continue dynamically with Ego; do not relabel pending work as review.`);
          }
          if (params.status === "DRAFT_COMPLETE" && [...assessments.values()].some(assessment => assessment.outcome !== "verified"))
            throw new Error("DRAFT_COMPLETE requires every populated RR domain assessment to be verified");
          if (params.status === "REVIEW_REQUIRED") {
            if (!params.unresolvedItems.length) throw new Error("REVIEW_REQUIRED needs exact unresolved item-level exceptions");
            if (![...assessments.values()].some(assessment => assessment.outcome === "review_required" || assessment.outcome === "prohibited"))
              throw new Error("REVIEW_REQUIRED needs at least one domain assessment with a review_required or prohibited outcome");
          }
          const report = { status: params.status, execution_mode: "simple", reported_by: "pi",
            job_wide_blocker: params.jobWideBlocker ?? null, completion_reason: params.blockerEvidence ?? "Pi final QA; see actual evidence and review items",
            unresolved_items: params.unresolvedItems, domain_assessments: [...assessments.values()], real_reads: params.realReads, real_writes: params.realWrites,
            guardrails: { published: 0, emails_sent: 0, deletes: 0, global_mutations: 0 }, updated_at: new Date().toISOString() };
          await atomicJson(join(jobDir, "final-report.json"), report);
          const state = await readJson(join(jobDir, "state.json"), {});
          state.status = params.status === "DRAFT_COMPLETE" ? "completed" : params.status === "REVIEW_REQUIRED" ? "review_required" : "incomplete";
          state.current_action = `Pi final QA: ${params.status}`; state.updated_at = report.updated_at;
          await atomicJson(join(jobDir, "state.json"), state);
          await appendActivity(state.current_action);
          return { ...toolText({ ok: true, status: params.status }), terminate: true };
        }
        const validation = await readJson(join(jobDir, "rr-validation.json"), { items: [] });
        const verification = await readJson(join(jobDir, "final-verification.json"), { schemaVersion: 1, domains: {} });
        if (!params.jobWideBlocker) {
          if (!validation.items?.length) throw new Error("Cannot finish: verified RR plan is absent/empty; prepare the actual RR first");
          const outstanding = [...new Set(validation.items.map((item: any) => item.domain))].filter((domain: any) => !verification.domains?.[domain]?.cventEvidence?.length);
          if (outstanding.length) throw new Error(`Do not finish early. Inspect and attempt independent safe work in: ${outstanding.join(", ")}. Hold only uncertain items, not the job.`);
          if (params.status === "INCOMPLETE") throw new Error("INCOMPLETE requires a genuine job-wide blocker; use REVIEW_REQUIRED only after all independent work and final verification");
        }
        const recorded = new Map<string, any>();
        for (const domain of Object.values(verification.domains ?? {}) as any[]) for (const item of domain.items ?? []) recorded.set(item.itemId, item);
        for (const rrItem of validation.items ?? []) if (!recorded.has(rrItem.itemId)) recorded.set(rrItem.itemId, {
          itemId: rrItem.itemId, rrStatus: rrItem.status, status: rrItem.status === "AMBIGUOUS" ? "AMBIGUOUS" : "NOT_CONFIGURED",
          reason: "Domain was not verified before the job ended",
        });
        const accuracy: Record<string, number> = { MATCH: 0, NOT_CONFIGURED: 0, AMBIGUOUS: 0, PROHIBITED: 0 };
        for (const item of recorded.values()) accuracy[item.status] = (accuracy[item.status] ?? 0) + 1;
        verification.finalItems = [...recorded.values()]; verification.counts = accuracy; verification.updatedAt = new Date().toISOString();
        await atomicJson(join(jobDir, "final-verification.json"), verification);
        if (params.status === "DRAFT_COMPLETE" && (accuracy.NOT_CONFIGURED || accuracy.AMBIGUOUS || accuracy.PROHIBITED)) {
          throw new Error("DRAFT_COMPLETE requires every RR item to be MATCH");
        }
        const report = {
          status: params.status,
          job_wide_blocker: params.jobWideBlocker ?? null,
          completion_reason: params.blockerEvidence ?? "All populated RR domains assessed and verified",
          unresolved_items: params.unresolvedItems,
          real_reads: params.realReads,
          real_writes: params.realWrites,
          accuracy,
          guardrails: {
            published: params.guardrails.published,
            emails_sent: params.guardrails.emailsSent,
            deletes: params.guardrails.deletes,
            global_mutations: params.guardrails.globalMutations,
          },
          updated_at: new Date().toISOString(),
        };
        await atomicJson(join(jobDir, "final-report.json"), report);
        const state = await readJson(join(jobDir, "state.json"), {});
        if (params.status === "REVIEW_REQUIRED") state.status = "review_required";
        if (params.status === "INCOMPLETE") state.status = "incomplete";
        state.current_stage = "final_qa";
        state.current_action = params.status === "DRAFT_COMPLETE" ? "Draft build complete" : params.status.replaceAll("_", " ").toLowerCase();
        state.updated_at = new Date().toISOString();
        await atomicJson(join(jobDir, "state.json"), state);
        await appendActivity(`Final verdict: ${params.status}`);
        return { ...toolText({ ok: true, status: params.status }), terminate: true };
      });
    },
  });
}
