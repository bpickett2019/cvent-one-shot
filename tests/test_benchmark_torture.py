"""Gate 1: adversarial accounting sequences. Fake transport only, never Cvent."""
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import Mock, patch

import test_benchmark_cost as fixture
from benchmark_assertions import assert_meter_consistent
from benchmark_cost import BenchmarkCost, BenchmarkDenied, MODEL, PRICING, PROVIDER
from control_store import ControlStore

ROOT = Path(__file__).resolve().parents[1]


class BenchmarkTortureTests(unittest.TestCase):
    def setUp(self):
        self.f = fixture.BenchmarkCostTests()
        self.f.setUp()
        self.addCleanup(self.f.doCleanups)
        self.provider = Mock()  # Only a call counter; no real provider exists.
        self.previous_cost = 0

    def observe(self):
        f = self.f
        value = assert_meter_consistent(f.costs, f.job, lambda _: f.directory,
                                        previous_cost=self.previous_cost)
        self.previous_cost = value['estimated_model_consumption_micro']
        self.assertEqual(value['logical_build_id'], f.build_id)
        return value

    def successful(self, request_id, purpose='configuration'):
        f = self.f
        f.reserve(request_id, purpose=purpose)
        self.observe()
        f.dispatch(request_id)
        self.provider()
        self.observe()
        f.receipt(request_id)
        return self.observe()

    def denied(self, code, purpose='configuration'):
        f = self.f
        before = f.costs.snapshot(f.job['id'])
        calls = self.provider.call_count
        with self.assertRaisesRegex(BenchmarkDenied, code):
            f.reserve('must_not_dispatch', purpose=purpose)
            f.dispatch('must_not_dispatch')
            self.provider()
        self.assertEqual(calls, self.provider.call_count)
        self.assertEqual(before, f.costs.snapshot(f.job['id']))
        self.observe()

    def test_pause_retry_compaction_and_auth_preserve_previous_consumption(self):
        f = self.f
        self.successful('settled_before_pause')
        baseline = f.gate.read()
        for change in ({'ownership': 'USER'}, {'desiredOwnership': 'USER'},
                       {'authWaiting': True}, {'transition': 'VERIFYING_AFTER_USER'}):
            for purpose in ('configuration', 'retry', 'compaction'):
                with self.subTest(change=change, purpose=purpose):
                    f.gate.write({**baseline, **change})
                    self.denied('PAUSED_', purpose)
                    self.assertEqual(self.previous_cost, 1050)
        f.gate.write(baseline)
        (f.directory/'state.json').write_text('{"status":"login_required"}')
        for purpose in ('configuration', 'retry', 'compaction'):
            self.denied('PAUSED_AUTH', purpose)
        self.assertEqual(self.provider.call_count, 1)

    def test_pending_handoff_cancels_only_undispatched_exposure(self):
        f = self.f
        self.successful('previous')
        f.reserve('waiting'); self.observe()
        f.gate.request_user()
        before_calls = self.provider.call_count
        with self.assertRaisesRegex(BenchmarkDenied, 'PAUSED_USER'):
            f.dispatch('waiting'); self.provider()
        self.assertEqual(self.provider.call_count, before_calls)
        f.costs.terminal('execution_one', 'waiting', 'CANCELLED')
        view = self.observe()
        self.assertEqual(view['estimated_model_consumption_micro'], 1050)
        self.assertEqual(view['unresolved_exposure_upper_micro'], 0)
        self.assertEqual(view['physical_requests'], 1)

    def test_malformed_receipts_do_not_erase_prior_spend_or_release_exposure(self):
        f = self.f
        self.successful('previous')
        f.reserve('bad'); f.dispatch('bad'); self.provider(); self.observe()
        good = dict(input=10, output=4, cacheRead=20, cacheWrite=30, totalTokens=64)
        for usage in ({}, {**good, 'output': -1}, {**good, 'output': 1.5},
                      {**good, 'input': True}, {**good, 'cacheRead': '20'},
                      {**good, 'totalTokens': 999}, dict.fromkeys(good, 0)):
            with self.subTest(usage=usage):
                with self.assertRaises(ValueError):
                    f.costs.settle('execution_one', 'bad', {'usage': usage, 'costMicro': 0})
                self.observe()
        f.costs.terminal('execution_one', 'bad', 'UNKNOWN')
        view = self.observe()
        self.assertEqual(view['estimated_model_consumption_micro'], 1050)
        self.assertEqual(view['unresolved_exposure_upper_micro'], 6_000_000)
        self.assertFalse(view['accounting_complete'])
        self.denied('OUTSTANDING_USAGE')
        with self.assertRaisesRegex(BenchmarkDenied, 'CANNOT_REFUND'):
            f.costs.terminal('execution_one', 'bad', 'CANCELLED')
        f.costs.approve(f.job['id'], actor='offline-operator', is_admin=True,
                        allowance_micro=60_000_000, reason='Synthetic approval, never a real allowance change')
        self.denied('OUTSTANDING_USAGE')
        self.assertEqual(self.observe()['estimated_model_consumption_micro'], 1050)

    def test_abrupt_process_exits_preserve_pending_dispatched_unknown_and_spend(self):
        f = self.f
        self.successful('previous')
        code = '''
import json, os, sys
from pathlib import Path
from benchmark_cost import BenchmarkCost
from control_store import ControlStore
p=json.loads(sys.argv[1]); store=ControlStore(p['db']); costs=BenchmarkCost(store)
job=store.get_job(p['job'])
if p['phase']=='PENDING':
    costs.reserve(job,p['token'],Path(p['directory']),'execution_one',p['meta'])
elif p['phase']=='DISPATCHED':
    costs.begin_dispatch(job,p['token'],Path(p['directory']),'execution_one','crashed')
else:
    costs.terminal('execution_one','crashed','UNKNOWN')
os._exit(23)  # No orderly worker cleanup, receipt or cancellation.
'''
        for phase in ('PENDING', 'DISPATCHED', 'UNKNOWN'):
            with self.subTest(phase=phase):
                payload = dict(db=str(f.store.path), job=f.job['id'], token=f.lease['token'],
                    directory=str(f.directory), phase=phase,
                    meta=dict(id='crashed', provider=PROVIDER, model=MODEL, pricingVersion=PRICING,
                              purpose='configuration', upperMicro=6_000_000))
                child = subprocess.run([sys.executable, '-c', code, json.dumps(payload)],
                    env={'PATH': os.environ['PATH'], 'HOME': str(f.root), 'PYTHONPATH': str(ROOT)},
                    cwd=ROOT, capture_output=True, text=True, timeout=20)
                self.assertEqual(child.returncode, 23, child.stderr)
                f.store = ControlStore(f.store.path); f.costs = BenchmarkCost(f.store)
                view = self.observe()
                self.assertEqual(view['estimated_model_consumption_micro'], 1050)
                self.assertEqual(view['unresolved_exposure_upper_micro'], 6_000_000)
                self.assertFalse(view['accounting_complete'])
                row = f.costs.snapshot(f.job['id'])['requests'][-1]
                self.assertEqual(row['state'], phase)
                self.assertIsNone(row['usage']); self.assertIsNone(row['cost_micro'])
                with self.assertRaisesRegex(BenchmarkDenied, 'OUTSTANDING_USAGE'):
                    f.costs.register_execution(f.job['id'], 'resume', 'session_one', 'a'*40)
                self.denied('OUTSTANDING_USAGE', 'retry')

    def test_changing_failure_ids_and_unrelated_reads_stop_at_three(self):
        f = self.f
        self.successful('previous')
        for index in range(3):
            result = f.costs.failure(f.job['id'], 'browser_script', f'/editor?request_id={index}',
                f'Control not found @ref{index}; request_id=00000000-0000-4000-8000-{index:012d}; pid={index}')
            self.assertEqual(result['count'], index + 1)
            self.assertEqual(result['paused'], index == 2)
            # Successful unrelated reads and meter refreshes cannot reset the blocker.
            self.assertEqual(json.loads((f.directory/'state.json').read_text())['status'], 'running')
            self.observe(); self.observe()
            if index < 2:
                self.successful(f'unrelated_response_{index}')
                self.assertEqual(f.costs.snapshot(f.job['id'])['blocker_episodes'][0]['count'], index+1)
        for purpose in ('configuration', 'retry', 'compaction'):
            self.denied('BLOCKER_CONTROL_NOT_FOUND', purpose)
        self.assertEqual(self.provider.call_count, 3)
        self.assertEqual(self.previous_cost, 3150)

    def test_exhaustion_then_explicit_increase_never_resets_accounting(self):
        # Small authorization only in an isolated fake fixture. Production untouched.
        with patch('benchmark_cost.INITIAL_ALLOWANCE', 1050):
            self.f = fixture.BenchmarkCostTests(); self.f.setUp()
        f = self.f
        self.addCleanup(f.doCleanups)
        f.reserve('first', upper=1050); self.observe()
        f.dispatch('first'); self.provider(); f.receipt('first'); self.observe()
        self.assertEqual(self.observe()['remaining_authorization_micro'], 0)
        self.denied('ALLOWANCE_HEADROOM')
        before = f.costs.snapshot(f.job['id'])
        with self.assertRaises(PermissionError):
            f.costs.approve(f.job['id'], actor='model', is_admin=False,
                           allowance_micro=60_000_000, reason='Not authorized')
        with self.assertRaises(ValueError):
            f.costs.approve(f.job['id'], actor='operator', is_admin=True,
                           allowance_micro=1050, reason='Cannot reset authorization')
        self.assertEqual(before, f.costs.snapshot(f.job['id']))
        f.costs.approve(f.job['id'], actor='offline-operator', is_admin=True,
                       allowance_micro=2100, reason='Explicit synthetic increase by 1050 micro-USD')
        f.store = ControlStore(f.store.path); f.costs = BenchmarkCost(f.store)
        f.costs.register_execution(f.job['id'], 'execution_resume', 'session_one', 'a'*40)
        view = self.observe()
        self.assertEqual(view['estimated_model_consumption_micro'], 1050)
        self.assertEqual(view['remaining_authorization_micro'], 1050)
        f.costs.reserve(f.job, f.lease['token'], f.directory, 'execution_resume',
            dict(id='second', provider=PROVIDER, model=MODEL, pricingVersion=PRICING,
                 purpose='configuration', upperMicro=1050))
        self.observe()
        f.costs.begin_dispatch(f.job, f.lease['token'], f.directory, 'execution_resume', 'second')
        self.provider(); self.observe()
        f.costs.settle('execution_resume', 'second', {'usage': dict(input=100, output=20,
            cacheRead=1000, cacheWrite=40, totalTokens=1160), 'costMicro': 1050})
        self.observe()
        self.assertEqual(self.observe()['estimated_model_consumption_micro'], 2100)
        self.denied('ALLOWANCE_HEADROOM')
        self.assertEqual(self.provider.call_count, 2)
