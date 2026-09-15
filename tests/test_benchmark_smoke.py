import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from scripts import benchmark_smoke


class SmokeHarnessTests(unittest.TestCase):
    def test_entire_diagnostic_with_fake_transport_and_real_sqlite(self):
        original = subprocess.Popen
        def offline(args, *pos, **kw):
            if args[0] == 'node':
                args = [args[0], '--import', str(benchmark_smoke.ROOT / 'tests/benchmark_smoke_preload.mjs'), *args[1:]]
            return original(args, *pos, **kw)
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / 'isolated'
            with patch.dict(os.environ, {'ANTHROPIC_API_KEY': 'offline-not-a-key'}), patch.object(sys, 'argv', [
                    'smoke', '--allow-paid-no-cvent', '--output', str(output)]), patch.object(subprocess, 'Popen', side_effect=offline):
                self.assertEqual(benchmark_smoke.main(), 0)
            evidence = json.loads((output / 'smoke-evidence.json').read_text())
            self.assertTrue(evidence['passed'])
            self.assertEqual(evidence['cost']['physical_attempts'], 1)
            self.assertEqual(evidence['cost']['cumulative_cost_micro'], 45)
            self.assertTrue(evidence['result']['secondBlocked'])
            self.assertTrue(evidence['persistence_verified'])
            self.assertIn('BUILD_ALLOWANCE_HEADROOM', json.dumps(evidence['trace']))
            self.assertNotIn('offline-not-a-key', json.dumps(evidence))
