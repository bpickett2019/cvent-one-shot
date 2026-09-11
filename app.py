from __future__ import annotations

import asyncio
import json
import os
import re
import secrets
import shutil
import signal
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

import websockets
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, JSONResponse, Response
from starlette.middleware.sessions import SessionMiddleware

from auth import EntraAuth, Identity, restricted_staging_access
from browser_gate import BrowserGate
from browser_runtime import command as browser_command, load as load_browser_runtime, local_probe, pages as browser_pages, select_page
from control_store import ACTIVE_STATES, TERMINAL_STATES, ControlStore
from job_runner import JobRunner, UploadTooLarge, atomic_json, now, read_json
from runtime_config import DATA_ROOT, ROOT, authorized_events, browser_auth_metadata_path, browser_profile_dir, job_dir, validate_production_environment
from workbook_ops import info as workbook_info_data, sheet as workbook_sheet_data, update as update_workbook_data

def session_secret() -> str:
    configured = os.environ.get("CVENT_SESSION_SECRET")
    if configured:
        return configured
    # Development restarts and multiple local workers must verify the same signed
    # session/CSRF cookie. Production still requires an approved external secret.
    path = DATA_ROOT / ".development-session-secret"
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w") as output:
            output.write(secrets.token_hex(32))
    except FileExistsError:
        pass
    return path.read_text().strip()


app = FastAPI(title="CVENT Agent", docs_url=None, redoc_url=None)
_session_secret = session_secret()
app.add_middleware(
    SessionMiddleware,
    secret_key=_session_secret,
    session_cookie="cvent_agent_session",
    max_age=8 * 60 * 60,
    same_site="lax",
    https_only=os.environ.get("CVENT_ENV") == "production" or restricted_staging_access(),
)
auth = EntraAuth()
app.include_router(auth.router)
store = ControlStore(DATA_ROOT / "control.db", slots=3, lease_seconds=int(os.environ.get("CVENT_LEASE_SECONDS", "30")))
runner = JobRunner(store)


def product_facing(value):
    if value == "PI_EGO":
        return "CVENT_EGO"
    if isinstance(value, str):
        return re.sub(r"\bpi(?:\s+agent)?\b", "CVENT Agent", value.replace(str(ROOT), "[CVENT Agent application]"), flags=re.I)
    if isinstance(value, list):
        return [product_facing(item) for item in value]
    if isinstance(value, dict):
        return {key: product_facing(item) for key, item in value.items()}
    return value


def current_user(request: Request, mutate: bool = False) -> dict:
    identity = auth.identity(request)
    if mutate:
        auth.validate_csrf(request)
    return store.ensure_user(identity.subject, identity.email, identity.display_name, identity.is_admin)


def authorize_job(identity: dict, job_id: str | None = None) -> dict:
    job = store.get_job(job_id) if job_id else store.latest_job(identity["subject"])
    if not job:
        raise HTTPException(404, "No job found")
    if job["owner_subject"] != identity["subject"] and not identity["is_admin"]:
        # Do not reveal whether another user's identifier exists.
        raise HTTPException(404, "No job found")
    return job


def directory_for(job: dict) -> Path:
    return job_dir(job["workspace_id"], job["id"])


def active_job(job: dict):
    from readonly_session import resolve_readonly_session
    return runner.active(job["id"]) or resolve_readonly_session(store, job, directory_for(job))


def browser_directory_for(job: dict) -> Path:
    active = active_job(job)
    return active.runtime_dir if getattr(active, "read_only", False) else directory_for(job)


def verified_auth_metadata(job: dict, slot_id: int) -> dict:
    path = browser_auth_metadata_path(job["workspace_id"], slot_id)
    metadata = read_json(path, {})
    expected_profile = browser_profile_dir(job["workspace_id"], slot_id)
    if (
        metadata.get("authenticated") is True
        and metadata.get("workerSlot") == slot_id
        and metadata.get("profilePath") == str(expected_profile)
        and expected_profile.exists()
    ):
        return metadata
    return {}


