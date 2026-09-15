#!/usr/bin/env python3
"""Minimal Anthropic availability/credit probe; never prints credentials or response content."""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request


def main():
    if os.environ.get("CVENT_MODEL_BENCHMARK") == "1":
        print(json.dumps({"ok": False, "classification": "benchmark_inference_probe_disabled"}))
        raise SystemExit(2)
    key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not key:
        print(json.dumps({"ok": False, "classification": "missing_key"}))
        raise SystemExit(2)
    payload = json.dumps({
        "model": os.environ.get("CVENT_PI_MODEL", "claude-sonnet-4-6"),
        "max_tokens": 1,
        "messages": [{"role": "user", "content": "Reply OK"}],
    }).encode()
    request = urllib.request.Request("https://api.anthropic.com/v1/messages", data=payload, method="POST", headers={
        "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json",
    })
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            print(json.dumps({"ok": response.status == 200, "classification": "usable", "httpStatus": response.status}))
    except urllib.error.HTTPError as exc:
        body = exc.read(32768).decode(errors="replace").lower()
        classification = "credit_unavailable" if "credit balance" in body or "billing" in body else (
            "authentication_failed" if exc.code in {401, 403} else "provider_error"
        )
        print(json.dumps({"ok": False, "classification": classification, "httpStatus": exc.code}))
        raise SystemExit(1)
    except Exception as exc:
        print(json.dumps({"ok": False, "classification": "network_unavailable", "errorType": type(exc).__name__}))
        raise SystemExit(1)


if __name__ == "__main__":
    main()
