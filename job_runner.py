"""Immediate three-slot admission and isolated Pi/Steel lifecycle."""
from __future__ import annotations

import json
import os
import re
import signal
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from browser_gate import BrowserGate
from browser_runtime import initialize as initialize_browser_runtime
from control_store import ControlStore
from performance_monitor import monitor as monitor_performance
from mutation_outcome import mutation_outcome
from runtime_config import DATA_ROOT, ROOT, AuthorizedEvent, browser_cache_dir, browser_profile_dir, event_by_id, job_dir, pi_model, pi_provider, slot_by_id


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


def bind_ego_runtime_environment(environment: dict[str, str], runtime: dict[str, Any]) -> None:
    """Bind Ego to the exact canonical target and marker created by browser_runtime.initialize."""
    runtime_id = runtime.get("browserRuntimeId")
    target_id = (runtime.get("targetBrowserIdentity") or {}).get("targetId")
    if not runtime_id or not target_id:
        raise RuntimeError("Canonical BrowserRuntime is missing Ego target identity")
    environment["CVENT_BROWSER_RUNTIME_ID"] = str(runtime_id)
    environment["CVENT_BROWSER_TARGET_ID"] = str(target_id)


def append_log(directory: Path, message: str) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / "activity.log").open("a") as output:
        output.write(f"{now()}  {message.strip()}\n")


def classify_process_outcome(code: int, report_status: str, reported_state: str,
                             writes_exist: bool, writes_unresolved: bool, provider_failure: str | None) -> tuple[str, bool, str | None]:
    """Map a completed agent process to a durable fail-closed job outcome."""
    if code == 0 and report_status == "DRAFT_COMPLETE":
        return "completed", False, None
    if code == 0 and (report_status in {"REVIEW_REQUIRED", "INCOMPLETE"} or reported_state == "review_required"):
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


