"""Locate and pin the installed SDK without reading credentials or making requests."""
import json
import shutil
from pathlib import Path
from benchmark_cost import BenchmarkDenied, PI_VERSION


def sdk_environment():
    executable = shutil.which("pi")
    if not executable:
        raise BenchmarkDenied("PI_SDK_UNAVAILABLE")
    for parent in Path(executable).resolve().parents:
        manifest = parent / "package.json"
        if not manifest.is_file():
            continue
        package = json.loads(manifest.read_text())
        if package.get("name") != "@earendil-works/pi-coding-agent":
            continue
        if package.get("version") != PI_VERSION:
            raise BenchmarkDenied("PI_VERSION_MISMATCH")
        entry = parent / "dist/index.js"
        if not entry.is_file():
            raise BenchmarkDenied("PI_SDK_UNAVAILABLE")
        return {"CVENT_PI_SDK_ENTRY": str(entry), "CVENT_PI_VERSION": PI_VERSION}
    raise BenchmarkDenied("PI_SDK_UNAVAILABLE")
