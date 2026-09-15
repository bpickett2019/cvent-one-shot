# Serialized full-RR benchmark controls

Implementation scope: the existing Simple Mode Pi/Ego engine, with pre-dispatch
runaway protection and auditable accounting. No semantic requirement ledger,
custom context eviction, operation scheduler, shared budget pool, API adapter, or
new human-intervention classifier is enabled by this implementation.

## Activation and release gate

Default is **off**. A matching controller and worker release must use:

```text
CVENT_MODEL_BENCHMARK=1
CVENT_EXECUTION_MODE=simple
CVENT_PI_PROVIDER=anthropic
CVENT_PI_MODEL=claude-sonnet-4-6
CVENT_PI_THINKING=high
```

The installed Pi SDK must be **0.84.4**. The guarded launcher uses an in-memory
credential store and the existing Anthropic API key; it does not read/copy OAuth
credentials or refresh model catalogs. Other providers are not benchmark paths.
Inference-based availability probes are disabled, including standalone
`provider_probe.py` when benchmark mode is set. The first admitted request tests
provider availability. Existing native Pi compaction remains enabled/unchanged.

Deploy only a reviewed immutable release, during an idle window, using existing
release/backup procedures. Do not deploy the entire pre-existing dirty worktree.
The release must have a matching `.deployed-git-sha` (or a canonical release
folder named by its Git SHA). An unknown revision cannot admit paid work.
Do not roll back to an unguarded launcher while continuing a benchmark build.
Retain SQLite, sessions, cost records, browser evidence, and uncertainty markers.

Run the offline suite on the selected release:

```sh
bash scripts/test_local_dynamic.sh
```

The suite isolates application data and strips provider credentials. Actual Pi
SDK/launcher tests use fake fetch exclusively, including the real controller
route and native automatic compaction. No browser, service, or paid inference is
started. An absent/wrong installed SDK fails the new launcher tests; skipped
legacy SDK tests do not satisfy the release gate.

## Required benchmark manifest

Before starting a benchmark job, place `benchmark-manifest.json` in its private
job directory. The model cannot create this artifact through its tools. Template
below is intentionally **not** an authorization:

```json
{
  "authorized": false,
  "authorized_by": "REQUIRED_OPERATOR",
  "rr_version": "REQUIRED_WORKBOOK_VERSION",
  "rr_sha256": "REQUIRED_SHA256",
  "target": {
    "event_id": "REQUIRED_EXACT_EVENT_ID",
    "event_key": "REQUIRED_EXACT_EVENT_KEY",
    "event_name": "REQUIRED_EXACT_EVENT_NAME"
  },
  "runtime": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-6",
    "thinking": "high",
    "pi_version": "0.84.4",
    "execution_mode": "simple",
    "pricing_basis": "sonnet-4-6-sdk-0.84.4-standard-5m-v1",
    "revision": "REQUIRED_DEPLOYED_GIT_SHA"
  },
  "workload": "write_heavy_full_rr",
  "remaining_work": ["REQUIRED_SUBSTANTIAL_GENUINE_REMAINING_CONFIGURATION"],
  "starting_state_evidence": {"path": "starting-state.md", "sha256": "REQUIRED_SHA256"},
  "remaining_work_evidence": {"path": "remaining-work.md", "sha256": "REQUIRED_SHA256"},
  "fault_test_evidence": {"path": "release-offline-tests.log", "sha256": "REQUIRED_SHA256"},
  "fault_test_revision": "REQUIRED_DEPLOYED_GIT_SHA",
  "provider_limit_verified": false,
  "provider_limit_evidence": {"path": "provider-backstop.md", "sha256": "REQUIRED_SHA256"}
}
```

All evidence paths must remain inside that job directory, with matching hashes.
Document actual initial configuration and remaining writes, not compiler item
counts. Prefer a BDNY/CGJWS-sized RR with substantial genuine remaining work.
A mostly-configured event is not a write-heavy full-build benchmark.

The operator must verify the provider spending limit's scope/enforcement and the
pricing basis before authorizing. Alerts alone are not a spending backstop. Keep
credentials out of evidence files. Recorded rates are SDK estimates, not invoices:
$3/M fresh input, $0.30/M cache reads, $3.75/M five-minute cache writes, $15/M output.
Reasoning is included in Anthropic output tokens. Unsupported cache TTLs, server
tools, runtime changes, or inconsistent returned pricing fail closed.

## Accounting and pauses

- One active worker and one outstanding paid request. No shared worker allocation.
- A logical build is bound to its canonical event and exact workbook hash.
  Reuploading the same RR/event or starting another session does not reset spend.
  Changed workbooks and untracked historical executions require review; no legacy
  import or automatic new-build reset is provided.
- SQLite records the execution/session, unique physical attempt, purpose,
  provider/model/rate basis, usage, cost, and outstanding state.
- PENDING is durable before dispatch. DISPATCHED is the short admission boundary
  sequenced with browser ownership changes. Once accepted there, a request is
  conservatively in-flight, including the small interval before network I/O.
  Handoff never waits for the long-running provider response.
- USER ownership, pending USER transfer, authentication waiting, or unknown gate
  state denies a new dispatch. Already accepted requests remain accounted for.
