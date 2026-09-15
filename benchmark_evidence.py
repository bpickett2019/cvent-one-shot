"""Small file-based benchmark manifest/report; not a completion database."""
from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime
from pathlib import Path

from benchmark_cost import BenchmarkDenied, MODEL, PI_VERSION, PRICING, PROVIDER


def validate_manifest(directory, job, revision):
    directory = Path(directory)
    try:
        manifest = json.loads((directory / "benchmark-manifest.json").read_text())
        expected = {"provider": PROVIDER, "model": MODEL, "thinking": "high", "pi_version": PI_VERSION,
                    "execution_mode": "simple", "pricing_basis": PRICING, "revision": revision}
        if manifest["runtime"] != expected or not re.fullmatch(r"[0-9a-f]{40}", revision):
            raise ValueError("Runtime pin mismatch")
        if manifest["target"] != {"event_id": job["event_id"], "event_key": job["event_key"], "event_name": job["event_name"]}:
            raise ValueError("Target mismatch")
        if manifest["rr_sha256"] != hashlib.sha256((directory / "input.xlsx").read_bytes()).hexdigest():
            raise ValueError("RR changed")
        if manifest["authorized"] is not True or not manifest["authorized_by"] or not manifest["rr_version"]:
            raise ValueError("Explicit benchmark authorization absent")
        if manifest["workload"] != "write_heavy_full_rr" or not manifest["remaining_work"]:
            raise ValueError("Substantial remaining work must be documented")
        # Operator-supplied evidence, not model assertions or fixture equivalence
        # inferred from compiler item counts. Paths must be private job artifacts.
        for name in ("starting_state_evidence", "remaining_work_evidence", "fault_test_evidence", "provider_limit_evidence"):
            evidence = manifest[name]
            path = (directory / evidence["path"]).resolve()
            if not path.is_relative_to(directory.resolve()) or not path.is_file():
                raise ValueError("Missing job-scoped benchmark evidence")
            if hashlib.sha256(path.read_bytes()).hexdigest() != evidence["sha256"]:
                raise ValueError("Benchmark evidence changed")
        if manifest["fault_test_revision"] != revision or manifest["provider_limit_verified"] is not True:
            raise ValueError("Release/backstop gate not met")
        return manifest
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise BenchmarkDenied("BENCHMARK_MANIFEST_GATE_UNMET") from exc