class JobRunner:
    def __init__(self, store: ControlStore):
        self.store = store
        self._lock = threading.RLock()
        self._active: dict[str, ActiveJob] = {}
        self._shutdown = threading.Event()

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
            "EGO_BROWSER_CDP_HOST": slot.cdp_origin.split("://", 1)[-1].split(":", 1)[0],
            "EGO_BROWSER_CDP_PORT": slot.cdp_origin.rsplit(":", 1)[-1],
            "CVENT_VIEWER_URL": f"/api/jobs/{job['id']}/viewer",
            "CVENT_LEASE_VALIDATE_URL": os.environ.get("CVENT_LEASE_VALIDATE_URL", "http://127.0.0.1:8877/internal/leases/validate"),
            "CVENT_LEASE_TOKEN": token, "CVENT_AUTHORIZED_EVENT_ID": job["event_id"],
            "CVENT_AUTHORIZED_EVENT_NAME": job["event_name"], "CVENT_AUTHORIZED_EVENT_KEY": job["event_key"],
            "CVENT_AUTHORIZED_EVENT_CODE": event_by_id(job["event_id"]).event_code,
            "CVENT_PI_PROVIDER": pi_provider(), "CVENT_PI_MODEL": pi_model(),
            "CVENT_PYTHON": sys.executable,
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
        return environment

    def verify_provider_access(self, directory: Path) -> dict[str, Any]:
        """Fail before Steel/Cvent when the approved Anthropic account cannot serve even one token."""
        cache = read_json(directory / "provider-probe.json", {})
        try:
            checked = datetime.fromisoformat(cache.get("checkedAt", ""))
            if cache.get("ok") and (datetime.now(timezone.utc) - checked).total_seconds() < 600:
                return cache
        except Exception:
            pass
        environment = {name: os.environ[name] for name in ("PATH", "LANG", "LC_ALL", "TZ") if os.environ.get(name)}
        environment["ANTHROPIC_API_KEY"] = os.environ.get("ANTHROPIC_API_KEY", "")
        environment["CVENT_PI_MODEL"] = pi_model()
        started = time.monotonic()
        completed = subprocess.run([sys.executable, str(ROOT / "provider_probe.py")], cwd=ROOT, env=environment,
                                   text=True, capture_output=True, timeout=30)
        try:
            result = json.loads((completed.stdout or "{}").splitlines()[-1])
        except Exception:
            result = {"ok": False, "classification": "invalid_probe_result"}
        result.update({"checkedAt": now(), "durationMs": round((time.monotonic() - started) * 1000, 1),
                       "scope": "one-token availability probe; Anthropic exposes no approved remaining-credit balance endpoint"})
        atomic_json(directory / "provider-probe.json", result)
        if completed.returncode or not result.get("ok"):
            raise RuntimeError(f"Anthropic preflight failed: {result.get('classification', 'unavailable')}")
        return result

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
        lease = self.store.reserve_now(job_id, actor)
        job = self.store.get_job(job_id)
        if not job:
            raise ValueError("Job not found")
        active = ActiveJob(job_id, lease["token"], lease["slot_id"], threading.Event())
        with self._lock:
            self._active[job_id] = active
        directory = job_dir(job["workspace_id"], job_id)
        state = read_json(directory / "state.json", fresh_state(job))
        state.update({
            "status": "starting", "current_stage": "starting",
            "current_action": f"Starting isolated worker {lease['slot_id']}",
            "worker_slot": lease["slot_id"], "updated_at": now(),
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
                "status": "starting", "current_stage": "starting", "current_action": "Preparing Pi agent",
                "worker_slot": active.slot_id, "started_at": state.get("started_at") or now(), "updated_at": now(),
            })
            atomic_json(directory / "state.json", state)
            state.update({"current_action": "Verifying Anthropic account access before Cvent", "updated_at": now()})
            atomic_json(directory / "state.json", state)
            provider = self.verify_provider_access(directory)
            append_log(directory, f"Anthropic one-token access probe passed in {provider.get('durationMs', 0)} ms")
            state.update({"current_action": "Starting isolated Steel.dev browser", "updated_at": now()})
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
            BrowserGate(directory).initialize()
            environment = self.pi_environment(job, active.token, active.slot_id)
            bind_ego_runtime_environment(environment, runtime)
            environment["PATH"] = str(ROOT / "bin") + os.pathsep + environment.get("PATH", "")
            prompt = self.render_prompt(job, directory, runtime)
            self._write_pi_settings(directory)
            sessions = directory / "pi-sessions"
            sessions.mkdir(parents=True, exist_ok=True)
            command_line = self.pi_command(job, directory, state, prompt)
            output = open(directory / "pi-output.log", "a", buffering=1)
            process = subprocess.Popen(
                command_line, cwd=directory, env=environment,
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
            append_log(directory, f"Started isolated Anthropic Pi process PID {process.pid} on worker {active.slot_id}")
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
        finish_state, uncertain, error = classify_process_outcome(
            code, report_status, reported_state, writes_exist, outcome["unresolved"], provider_failure,
        )
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
            "status": finish_state, "current_action": error or ("Draft build complete" if finish_state == "completed" else "Review required"),
            "pi_pid": None, "process_started_at": None, "worker_slot": None, "updated_at": now(),
        })
        atomic_json(directory / "state.json", state)
        active.stop_heartbeat.set()
        try:
            subprocess.run([sys.executable, str(ROOT / "performance_report.py"), str(directory)], cwd=ROOT,
                           env=self.prepare_environment(job, active.slot_id), capture_output=True, text=True, timeout=30)
        except Exception:
            pass
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
        tools = "read,bash,cvent_job_update,cvent_login_handoff,cvent_finish"
        command_line = [
            "pi", "-p", "--approve", "--provider", pi_provider(), "--model", pi_model(),
            "--thinking", os.environ.get("CVENT_PI_THINKING", "high"),
            "--no-extensions", "--extension", str(ROOT / "extensions/cvent-job-tools.ts"),
            "--no-skills", "--skill", str(ROOT / "skills/ego-browser/SKILL.md"),
            "--no-prompt-templates", "--no-context-files",
            "--tools", tools,
            "--session-dir", str(sessions), "--name", f"cvent-{job['id']}",
        ]
        if state.get("resume_requested") is True:
            session_files = sorted(sessions.glob("*.jsonl"), key=lambda path: path.stat().st_mtime, reverse=True)
            if not session_files:
                raise RuntimeError("No saved Pi session is available to continue")
            command_line += ["--session", str(session_files[0]),
                             "Re-read the controlling job prompt and continue idempotently."]
        else:
            command_line.append(prompt)
        return command_line

    def render_prompt(self, job: dict[str, Any], directory: Path, runtime: dict[str, Any]) -> str:
        values = {
            "RR_PATH": str((directory / "input.xlsx").resolve()),
            "TARGET_URL": f"DISCOVER EXACTLY {job['event_name']} — THE RR MUST NOT SELECT THE TARGET",
            "STATE_PATH": str((directory / "state.json").resolve()), "LOG_PATH": str((directory / "activity.log").resolve()),
            "REPORT_PATH": str((directory / "final-report.json").resolve()),
            "AUTH_SETTINGS_PATH": str((directory / "auth-settings.json").resolve()),
            "BROWSER_RUNTIME_PATH": str((directory / "browser-runtime.json").resolve()),
            "JOB_DIR": str(directory.resolve()),
            "AUTHORIZED_EVENT_NAME": job["event_name"], "AUTHORIZED_EVENT_ID": job["event_id"],
            "AUTHORIZED_EVENT_KEY": job["event_key"],
        }
        text = (ROOT / "PI_PROMPT.md").read_text()
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
            "defaultProvider": "anthropic", "defaultModel": "claude-sonnet-4-6",
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
            return "Anthropic API rate limit prevented the agent from continuing"
        if "authentication_error" in text or "invalid x-api-key" in text:
            return "Anthropic API authentication failed"
        return None

    @staticmethod
    def _mutation_attempted(directory: Path) -> bool:
        audit = directory / "scope-write-audit.jsonl"
        uncertain = directory / "browser-mutation-uncertain.json"
        direct_ego = directory / "direct-ego-invoked.json"
        return direct_ego.exists() or uncertain.exists() or (audit.exists() and audit.stat().st_size > 0)

    @staticmethod
    def _is_pi_process(pid: int) -> bool:
        try:
            command = subprocess.check_output(["ps", "-p", str(pid), "-o", "command="], text=True).strip()
            return bool(command and re.search(r"(^|/)pi(?:\s|$)", command))
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