def verify_authenticated_cvent(job: dict, active, directory: Path) -> tuple[dict, dict]:
    runtime = load_browser_runtime(directory / "browser-runtime.json")
    slot_id = int(active.slot_id)
    expected_profile = browser_profile_dir(job["workspace_id"], slot_id)
    if int(runtime.get("workerSlot", 0)) != slot_id:
        raise RuntimeError("Browser runtime does not belong to this worker slot")
    if Path(runtime.get("profilePath", "")).resolve() != expected_profile.resolve():
        raise RuntimeError("Browser profile does not belong to this worker slot")
    if not expected_profile.is_dir():
        raise RuntimeError("Worker browser profile is unavailable")
    viewer = local_probe(runtime)
    page_url = str(viewer.get("url", ""))
    host = (urlparse(page_url).hostname or "").lower()
    if host != "app.cvent.com" or re.search(r"(?:login|signin|authenticate|sso)", page_url, re.I):
        raise RuntimeError("Browser is not on the authenticated Cvent application origin")
    page = select_page(browser_pages(runtime["cdpHttpOrigin"]), runtime["targetBrowserIdentity"]["targetId"])
    if not page:
        raise RuntimeError("Authenticated Cvent page is unavailable")
    cookies = browser_command(page["webSocketDebuggerUrl"], "Network.getAllCookies", {}, runtime["cdpHttpOrigin"]).get("cookies", [])
    organization_id = next((str(cookie.get("value", "")) for cookie in cookies
                            if cookie.get("name") == "org-id" and str(cookie.get("domain", "")).endswith("cvent.com")), "")
    ui = browser_command(
        page["webSocketDebuggerUrl"], "Runtime.evaluate",
        {"expression": "(() => { const text=(document.body?.innerText||'').slice(0,50000); return {ready:document.readyState,title:document.title,hasUi:/(?:event management|my events|event details|registration|cvent)/i.test(text),hasLogin:/(?:sign in|log in|enter your password|verify your identity|authenticator)/i.test(text)} })()", "returnByValue": True},
        runtime["cdpHttpOrigin"],
    ).get("result", {}).get("value", {})
    if not organization_id or ui.get("ready") != "complete" or not ui.get("hasUi") or ui.get("hasLogin"):
        raise RuntimeError("Cvent UI does not prove a completed authenticated session")
    prior = read_json(browser_auth_metadata_path(job["workspace_id"], slot_id), {})
    if prior.get("organizationId") and prior["organizationId"] != organization_id:
        raise RuntimeError("Cvent account context differs from this slot's saved login")
    timestamp = now()
    metadata = {
        "schemaVersion": 1,
        "workerSlot": slot_id,
        "profileId": f"{job['workspace_id']}:slot-{slot_id}",
        "profilePath": str(expected_profile),
        "createdAt": prior.get("createdAt") or timestamp,
        "lastVerifiedAt": timestamp,
        "authenticated": True,
        "organizationId": organization_id,
        "authenticatedOrigin": "https://app.cvent.com",
        "browserRuntimeId": runtime["browserRuntimeId"],
        "microsoftSsoPersistent": any(cookie.get("name") == "ESTSAUTHPERSISTENT" for cookie in cookies),
    }
    evidence = {"browserRuntimeId": runtime["browserRuntimeId"], "viewer": viewer,
                "uiVerified": True, "inspectedAt": timestamp}
    return metadata, evidence


def persist_authenticated_cvent(job: dict, directory: Path, metadata: dict) -> None:
    slot_path = browser_auth_metadata_path(job["workspace_id"], int(metadata["workerSlot"]))
    atomic_json(slot_path, metadata)
    os.chmod(slot_path, 0o600)
    # The bounded agent sees only a redacted job-scoped proof. The internal
    # account-context identifier remains in slot metadata for wrong-account
    # detection and is not exposed through agent tools or the product API.
    job_metadata = {key: value for key, value in metadata.items() if key != "organizationId"}
    job_metadata["accountContextVerified"] = True
    job_path = directory / "auth-settings.json"
    atomic_json(job_path, job_metadata)
    os.chmod(job_path, 0o600)


def safe_job(job: dict, include_owner: bool = False) -> dict:
    result = {key: job.get(key) for key in (
        "id", "workspace_id", "event_id", "event_name", "original_filename", "state", "preferred_slot", "slot_id",
        "queued_at", "started_at", "finished_at", "heartbeat_at", "error", "uncertain", "created_at", "updated_at",
    )}
    if include_owner:
        result["owner_subject"] = job["owner_subject"]
    return result


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
    response.headers.setdefault("Referrer-Policy", "same-origin")
    response.headers.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
    response.headers.setdefault(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data: blob:; connect-src 'self' ws: wss:; frame-src 'self'; object-src 'none'; base-uri 'self'",
    )
    if os.environ.get("CVENT_ENV") == "production":
        response.headers.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
    return response


