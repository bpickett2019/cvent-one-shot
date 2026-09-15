"""Installed Pi SDK tests with fake fetch and memory-only credentials."""
import json
import os
import shutil
import subprocess
import unittest
from pathlib import Path


class ModelRequestGuardTests(unittest.TestCase):
    def test_offline_transport_and_compaction(self):
        executable = shutil.which("pi")
        if not executable or not shutil.which("node"):
            self.skipTest("Installed Pi/Node required; deployment gate must run this test")
        sdk = None
        for parent in Path(executable).resolve().parents:
            manifest = parent / "package.json"
            if manifest.is_file() and json.loads(manifest.read_text()).get("name") == "@earendil-works/pi-coding-agent":
                sdk = parent / "dist/index.js"
                break
        self.assertIsNotNone(sdk, "Cannot locate installed SDK; do not silently skip integration")
        result = subprocess.run(["node", "tests/model_request_guard.mjs", str(sdk)],
                                cwd=Path(__file__).resolve().parents[1],
                                env={"PATH": os.environ["PATH"], "PI_OFFLINE": "1", "PI_TELEMETRY": "0"},
                                capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, (result.stdout + result.stderr)[-6000:])
        self.assertIn("zero real network", result.stdout)


if __name__ == "__main__":
    unittest.main()
