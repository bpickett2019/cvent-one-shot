"""Validated runtime configuration for the three-worker single-VM deployment."""
from __future__ import annotations

import hashlib
import os
import re
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA_ROOT = Path(os.environ.get("CVENT_DATA_ROOT", ROOT / "data")).resolve()
# Non-production fallback used only by BrowserRuntime unit tests and diagnostics;
# selectable production events always come from authenticated inventory.
DEFAULT_EVENT_NAME = "Development Test Event"
DEFAULT_EVENT_KEY = "00000000-0000-4000-8000-000000000001"
STEEL_IMAGE = os.environ.get(
    "CVENT_STEEL_IMAGE",
    "ghcr.io/steel-dev/steel-browser@sha256:21cf2a5785aa9478d0f7933c04bce96ca79f3d7a93d9824ea184800d29d3cd02",
)


@dataclass(frozen=True)
class AuthorizedEvent:
    event_id: str
    name: str
    event_key: str
    event_code: str = ""


@dataclass(frozen=True)
class WorkerSlot:
    slot_id: int
    api_port: int
    cdp_port: int

    @property
    def container_name(self) -> str:
        return f"cvent-agent-steel-{self.slot_id}"

    @property
    def api_origin(self) -> str:
        return f"http://127.0.0.1:{self.api_port}"

    @property
    def cdp_origin(self) -> str:
        return f"http://127.0.0.1:{self.cdp_port}"


WORKER_SLOTS = tuple(WorkerSlot(i, 3004 + i, 9333 + i) for i in range(1, 4))


def _safe_component(value: str) -> str:
    if not re.fullmatch(r"[a-zA-Z0-9_-]{1,128}", value):
        raise ValueError("Unsafe filesystem identifier")
    return value


def subject_key(subject: str) -> str:
    """Pseudonymous stable directory key; raw Entra object IDs never become paths."""
    return hashlib.sha256(subject.encode("utf-8")).hexdigest()[:32]


def workspace_dir(workspace_id: str) -> Path:
    return DATA_ROOT / "workspaces" / _safe_component(workspace_id)


def job_dir(workspace_id: str, job_id: str) -> Path:
    return workspace_dir(workspace_id) / "jobs" / _safe_component(job_id)


def browser_profile_dir(workspace_id: str, slot_id: int) -> Path:
    """One persistent, non-shared Chromium profile per user workspace and worker slot."""
    slot = slot_by_id(slot_id)
    return workspace_dir(workspace_id) / "browser-profiles" / f"slot-{slot.slot_id}" / "chromium-profile"


def browser_cache_dir(workspace_id: str, slot_id: int) -> Path:
    slot = slot_by_id(slot_id)
    return workspace_dir(workspace_id) / "browser-profiles" / f"slot-{slot.slot_id}" / "steel-cache"


def browser_auth_metadata_path(workspace_id: str, slot_id: int) -> Path:
    slot = slot_by_id(slot_id)
    return workspace_dir(workspace_id) / "browser-profiles" / f"slot-{slot.slot_id}" / "auth-profile.json"


def slot_by_id(slot_id: int) -> WorkerSlot:
    try:
        return next(slot for slot in WORKER_SLOTS if slot.slot_id == slot_id)
    except StopIteration as exc:
        raise ValueError(f"Unknown worker slot {slot_id}") from exc


def pi_provider() -> str:
    provider = os.environ.get("CVENT_PI_PROVIDER", "anthropic")
    if provider != "anthropic":
        raise RuntimeError("CVENT_PI_PROVIDER must be anthropic")
    return provider


def pi_model() -> str:
    model = os.environ.get("CVENT_PI_MODEL", "claude-sonnet-5")
    if model not in {"claude-sonnet-5", "anthropic/claude-sonnet-5"}:
        raise RuntimeError("CVENT_PI_MODEL must be claude-sonnet-5")
    return model.split("/", 1)[-1]


def validate_production_environment() -> None:
    if os.environ.get("CVENT_ENV", "development") != "production":
        return
    required = (
        "ANTHROPIC_API_KEY",
        "ENTRA_TENANT_ID",
        "ENTRA_CLIENT_ID",
        "ENTRA_CLIENT_SECRET",
        "CVENT_SESSION_SECRET",
    )
    missing = [name for name in required if not os.environ.get(name)]
    if missing:
        raise RuntimeError("Missing production environment variables: " + ", ".join(missing))
    if len(os.environ["CVENT_SESSION_SECRET"]) < 32:
        raise RuntimeError("CVENT_SESSION_SECRET must contain at least 32 characters")
    pi_provider()
    pi_model()