@app.on_event("startup")
def startup():
    validate_production_environment()
    runner.start_scheduler()


@app.on_event("shutdown")
def shutdown():
    runner.shutdown()


@app.get("/healthz")
def healthz():
    return {"ok": True, "workers": 3}


@app.get("/internal/leases/validate", include_in_schema=False)
def validate_internal_lease(request: Request, job_id: str, event_id: str):
    if not request.client or request.client.host not in {"127.0.0.1", "::1"}:
        raise HTTPException(403, "Internal endpoint")
    token = request.headers.get("x-cvent-lease-token", "")
    if not token or not store.valid_event_lease(job_id, token, event_id):
        raise HTTPException(409, "Canonical event lease is absent, stale, or owned by another job")
    return Response(status_code=204)


@app.get("/", response_class=HTMLResponse)
def home(request: Request):
    try:
        current_user(request)
    except HTTPException as exc:
        if exc.status_code == 401:
            return HTMLResponse(
                "<!doctype html><title>Forge · CVENT Agent</title><main style='font:16px system-ui;max-width:40rem;margin:10vh auto'>"
                "<h1>Forge CVENT Agent</h1><p>Sign in with your authorized Microsoft Entra account.</p>"
                "<a href='/auth/login'>SIGN IN</a></main>", status_code=401,
            )
        raise
    return HTMLResponse(
        (ROOT / "templates/index.html").read_text(),
        headers={"Cache-Control": "no-store, no-cache, must-revalidate", "Pragma": "no-cache", "Expires": "0"},
    )


@app.get("/api/me")
def me(request: Request):
    identity = current_user(request)
    value = auth.me(request)
    value["workspace_id"] = identity["workspace_id"]
    return JSONResponse(value, headers={"Cache-Control": "no-store"})


@app.get("/api/events")
def events(request: Request):
    current_user(request)
    return [{"event_id": event.event_id, "name": event.name, "event_code": event.event_code}
            for event in authorized_events()]


@app.get("/api/jobs")
def jobs(request: Request):
    identity = current_user(request)
    return [safe_job(job) for job in store.list_jobs(identity["subject"])]


@app.get("/api/admin/jobs")
def admin_jobs(request: Request):
    identity = auth.require_admin(request)
    store.ensure_user(identity.subject, identity.email, identity.display_name, identity.is_admin)
    return [safe_job(job, include_owner=True) for job in store.list_jobs()]


@app.get("/api/admin/leases")
def admin_leases(request: Request):
    identity = auth.require_admin(request)
    store.ensure_user(identity.subject, identity.email, identity.display_name, identity.is_admin)
    return store.active_leases()


