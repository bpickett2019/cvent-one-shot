"""Serialized Anthropic benchmark accounting. No shared pools or semantic ledger.

Controller-owned SQLite records are the accounting authority. Unknown usage never
becomes zero; a dispatched request survives worker/controller crashes. This is an
API estimate, not a billing guarantee. Only explicit operator actions raise limits.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import uuid
from decimal import Decimal, ROUND_CEILING
from pathlib import Path
from urllib.parse import urlsplit

from control_store import iso
from model_failures import normalize_blocker

PROVIDER = "anthropic"
MODEL = "claude-sonnet-5"
PI_VERSION = "0.84.4"
PRICING = "sonnet-5-sdk-0.84.4-standard-5m-v1"
RATES = {"input": Decimal("2"), "cacheRead": Decimal("0.2"),
         "cacheWrite": Decimal("2.5"), "output": Decimal("10")}
INITIAL_ALLOWANCE = 50_000_000
FAILURE_BOUND = 3


class BenchmarkDenied(RuntimeError):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def enabled():
    return os.environ.get("CVENT_MODEL_BENCHMARK") == "1"


def validate_configuration():
    from runtime_config import pi_model, pi_provider
    if (pi_provider(), pi_model(), os.environ.get("CVENT_PI_THINKING", "high"),
            os.environ.get("CVENT_EXECUTION_MODE")) != (PROVIDER, MODEL, "high", "simple"):
        raise BenchmarkDenied("BENCHMARK_RUNTIME_PIN_MISMATCH")


def integer(value, maximum=10**12):
    if type(value) is not int or not 0 <= value <= maximum:
        raise ValueError("Expected bounded nonnegative integer")
    return value


def identifier(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,160}", value):
        raise ValueError("Invalid identifier")
    return value


def charge(usage):
    if not isinstance(usage, dict) or set(usage) != {*RATES, "totalTokens"}:
        raise ValueError("Missing usage is not zero")
    for value in usage.values():
        integer(value)
    if usage["totalTokens"] != sum(usage[k] for k in RATES) or not usage["totalTokens"]:
        raise ValueError("Invalid or synthetic usage")
    # USD/million tokens is numerically micro-USD/token. Reasoning is included in
    # Anthropic output_tokens; it is NOT an additional separately billable bucket.
    return int(sum(usage[k] * rate for k, rate in RATES.items()).to_integral_value(rounding=ROUND_CEILING))


class BenchmarkCost:
    def __init__(self, store):
        self.store = store
        with store.connect() as conn:
            conn.executescript("""
            CREATE TABLE IF NOT EXISTS benchmark_builds (
                id TEXT PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, workspace_id TEXT NOT NULL,
                rr_sha256 TEXT NOT NULL, allowance_micro INTEGER NOT NULL,
                pause_code TEXT, created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS benchmark_jobs (
                job_id TEXT PRIMARY KEY REFERENCES jobs(id),
                build_id TEXT NOT NULL REFERENCES benchmark_builds(id)
            );
            CREATE TABLE IF NOT EXISTS benchmark_executions (
                id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES benchmark_jobs(job_id),
                session_id TEXT NOT NULL, revision TEXT NOT NULL, started_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS benchmark_requests (
                id TEXT PRIMARY KEY, execution_id TEXT NOT NULL REFERENCES benchmark_executions(id),
                build_id TEXT NOT NULL REFERENCES benchmark_builds(id), purpose TEXT NOT NULL,
                provider TEXT NOT NULL, model TEXT NOT NULL, pricing TEXT NOT NULL,
                upper_micro INTEGER NOT NULL, state TEXT NOT NULL,
                usage_json TEXT, cost_micro INTEGER, sdk_cost_micro INTEGER,
                created_at TEXT NOT NULL, dispatched_at TEXT, settled_at TEXT,
                duration_ms INTEGER, stop_reason TEXT
            );
            CREATE TABLE IF NOT EXISTS benchmark_blockers (
                build_id TEXT NOT NULL REFERENCES benchmark_builds(id), scope TEXT NOT NULL,
                blocker TEXT NOT NULL, count INTEGER NOT NULL, first_at TEXT NOT NULL,
                last_at TEXT NOT NULL, PRIMARY KEY(build_id,scope,blocker)
            );
            """)

    def bind(self, job, directory):
        digest = hashlib.sha256((Path(directory) / "input.xlsx").read_bytes()).hexdigest()
        with self.store.immediate() as conn:
            old = conn.execute("SELECT b.* FROM benchmark_jobs j JOIN benchmark_builds b ON b.id=j.build_id WHERE j.job_id=?", (job["id"],)).fetchone()
            if old:
                if old["rr_sha256"] != digest or old["event_id"] != job["event_id"]:
                    raise BenchmarkDenied("BUILD_BINDING_CHANGED")
                return old["id"]
            # No legacy migration in this release. A previously run untracked job
            # cannot be made free by enrolling it as a new benchmark execution.
            if job.get("started_at") or list((Path(directory) / "pi-sessions").glob("*.jsonl")) or (Path(directory) / "provider-probe.json").exists():
                raise BenchmarkDenied("UNTRACKED_LEGACY_EXECUTION")
            build = conn.execute("SELECT * FROM benchmark_builds WHERE event_id=?", (job["event_id"],)).fetchone()
            if build and build["workspace_id"] != job["workspace_id"]:
                raise BenchmarkDenied("BUILD_OWNERSHIP_MISMATCH")
            if build and build["rr_sha256"] != digest:
                raise BenchmarkDenied("RR_REVISION_REQUIRES_REVIEW")
            build_id = build["id"] if build else "rr_" + uuid.uuid4().hex
            if not build:
                conn.execute("INSERT INTO benchmark_builds VALUES(?,?,?,?,?,NULL,?)", (build_id, job["event_id"], job["workspace_id"], digest, INITIAL_ALLOWANCE, iso()))
            conn.execute("INSERT INTO benchmark_jobs VALUES(?,?)", (job["id"], build_id))
            self.store._audit(conn, "system", "benchmark.bound", job["id"], {"build_id": build_id, "rr_sha256": digest})
            return build_id

    @staticmethod
    def build_for(conn, job_id):
        row = conn.execute("SELECT b.* FROM benchmark_jobs j JOIN benchmark_builds b ON b.id=j.build_id WHERE j.job_id=?", (job_id,)).fetchone()
        if not row:
            raise BenchmarkDenied("UNBOUND_BUILD")
        return row

    def register_execution(self, job_id, execution_id, session_id, revision):
        for value in (execution_id, session_id):
            identifier(value)
        if not re.fullmatch(r"[0-9a-f]{40}", revision):
            raise BenchmarkDenied("DEPLOYED_REVISION_UNKNOWN")
        with self.store.immediate() as conn:
            build = self.build_for(conn, job_id)
            if conn.execute("SELECT 1 FROM benchmark_requests WHERE state IN ('PENDING','DISPATCHED','UNKNOWN')").fetchone():
                raise BenchmarkDenied("OUTSTANDING_USAGE")
            if build["pause_code"]:
                raise BenchmarkDenied(build["pause_code"])
            old = conn.execute("SELECT * FROM benchmark_executions WHERE id=?", (execution_id,)).fetchone()
            if old:
                if (old["job_id"], old["session_id"], old["revision"]) != (job_id, session_id, revision):
                    raise BenchmarkDenied("EXECUTION_BINDING_CHANGED")
            else:
                conn.execute("INSERT INTO benchmark_executions VALUES(?,?,?,?,?)", (execution_id, job_id, session_id, revision, iso()))
            return dict(build)

    @staticmethod
    def ready(conn, job, token, directory):
        # Strict read: BrowserGate.read's legacy default must never authorize paid work.
        try:
            gate = json.loads((Path(directory) / "browser-gate.json").read_text())
            state = json.loads((Path(directory) / "state.json").read_text())
        except (OSError, ValueError):
            raise BenchmarkDenied("CONTROL_STATE_UNKNOWN")
        if gate.get("ownership") != "AGENT" or gate.get("desiredOwnership") != "AGENT" or gate.get("agentPaused"):
            raise BenchmarkDenied("MODEL_PAUSED_USER")
        if gate.get("transition") or gate.get("authWaiting") or state.get("status") == "login_required":
            raise BenchmarkDenied("MODEL_PAUSED_AUTH")
        workers = conn.execute("SELECT * FROM worker_leases").fetchall()
        if len(workers) != 1 or workers[0]["holder_job_id"] != job["id"] or workers[0]["token"] != token or workers[0]["expires_at"] <= iso():
            raise BenchmarkDenied("BENCHMARK_NOT_EXCLUSIVE")
        if not conn.execute("SELECT 1 FROM event_leases WHERE holder_job_id=? AND token=? AND event_id=? AND expires_at>?", (job["id"], token, job["event_id"], iso())).fetchone():
            raise BenchmarkDenied("LEASE_LOST")
        live = conn.execute("SELECT state FROM jobs WHERE id=?", (job["id"],)).fetchone()
        if not live or live[0] not in {"starting", "running"}:
            raise BenchmarkDenied("JOB_STOPPED")
        build = BenchmarkCost.build_for(conn, job["id"])
        if build["pause_code"]:
            raise BenchmarkDenied(build["pause_code"])
        return build

    def reserve(self, job, token, directory, execution_id, meta):
        identifier(meta["id"])
        if (meta["provider"], meta["model"], meta["pricingVersion"]) != (PROVIDER, MODEL, PRICING):
            raise BenchmarkDenied("PRICING_OR_MODEL_MISMATCH")
        if meta["purpose"] not in {"configuration", "compaction", "retry"}:
            raise BenchmarkDenied("AUXILIARY_INFERENCE_DISABLED")
        upper = integer(meta["upperMicro"], 8_000_000)
        if not upper:
            raise ValueError("Positive request bound required")
        from browser_gate import model_control_lock
        with model_control_lock(directory), self.store.immediate() as conn:
            build = self.ready(conn, job, token, directory)
            if not conn.execute("SELECT 1 FROM benchmark_executions WHERE id=? AND job_id=?", (execution_id, job["id"])).fetchone():
                raise BenchmarkDenied("EXECUTION_BINDING_CHANGED")
            if conn.execute("SELECT 1 FROM benchmark_requests WHERE state IN ('PENDING','DISPATCHED','UNKNOWN')").fetchone():
                raise BenchmarkDenied("OUTSTANDING_USAGE")
            spent = conn.execute("SELECT COALESCE(SUM(cost_micro),0) FROM benchmark_requests WHERE build_id=?", (build["id"],)).fetchone()[0]
            if spent + upper > build["allowance_micro"]:
                raise BenchmarkDenied("BUILD_ALLOWANCE_HEADROOM")
            conn.execute("""INSERT INTO benchmark_requests(id,execution_id,build_id,purpose,provider,model,pricing,upper_micro,state,created_at)
                VALUES(?,?,?,?,?,?,?,?,'PENDING',?)""", (meta["id"], execution_id, build["id"], meta["purpose"], PROVIDER, MODEL, PRICING, upper, iso()))

    @staticmethod
    def request(conn, execution_id, request_id):
        row = conn.execute("SELECT * FROM benchmark_requests WHERE id=? AND execution_id=?", (request_id, execution_id)).fetchone()
        if not row:
            raise BenchmarkDenied("REQUEST_BINDING_MISMATCH")
        return row

    def begin_dispatch(self, job, token, directory, execution_id, request_id):
        from browser_gate import model_control_lock
        with model_control_lock(directory), self.store.immediate() as conn:
            self.ready(conn, job, token, directory)
            row = self.request(conn, execution_id, request_id)
            if row["state"] != "PENDING":
                raise BenchmarkDenied("REQUEST_ALREADY_DISPATCHED")
            # This is the dispatch linearization point, sequenced with gate writes.
            # It is conservatively in-flight even if transport/process dies next.
            conn.execute("UPDATE benchmark_requests SET state='DISPATCHED',dispatched_at=? WHERE id=?", (iso(), request_id))

    def terminal(self, execution_id, request_id, state):
        with self.store.immediate() as conn:
            row = self.request(conn, execution_id, request_id)
            if row["state"] == state or row["state"] == "SETTLED":
                return
            if (state, row["state"]) not in {("CANCELLED", "PENDING"), ("UNKNOWN", "DISPATCHED")}:
                raise BenchmarkDenied("CANNOT_REFUND_POSSIBLE_DISPATCH")
            conn.execute("UPDATE benchmark_requests SET state=? WHERE id=?", (state, request_id))

    def settle(self, execution_id, request_id, data):
        cost = charge(data["usage"])
        sdk_cost = integer(data["costMicro"])
        duration = integer(data.get("durationMs", 0))
        reason = data.get("stopReason", "unknown")
        if reason not in {"stop", "length", "toolUse", "error", "aborted", "unknown"}:
            raise ValueError("Invalid completion reason")
        encoded = json.dumps(data["usage"], sort_keys=True)
        with self.store.immediate() as conn:
            row = self.request(conn, execution_id, request_id)
            if row["state"] == "SETTLED":
                if row["usage_json"] != encoded or row["sdk_cost_micro"] != sdk_cost:
                    raise ValueError("Conflicting duplicate usage")
                return
            if row["state"] not in {"DISPATCHED", "UNKNOWN"}:
                raise ValueError("Request was not dispatched")
            # Preserve the larger estimate if pricing disagrees; never hide spend.
            conn.execute("UPDATE benchmark_requests SET state='SETTLED',usage_json=?,cost_micro=?,sdk_cost_micro=?,settled_at=?,duration_ms=?,stop_reason=? WHERE id=?", (encoded, max(cost, sdk_cost), sdk_cost, iso(), duration, reason, request_id))
            if abs(cost - sdk_cost) > 1 or max(cost, sdk_cost) > row["upper_micro"]:
                conn.execute("UPDATE benchmark_builds SET pause_code='PRICING_RECONCILIATION_REQUIRED' WHERE id=?", (row["build_id"],))

    def failure(self, job_id, operation, surface, message):
        identifier(operation)
        # Only route class + operation survive, never auth queries, refs or errors.
        route = urlsplit(str(surface)).path.lower() or "unknown"
        route = re.sub(r"[0-9a-f]{8}-[0-9a-f-]{20,}|\b\d+\b", ":id", route)
        scope = hashlib.sha256((operation + "\0" + route).encode()).hexdigest()
        blocker = normalize_blocker(message)
        immediate = blocker in {"USER_OWNERSHIP", "AUTH_REQUIRED", "LEASE_LOST", "WRONG_EVENT", "PERSISTENCE_UNCERTAIN", "PROVIDER_UNAVAILABLE"}
        with self.store.immediate() as conn:
            build = self.build_for(conn, job_id)
            conn.execute("""INSERT INTO benchmark_blockers VALUES(?,?,?,1,?,?) ON CONFLICT(build_id,scope,blocker)
                DO UPDATE SET count=count+1,last_at=excluded.last_at""", (build["id"], scope, blocker, iso(), iso()))
            count = conn.execute("SELECT count FROM benchmark_blockers WHERE build_id=? AND scope=? AND blocker=?", (build["id"], scope, blocker)).fetchone()[0]
            if immediate or count >= FAILURE_BOUND:
                conn.execute("UPDATE benchmark_builds SET pause_code=? WHERE id=?", ("BLOCKER_" + blocker, build["id"]))
            return {"blocker": blocker, "scope": scope, "count": count, "paused": immediate or count >= FAILURE_BOUND}

    def approve(self, job_id, *, actor, is_admin, allowance_micro=None, resolve_blockers=False, reason):
        if not is_admin:
            raise PermissionError("Operator approval required")
        if not isinstance(reason, str) or not 1 <= len(reason.strip()) <= 1000:
            raise ValueError("Approval reason required")
        with self.store.immediate() as conn:
            build = self.build_for(conn, job_id)
            if allowance_micro is not None:
                integer(allowance_micro)
                if allowance_micro <= build["allowance_micro"]:
                    raise ValueError("Allowance must increase; usage cannot be reset")
                conn.execute("UPDATE benchmark_builds SET allowance_micro=? WHERE id=?", (allowance_micro, build["id"]))
            if resolve_blockers:
                if build["pause_code"] and not build["pause_code"].startswith("BLOCKER_"):
                    raise BenchmarkDenied("FINANCIAL_RECONCILIATION_REQUIRED")
                self.store._audit(conn, actor, "benchmark.blockers_reviewed", job_id, {"blockers": [dict(r) for r in conn.execute("SELECT * FROM benchmark_blockers WHERE build_id=?", (build["id"],))], "reason": reason})
                conn.execute("DELETE FROM benchmark_blockers WHERE build_id=?", (build["id"],))
                conn.execute("UPDATE benchmark_builds SET pause_code=NULL WHERE id=?", (build["id"],))
            self.store._audit(conn, actor, "benchmark.allowance_reviewed", job_id, {"build_id": build["id"], "old_micro": build["allowance_micro"], "new_micro": allowance_micro, "reason": reason})
        return self.snapshot(job_id)

    def snapshot(self, job_id):
        with self.store.immediate() as conn:
            build = dict(self.build_for(conn, job_id))
            requests = [dict(r) for r in conn.execute("SELECT * FROM benchmark_requests WHERE build_id=? ORDER BY created_at", (build["id"],))]
            executions = [dict(r) for r in conn.execute("SELECT e.* FROM benchmark_executions e JOIN benchmark_jobs j ON e.job_id=j.job_id WHERE j.build_id=?", (build["id"],))]
            blockers = [dict(r) for r in conn.execute("SELECT * FROM benchmark_blockers WHERE build_id=?", (build["id"],))]
            approvals = [dict(r) for r in conn.execute("SELECT a.at,a.actor_subject,a.action,a.details_json FROM audit_log a JOIN benchmark_jobs j ON a.job_id=j.job_id WHERE j.build_id=? AND a.action IN ('benchmark.allowance_reviewed','benchmark.blockers_reviewed') ORDER BY a.id", (build["id"],))]
        totals = {k: 0 for k in [*RATES, "totalTokens"]}
        contexts = []
        for row in requests:
            usage = json.loads(row.pop("usage_json")) if row["usage_json"] else None
            row["usage"] = usage
            if usage:
                for k in totals:
                    totals[k] += usage[k]
                contexts.append(usage["input"] + usage["cacheRead"] + usage["cacheWrite"])
        contexts.sort()
        spent = sum(r["cost_micro"] or 0 for r in requests)
        outstanding = [r["id"] for r in requests if r["state"] in {"PENDING", "DISPATCHED", "UNKNOWN"}]
        return {"logical_build_id": build["id"], "rr_sha256": build["rr_sha256"], "event_id": build["event_id"],
                "accounting_basis": PRICING + "; API estimate, not invoice; reasoning included in output",
                "allowance_micro": build["allowance_micro"], "cumulative_cost_micro": spent,
                "warnings": [v for v in (25, 40, 45, 50) if spent >= v * 1_000_000],
                "pause_code": build["pause_code"], "outstanding_requests": outstanding,
                "unresolved_exposure_upper_micro": sum(r["upper_micro"] for r in requests if r["id"] in outstanding),
                "blocker_episodes": blockers,
                "operator_reviews": [{**{k: r[k] for k in ('at', 'actor_subject', 'action')}, "details": json.loads(r['details_json'])} for r in approvals],
                "accounting_complete": not outstanding, "tokens": totals,
                "physical_attempts": sum(r["dispatched_at"] is not None for r in requests),
                "model_responses": sum(r["state"] == "SETTLED" for r in requests),
                "purpose_counts": {p: sum(r["purpose"] == p and r["dispatched_at"] is not None for r in requests) for p in ("configuration", "retry", "compaction", "probe")},
                "context_tokens": {"median": (contexts[(len(contexts)-1)//2] + contexts[len(contexts)//2]) / 2 if contexts else None,
                                   "p95": contexts[math.ceil(len(contexts)*.95)-1] if contexts else None,
                                   "max": max(contexts) if contexts else None},
                "model_request_wall_ms": sum(r["duration_ms"] or 0 for r in requests),
                "executions": executions, "requests": requests}
