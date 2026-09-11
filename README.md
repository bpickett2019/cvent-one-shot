# CVENT Agent

Forge CVENT Agent production V1 supports Microsoft Entra authentication and up
to three simultaneous, isolated jobs on one Azure VM. Users can access only
their own workspaces/jobs; administrators receive all-job and lease visibility.

Each active job has its own Pi process/session/config, pinned Steel container,
Chromium profile/cache, API/CDP endpoints, BrowserRuntime, Ego process calls,
BrowserActionGate, authenticated viewer, files, logs, evidence, and report.
SQLite/WAL provides crash-safe host-wide worker and canonical Cvent event leases.
Jobs for different approved events can use all three workers. A same-event job
or a fourth simultaneous job is rejected immediately with HTTP 409 and remains
safely restartable; V1 has no waiting queue.

Pi is explicitly configured as `anthropic/claude-sonnet-4-6`. The Anthropic key
is read only from `ANTHROPIC_API_KEY`; Azure production loads it from Key Vault
with a VM managed identity. No API key is accepted in the UI, source, Terraform
variables, or process command line.

## Local development

```bash
cd /Users/bp/cvent-one-shot
python3 -m pip install -r requirements.txt
npm ci
export CVENT_ENV=development
export CVENT_DEV_AUTH_SUBJECT=local-operator
export CVENT_DEV_AUTH_NAME='Local operator'
export CVENT_DEV_AUTH_ADMIN=1
export ANTHROPIC_API_KEY='<load from your secret manager>'
python3 -m uvicorn app:app --host 127.0.0.1 --port 8877
```

Open <http://127.0.0.1:8877>. Docker must be running. Local development auth is
explicit and cannot activate when `CVENT_ENV=production`.

Development uses a non-Cvent placeholder allowlist entry. Staging and production
must receive explicitly authorized existing events through the deployment's
server-side allowlist; RR uploads never choose or authorize arbitrary Cvent
targets.

## RR → Pi → Ego → Steel.dev

The runtime intentionally follows one direct path:

1. The operator selects an authorized existing Cvent event and uploads an `.xlsx` RR.
2. The isolated Pi agent reads that workbook directly with the literal workbook reader.
3. Pi loads the bundled `ego-browser` skill.
4. The skill operates the job's existing Steel.dev Chromium profile and configures Cvent.
5. Pi saves and reads values back in Cvent, then reports completion or specific unresolved items.

There is no RR compiler, validator, generated execution contract, fixed field map,
or application-owned section executor in the live path. Pi interprets workbook
context and discovers the current Cvent controls through Ego.

The server still isolates each user/job/profile, reserves one worker and one
canonical event lease, and binds the Steel target before Pi starts. The operator
viewer is shielded while Pi owns the browser. Login handoff reuses the same
persistent profile for SSO/MFA. The controlling prompt forbids event creation or
renaming, publish/Go Live, communication sends, deletion/archive, attendee/contact
access, and account-global mutations.

## Validation

```bash
npm test
python3 -m compileall -q .
docker compose --profile manual config
```

The manual Compose profile exposes the same three localhost-only diagnostic slot
pairs used by the app: `3005/9334`, `3006/9335`, and `3007/9336`. Normally the
application creates/removes the pinned Steel containers dynamically so each
container mounts only its active job's private profile.

## Azure deployment

See [`docs/PRODUCTION-V1.md`](docs/PRODUCTION-V1.md) and
[`infra/terraform`](infra/terraform). The design intentionally does not use AKS,
Service Bus, or a distributed database until measured pilot demand justifies a
scale-out architecture.

The audited pre-refactor map is in
[`docs/CURRENT-STATE-AUDIT.md`](docs/CURRENT-STATE-AUDIT.md). Performance notes
are in [`docs/PERFORMANCE-NOTES.md`](docs/PERFORMANCE-NOTES.md). Complete
section-level state collection and fresh targeted verification after each saved
configuration group remain mandatory; repeated full-page snapshots are not.