@app.get("/api/status")
def status(request: Request, job_id: str | None = None, worker_slot: int | None = None):
    identity = current_user(request)
    if worker_slot is not None and worker_slot not in range(1, store.slots + 1):
        raise HTTPException(400, "Worker profile must be 1, 2, or 3")
    job = None
    if job_id:
        job = authorize_job(identity, job_id)
    elif worker_slot is not None:
        job = next((item for item in store.list_jobs(identity["subject"], limit=1000)
                    if int(item.get("slot_id") or item.get("preferred_slot") or 1) == worker_slot), None)
    else:
        job = store.latest_job(identity["subject"])
    if not job:
        return JSONResponse({
            "status": "waiting_for_rr", "current_stage": "upload",
            "current_action": f"User {worker_slot or 1} is ready for an RR workbook",
            "completed": [], "review_required": [], "activity_log": [], "agent_process_running": False,
            "browser": {"running": False, "worker_slot": worker_slot},
            "browser_gate": {"ownership": "AGENT", "desiredOwnership": "AGENT"},
            "browser_strategy": "PI + EGO SKILL · JOB-ISOLATED STEEL.DEV", "automation_scope": scope_summary(),
            "events": len(authorized_events()), "selected_worker": worker_slot or 1,
        }, headers={"Cache-Control": "no-store"})
    directory = directory_for(job)
    state = read_json(directory / "state.json", {})
    persisted = store.get_job(job["id"])
    state.update({"job": safe_job(persisted), "run_mode": "mock", "browser_strategy": "PI + EGO SKILL · JOB-ISOLATED STEEL.DEV"})
    if persisted and persisted["state"] in TERMINAL_STATES:
        state.update({"status": persisted["state"], "current_action": persisted.get("error") or state.get("current_action")})
        provider_failure = runner._provider_failure(directory)
        if provider_failure:
            state["provider_failure"] = provider_failure
            if provider_failure.lower() not in str(state.get("current_action", "")).lower():
                state["current_action"] = f"{provider_failure}; {state.get('current_action', 'agent stopped')}"
    validation = read_json(directory / "rr-validation.json", {})
    if validation.get("items"):
        from completion_state import verified_completed_stages
        state["completed"] = verified_completed_stages(state,
            read_json(directory / "domain-results.json", {}),
            read_json(directory / "final-verification.json", {}), validation)
    state["automation_scope"] = scope_summary()
    state["activity_log"] = (directory / "activity.log").read_text(errors="replace").splitlines()[-200:] if (directory / "activity.log").exists() else []
    state["final_report"] = read_json(directory / "final-report.json", None)
    state["browser_gate"] = BrowserGate(browser_directory_for(job)).read()
    active = active_job(job)
    if getattr(active, "read_only", False):
        state["current_action"] = "Read-only uncertainty reconciliation/capability inspection; no configuration writes are enabled"
        state["read_only_reconciliation"] = True
    state["agent_process_running"] = bool(active and active.process and active.process.poll() is None)
    state["agent_pid"] = active.process.pid if state["agent_process_running"] else None
    state["agent_session_saved"] = bool(state.get("pi_session"))
    state["browser"] = {"running": bool(active), "worker_slot": active.slot_id if active else None,
                        "viewer_url": f"/api/jobs/{job['id']}/viewer" if active else None}
    profile_slot = int((active.slot_id if active else None) or job.get("slot_id") or job.get("preferred_slot") or 1)
    saved_auth = verified_auth_metadata(job, profile_slot)
    state["auth_settings"] = {
        "verified": bool(saved_auth),
        "worker_slot": profile_slot,
        "last_verified_at": saved_auth.get("lastVerifiedAt"),
        "cookies_saved": bool(saved_auth),
        "microsoft_sso_persistent": bool(saved_auth.get("microsoftSsoPersistent")),
        "display": f"USER {profile_slot} · Cvent login verified" if saved_auth else f"USER {profile_slot} · Cvent login required",
    }
    workbook = directory / "input.xlsx"
    state["rr_version"] = str(workbook.stat().st_mtime_ns) if workbook.exists() else None
    if state["agent_process_running"] and state.get("process_started_at"):
        try:
            state["elapsed_seconds"] = max(0, int((datetime.now(timezone.utc) - datetime.fromisoformat(state["process_started_at"])).total_seconds()))
        except Exception:
            state["elapsed_seconds"] = 0
    else:
        state["elapsed_seconds"] = 0
    state.pop("pi_pid", None)
    state.pop("pi_session", None)
    return JSONResponse(product_facing(state), headers={"Cache-Control": "no-store"})


def scope_summary():
    return {
        "valid": True, "authority": "Uploaded RR", "mode": "writable_event_configuration",
        "safeguards": ["exact selected event", "one writer", "protected actions blocked", "saved changes verified"],
    }


@app.get("/api/scope")
def automation_scope(request: Request):
    current_user(request)
    return JSONResponse(scope_summary(), headers={"Cache-Control": "no-store"})


@app.post("/api/upload")
def upload(request: Request, rr: UploadFile = File(...), event_id: str = Form(...), worker_slot: int = Form(1)):
    identity = current_user(request, mutate=True)
    if worker_slot not in range(1, store.slots + 1):
        raise HTTPException(400, "Worker profile must be 1, 2, or 3")
    name = rr.filename or ""
    if not name.lower().endswith(".xlsx"):
        raise HTTPException(400, "Upload an .xlsx file")
    event = next((item for item in authorized_events() if item.event_id == event_id.lower()), None)
    if not event:
        raise HTTPException(403, "Event is not in the server-side authorization allowlist")
    job = store.create_job(identity, event, Path(name).name, preferred_slot=worker_slot)
    directory = job_dir(job["workspace_id"], job["id"])
    try:
        runner.create_files(
            job, rr.file, int(os.environ.get("CVENT_MAX_UPLOAD_BYTES", str(25 * 1024 * 1024)))
        )
        workbook_info_data(directory)  # Reject malformed/non-Excel input before it can be started.
    except UploadTooLarge as exc:
        store.finish(job["id"], None, "failed", str(exc), False, identity["subject"])
        shutil.rmtree(directory, ignore_errors=True)
        raise HTTPException(413, str(exc)) from exc
    except Exception as exc:
        store.finish(job["id"], None, "failed", "Invalid RR workbook", False, identity["subject"])
        shutil.rmtree(directory, ignore_errors=True)
        raise HTTPException(400, "The uploaded file is not a valid .xlsx workbook") from exc
    return {"ok": True, "file": name, "job_id": job["id"], "event_id": event.event_id, "worker_slot": worker_slot}