def _jsonlines(path):
    if not path.exists():
        return []
    # Do not silently drop malformed telemetry in a supposedly trustworthy report.
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def _timestamp(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def write_report(costs, job, directory_for):
    report = costs.snapshot(job["id"])
    jobs = sorted({e["job_id"] for e in report["executions"]})
    metrics = {"browser_execution_ms": 0, "ego_actions": 0, "ego_batches": 0,
               "preview_retrievals": 0, "preview_retrieval_bytes": 0,
               "preview_full_bytes": 0, "preview_delivered_bytes": 0, "human_wait_ms": 0,
               "browser_failure_execution_ms": 0, "model_active_estimate_ms": 0,
               "resolved_blocker_episode_wall_ms": 0, "recorded_model_response_events": 0}
    gaps, artifacts = [], []
    for job_id in jobs:
        execution_job = costs.store.get_job(job_id)
        directory = Path(directory_for(execution_job))
        artifacts.append({"job_id": job_id, "directory": str(directory),
                          "completion_evidence": "final-report.json", "mutation_evidence": "scope-write-audit.jsonl",
                          "independent_review": "benchmark-independent-review.md"})
        try:
            if hashlib.sha256((directory / "input.xlsx").read_bytes()).hexdigest() != report["rr_sha256"]:
                gaps.append(f"{job_id}: RR changed during the benchmark")
            events = _jsonlines(directory / "performance-events.jsonl")
            if not events:
                gaps.append(f"{job_id}: performance telemetry absent")
            for event in events:
                kind, details = event.get("kind"), event
                duration = event.get("durationMs", 0) or 0
                if kind == "anthropic_response" and event.get("totalTokens", 0) > 0:
                    metrics["recorded_model_response_events"] += 1
                if kind in {"browser_operation", "browser_operation_failed"}:
                    metrics["browser_execution_ms"] += duration
                if kind == "browser_operation_failed":
                    metrics["browser_failure_execution_ms"] += duration
                if kind in {"browser_operation", "browser_operation_failed"}:
                    metrics["ego_actions"] += details.get("actionCount", 0) or 0
                    metrics["ego_batches"] += bool(details.get("egoExecutionRound"))
                if kind == "browser_preview_retrieval":
                    metrics["preview_retrievals"] += 1
                    metrics["preview_retrieval_bytes"] += details.get("bytes", 0)
                if kind == "browser_preview":
                    metrics["preview_full_bytes"] += details.get("fullBytes", 0)
                    metrics["preview_delivered_bytes"] += details.get("previewBytes", 0)
            controls = _jsonlines(directory / "model-control-events.jsonl")
            if not controls:
                gaps.append(f"{job_id}: ownership timing absent")
            intervals, waiting = [], None
            executions = [e["id"] for e in report["executions"] if e["job_id"] == job_id]
            requests = [r for r in report["requests"] if r["execution_id"] in executions]
            end = max([_timestamp(r["settled_at"] or r["dispatched_at"] or r["created_at"]) for r in requests] or [0])
            for control in controls:
                at = _timestamp(control["at"])
                paused = control.get("ownership") == "USER" or control.get("desiredOwnership") == "USER" or control.get("authWaiting")
                if paused and waiting is None:
                    waiting = at
                elif not paused and waiting is not None:
                    intervals.append((waiting, at)); waiting = None
                end = max(end, at)
            state = json.loads((directory / "state.json").read_text())
            if state.get("updated_at"):
                end = max(end, _timestamp(state["updated_at"]))
            if waiting is not None:
                intervals.append((waiting, end))
            metrics["human_wait_ms"] += round(sum(b-a for a, b in intervals) * 1000)
            for request in requests:
                if not request["dispatched_at"] or not request["settled_at"]:
                    continue
                start, finish = _timestamp(request["dispatched_at"]), _timestamp(request["settled_at"])
                overlap = sum(max(0, min(finish, b)-max(start, a)) for a, b in intervals)
                metrics["model_active_estimate_ms"] += round(max(0, finish-start-overlap)*1000)
        except (OSError, ValueError, TypeError, KeyError) as exc:
            gaps.append(f"{job_id}: incomplete telemetry ({type(exc).__name__})")
    expected_responses = sum(r["state"] == "SETTLED" and r["purpose"] != "compaction" for r in report["requests"])
    if metrics["recorded_model_response_events"] != expected_responses:
        gaps.append("Model response telemetry does not reconcile with settled ordinary/retry requests")
    for review in report["operator_reviews"]:
        if review["action"] == "benchmark.blockers_reviewed":
            metrics["resolved_blocker_episode_wall_ms"] += round(sum(
                max(0, _timestamp(review["at"]) - _timestamp(episode["first_at"]))
                for episode in review["details"]["blockers"]) * 1000)
    report.update({"execution_metrics": metrics, "telemetry_gaps": gaps, "job_artifacts": artifacts,
        "timing_basis": "Model active estimate is request wall time excluding recorded human waits, not provider compute time. Browser/failure time can overlap and must not be summed as disjoint latency.",
        "completion_status": "INDEPENDENT_FULL_RR_REVIEW_REQUIRED",
        "blocker_recovery_evidence": "Blocker episodes include first/last failure and operator resolution timestamps. Episode wall times overlap other activity; unresolved episodes remain explicit. Review active recovery work independently.",
        "verified_outcomes": "Review all original RR instructions against persisted readback evidence; model domain attestations alone are not independent completion proof."})
    return report
