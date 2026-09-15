import json
import unittest
from unittest.mock import patch

import test_benchmark_cost as fixture
from benchmark_cost import BenchmarkCost
from benchmark_meter import meter


class MeterTests(unittest.TestCase):
    def setUp(self):
        self.f = fixture.BenchmarkCostTests()
        self.f.setUp()
        self.addCleanup(self.f.doCleanups)

    def view(self):
        f = self.f
        return meter(f.costs.snapshot(f.job['id']), f.store.get_job(f.job['id']), lambda _: f.directory, f.store)

    def test_real_receipt_fields_survive_reopen_and_approval_without_reset(self):
        f = self.f
        f.reserve(); f.dispatch(); f.receipt()
        before = self.view()
        f.costs = BenchmarkCost(f.store)
        f.costs.approve(f.job['id'], actor='operator', is_admin=True, allowance_micro=60_000_000, reason='offline fixture')
        after = self.view()
        self.assertEqual(before['estimated_model_consumption_micro'], 1050)
        self.assertEqual(after['estimated_model_consumption_micro'], 1050)
        self.assertEqual(after['allowance_micro'], 60_000_000)
        self.assertEqual(after['latest_context_tokens'], 1140)
        self.assertIsNone(after['actual_provider_charges_micro'])
        self.assertIsNone(after['subscription_quota_remaining'])
        self.assertEqual(after['tokens']['totalTokens'], 1160)
        self.assertEqual(after['authentication_mode'], 'Anthropic API key')

    def test_unresolved_usage_is_not_zero_and_reads_never_clear_blockers(self):
        f = self.f
        f.reserve(); f.dispatch()
        for _ in range(3): f.costs.failure(f.job['id'], 'click', '/settings', 'Control not found')
        before = f.costs.snapshot(f.job['id'])
        files = {p: p.stat().st_mtime_ns for p in f.directory.iterdir() if p.is_file()}
        with patch('subprocess.Popen', side_effect=AssertionError('Meter cannot launch inference')):
            value = self.view(); self.view()
        self.assertEqual(before, f.costs.snapshot(f.job['id']))
        self.assertEqual(files, {p: p.stat().st_mtime_ns for p in files})
        self.assertFalse(value['accounting_complete'])
        self.assertEqual(value['unresolved_exposure_upper_micro'], 6_000_000)
        self.assertEqual(value['remaining_authorization_micro'], 44_000_000)
        self.assertEqual(value['pause_code'], 'BLOCKER_CONTROL_NOT_FOUND')
        self.assertTrue(value['telemetry_gaps'])

    def test_existing_browser_and_progress_telemetry_only(self):
        f = self.f
        (f.directory / 'performance-events.jsonl').write_text('\n'.join(map(json.dumps, [
            {'kind': 'browser_operation', 'egoExecutionRound': True, 'actionCount': 5},
            {'kind': 'MODEL_RESPONSE_WITH_ZERO_PROGRESS'},
        ])))
        value = self.view()
        self.assertEqual(value['counters']['browser_batches'], 1)
        self.assertEqual(value['counters']['browser_actions'], 5)
        self.assertEqual(value['counters']['zero_progress_responses'], 1)
        self.assertEqual(value['counters']['acknowledged_persisted_outcomes'], 0)

    def test_meter_html_uses_text_content_not_untrusted_html(self):
        from pathlib import Path
        html = (Path(__file__).resolve().parents[1] / 'templates/index.html').read_text()
        self.assertIn('renderModelMeter();', html)
        renderer = html.split('function renderModelMeter(){')[1].split('function duration(s)')[0]
        self.assertIn('out.textContent=', renderer)
        self.assertNotIn('innerHTML', renderer)
        self.assertIn('Consumption unknown, not $0', renderer)