@app.get("/api/workbook")
def workbook_info(request: Request, job_id: str | None = None):
    identity = current_user(request)
    return JSONResponse(workbook_info_data(directory_for(authorize_job(identity, job_id))), headers={"Cache-Control": "no-store"})


@app.get("/api/workbook/sheet")
def workbook_sheet(request: Request, name: str, start: int = 1, limit: int = 80, job_id: str | None = None):
    identity = current_user(request)
    return JSONResponse(workbook_sheet_data(directory_for(authorize_job(identity, job_id)), name, start, limit),
                        headers={"Cache-Control": "no-store"})


@app.patch("/api/workbook")
def update_workbook(request: Request, payload: dict, job_id: str | None = None):
    identity = current_user(request, mutate=True)
    job = authorize_job(identity, job_id)
    if job["state"] not in {"draft", "cancelled", "failed", "failed_prewrite", "failed_recoverable", "review_required", "login_required"}:
        raise HTTPException(409, "This job is not editable in its current state")
    result = update_workbook_data(directory_for(job), payload, bool(active_job(job)))
    store.audit(identity["subject"], "workbook.updated", job["id"], {"saved": result["saved"]})
    return result


@app.post("/api/auth-settings")
def save_auth_settings(request: Request, job_id: str | None = None):
    """Compatibility endpoint; normal UX persists automatically on Return."""
    identity = current_user(request, mutate=True)
    job, active = require_active(identity, authorize_job(identity, job_id)["id"])
    directory = browser_directory_for(job)
    try:
        metadata, _ = verify_authenticated_cvent(job, active, directory)
    except Exception as exc:
        raise HTTPException(409, "Cvent login is not complete. Finish SSO/MFA before returning control.") from exc
    persist_authenticated_cvent(job, directory, metadata)
    store.audit(identity["subject"], "cvent_login.verified", job["id"], {"worker_slot": active.slot_id})
    return {"ok": True, "verified": True, "worker_slot": active.slot_id}


@app.post("/api/start")
def start(request: Request, job_id: str | None = None):
    identity = current_user(request, mutate=True)
    job = authorize_job(identity, job_id)
    if not (directory_for(job) / "input.xlsx").exists():
        raise HTTPException(400, "Upload the RR workbook first")
    gate = BrowserGate(directory_for(job))
    if gate.read().get("ownership") != "AGENT":
        active = active_job(job)
        if not active and job["state"] in {"login_required", "failed_prewrite", "failed_recoverable", "failed", "review_required"}:
            gate.initialize()
            store.audit(identity["subject"], "browser.stale_control_reset_on_start", job["id"], {})
        else:
            raise HTTPException(409, "Return browser control to the agent before starting")
    try:
        runner.start(job["id"], identity["subject"])
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    return {"ok": True, "job_id": job["id"], "state": "starting"}


@app.post("/api/continue")
def continue_job(request: Request, job_id: str | None = None):
    identity = current_user(request, mutate=True)
    job = authorize_job(identity, job_id)
    gate = BrowserGate(directory_for(job))
    if gate.read().get("ownership") != "AGENT":
        active = active_job(job)
        if active and active.process and active.process.poll() is None:
            raise HTTPException(409, "Return browser control to the agent before continuing")
        # A completed/timed-out login handoff has no live browser or process to
        # return. Reset only that stale gate before acquiring a fresh worker.
        gate.initialize()
    try:
        if job["state"] == "failed_prewrite":
            runner.retry_prewrite(job["id"], identity["subject"])
        elif job["state"] == "failed_recoverable":
            runner.retry_recoverable(job["id"], identity["subject"])
        else:
            runner.resume(job["id"], identity["subject"])
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    return {"ok": True, "job_id": job["id"], "state": "starting"}


