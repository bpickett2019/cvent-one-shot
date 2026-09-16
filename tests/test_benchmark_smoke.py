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
    def run_offline(self, mode='success'):
        original = subprocess.Popen
        def offline(args, *pos, **kw):
            if args[0] == 'node':
                args = [args[0], '--import', str(benchmark_smoke.ROOT / 'tests/benchmark_smoke_preload.mjs'), *args[1:]]
                kw['env']['CVENT_OFFLINE_SMOKE_CASE'] = mode
            return original(args, *pos, **kw)
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / 'isolated'
            with patch.dict(os.environ, {'ANTHROPIC_API_KEY': 'offline-not-a-key'}), patch.object(sys, 'argv', [
                    'smoke', '--allow-paid-no-cvent', '--output', str(output)]), patch.object(subprocess, 'Popen', side_effect=offline):
                result = benchmark_smoke.main()
            evidence = json.loads((output / 'smoke-evidence.json').read_text())
            self.assertNotIn('offline-not-a-key', json.dumps(evidence))
            self.assertNotIn('PRIVATE_PROVIDER_BODY_MUST_NOT_APPEAR', json.dumps(evidence))
            self.assertEqual(evidence['result']['networkCalls'], 1)
            self.assertEqual(evidence['cost']['physical_attempts'], 1)
            # Read-only reopen; never invoke a new diagnostic or repair UNKNOWN.
            from benchmark_cost import BenchmarkCost
            from control_store import ControlStore
            reopened = BenchmarkCost(ControlStore(output / 'control.db', lease_seconds=300))
            self.assertEqual(reopened.snapshot(evidence['meter']['job_id']), evidence['cost'])
            from benchmark_assertions import assert_meter_consistent
            view = assert_meter_consistent(reopened, reopened.store.get_job(evidence['meter']['job_id']), lambda _: output/'job')
            for field in ('tokens', 'physical_requests', 'responses', 'accounting_complete',
                          'estimated_model_consumption_micro', 'remaining_authorization_micro',
                          'unresolved_exposure_upper_micro', 'outstanding_requests'):
                self.assertEqual(view[field], evidence['meter'][field])
            return result, evidence

    def test_entire_diagnostic_with_fake_transport_and_real_sqlite(self):
        result, evidence = self.run_offline()
        self.assertEqual(result, 0)
        self.assertTrue(evidence['passed'])
        self.assertEqual(evidence['cost']['cumulative_cost_micro'], 30)
        self.assertTrue(evidence['result']['secondBlocked'])
        self.assertTrue(evidence['persistence_verified'])
        self.assertIn('BUILD_ALLOWANCE_HEADROOM', json.dumps(evidence['trace']))
        self.assertEqual(evidence['result']['transport'], [dict(
            attempt=1, httpStatus=200, responseFormat='sse', transportError=None)])

    def test_cache_and_reasoning_usage_use_existing_accounting_and_meter(self):
        result, evidence = self.run_offline('usage_categories')
        self.assertEqual(result, 0)
        self.assertEqual(evidence['cost']['tokens'], dict(input=10, output=4, cacheRead=20, cacheWrite=30, totalTokens=64))
        # Two reasoning tokens are a subset of four output tokens, never added twice.
        self.assertEqual(evidence['cost']['cumulative_cost_micro'], 139)
        self.assertEqual(evidence['meter']['estimated_model_consumption_micro'], 139)
        self.assertTrue(evidence['persistence_verified'])
        self.assertTrue(evidence['result']['secondBlocked'])

    def test_malformed_usage_never_settles_or_retries(self):
        for mode in ('malformed_negative', 'malformed_fraction', 'malformed_string', 'malformed_null'):
            with self.subTest(mode=mode):
                result, evidence = self.run_offline(mode)
                self.assertEqual(result, 1)
                self.assert_unknown(evidence)
                self.assertEqual(evidence['meter']['responses'], 0)
                self.assertFalse(evidence['meter']['accounting_complete'])

    def assert_unknown(self, evidence):
        self.assertFalse(evidence['passed'])
        self.assertFalse(evidence['cost']['accounting_complete'])
        self.assertEqual(evidence['cost']['requests'][0]['state'], 'UNKNOWN')
        self.assertIsNone(evidence['cost']['requests'][0]['cost_micro'])
        self.assertEqual(evidence['cost']['unresolved_exposure_upper_micro'], 2501280)
        self.assertNotIn('reopen_and_reduce_test_allowance', json.dumps(evidence['trace']))

    def test_http_errors_reproduce_unknown_without_retry_and_keep_safe_status(self):
        for status in (400, 401, 403, 429, 500, 529):
            with self.subTest(status=status):
                result, evidence = self.run_offline(f'http_{status}')
                self.assertEqual(result, 1)
                self.assert_unknown(evidence)
                self.assertEqual(evidence['result']['stopCode'], 'USAGE_RECONCILIATION_REQUIRED')
                self.assertEqual(evidence['result']['transport'], [dict(
                    attempt=1, httpStatus=status, responseFormat='json', transportError=None)])

    def test_incomplete_streams_reproduce_same_unknown_as_http_errors(self):
        for mode in ('truncated', 'missing_usage', 'sse_error', 'no_body'):
            with self.subTest(mode=mode):
                result, evidence = self.run_offline(mode)
                self.assertEqual(result, 1)
                self.assert_unknown(evidence)
                self.assertEqual(evidence['result']['stopCode'], 'USAGE_RECONCILIATION_REQUIRED')
                self.assertEqual(evidence['result']['transport'][0]['httpStatus'], 200)

    def test_transport_failures_preserve_unknown_and_no_raw_exception(self):
        for mode, category in (('transport', 'TypeError'), ('timeout', 'TimeoutError')):
            with self.subTest(mode=mode):
                result, evidence = self.run_offline(mode)
                self.assertEqual(result, 1)
                self.assert_unknown(evidence)
                self.assertIn('ADMISSION_OR_TRANSPORT_FAILURE', json.dumps(evidence['trace']))
                self.assertEqual(evidence['result']['stopCode'], 'ADMISSION_OR_PROVIDER_FAILURE')
                self.assertEqual(evidence['result']['transport'], [dict(
                    attempt=1, httpStatus=None, responseFormat=None, transportError=category)])