- Final usage must agree with the provider's SSE receipt, including its final
  usage update and stream terminator. A truncated stream, missing usage, or
  potentially dispatched crash remains outstanding/UNKNOWN and blocks continuation.
- The next request waits for settlement. SDK-internal retries are disabled;
  Pi-level retries and model-backed compaction use the same guarded runtime.
- $50 cumulative automatic authorization. Warnings are recorded at $25/$40/$45/$50.
  Admission conservatively allows a full input window at cache-write rates plus
  the request's allowed output. Consequently it can pause **before** $50 when
  remaining headroom cannot cover the next request. It never assumes a cache hit.
- Equivalent failures are keyed by normalized blocker and operation/surface,
  independent of volatile refs and unrelated successful reads. Auth/ownership and
  critical safety blockers pause immediately; other equivalent failures pause at
  three. The first benchmark uses conservative operator-reviewed resets, not an
  automatic semantic progress classifier. Resetting a blocker cannot clear Cvent
  mutation uncertainty or unknown financial exposure.

The authoritative counters are available to the job owner/admin at
`GET /api/jobs/{job_id}/model-cost`; bounded cost/warning fields also appear in
`/api/status`. Private `benchmark-cost.json` is updated at settlement/stops.
`token-usage.json` remains a diagnostic legacy counter, not the financial authority.
Unknown usage is explicitly reported, not treated as free consumption.

An authenticated **admin**, with the existing CSRF protection, can explicitly
raise total authorization without resetting cost:

```text
POST /api/jobs/{job_id}/model-allowance
{"allowance_micro":60000000,"reason":"Explicit additional $10 for this RR"}
```

The same narrowly scoped route accepts `resolve_blockers: true` with an evidence-
referenced reason after operator reconciliation. Reviews are recorded in the
existing audit log. Worker model capabilities cannot authorize either action.
There is no automatic allowance increase or refund of unknown usage.

## Evidence and completion

Browser stdout previews are 12 KiB. Full output remains in `ego-output-*.txt` and
complete structured results in `ego-result-*.json`, with unique per-batch names;
`read` supports offset/limit plus chunk pagination, including very long single
lines. No custom history pruning is introduced. Keep existing checkpoint and
full-RR completion behavior. Instructions prefer coherent related work followed
by Save/autosave and value-level persisted readback, stopping on unexpected state.

`benchmark-report.json` combines cumulative request accounting with existing
browser metrics, preview retrieval overhead, ownership timing, and blocker/review
timestamps across executions. Model-active time is an estimate from request wall
time minus recorded human waits, **not** provider compute time. Browser, blocker,
and model timings can overlap and must not be summed as disjoint elapsed time.
Missing telemetry remains explicit. Partial failed-browser action counts may be
unknown; consult preserved browser failure/mutation artifacts rather than inventing
counts or treating intended edits as verified writes.

Independently review every original RR instruction against saved readback evidence,
including requirements not covered by compiler output. Save the review as
`benchmark-independent-review.md`, referencing RR cells and immutable evidence,
verified outcomes, held/unresolved work, and any measurement gaps. The generated
report deliberately does not promote domain attestations into independent proof.

A budget/failure stop is INCOMPLETE; unresolved mutations retain their stronger
uncertain classification. All original event targeting, event leases, ownership,
no-delete/identity-change/publish/send/global-mutation restrictions and Save/readback
protections remain in place. Low cost is not completion. Only a complete, correct,
independently reviewed run is the healthy full-RR baseline.

## Read-only live meter

The existing status poll renders `model_meter`; the same owner/admin projection
is available at `GET /api/jobs/{job_id}/model-meter` (no-store). It reads the
controller accounting, ownership events, performance events and mutation audit;
it performs no inference, budget changes or separate accounting writes.
Unbound legacy jobs show unknown consumption, not $0. The selected staging path
is **Anthropic API key**, not OAuth. Actual invoices and subscription quota are
unknown; neither $0 direct charges nor absent billing data replaces token-derived
consumption. Missing telemetry remains explicitly incomplete. Persisted counters
are existing audit acknowledgments, not independent completion proof. Timing is
observed ownership within registered executions, bounded by last request for
stopped executions; it is not provider compute time or exact end-to-end work time.

## Explicit tiny authentication/accounting diagnostic

Only with operator authorization, run `scripts/benchmark_smoke.py
--allow-paid-no-cvent --output <new-private-directory>` through the existing
staging Key Vault wrapper and selected release Python. It uses the same installed
SDK, model, high reasoning, API-key source, transport guard and SQLite accounting
code; **one** real request has no tools/Cvent access and at most 128 output tokens.
It reopens accounting, deliberately lowers only its isolated synthetic test
allowance, then proves a second request is denied before transport. This is not
a full RR, an alternative worker launch path, production allowance reduction,
provider-limit proof, or invoice reconciliation. Preserve `smoke-evidence.json`
and `after-genuine-response-meter.json`; failures/unknown usage remain explicit.

## Release evidence

A release must preserve its exact commit, selected-runtime offline suite result,
live process/revision proof, authentication diagnostic and verified provider
backstop evidence. This source document itself does not attest deployment or
provider limits. Full-RR authorization remains a separate manifest gate.