@app.post("/api/stop-agent")
def stop_agent(request: Request, job_id: str | None = None):
    identity = current_user(request, mutate=True)
    job = authorize_job(identity, job_id)
    active = active_job(job)
    if getattr(active, "read_only", False):
        atomic_json(active.runtime_dir / "stop-requested.json", {"at": now()})
        return {"ok": True, "stopping": True, "readOnly": True}
    try:
        runner.stop(job["id"], identity["subject"], uncertain=job["state"] in ACTIVE_STATES)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    return {"ok": True, "job_id": job["id"]}


def require_active(identity: dict, job_id: str):
    job = authorize_job(identity, job_id)
    active = active_job(job)
    if not active:
        raise HTTPException(503, "This job does not currently own a browser worker")
    return job, active


@app.post("/api/open-browser")
def open_browser(request: Request, job_id: str | None = None):
    identity = current_user(request, mutate=True)
    job = authorize_job(identity, job_id)
    active = active_job(job)
    if not active:
        raise HTTPException(409, "Start or continue the job to acquire an isolated browser worker")
    runtime_path = browser_directory_for(job) / "browser-runtime.json"
    if not runtime_path.exists():
        return {"running": False, "starting": True, "worker_slot": active.slot_id}
    runtime = load_browser_runtime(runtime_path)
    return {"running": True, "worker_slot": active.slot_id, "browserRuntime": runtime, "displayOnly": True}


@app.get("/api/jobs/{job_id}/viewer", response_class=HTMLResponse)
def steel_viewer(request: Request, job_id: str):
    identity = current_user(request)
    _, active = require_active(identity, job_id)
    slot = __import__("runtime_config").slot_by_id(active.slot_id)
    try:
        with urllib.request.urlopen(slot.api_origin + "/v1/sessions/debug", timeout=10) as response:
            html = response.read().decode("utf-8")
    except Exception as exc:
        raise HTTPException(503, f"Job Steel viewer unavailable: {exc}") from exc
    ws_scheme = "wss" if request.url.scheme == "https" else "ws"
    ws_base = f"{ws_scheme}://{request.headers.get('host')}/api/jobs/{job_id}/viewer-ws"
    http_base = f"/api/jobs/{job_id}/steel"
    for host in ("0.0.0.0:3000", "127.0.0.1:3000", "localhost:3000"):
        html = html.replace("ws://" + host, ws_base).replace("http://" + host, http_base)
    safety = f"""<script>(()=>{{let user=false;const stop=e=>{{if(!user){{e.preventDefault();e.stopImmediatePropagation();try{{document.activeElement?.blur()}}catch{{}}}}}};['pointerdown','pointerup','pointermove','mousedown','mouseup','mousemove','click','dblclick','contextmenu','wheel','touchstart','touchmove','touchend','keydown','keyup','keypress','focusin'].forEach(n=>document.addEventListener(n,stop,{{capture:true,passive:false}}));const fixConnectionLabel=()=>{{const status=document.getElementById('connection-status'),online=status?.classList.contains('online'),indicator=status?.querySelector('.status-indicator'),label=status?.querySelector('span');if(indicator)indicator.className='status-indicator '+(online?'online':'offline');if(label)label.textContent=online?'Session Online':'Session Offline'}};async function sync(){{try{{const r=await fetch('/api/browser/ownership?job_id={job_id}',{{cache:'no-store'}}),d=await r.json();user=d.ownership==='USER'&&d.desiredOwnership==='USER';document.documentElement.dataset.controlOwner=user?'USER':'AGENT';document.body.style.pointerEvents=user?'auto':'none';if(!user)try{{document.activeElement?.blur()}}catch{{}}}}catch{{user=false;document.body.style.pointerEvents='none'}}finally{{fixConnectionLabel()}}}}sync();setInterval(sync,400)}})()</script>"""
    html = html.replace("</body>", safety + "</body>")
    return HTMLResponse(html, headers={"Cache-Control": "no-store"})


@app.get("/api/jobs/{job_id}/steel/{path:path}")
def steel_http_proxy(request: Request, job_id: str, path: str):
    identity = current_user(request)
    _, active = require_active(identity, job_id)
    slot = __import__("runtime_config").slot_by_id(active.slot_id)
    url = f"{slot.api_origin}/{path}"
    if request.url.query:
        url += "?" + request.url.query
    try:
        with urllib.request.urlopen(url, timeout=20) as upstream:
            return Response(upstream.read(), status_code=upstream.status,
                            media_type=upstream.headers.get_content_type())
    except Exception as exc:
        raise HTTPException(502, f"Viewer proxy failed: {exc}") from exc


