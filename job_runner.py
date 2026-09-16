"""Immediate three-slot admission and isolated Pi/Steel lifecycle."""
from __future__ import annotations

import hashlib
import json
import os
import re
import signal
import subprocess
import sys
import threading
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from browser_gate import BrowserGate
from browser_runtime import initialize as initialize_browser_runtime
from control_store import ControlStore
from performance_monitor import monitor as monitor_performance
from mutation_outcome import mutation_outcome
from runtime_config import DATA_ROOT, ROOT, AuthorizedEvent, browser_cache_dir, browser_profile_dir, job_dir, pi_model, pi_provider, slot_by_id
from telemetry_report import write_telemetry_report
from benchmark_cost import BenchmarkCost, enabled as benchmark_enabled, validate_configuration
from benchmark_runtime import sdk_environment
from benchmark_evidence import validate_manifest, write_report as benchmark_report


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def read_json(path: Path, default: Any):
    try:
        return json.loads(path.read_text())
    except Exception:
        return default


def atomic_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(data, indent=2, ensure_ascii=False))
    temporary.replace(path)


def append_log(directory: Path, message: str) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / "activity.log").open("a") as output:
        output.write(f"{now()}  {message.strip()}\n")


def classify_process_outcome(code: int, report_status: str, reported_state: str,
                             writes_exist: bool, writes_unresolved: bool, provider_failure: str | None) -> tuple[str, bool, str | None]:
    """Map a completed agent process to a durable fail-closed job outcome."""
    if writes_unresolved:
        return "failed_uncertain", True, (provider_failure + "; " if provider_failure else "") + "Job has an unresolved Cvent mutation; global replay is blocked pending readback/review"
    if code == 0 and report_status == "DRAFT_COMPLETE":
        return "completed", False, None
    if code == 0 and report_status == "REVIEW_REQUIRED":
        return "review_required", False, None
    if reported_state == "login_required" and not writes_unresolved:
        return "login_required", False, None
    uncertain = writes_unresolved
    finish_state = "failed_uncertain" if uncertain else ("failed_recoverable" if writes_exist else "failed_prewrite")
    outcome = (
        "job has an unresolved Cvent write attempt; mutation outcome requires review"
        if uncertain else ("all attempted Cvent writes were conclusively read back; reacquire leases and recompute the remaining delta"
                           if writes_exist else "no Cvent write was attempted; a fresh preflight is required")
    )
    error = f"{provider_failure}; {outcome}" if provider_failure else f"CVENT Agent exited with code {code}; {outcome}"
    return finish_state, uncertain, error


def stopped_job_action(state: str, error: str | None) -> str:
    if error:
        return error
    if state == "login_required":
        return "Agent stopped waiting for login; worker released. Continue this job to reopen the browser and sign in."
    return "Draft build complete" if state == "completed" else "Review required"


class UploadTooLarge(ValueError):
    pass


def fresh_state(job: dict[str, Any]) -> dict[str, Any]:
    return {
        "job_id": job["id"], "workspace_id": job["workspace_id"], "status": job["state"],
        "current_stage": "upload", "current_action": "RR uploaded; ready to start",
        "completed": [], "pending": [
            "target_discovery", "event_settings", "site_designer", "registration_paths",
            "registration_types", "admission_items", "optional_items", "pricing",
            "discounts_vouchers", "questions", "sessions", "integrations", "communications",
            "badges_onsite", "associations", "final_qa",
        ],
        "review_required": [], "rr_file": job["original_filename"], "run_mode": "mock",
        "authorized_event_name": job["event_name"], "authorized_event_id": job["event_id"],
        "authorized_event_key": job["event_key"], "target_url": "", "target_identity": job["event_name"],
        "started_at": None, "process_started_at": None, "last_run_seconds": 0,
        "updated_at": now(), "pi_pid": None, "pi_session": None, "worker_slot": None,
    }


@dataclass
class ActiveJob:
    job_id: str
    token: str
    slot_id: int
    stop_heartbeat: threading.Event
    process: subprocess.Popen | None = None
    output: Any = None
    model_token: str | None = None
    execution_id: str | None = None


