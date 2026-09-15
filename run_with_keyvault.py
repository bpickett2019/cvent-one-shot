#!/usr/bin/env python3
"""Load runtime secrets with the VM managed identity, then exec the app.

Secret values remain only in process memory/environment and are never printed or
written to disk. Production loads every required secret. The explicitly enabled
SSH-tunnel staging fallback loads only Anthropic so Entra/DNS cannot block a
controlled USER 1 acceptance run. Non-secret settings belong in systemd.
"""
from __future__ import annotations

import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

from azure.identity import ManagedIdentityCredential
from azure.keyvault.secrets import SecretClient

RESTRICTED_STAGING_SETTINGS = {
    "CVENT_ENV": "development",
    "CVENT_STAGING_TUNNEL_FALLBACK": "1",
    "CVENT_STAGING_RESTRICTED_ACCESS": "1",
    "CVENT_STAGING_PUBLIC_HOST": "staging.app-chartsdarts-dashboard.com",
    "CVENT_KEY_VAULT_URL": "https://kvcventstg729.vault.azure.net/",
    "CVENT_DEPLOYMENT_SCOPE": "rg-chartdarts-stg",
    "CVENT_DEV_AUTH_ADMIN": "0",
}

SECRET_ENV_MAP = {
    "anthropic-api-key": "ANTHROPIC_API_KEY",
    "entra-client-secret": "ENTRA_CLIENT_SECRET",
    "cvent-session-secret": "CVENT_SESSION_SECRET",
}


def validate_restricted_staging() -> None:
    if os.environ.get("CVENT_STAGING_RESTRICTED_ACCESS") != "1":
        return
    mismatches = [name for name, value in RESTRICTED_STAGING_SETTINGS.items() if os.environ.get(name) != value]
    try:
        expires = datetime.fromisoformat(os.environ["CVENT_STAGING_RESTRICTED_ACCESS_EXPIRES"].replace("Z", "+00:00"))
        now = datetime.now(timezone.utc)
        time_bounded = now < expires <= now + timedelta(days=14)
    except (KeyError, ValueError, TypeError):
        time_bounded = False
    if mismatches or not time_bounded:
        raise RuntimeError("Restricted access is valid only for the explicit, time-bounded non-admin staging deployment")


def selected_secrets() -> dict[str, str]:
    environment = os.environ.get("CVENT_ENV")
    if environment == "production":
        if os.environ.get("CVENT_STAGING_RESTRICTED_ACCESS") == "1":
            raise RuntimeError("Restricted staging access cannot run in production")
        return SECRET_ENV_MAP
    if environment == "development" and os.environ.get("CVENT_STAGING_TUNNEL_FALLBACK") == "1":
        validate_restricted_staging()
        return {"anthropic-api-key": "ANTHROPIC_API_KEY"}
    raise RuntimeError("Key Vault runtime requires production or the explicit staging tunnel fallback")


def load(secret_map: dict[str, str]) -> None:
    vault_url = os.environ.get("CVENT_KEY_VAULT_URL")
    if not vault_url:
        raise RuntimeError("CVENT_KEY_VAULT_URL is required")
    client_id = os.environ.get("AZURE_CLIENT_ID")
    credential = ManagedIdentityCredential(client_id=client_id) if client_id else ManagedIdentityCredential()
    client = SecretClient(vault_url=vault_url, credential=credential)
    for secret_name, environment_name in secret_map.items():
        value = client.get_secret(secret_name).value
        if not value:
            raise RuntimeError(f"Key Vault secret {secret_name!r} is empty")
        os.environ[environment_name] = value


def validate_staging_command(command: list[str]) -> None:
    if os.environ.get("CVENT_STAGING_TUNNEL_FALLBACK") != "1":
        return
    try:
        is_bounded_probe = (
            Path(command[0]).name == "pi"
            and "--no-tools" in command
            and "--no-session" in command
            and command[command.index("--provider") + 1] == "anthropic"
            and command[command.index("--model") + 1] == "claude-sonnet-4-6"
        )
    except (ValueError, IndexError):
        is_bounded_probe = False
    if is_bounded_probe:
        return
    # Fixed no-tools diagnostic only; never a general staging command exemption.
    if (len(command) == 5
            and Path(command[0]).resolve() == Path(sys.executable).resolve()
            and Path(command[1]).resolve() == Path(__file__).resolve().parent / "scripts/benchmark_smoke.py"
            and command[2:4] == ["--allow-paid-no-cvent", "--output"]):
        return
    try:
        host = command[command.index("--host") + 1]
    except (ValueError, IndexError) as exc:
        raise RuntimeError("Staging tunnel fallback must declare a loopback --host") from exc
    if host not in {"127.0.0.1", "localhost", "::1"}:
        raise RuntimeError("Staging tunnel fallback may only bind to loopback")


def main() -> None:
    secret_map = selected_secrets()
    load(secret_map)
    command = sys.argv[1:] or [
        sys.executable, "-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", "8877",
        "--proxy-headers", "--forwarded-allow-ips", "127.0.0.1",
    ]
    validate_staging_command(command)
    os.execvpe(command[0], command, os.environ)


if __name__ == "__main__":
    main()