@app.websocket("/api/jobs/{job_id}/viewer-ws/{path:path}")
async def steel_websocket_proxy(websocket: WebSocket, job_id: str, path: str):
    try:
        identity_value = auth.identity(websocket)  # SessionMiddleware also populates WebSocket scopes.
        identity = store.ensure_user(identity_value.subject, identity_value.email, identity_value.display_name, identity_value.is_admin)
        _, active = require_active(identity, job_id)
    except HTTPException:
        await websocket.close(code=4403)
        return
    slot = __import__("runtime_config").slot_by_id(active.slot_id)
    upstream_url = f"ws://127.0.0.1:{slot.api_port}/{path}"
    if websocket.url.query:
        upstream_url += "?" + websocket.url.query
    gate = BrowserGate(browser_directory_for(authorize_job(identity, job_id)))
    await websocket.accept()
    try:
        async with websockets.connect(upstream_url, origin=slot.api_origin, max_size=16 * 1024 * 1024) as upstream:
            async def client_to_upstream():
                while True:
                    message = await websocket.receive()
                    if message.get("type") == "websocket.disconnect":
                        break
                    ownership = gate.read()
                    user_owned = ownership.get("ownership") == "USER" and ownership.get("desiredOwnership") == "USER"
                    # The cast stream needs no client message for display. Drop
                    # every mouse/key/navigation/clipboard message server-side
                    # until explicit, completed human takeover.
                    if not user_owned:
                        continue
                    if message.get("text") is not None:
                        await upstream.send(message["text"])
                    elif message.get("bytes") is not None:
                        await upstream.send(message["bytes"])

            async def upstream_to_client():
                async for message in upstream:
                    if isinstance(message, str):
                        await websocket.send_text(message)
                    else:
                        await websocket.send_bytes(message)

            await asyncio.gather(client_to_upstream(), upstream_to_client())
    except (WebSocketDisconnect, websockets.ConnectionClosed):
        pass
    finally:
        try:
            await websocket.close()
        except Exception:
            pass


@app.get("/api/browser/ownership")
def browser_ownership(request: Request, job_id: str | None = None):
    identity = current_user(request)
    job = authorize_job(identity, job_id)
    return JSONResponse(BrowserGate(browser_directory_for(job)).read(), headers={"Cache-Control": "no-store"})


@app.post("/api/browser/take-control")
def take_control(request: Request, job_id: str | None = None):
    identity = current_user(request, mutate=True)
    job = authorize_job(identity, job_id)
    active = active_job(job)
    if getattr(active, "read_only", False):
        gate = BrowserGate(active.runtime_dir)
        gate.request_user()
        with gate.lock_file():
            value = gate.read()
            value.update({"ownership": "USER", "desiredOwnership": "USER", "activeActor": "USER", "agentPaused": True})
            gate.write(value)
        return {"ok": True, "gate": gate.read(), "readOnly": True}
    if not active or not active.process or active.process.poll() is not None:
        raise HTTPException(409, "CVENT Agent is not actively running")
    runtime = load_browser_runtime(directory_for(job) / "browser-runtime.json")
    local_probe(runtime)
    gate = BrowserGate(directory_for(job))
    gate.request_user()
    with gate.lock_file():
        os.killpg(active.process.pid, signal.SIGSTOP)
        value = gate.read()
        value.update({
            "ownership": "USER", "desiredOwnership": "USER", "activeActor": "USER", "automationOwner": "USER",
            "agentPaused": True, "pausedPids": [active.process.pid], "transition": None,
            "browserRuntimeId": runtime["browserRuntimeId"],
        })
        gate.write(value)
    store.audit(identity["subject"], "browser.take_control", job["id"], {})
    return {"ok": True, "gate": gate.read()}