class JobRunner:
    def __init__(self, store: ControlStore):
        self.store = store
        self._lock = threading.RLock()
        self._active: dict[str, ActiveJob] = {}
        self._shutdown = threading.Event()
        self.benchmark = BenchmarkCost(store) if benchmark_enabled() else None

    def start_scheduler(self) -> list[str]:
        interrupted = [job for job in self.store.list_jobs(limit=1000) if job["state"] in {"starting", "running", "stopping"}]
        for job in interrupted:
            pid = job.get("pid")
            if isinstance(pid, int) and self._is_pi_process(pid):
                self._stop_process_tree(pid)
        recovered = self.store.recover_after_controller_restart()
        for job_id in recovered:
            job = self.store.get_job(job_id)
            if not job:
                continue
            directory = job_dir(job["workspace_id"], job_id)
            state = read_json(directory / "state.json", fresh_state(job))
            state.update({
                "status": job["state"], "current_action": job.get("error") or "Fresh preflight required",
                "pi_pid": None, "process_started_at": None, "worker_slot": None, "updated_at": now(),
            })
            atomic_json(directory / "state.json", state)
            append_log(directory, f"Controller recovery classified job as {job['state']}")
        legacy_queued = self.store.cancel_legacy_queued_jobs()
        for job_id in legacy_queued:
            job = self.store.get_job(job_id)
            if not job:
                continue
            directory = job_dir(job["workspace_id"], job_id)
            state = read_json(directory / "state.json", fresh_state(job))
            state.update({
                "status": "cancelled", "current_stage": "cancelled",
                "current_action": job.get("error") or "Start this job again explicitly",
                "pi_pid": None, "process_started_at": None, "worker_slot": None, "updated_at": now(),
            })
            atomic_json(directory / "state.json", state)
            append_log(directory, "Legacy waiting job cancelled; explicit restart required")
        # Containers may outlive a hard controller crash. Remove only named slot
        # containers; job profiles and evidence remain untouched for review.
        for slot_id in range(1, self.store.slots + 1):
            subprocess.run(
                ["docker", "rm", "-f", slot_by_id(slot_id).container_name],
                text=True, capture_output=True, timeout=30,
            )
        return recovered + legacy_queued

    def shutdown(self) -> None:
        self._shutdown.set()
        with self._lock:
            jobs = list(self._active)
        for job_id in jobs:
            self.stop(job_id, "system", uncertain=True)

    def create_files(self, job: dict[str, Any], upload, max_bytes: int = 25 * 1024 * 1024) -> Path:
        directory = job_dir(job["workspace_id"], job["id"])
        directory.mkdir(parents=True, exist_ok=False)
        os.chmod(directory, 0o700)
        total = 0
        with (directory / "input.xlsx").open("wb") as output:
            while True:
                chunk = upload.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > max_bytes:
                    raise UploadTooLarge("RR workbook exceeds the upload limit")
                output.write(chunk)
        atomic_json(directory / "state.json", fresh_state(job))
        atomic_json(directory / "final-report.json", {
            "status": "INCOMPLETE", "unresolved_items": ["Build not started"],
            "real_reads": [], "real_writes": [],
            "guardrails": {"published": 0, "emails_sent": 0, "deletes": 0, "global_mutations": 0},
            "updated_at": now(),
        })
        (directory / "activity.log").touch()
        BrowserGate(directory).initialize()
        append_log(directory, f"Uploaded RR workbook: {job['original_filename']}")
        return directory

    def environment(self, job: dict[str, Any], token: str, slot_id: int) -> dict[str, str]:
        directory = job_dir(job["workspace_id"], job["id"])
        slot = slot_by_id(slot_id)
        environment = os.environ.copy()
        environment.update({
            "CVENT_REPO_ROOT": str(ROOT), "CVENT_DATA_ROOT": str(DATA_ROOT), "CVENT_JOB_DIR": str(directory), "CVENT_JOB_ID": job["id"],
            "CVENT_WORKSPACE_ID": job["workspace_id"], "CVENT_WORKER_SLOT": str(slot_id),
            "CVENT_BROWSER_PROFILE_DIR": str(browser_profile_dir(job["workspace_id"], slot_id)),
            "CVENT_BROWSER_CACHE_DIR": str(browser_cache_dir(job["workspace_id"], slot_id)),
            "CVENT_STEEL_API_ORIGIN": slot.api_origin, "CVENT_CDP_ORIGIN": slot.cdp_origin,
            "CVENT_VIEWER_URL": f"/api/jobs/{job['id']}/viewer",
            "CVENT_LEASE_VALIDATE_URL": os.environ.get("CVENT_LEASE_VALIDATE_URL", "http://127.0.0.1:8877/internal/leases/validate"),
            "CVENT_LEASE_TOKEN": token, "CVENT_AUTHORIZED_EVENT_ID": job["event_id"],
            "CVENT_AUTHORIZED_EVENT_NAME": job["event_name"], "CVENT_AUTHORIZED_EVENT_KEY": job["event_key"],
            "CVENT_AUTHORIZED_EVENT_CODE": str(job.get("event_code") or ""),
            "CVENT_PI_PROVIDER": pi_provider(), "CVENT_PI_MODEL": pi_model(),
            "CVENT_EXECUTION_MODE": os.environ.get("CVENT_EXECUTION_MODE", "controlled"),
            "CVENT_PYTHON": sys.executable,
            "CVENT_USAGE_GUARD_ENABLED": "1",  # This controller understands usage-stop markers.
            "PI_CODING_AGENT_DIR": str(directory / "pi-config"), "PI_CODING_AGENT_SESSION_DIR": str(directory / "pi-sessions"),
            "PI_SKIP_VERSION_CHECK": "1", "PI_TELEMETRY": "0",
        })
        return environment

    def pi_environment(self, job: dict[str, Any], token: str, slot_id: int) -> dict[str, str]:
        """Give Pi only its provider key and job capabilities, never app auth secrets."""
        environment = self.environment(job, token, slot_id)
        for name in (
            "ENTRA_CLIENT_SECRET", "CVENT_SESSION_SECRET", "AZURE_CLIENT_SECRET",
            "AZURE_CLIENT_CERTIFICATE_PATH", "AZURE_FEDERATED_TOKEN_FILE",
        ):
            environment.pop(name, None)
        if benchmark_enabled():
            validate_configuration()
            active = self.active(job["id"])
            if not active or not active.model_token or not active.execution_id:
                raise RuntimeError("Benchmark admission capability is absent")
            environment.update(sdk_environment())
            environment.update({
                "CVENT_MODEL_ADMISSION_URL": "http://127.0.0.1:8877/internal/model-benchmark",
                "CVENT_MODEL_TOKEN": active.model_token,
                "CVENT_MODEL_EXECUTION_ID": active.execution_id,
                "CVENT_PI_THINKING": "high",
            })
            for key in list(environment):
                if key.endswith("API_KEY") and key != "ANTHROPIC_API_KEY":
                    environment.pop(key)
        return environment

    def prepare_environment(self, job: dict[str, Any], slot_id: int) -> dict[str, str]:
        """Give deterministic RR helpers only non-secret job identity and fixed paths."""
        environment = {
            name: os.environ[name] for name in ("PATH", "LANG", "LC_ALL", "TZ") if os.environ.get(name)
        }
        environment.update({
            "CVENT_REPO_ROOT": str(ROOT),
            "CVENT_JOB_DIR": str(job_dir(job["workspace_id"], job["id"])),
            "CVENT_JOB_ID": job["id"],
            "CVENT_WORKSPACE_ID": job["workspace_id"],
            "CVENT_WORKER_SLOT": str(slot_id),
            "CVENT_AUTHORIZED_EVENT_ID": job["event_id"],
            "CVENT_AUTHORIZED_EVENT_NAME": job["event_name"],
            "CVENT_AUTHORIZED_EVENT_KEY": job["event_key"],
            "CVENT_AUTHORIZED_EVENT_CODE": str(job.get("event_code") or ""),
        })
        return environment

    def verify_provider_access(self, directory: Path) -> dict[str, Any]:
        """Fail before Steel/Cvent if the selected provider cannot serve a bounded probe."""
        provider, model = pi_provider(), pi_model()
        if benchmark_enabled():
            validate_configuration()
            sdk_environment()
            if not os.environ.get("ANTHROPIC_API_KEY"):
                raise RuntimeError("Benchmark Anthropic API key is absent")
            # No untracked inference before ownership/runtime initialization. The
            # first guarded request establishes availability; no probe is needed.
            return {"ok": True, "classification": "credential_present_not_probed", "durationMs": 0,
                    "scope": "No inference probe in serialized benchmark"}
        cache = read_json(directory / "provider-probe.json", {})
        try:
            checked = datetime.fromisoformat(cache.get("checkedAt", ""))
            if (cache.get("ok") and cache.get("provider") == provider and cache.get("model") == model
                    and 0 <= (datetime.now(timezone.utc) - checked).total_seconds() < 600):
                return cache
        except Exception:
            pass
        environment = {name: os.environ[name] for name in ("PATH", "LANG", "LC_ALL", "TZ") if os.environ.get(name)}
        environment["CVENT_PI_MODEL"] = model
        environment["ANTHROPIC_API_KEY"] = os.environ.get("ANTHROPIC_API_KEY", "")
        command = [sys.executable, str(ROOT / "provider_probe.py")]
        cwd, timeout = ROOT, 30
        scope = "One-token Anthropic availability probe; not a remaining-credit balance check"
        started = time.monotonic()
        try:
            completed = subprocess.run(command, cwd=cwd, env=environment,
                                       text=True, capture_output=True, timeout=timeout)
        except (subprocess.TimeoutExpired, OSError) as exc:
            atomic_json(directory / "provider-probe.json", {
                "ok": False, "classification": "probe_unavailable", "provider": provider,
                "model": model, "checkedAt": now(), "errorType": type(exc).__name__,
            })
            raise RuntimeError(f"{provider} preflight failed: probe_unavailable") from exc
        try:
            result = json.loads((completed.stdout or "{}").splitlines()[-1])
        except Exception:
            result = {"ok": False, "classification": "invalid_probe_result"}
        if not isinstance(result, dict):
            result = {"ok": False, "classification": "invalid_probe_result"}
        result.update({"checkedAt": now(), "durationMs": round((time.monotonic() - started) * 1000, 1),
                       "provider": provider, "model": model, "scope": scope})
        atomic_json(directory / "provider-probe.json", result)
        if completed.returncode or not result.get("ok"):
            raise RuntimeError(f"{provider} preflight failed: {result.get('classification', 'unavailable')}")
        return result

    def prepare_rr(self, job: dict[str, Any], slot_id: int) -> dict[str, Any]:
        """Load literal workbook evidence; compiled hints are optional in Simple Mode."""
        directory = job_dir(job["workspace_id"], job["id"])
        workbook = directory / "input.xlsx"
        inspection = directory / "input.inspection.json"
        environment = self.prepare_environment(job, slot_id)
        commands = (
            ("rr_load_inspection", [sys.executable, str(ROOT / "inspect_rr.py"), str(workbook), str(inspection)]),
            ("rr_extraction", [sys.executable, str(ROOT / "rr_compiler.py")]),
            ("rr_validation_and_planning", [sys.executable, str(ROOT / "rr_validator.py")]),
        )
        completed = None
        timings = []
        preflight_started = time.monotonic()
        simple = os.environ.get("CVENT_EXECUTION_MODE") == "simple"

        def original_only(reason: str) -> dict[str, Any]:
            # Never feed stale/wrong-event compiler output to Pi; retain it as
            # diagnostic evidence rather than destroying artifacts on resume.
            archive = directory / "compiler-diagnostics" / uuid.uuid4().hex
            for name in ("expected-domains.json", "rr-validation.json", "configuration-plan.json"):
                source = directory / name
                if source.exists():
                    archive.mkdir(parents=True, exist_ok=True)
                    source.rename(archive / name)
            atomic_json(directory / "preflight-performance.json", {
                "stages": timings, "totalMs": round((time.monotonic() - preflight_started) * 1000, 1),
                "source": "original_workbook", "compilerWarning": reason,
            })
            append_log(directory, "Optional RR compiler unavailable; Pi will use original sheet/cell evidence: " + reason)
            return {}

        for stage, command_line in commands:
            started = time.monotonic()
            try:
                completed = subprocess.run(
                    command_line, cwd=ROOT, env=environment, text=True, capture_output=True, timeout=180,
                )
            except (subprocess.TimeoutExpired, OSError) as exc:
                timings.append({"stage": stage, "durationMs": round((time.monotonic() - started) * 1000, 1)})
                if simple and stage != "rr_load_inspection":
                    return original_only(f"{stage}: {type(exc).__name__}")
                raise RuntimeError(f"RR preflight failed at {stage}: {type(exc).__name__}") from exc
            timings.append({"stage": stage, "durationMs": round((time.monotonic() - started) * 1000, 1)})
            if completed.returncode:
                detail = (completed.stderr or completed.stdout).strip().splitlines()
                reason = detail[-1] if detail else "approved helper failed"
                if simple and stage != "rr_load_inspection":
                    return original_only(reason)
                raise RuntimeError("RR preflight failed: " + reason)
        expected = read_json(directory / "expected-domains.json", {})
        validation = read_json(directory / "rr-validation.json", {})
        plan = read_json(directory / "configuration-plan.json", {})
        if (
            not all(isinstance(value, dict) for value in (expected, validation, plan))
            or not isinstance(expected.get("rr"), dict)
            or not isinstance(expected.get("target"), dict)
            or not isinstance(plan.get("target"), dict)
        ):
            if simple:
                return original_only("RR compiler produced malformed expectations")
            raise RuntimeError("RR preflight produced malformed expectations")
        atomic_json(directory / "preflight-performance.json", {
            "stages": timings, "totalMs": round((time.monotonic() - preflight_started) * 1000, 1),
            "validationCounts": validation.get("counts", {}),
        })
        if (
            not expected
            or expected.get("rr", {}).get("sha256") != hashlib.sha256(workbook.read_bytes()).hexdigest()
            or expected.get("rr", {}).get("authority") != "uploaded_rr"
            or expected.get("target", {}).get("eventId") != job["event_id"]
            or expected.get("target", {}).get("eventKey") != job["event_key"]
            or expected.get("target", {}).get("name") != job["event_name"]
            or validation.get("rrSha256") != expected.get("rr", {}).get("sha256")
            or plan.get("rrSha256") != expected.get("rr", {}).get("sha256")
            or plan.get("target", {}).get("eventId") != job["event_id"]
        ):
            if simple:
                return original_only("RR preflight produced stale or mismatched expectations")
            raise RuntimeError("RR preflight produced stale or mismatched expectations")
        return expected

    def steel_command(self, job: dict[str, Any], token: str, slot_id: int, command: str,
                      url: str | None = None, timeout: int = 180) -> dict[str, Any]:
        args = [sys.executable, str(ROOT / "steel_session.py"), command]
        if url:
            args += ["--url", url]
        result = subprocess.run(
            args, cwd=ROOT, env=self.environment(job, token, slot_id), text=True,
            capture_output=True, timeout=timeout,
        )
        data = next(
            (json.loads(line.split("=", 1)[1]) for line in reversed(result.stdout.splitlines())
             if line.startswith("STEEL_RESULT=")), None,
        )
        if data is None:
            data = {"provider": "steel-oss", "running": False, "error": (result.stderr or result.stdout)[-1200:]}
        if result.returncode and not data.get("error"):
            data["error"] = f"Steel command exited {result.returncode}"
        return data

    def start(self, job_id: str, actor: str) -> dict[str, Any]:
        """Reserve capacity now and launch; reject busy events/slots immediately."""
        if benchmark_enabled():
            validate_configuration()
            sdk_environment()
            candidate = self.store.get_job(job_id)
            if not candidate or self.benchmark is None:
                raise ValueError("Benchmark controller must be loaded with matching guard configuration")
            directory = job_dir(candidate["workspace_id"], job_id)
            try:
                revision = (ROOT / ".deployed-git-sha").read_text().strip()
            except OSError:
                revision = ROOT.name
            validate_manifest(directory, candidate, revision)
            self.benchmark.bind(candidate, directory)
        lease = self.store.reserve_now(job_id, actor, serialized=benchmark_enabled())
        job = self.store.get_job(job_id)
        if not job:
            raise ValueError("Job not found")
        active = ActiveJob(job_id, lease["token"], lease["slot_id"], threading.Event())
        if benchmark_enabled():
            active.model_token = uuid.uuid4().hex + uuid.uuid4().hex
            active.execution_id = "execution_" + uuid.uuid4().hex
        with self._lock:
            self._active[job_id] = active
        directory = job_dir(job["workspace_id"], job_id)
        state = read_json(directory / "state.json", fresh_state(job))
        try:
            deployed_sha = (ROOT / ".deployed-git-sha").read_text().strip()
        except OSError:
            deployed_sha = ROOT.name if re.fullmatch(r"[0-9a-f]{40}", ROOT.name) else "unknown"
        state.update({
            "status": "starting", "current_stage": "starting",
            "current_action": f"Starting isolated worker {lease['slot_id']}",
            "worker_slot": lease["slot_id"], "deployed_sha": deployed_sha, "updated_at": now(),
        })
        atomic_json(directory / "state.json", state)
        append_log(directory, f"Immediately reserved worker {lease['slot_id']} and canonical event lease")
        threading.Thread(target=self._heartbeat, args=(active,), daemon=True).start()
        threading.Thread(target=self._launch, args=(job, active), daemon=True).start()
        return lease

    def _heartbeat(self, active: ActiveJob) -> None:
        interval = max(1, self.store.lease_seconds // 3)
        while not active.stop_heartbeat.wait(interval):
            if not self.store.heartbeat(active.job_id, active.token):
                process = active.process
                if process and process.poll() is None:
                    self._stop_process_tree(process.pid)
                return

    def _launch(self, job: dict[str, Any], active: ActiveJob) -> None:
        directory = job_dir(job["workspace_id"], job["id"])
        threading.Thread(target=monitor_performance, args=(directory / "system-metrics.jsonl", active.stop_heartbeat, [
            DATA_ROOT, directory, directory / "input.xlsx", browser_profile_dir(job["workspace_id"], active.slot_id),
            browser_cache_dir(job["workspace_id"], active.slot_id), Path("/tmp"),
        ]), daemon=True).start()
        try:
            state = read_json(directory / "state.json", fresh_state(job))
            state.update({
                "status": "starting", "current_stage": "starting", "current_action": "Compiling and verifying the current RR",
                "worker_slot": active.slot_id, "started_at": state.get("started_at") or now(), "updated_at": now(),
            })
            atomic_json(directory / "state.json", state)
            state.update({"current_action": f"Verifying {pi_provider()}/{pi_model()} access before Cvent", "updated_at": now(),
                          "model_provider": pi_provider(), "model_id": pi_model()})
            atomic_json(directory / "state.json", state)
            provider = self.verify_provider_access(directory)
            append_log(directory, f"{pi_provider()}/{pi_model()} access probe passed in {provider.get('durationMs', 0)} ms")
            state.update({"current_action": "Compiling and verifying the current RR", "updated_at": now()})
            atomic_json(directory / "state.json", state)
            expected = self.prepare_rr(job, active.slot_id)
            append_log(directory, f"RR preflight compiled {expected.get('counts', {}).get('applicableFields', 0)} writable configuration fields")
            state.update({"current_action": "Starting isolated Steel browser", "updated_at": now()})
            atomic_json(directory / "state.json", state)
            append_log(directory, f"Acquired worker {active.slot_id} and event lease {job['event_id']}")
            steel = self.steel_command(job, active.token, active.slot_id, "ensure")
            if not steel.get("running"):
                raise RuntimeError(steel.get("error") or "Steel failed to start")
            runtime = initialize_browser_runtime(
                directory, active.slot_id, job["event_name"], job["event_id"], job["event_key"],
                f"/api/jobs/{job['id']}/viewer",
                profile_path=browser_profile_dir(job["workspace_id"], active.slot_id),
            )
            runtime['executionMode'] = os.environ.get('CVENT_EXECUTION_MODE', 'controlled')
            atomic_json(directory / 'browser-runtime.json', runtime)
            BrowserGate(directory).initialize()
            prompt = self.render_prompt(job, directory, runtime)
            self._write_pi_settings(directory)
            sessions = directory / "pi-sessions"
            sessions.mkdir(parents=True, exist_ok=True)
            command_line = self.pi_command(job, directory, state, prompt)
            output = open(directory / "pi-output.log", "a", buffering=1)
            process = subprocess.Popen(
                command_line, cwd=directory, env=self.pi_environment(job, active.token, active.slot_id),
                stdout=output, stderr=subprocess.STDOUT, text=True, start_new_session=True,
            )
            active.process = process
            active.output = output
            if not self.store.mark_running(job["id"], active.token, process.pid):
                self._stop_process_tree(process.pid)
                raise RuntimeError("Lease was lost before Pi started")
            state.update({
                "status": "running", "current_stage": "starting", "current_action": "CVENT Agent is starting",
                "pi_pid": process.pid, "process_started_at": now(), "resume_requested": False, "updated_at": now(),
            })
            atomic_json(directory / "state.json", state)
            append_log(directory, f"Started isolated {pi_provider()}/{pi_model()} Pi process PID {process.pid} on worker {active.slot_id}")
            self._monitor(job, active)
        except Exception as exc:
            append_log(directory, f"Worker launch failed closed: {type(exc).__name__}: {exc}")
            try:
                self.steel_command(job, active.token, active.slot_id, "release", timeout=60)
            except Exception:
                pass
            try:
                outcome = mutation_outcome(directory)
                failure_state = "failed_uncertain" if outcome["unresolved"] else ("failed_recoverable" if outcome["hasAttempts"] else "failed_prewrite")
                self._finish_after_lease_loss(job["id"], active.token, failure_state, str(exc), outcome["unresolved"])
            except Exception:
                pass
            state = read_json(directory / "state.json", fresh_state(job))
            persisted = self.store.get_job(job["id"])
            failed_state = persisted["state"] if persisted else "failed"
            state.update({"status": failed_state, "current_action": f"Worker launch failed: {exc}", "pi_pid": None, "updated_at": now()})
            atomic_json(directory / "state.json", state)
            try:
                write_telemetry_report(directory, persisted or job, ROOT)
            except Exception as report_error:
                append_log(directory, f"Persisted telemetry report generation failed: {type(report_error).__name__}: {report_error}")
            self._remove_active(active)

    def _monitor(self, job: dict[str, Any], active: ActiveJob) -> None:
        process = active.process
        assert process is not None
        code = process.wait()
        if active.output:
            active.output.close()
        directory = job_dir(job["workspace_id"], job["id"])
        state = read_json(directory / "state.json", fresh_state(job))
        sessions = sorted((directory / "pi-sessions").glob("*.jsonl"), key=lambda path: path.stat().st_mtime, reverse=True)
        if sessions:
            state["pi_session"] = str(sessions[0])
        report = read_json(directory / "final-report.json", {})
        report_status = str(report.get("status", "")).upper()
        reported_state = str(state.get("status", "")).lower()
        outcome = mutation_outcome(directory)
        writes_exist = outcome["hasAttempts"]
        provider_failure = self._provider_failure(directory)
        controller_failure = read_json(directory / f"controller-failure-{process.pid}.json", {})
        usage_stop = read_json(directory / f"usage-budget-stop-{process.pid}.json", {})
        if benchmark_enabled():
            admission_stop = read_json(directory / f"model-admission-stop-{process.pid}.json", {})
            if admission_stop:
                usage_stop = admission_stop
            try:
                snapshot = self.benchmark.snapshot(job["id"])
                atomic_json(directory / "benchmark-cost.json", snapshot)
                if not snapshot["accounting_complete"] or snapshot["pause_code"]:
                    usage_stop = {"reason": snapshot["pause_code"] or "OUTSTANDING_USAGE"}
            except Exception:
                usage_stop = {"reason": "BENCHMARK_ACCOUNTING_UNAVAILABLE"}
        first_browser_failure = read_json(directory / f"first-browser-failure-{process.pid}.json", {})
        stop_request = read_json(directory / f"stop-request-{process.pid}.json", {})
        reasons = [provider_failure] if provider_failure else []
        if report_status == "INCOMPLETE":
            final_report = read_json(directory / "final-report.json", {})
            reasons.append(final_report.get("completion_reason") or "; ".join(final_report.get("unresolved_items", [])) or "Agent exited without completing the RR")
        if stop_request:
            reasons.append(f"Stop requested by {stop_request['actor']} at {stop_request['at']} (PID {process.pid})")
        if controller_failure or (code != 0 and first_browser_failure):
            first = controller_failure.get("first") or first_browser_failure
            reasons.append(f"First browser failure during {first.get('operation', 'unknown')}: {first.get('message', '')}")
            if controller_failure:
                reasons.append(f"Runtime recovery stopped: {controller_failure.get('message', '')}")
                # A terminating tool returns process code 0, but is not a successful build.
                code, report_status, reported_state = 1, "", ""
        if usage_stop:
            reasons.append("Usage checkpoint: " + str(usage_stop.get("reason", "operator approval required")))
            code, report_status, reported_state = 1, "", ""
        finish_state, uncertain, error = classify_process_outcome(
            code, report_status, reported_state, writes_exist, outcome["unresolved"], "; ".join(reasons) or None,
        )
        report_path = directory / "final-report.json"
        final_report = read_json(report_path, {})
        if finish_state.startswith("failed_") and (usage_stop or not final_report.get("completion_reason")):
            final_report.update({"status": "INCOMPLETE", "completion_reason": error,
                                 "unresolved_items": [error] if error else ["Agent stopped before final verification"],
                                 "job_wide_blocker": "uncertain_mutation" if uncertain else ("usage_budget" if usage_stop else "provider_unavailable" if provider_failure else "browser_runtime_failure" if controller_failure else "process_exit"),
                                 "reported_by": "controller", "updated_at": now()})
            atomic_json(report_path, final_report)
        try:
            self.steel_command(job, active.token, active.slot_id, "release", timeout=60)
        finally:
            self._finish_after_lease_loss(job["id"], active.token, finish_state, error, uncertain)
        persisted = self.store.get_job(job["id"])
        if persisted:
            finish_state = persisted["state"]
            uncertain = bool(persisted["uncertain"])
            error = persisted.get("error") or error
        if state.get("process_started_at"):
            try:
                elapsed = datetime.now(timezone.utc) - datetime.fromisoformat(state["process_started_at"])
                state["last_run_seconds"] = max(0, int(elapsed.total_seconds()))
            except Exception:
                pass
        state.update({
            "status": finish_state, "current_action": stopped_job_action(finish_state, error),
            "pi_pid": None, "last_process_started_at": state.get("process_started_at"), "process_started_at": None,
            "worker_slot": None, "updated_at": now(),
        })
        atomic_json(directory / "state.json", state)
        active.stop_heartbeat.set()
        try:
            subprocess.run([sys.executable, str(ROOT / "performance_report.py"), str(directory)], cwd=ROOT,
                           env=self.prepare_environment(job, active.slot_id), capture_output=True, text=True, timeout=30)
        except Exception:
            pass
        try:
            write_telemetry_report(directory, self.store.get_job(job["id"]) or job, ROOT)
        except Exception as report_error:
            append_log(directory, f"Persisted telemetry report generation failed: {type(report_error).__name__}: {report_error}")
        if self.benchmark is not None:
            try:
                atomic_json(directory / "benchmark-report.json", benchmark_report(self.benchmark, job,
                    lambda item: job_dir(item["workspace_id"], item["id"])))
            except Exception as exc:
                append_log(directory, f"Benchmark report unavailable: {type(exc).__name__}; measurement gate remains unmet")
        append_log(directory, f"Released worker {active.slot_id} and event lease; job state is {finish_state}")
        self._remove_active(active)

    def stop(self, job_id: str, actor: str, uncertain: bool = True) -> None:
        with self._lock:
            active = self._active.get(job_id)
        if not active:
            raise ValueError("Job is not running")
        job = self.store.get_job(job_id)
        process = active.process
        if process and process.poll() is None:
            requested = {"actor": actor, "at": now(), "pid": process.pid, "reason": "explicit_stop_request"}
            atomic_json(job_dir(job["workspace_id"], job_id) / f"stop-request-{process.pid}.json", requested)
            self.store.audit(actor, "job.stop_requested", job_id, requested)
            append_log(job_dir(job["workspace_id"], job_id), f"Stop requested by {actor}; terminating Pi PID {process.pid}")
            self._stop_process_tree(process.pid)
        # Monitor owns canonical teardown once a Pi process exists.
        if process:
            return
        self.steel_command(job, active.token, active.slot_id, "release", timeout=60)
        outcome = mutation_outcome(job_dir(job["workspace_id"], job_id))
        state = "failed_uncertain" if outcome["unresolved"] else ("failed_recoverable" if outcome["hasAttempts"] else "failed_prewrite")
        self._finish_after_lease_loss(
            job_id, active.token, state,
            "Stopped with an unresolved Cvent write" if outcome["unresolved"] else ("Stopped after prior writes were conclusively read back; recompute delta" if outcome["hasAttempts"] else "Stopped before any Cvent write attempt; fresh preflight required"),
            outcome["unresolved"],
        )
        self._remove_active(active)

    def resume(self, job_id: str, actor: str) -> None:
        job = self.store.get_job(job_id)
        if not job:
            raise ValueError("Job not found")
        directory = job_dir(job["workspace_id"], job_id)
        state = read_json(directory / "state.json", fresh_state(job))
        state["resume_requested"] = True
        atomic_json(directory / "state.json", state)
        self.start(job_id, actor)

    def retry_recoverable(self, job_id: str, actor: str) -> None:
        """Start fresh after verified writes when no mutation outcome is unresolved."""
        job = self.store.get_job(job_id)
        if not job or job["state"] != "failed_recoverable" or job.get("uncertain"):
            raise ValueError("Only a certain recoverable job can be resumed")
        directory = job_dir(job["workspace_id"], job_id)
        if mutation_outcome(directory)["unresolved"]:
            raise ValueError("Resume blocked because a Cvent mutation outcome is unresolved")
        state = read_json(directory / "state.json", fresh_state(job))
        state.update({"resume_requested": False, "pi_session": None, "current_stage": "starting",
                      "current_action": "Reacquiring leases, rechecking auth/event identity, and recomputing the current delta"})
        atomic_json(directory / "state.json", state)
        self.start(job_id, actor)

    def retry_prewrite(self, job_id: str, actor: str) -> None:
        """Start a fresh agent session after a proven zero-write failure."""
        job = self.store.get_job(job_id)
        if not job or job["state"] != "failed_prewrite" or job.get("uncertain"):
            raise ValueError("Only a certain failed-prewrite job can receive a fresh retry")
        directory = job_dir(job["workspace_id"], job_id)
        if self._mutation_attempted(directory):
            raise ValueError("Fresh retry blocked because Cvent mutation evidence exists")
        state = read_json(directory / "state.json", fresh_state(job))
        state["resume_requested"] = False
        state["pi_session"] = None
        state["completed"] = []
        state["current_stage"] = "starting"
        state["current_action"] = "Starting fresh preflight after a verified zero-write failure"
        atomic_json(directory / "state.json", state)
        self.start(job_id, actor)

    def active(self, job_id: str) -> ActiveJob | None:
        with self._lock:
            return self._active.get(job_id)

    def pi_command(self, job: dict[str, Any], directory: Path, state: dict[str, Any], prompt: str) -> list[str]:
        sessions = directory / "pi-sessions"
        capability_tools = "read,bash,cvent_open_event,cvent_login_handoff,cvent_job_update,cvent_finish" if os.environ.get('CVENT_EXECUTION_MODE') == 'simple' else (
            "read,bash,cvent_prepare_rr,cvent_expectations,cvent_plan,cvent_job_read,"
            "cvent_job_update,cvent_record_domain,cvent_verify_domain,cvent_browser,cvent_section_state,cvent_execute_section,cvent_login_handoff,"
            "cvent_snapshot_chunk,cvent_finish"
        )
        command_line = [
            "pi", "-p", "--mode", "json", "--approve", "--provider", pi_provider(), "--model", pi_model(),
            "--thinking", os.environ.get("CVENT_PI_THINKING", "high"),
            "--no-extensions", "--extension", str(ROOT / "extensions/cvent-job-tools.ts"),
            "--no-skills",
            *(["--system-prompt", str(ROOT / "PI_SIMPLE_SYSTEM_PROMPT.md")] if os.environ.get('CVENT_EXECUTION_MODE') == 'simple'
              else ["--skill", str(ROOT / "skills/ego-browser/SKILL.md")]),
            "--no-prompt-templates", "--no-context-files", "--no-builtin-tools",
            "--tools", capability_tools,
            "--session-dir", str(sessions), "--name", f"cvent-{job['id']}",
        ]
        if benchmark_enabled():
            command_line = ["node", str(ROOT / "scripts/run_pi_guarded.mjs"), "--job"]
        if state.get("resume_requested") is True:
            session_files = sorted(sessions.glob("*.jsonl"), key=lambda path: path.stat().st_mtime, reverse=True)
            if not session_files:
                raise RuntimeError("No saved Pi session is available to continue")
            command_line += ["--session", str(session_files[0]),
                             "Re-read and obey this complete controlling job prompt, then continue idempotently without replaying completed work:\n\n" + prompt]
        else:
            command_line.append(prompt)
        return command_line

    def render_prompt(self, job: dict[str, Any], directory: Path, runtime: dict[str, Any]) -> str:
        workspace_root = directory.parent.parent if directory.parent.name == "jobs" else directory.parent
        hold_source = workspace_root / "event-holds" / (re.sub(r"[^A-Za-z0-9._-]", "_", job["event_key"]) + ".json")
        holds: list[dict[str, Any]] = []
        if hold_source.exists():
            document = json.loads(hold_source.read_text())
            if document.get("eventKey") != job["event_key"] or not isinstance(document.get("holds"), list):
                raise RuntimeError("Event replay-hold evidence is malformed or belongs to another event")
            for hold in document["holds"]:
                if not isinstance(hold, dict) or hold.get("automaticReplayPermitted") is not False or not hold.get("domain") or not hold.get("identity"):
                    raise RuntimeError("Event replay-hold entry is malformed")
                holds.append(hold)
            atomic_json(directory / "replay-holds.json", {"schemaVersion": 1, "eventKey": job["event_key"], "holds": holds})
        hold_lines = [
            f'- `{hold["domain"]}` exact {hold.get("identityType", "identity")} `{hold["identity"]}`: '
            f'{hold.get("outcome", "MATCH_UNCERTAIN_HUMAN_REVIEW")}; automatic replay is forbidden. '
            "Read it if needed, but do not mutate any property of this held object."
            for hold in holds
        ]
        replay_holds = "\n".join(hold_lines) if hold_lines else "- None."
        coverage_counts: dict[str, int] = {}
        for item in read_json(directory / "rr-validation.json", {}).get("items", []):
            domain = str(item.get("domain", "")).strip() if isinstance(item, dict) else ""
            if domain:
                coverage_counts[domain] = coverage_counts.get(domain, 0) + 1
        coverage_domains = "\n".join(f"- `{domain}`: {count} RR evidence items" for domain, count in coverage_counts.items())
        if not coverage_domains:
            coverage_domains = "- Optional compiler unavailable; derive the complete checklist directly from the original RR."
        values = {
            "RR_PATH": str((directory / "input.xlsx").resolve()),
            "REPLAY_HOLDS": replay_holds,
            "COVERAGE_DOMAINS": coverage_domains,
            "TARGET_URL": f"DISCOVER EXACTLY {job['event_name']} — THE RR MUST NOT SELECT THE TARGET",
            "STATE_PATH": str((directory / "state.json").resolve()), "LOG_PATH": str((directory / "activity.log").resolve()),
            "REPORT_PATH": str((directory / "final-report.json").resolve()),
            "AUTH_SETTINGS_PATH": str((directory / "auth-settings.json").resolve()),
            "BROWSER_RUNTIME_PATH": str((directory / "browser-runtime.json").resolve()),
            "BROWSER_TOOL_PATH": str((ROOT / "browser_tool.py").resolve()),
            "CAPABILITY_EXTENSION_PATH": str((ROOT / "extensions/cvent-job-tools.ts").resolve()),
            "JOB_DIR": str(directory.resolve()),
            "AUTHORIZED_EVENT_NAME": job["event_name"], "AUTHORIZED_EVENT_ID": job["event_id"],
            "AUTHORIZED_EVENT_KEY": job["event_key"],
        }
        text = (ROOT / ("PI_SIMPLE_PROMPT.md" if os.environ.get("CVENT_EXECUTION_MODE") == "simple" else "PI_PROMPT.md")).read_text()
        for key, value in values.items():
            text = text.replace("{{" + key + "}}", value)
        unresolved = re.findall(r"{{[A-Z0-9_]+}}", text)
        if unresolved:
            raise RuntimeError("Unresolved prompt variables: " + ", ".join(unresolved))
        (directory / "job-prompt.md").write_text(text)
        return text

    @staticmethod
    def _write_pi_settings(directory: Path) -> None:
        config = directory / "pi-config"
        config.mkdir(parents=True, exist_ok=True)
        atomic_json(config / "settings.json", {
            "defaultProvider": pi_provider(), "defaultModel": pi_model(),
            "defaultThinkingLevel": os.environ.get("CVENT_PI_THINKING", "high"),
            "defaultProjectTrust": "never", "enableInstallTelemetry": False,
            "retry": {
                "enabled": True, "maxRetries": 3, "baseDelayMs": 2000,
                "provider": {"timeoutMs": 3600000, "maxRetries": 0, "maxRetryDelayMs": 60000},
            },
        })

    def _finish_after_lease_loss(self, job_id: str, token: str, state: str,
                                 error: str | None, uncertain: bool) -> None:
        try:
            self.store.finish(job_id, token, state, error, uncertain)
        except PermissionError:
            # Expiration recovery may already have removed this exact job's
            # leases. Never touch another holder; tokenless cleanup is keyed by
            # this job ID and preserves the fail-closed terminal outcome.
            recovered = self.store.get_job(job_id)
            recovered_uncertain = bool(recovered and recovered.get("uncertain"))
            final_state = "failed_uncertain" if recovered_uncertain else state
            self.store.finish(job_id, None, final_state, error, uncertain or recovered_uncertain)

    def _remove_active(self, active: ActiveJob) -> None:
        active.stop_heartbeat.set()
        with self._lock:
            self._active.pop(active.job_id, None)

    @staticmethod
    def _provider_failure(directory: Path) -> str | None:
        output = directory / "pi-output.log"
        if not output.exists():
            return None
        with output.open("rb") as handle:
            handle.seek(max(0, output.stat().st_size - 128 * 1024))
            text = handle.read().decode(errors="replace").lower()
        if "credit balance is too low" in text:
            return "Anthropic API credit balance is too low"
        if "rate_limit_error" in text or "rate limit" in text or "status 429" in text:
            return f"{pi_provider()} rate limit prevented the agent from continuing"
        if "authentication_error" in text or "invalid x-api-key" in text:
            return "Anthropic API authentication failed"
        return None

    @staticmethod
    def _mutation_attempted(directory: Path) -> bool:
        audit = directory / "scope-write-audit.jsonl"
        uncertain = directory / "browser-mutation-uncertain.json"
        return uncertain.exists() or (audit.exists() and audit.stat().st_size > 0)

    @staticmethod
    def _is_pi_process(pid: int) -> bool:
        try:
            command = subprocess.check_output(["ps", "-p", str(pid), "-o", "command="], text=True).strip()
            return bool(command and (re.search(r"(^|/)pi(?:\s|$)", command)
                                     or str(ROOT / "scripts/run_pi_guarded.mjs") in command))
        except Exception:
            return False

    @staticmethod
    def _stop_process_tree(pid: int) -> None:
        try:
            os.killpg(pid, signal.SIGTERM)
        except ProcessLookupError:
            return
        for _ in range(20):
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                return
            time.sleep(0.1)
        try:
            os.killpg(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
