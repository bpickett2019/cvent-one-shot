import os
import sys
from pathlib import Path
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import run_with_keyvault


class KeyVaultRuntimeTests(unittest.TestCase):
    def test_production_loads_all_required_secrets(self):
        with patch.dict(os.environ, {"CVENT_ENV": "production"}, clear=True):
            self.assertEqual(run_with_keyvault.selected_secrets(), run_with_keyvault.SECRET_ENV_MAP)

    def test_explicit_staging_tunnel_fallback_loads_only_anthropic(self):
        environment = {
            "CVENT_ENV": "development",
            "CVENT_STAGING_TUNNEL_FALLBACK": "1",
        }
        with patch.dict(os.environ, environment, clear=True):
            self.assertEqual(
                run_with_keyvault.selected_secrets(),
                {"anthropic-api-key": "ANTHROPIC_API_KEY"},
            )

    def test_restricted_access_requires_exact_non_admin_staging_identity(self):
        valid = {
            **run_with_keyvault.RESTRICTED_STAGING_SETTINGS,
            "CVENT_STAGING_RESTRICTED_ACCESS_EXPIRES": (
                datetime.now(timezone.utc) + timedelta(days=1)
            ).isoformat(),
        }
        with patch.dict(os.environ, valid, clear=True):
            self.assertEqual(
                run_with_keyvault.selected_secrets(),
                {"anthropic-api-key": "ANTHROPIC_API_KEY"},
            )
        unsafe = {**valid, "CVENT_DEV_AUTH_ADMIN": "1"}
        with patch.dict(os.environ, unsafe, clear=True):
            with self.assertRaisesRegex(RuntimeError, "time-bounded non-admin staging deployment"):
                run_with_keyvault.selected_secrets()

    def test_restricted_access_cannot_run_in_production(self):
        environment = {"CVENT_ENV": "production", "CVENT_STAGING_RESTRICTED_ACCESS": "1"}
        with patch.dict(os.environ, environment, clear=True):
            with self.assertRaisesRegex(RuntimeError, "cannot run in production"):
                run_with_keyvault.selected_secrets()

    def test_development_cannot_use_keyvault_without_explicit_fallback(self):
        with patch.dict(os.environ, {"CVENT_ENV": "development"}, clear=True):
            with self.assertRaisesRegex(RuntimeError, "explicit staging tunnel fallback"):
                run_with_keyvault.selected_secrets()

    def test_fixed_no_cvent_diagnostic_is_not_a_general_command_exemption(self):
        script = Path(run_with_keyvault.__file__).resolve().parent / 'scripts/benchmark_smoke.py'
        command = [sys.executable, str(script), '--allow-paid-no-cvent', '--output', '/tmp/new-private-diagnostic']
        with patch.dict(os.environ, {'CVENT_STAGING_TUNNEL_FALLBACK': '1'}, clear=True):
            run_with_keyvault.validate_staging_command(command)
            for bad in ([sys.executable, '/tmp/benchmark_smoke.py', *command[2:]],
                        [sys.executable, str(script), '--job', *command[3:]],
                        [*command, '--model', 'other'], ['/bin/sh', *command[1:]]):
                with self.assertRaises(RuntimeError):
                    run_with_keyvault.validate_staging_command(bad)

    def test_staging_fallback_allows_only_loopback_app_or_bounded_probe(self):
        environment = {"CVENT_STAGING_TUNNEL_FALLBACK": "1"}
        probe = [
            "/usr/local/bin/pi", "--no-tools", "--no-session",
            "--provider", "anthropic", "--model", "claude-sonnet-4-6", "-p", "health",
        ]
        with patch.dict(os.environ, environment, clear=True):
            run_with_keyvault.validate_staging_command(probe)
            run_with_keyvault.validate_staging_command(["uvicorn", "--host", "127.0.0.1"])
            with self.assertRaisesRegex(RuntimeError, "only bind to loopback"):
                run_with_keyvault.validate_staging_command(["uvicorn", "--host", "0.0.0.0"])
            with self.assertRaisesRegex(RuntimeError, "must declare a loopback"):
                run_with_keyvault.validate_staging_command(["/bin/true"])


if __name__ == "__main__":
    unittest.main()