@app.post("/api/browser/return-to-agent")
def return_to_agent(request: Request, job_id: str | None = None):
    identity = current_user(request, mutate=True)
    job = authorize_job(identity, job_id)
    directory = browser_directory_for(job)
    gate = BrowserGate(directory)
    active = active_job(job)
    if getattr(active, "read_only", False):
        gate.shield_agent()
        with gate.lock_file():
            try:
                metadata, evidence = verify_authenticated_cvent(job, active, directory)
                persist_authenticated_cvent(job, directory, metadata)
                atomic_json(directory / "human-handoff-state.json", evidence)
                value = gate.read()
                value.update({"ownership": "AGENT", "desiredOwnership": "AGENT", "activeActor": "NONE", "automationOwner": "PI_EGO", "agentPaused": False})
                gate.write(value)
            except Exception as exc:
                value = gate.read()
                value.update({"ownership": "USER", "desiredOwnership": "USER", "activeActor": "USER", "agentPaused": True})
                gate.write(value)
                raise HTTPException(409, "Complete Cvent SSO/MFA before returning the read-only browser") from exc
        store.audit(identity["subject"], "reconciliation.login_verified", job["id"], {"readOnly": True})
        return {"ok": True, "verified": True, "worker_slot": 1, "readOnly": True, "gate": gate.read()}
    if not active or not active.process or active.process.poll() is not None:
        # A prior login handoff may outlive its worker. There is no process or
        # live browser to resume, so clear only this stale gate and require a
        # fresh runtime/lease/preflight on Continue.
        if gate.read().get("ownership") == "USER" and job["state"] in {"login_required", "failed_prewrite", "failed_recoverable", "failed", "review_required"}:
            gate.initialize()
            store.audit(identity["subject"], "browser.return_stale_control", job["id"], {})
            return {"ok": True, "staleReset": True, "gate": gate.read(), "instruction": "Continue to acquire a fresh isolated browser runtime"}
        raise HTTPException(409, "CVENT Agent is not actively running")
    gate.shield_agent()
    with gate.lock_file():
        try:
            metadata, state = verify_authenticated_cvent(job, active, directory)
            lock = read_json(directory / "authorized-target.json", {})
            if lock and (lock.get("event_id") != job["event_id"] or lock.get("event_key") != job["event_key"]):
                raise RuntimeError("Human left the authorized Cvent event")
            persist_authenticated_cvent(job, directory, metadata)
            atomic_json(directory / "human-handoff-state.json", state)
            job_state = read_json(directory / "state.json", {})
            job_state.update({"current_action": "Cvent login verified and persisted for this worker; resuming agent",
                              "updated_at": now()})
            atomic_json(directory / "state.json", job_state)
            value = gate.read()
            value.update({
                "ownership": "AGENT", "desiredOwnership": "AGENT", "activeActor": "NONE",
                "automationOwner": "PI_EGO", "agentPaused": False, "pausedPids": [], "transition": None,
            })
            gate.write(value)
            os.killpg(active.process.pid, signal.SIGCONT)
        except Exception as exc:
            value = gate.read()
            value.update({
                "ownership": "USER", "desiredOwnership": "USER", "activeActor": "USER",
                "automationOwner": "USER", "transition": None, "agentPaused": True,
                "pausedPids": [active.process.pid],
            })
            gate.write(value)
            store.audit(identity["subject"], "browser.return_rejected", job["id"],
                        {"worker_slot": active.slot_id, "reason": type(exc).__name__})
            raise HTTPException(409, "Cvent login is not complete. Finish SSO/MFA before returning control.") from exc
    store.audit(identity["subject"], "browser.return_to_agent", job["id"],
                {"worker_slot": active.slot_id, "profile_verified": True})
    return {"ok": True, "verified": True, "worker_slot": active.slot_id, "gate": gate.read()}


@app.post("/api/browser/reset-login")
def reset_cvent_login(request: Request, payload: dict):
    identity = current_user(request, mutate=True)
    try:
        slot_id = int(payload.get("worker_slot"))
    except (TypeError, ValueError) as exc:
        raise HTTPException(400, "Worker profile must be 1, 2, or 3") from exc
    if slot_id not in range(1, store.slots + 1):
        raise HTTPException(400, "Worker profile must be 1, 2, or 3")
    for job in store.list_jobs(identity["subject"], limit=1000):
        active = active_job(job)
        if active and active.slot_id == slot_id:
            attempted = runner._mutation_attempted(directory_for(job))
            runner.stop(job["id"], identity["subject"], uncertain=attempted)
            for _ in range(300):
                if not active_job(job):
                    break
                time.sleep(0.1)
            if active_job(job):
                raise HTTPException(409, "USER slot did not stop safely; login was not reset")
    slot_root = browser_profile_dir(identity["workspace_id"], slot_id).parent
    if slot_root.exists():
        shutil.rmtree(slot_root)
    store.audit(identity["subject"], "cvent_login.reset", None, {"worker_slot": slot_id})
    return {"ok": True, "worker_slot": slot_id, "instruction": "Fresh human Cvent SSO/MFA is required"}
