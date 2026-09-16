import hashlib
import io
import json
import os
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from benchmark_cost import BenchmarkCost, BenchmarkDenied, MODEL, PRICING, PROVIDER, charge
from benchmark_evidence import validate_manifest, write_report
from browser_gate import BrowserGate, model_control_lock
from control_store import ControlStore
from job_runner import ActiveJob, JobRunner


class BenchmarkCostTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.store = ControlStore(self.root / 'control.db')
        self.owner = self.store.ensure_user('operator', 'offline@example.invalid', 'Offline', True)
        self.event = SimpleNamespace(event_id='event', event_key='event', name='Selected Event')
        self.job = self.store.create_job(self.owner, self.event, 'RR.xlsx')
        self.directory = self.root / self.job['id']; self.directory.mkdir()
        (self.directory / 'input.xlsx').write_bytes(b'offline workbook')
        (self.directory / 'state.json').write_text('{"status":"running"}')
        self.gate = BrowserGate(self.directory); self.gate.initialize()
        self.costs = BenchmarkCost(self.store)
        self.build_id = self.costs.bind(self.job, self.directory)
        self.lease = self.store.reserve_now(self.job['id'], 'operator', serialized=True)
        self.costs.register_execution(self.job['id'], 'execution_one', 'session_one', 'a' * 40)

    def reserve(self, request_id='request_one', purpose='configuration', upper=6_000_000):
        self.costs.reserve(self.job, self.lease['token'], self.directory, 'execution_one', {
            'id': request_id, 'provider': PROVIDER, 'model': MODEL, 'pricingVersion': PRICING,
            'purpose': purpose, 'upperMicro': upper})

    def dispatch(self, request_id='request_one'):
        self.costs.begin_dispatch(self.job, self.lease['token'], self.directory, 'execution_one', request_id)

    def receipt(self, request_id='request_one', input=100, output=20):
        usage = {'input': input, 'output': output, 'cacheRead': 1000, 'cacheWrite': 40,
                 'totalTokens': input+output+1040}
        self.costs.settle('execution_one', request_id, {'usage': usage, 'costMicro': charge(usage), 'durationMs': 500, 'stopReason': 'stop'})

    def test_cumulative_usage_and_duplicate_settlement(self):
        self.reserve(); self.dispatch(); self.receipt(); self.receipt()
        view = self.costs.snapshot(self.job['id'])
        self.assertEqual(view['cumulative_cost_micro'], 1050)
        self.assertEqual(view['tokens']['totalTokens'], 1160)
        self.assertEqual(view['physical_attempts'], 1)
        self.assertTrue(view['accounting_complete'])
        self.assertEqual(view['context_tokens']['median'], 1140)

    def test_pause_blocks_every_permitted_purpose(self):
        for change in ({'ownership': 'USER'}, {'desiredOwnership': 'USER'}, {'authWaiting': True},
                       {'agentPaused': True}, {'transition': 'VERIFYING_AFTER_USER'}):
            for purpose in ('configuration', 'retry', 'compaction'):
                with self.subTest(change=change, purpose=purpose):
                    self.gate.initialize(); self.gate.update(change)
                    with self.assertRaises(BenchmarkDenied): self.reserve(purpose=purpose)
        self.assertEqual(self.costs.snapshot(self.job['id'])['physical_attempts'], 0)

    def test_auth_status_and_missing_control_fail_closed(self):
        (self.directory/'state.json').write_text('{"status":"login_required"}')
        with self.assertRaisesRegex(BenchmarkDenied, 'PAUSED_AUTH'): self.reserve()
        (self.directory/'state.json').unlink()
        with self.assertRaisesRegex(BenchmarkDenied, 'CONTROL_STATE_UNKNOWN'): self.reserve()

    def test_handoff_between_reserve_and_dispatch(self):
        self.reserve(); self.gate.request_user()
        with self.assertRaisesRegex(BenchmarkDenied, 'PAUSED_USER'): self.dispatch()
        self.costs.terminal('execution_one', 'request_one', 'CANCELLED')
        self.assertEqual(self.costs.snapshot(self.job['id'])['physical_attempts'], 0)

    def test_accepted_dispatch_remains_accountable_after_handoff(self):
        self.reserve(); self.dispatch(); self.gate.request_user(); self.receipt()
        self.assertEqual(self.costs.snapshot(self.job['id'])['physical_attempts'], 1)
        with self.assertRaises(BenchmarkDenied): self.reserve('two')

    def test_dispatch_waits_for_shared_short_boundary(self):
        self.reserve()
        started = threading.Event()
        def dispatch():
            started.set()
            with self.assertRaisesRegex(BenchmarkDenied, 'PAUSED_USER'): self.dispatch()
        with ThreadPoolExecutor(1) as pool:
            with model_control_lock(self.directory):
                future = pool.submit(dispatch); self.assertTrue(started.wait(1))
                self.gate.request_user()  # Reentrant controller boundary.
            future.result(timeout=3)

    def test_action_cleanup_cannot_clear_requested_handoff(self):
        with self.gate.action('runtime', 'PI_EGO'):
            self.gate.request_user()
        self.assertEqual(self.gate.read()['desiredOwnership'], 'USER')
        with self.assertRaises(BenchmarkDenied): self.reserve()

    def test_serial_admission_race(self):
        def attempt(i):
            try: self.reserve(f'request_{i}'); return True
            except BenchmarkDenied: return False
        with ThreadPoolExecutor(6) as pool:
            self.assertEqual(sum(pool.map(attempt, range(6))), 1)

    def test_worker_serialization_and_runtime_lease(self):
        another = self.store.create_job(self.owner, SimpleNamespace(event_id='other', event_key='other', name='Other'), 'RR.xlsx')
        with self.assertRaisesRegex(ValueError, 'Serialized benchmark'): self.store.reserve_now(another['id'], 'operator', serialized=True)
        self.store.reserve_now(another['id'], 'operator')
        with self.assertRaisesRegex(BenchmarkDenied, 'NOT_EXCLUSIVE'): self.reserve()

    def test_unknown_and_pending_usage_survive_restart(self):
        for state in ('PENDING', 'DISPATCHED', 'UNKNOWN'):
            with self.subTest(state=state):
                if state == 'PENDING': self.reserve()
                if state == 'DISPATCHED': self.dispatch()
                if state == 'UNKNOWN': self.costs.terminal('execution_one', 'request_one', 'UNKNOWN')
                restarted = BenchmarkCost(ControlStore(self.store.path))
                self.assertFalse(restarted.snapshot(self.job['id'])['accounting_complete'])
                with self.assertRaisesRegex(BenchmarkDenied, 'OUTSTANDING_USAGE'):
                    restarted.register_execution(self.job['id'], 'execution_two', 'session_two', 'a'*40)
                with self.assertRaisesRegex(BenchmarkDenied, 'OUTSTANDING_USAGE'): self.reserve('two')

    def test_missing_usage_does_not_settle_or_refund(self):
        self.reserve(); self.dispatch()
        for usage in ({}, {'totalTokens': 0}, {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0, 'totalTokens': 0}):
            with self.assertRaises(ValueError): self.costs.settle('execution_one', 'request_one', {'usage': usage, 'costMicro': 0})
        with self.assertRaises(BenchmarkDenied): self.costs.terminal('execution_one', 'request_one', 'CANCELLED')
        self.assertFalse(self.costs.snapshot(self.job['id'])['accounting_complete'])

    def test_budget_cumulative_50_to_60_without_reset(self):
        # Repeated finalized requests reach $48, then the conservative next-request
        # headroom denies admission. The extra allowance is explicit, not a reset.
        for index in range(8):
            self.reserve(f'r{index}', upper=6_000_000); self.dispatch(f'r{index}')
            usage = {'input': 0, 'output': 400000, 'cacheRead': 0, 'cacheWrite': 0, 'totalTokens': 400000}
            self.costs.settle('execution_one', f'r{index}', {'usage': usage, 'costMicro': 6_000_000})
        with self.assertRaisesRegex(BenchmarkDenied, 'ALLOWANCE_HEADROOM'): self.reserve('next')
        view = self.costs.approve(self.job['id'], actor='operator', is_admin=True, allowance_micro=60_000_000, reason='Explicit extra $10')
        self.assertEqual(view['cumulative_cost_micro'], 48_000_000)
        self.assertEqual(view['allowance_micro'], 60_000_000)
        self.reserve('next')
        self.assertEqual(len(view['requests']), 8)

    def test_approval_requires_operator_and_never_clears_unknown(self):
        self.reserve(); self.dispatch()
        with self.assertRaises(PermissionError): self.costs.approve(self.job['id'], actor='model', is_admin=False, allowance_micro=60_000_000, reason='no')
        self.costs.approve(self.job['id'], actor='operator', is_admin=True, allowance_micro=60_000_000, reason='extra')
        with self.assertRaisesRegex(BenchmarkDenied, 'OUTSTANDING_USAGE'): self.reserve('next')

    def test_reupload_and_restart_reuse_build(self):
        self.reserve(); self.dispatch(); self.receipt()
        other = self.store.create_job(self.owner, self.event, 'again.xlsx')
        other_dir = self.root/'other'; other_dir.mkdir(); (other_dir/'input.xlsx').write_bytes(b'offline workbook')
        self.assertEqual(self.costs.bind(other, other_dir), self.build_id)
        self.assertEqual(BenchmarkCost(ControlStore(self.store.path)).snapshot(other['id'])['cumulative_cost_micro'], 1050)
        (other_dir/'input.xlsx').write_bytes(b'changed')
        with self.assertRaisesRegex(BenchmarkDenied, 'BINDING_CHANGED'): self.costs.bind(other, other_dir)

    def test_unrelated_build_does_not_inherit_unknown_exposure(self):
        self.reserve('old_unknown', upper=3_751_920); self.dispatch('old_unknown')
        self.costs.terminal('execution_one', 'old_unknown', 'UNKNOWN')
        original = self.costs.snapshot(self.job['id'])
        other = self.store.create_job(self.owner,
            SimpleNamespace(event_id='unrelated_canary', event_key='unrelated_canary', name='No Cvent canary'), 'fake.txt')
        directory = self.root/'unrelated-canary'; directory.mkdir()
        (directory/'input.xlsx').write_bytes(b'distinct offline binding, not a Cvent workbook')
        build = self.costs.bind(other, directory)
        self.assertNotEqual(build, self.build_id)
        view = self.costs.snapshot(other['id'])
        self.assertEqual(view['cumulative_cost_micro'], 0)
        self.assertEqual(view['unresolved_exposure_upper_micro'], 0)
        self.assertEqual(view['requests'], [])
        self.assertEqual(view['outstanding_requests'], [])
        self.assertTrue(view['accounting_complete'])
        from benchmark_assertions import assert_meter_consistent
        projected = assert_meter_consistent(self.costs, other, lambda _: directory)
        self.assertEqual(projected['unresolved_exposure_upper_micro'], 0)
        self.assertEqual(projected['remaining_authorization_micro'], view['allowance_micro'])
        # This separate database-wide serialization veto is NOT cost inheritance.
        # Keep it intact: no unrelated-build accounting fix is needed.
        with self.assertRaisesRegex(BenchmarkDenied, 'OUTSTANDING_USAGE'):
            self.costs.register_execution(other['id'], 'canary_execution', 'canary_session', 'a'*40)
        self.assertEqual(self.costs.snapshot(self.job['id']), original)
        self.assertIsNone(original['requests'][0]['cost_micro'])
        self.assertEqual(original['unresolved_exposure_upper_micro'], 3_751_920)

    def test_another_workspace_cannot_attach_to_or_reset_the_build(self):
        owner = self.store.ensure_user('other-owner', 'other@example.invalid', 'Other', False)
        job = self.store.create_job(owner, self.event, 'RR.xlsx')
        directory = self.root/'other-owner'; directory.mkdir()
        (directory/'input.xlsx').write_bytes(b'offline workbook')
        with self.assertRaisesRegex(BenchmarkDenied, 'BUILD_OWNERSHIP_MISMATCH'):
            self.costs.bind(job, directory)
        with self.assertRaisesRegex(BenchmarkDenied, 'UNBOUND_BUILD'):
            self.costs.snapshot(job['id'])

    def test_no_legacy_import_or_silent_zero(self):
        legacy = self.store.create_job(self.owner, SimpleNamespace(event_id='legacy', event_key='legacy', name='Legacy'), 'RR.xlsx')
        directory = self.root/'legacy'; directory.mkdir(); (directory/'input.xlsx').write_bytes(b'old')
        (directory/'provider-probe.json').write_text('{}')
        with self.assertRaisesRegex(BenchmarkDenied, 'UNTRACKED_LEGACY'): self.costs.bind(legacy, directory)

    def test_equivalent_failures_ignore_volatile_refs_and_unrelated_work(self):
        for index in range(3):
            episode = self.costs.failure(self.job['id'], 'browser_script', 'https://app.cvent.com/editor?token=SECRET', f'Control not found @ref{index}; pid={index}')
            # Unrelated successful paid responses cannot reset this scoped blocker.
            if index < 2:
                self.reserve(f'r{index}'); self.dispatch(f'r{index}'); self.receipt(f'r{index}')
        self.assertEqual(episode['count'], 3); self.assertTrue(episode['paused'])
        with self.assertRaisesRegex(BenchmarkDenied, 'BLOCKER_CONTROL_NOT_FOUND'): self.reserve('next')
        with self.store.connect() as conn:
            self.assertNotIn('SECRET', json.dumps([dict(r) for r in conn.execute('SELECT * FROM benchmark_blockers')]))
        self.costs.approve(self.job['id'], actor='operator', is_admin=True, resolve_blockers=True, reason='Fresh read proves the missing control is available; no uncertain mutation cleared')
        self.reserve('reviewed')

    def test_distinct_operation_and_surface_do_not_conflate(self):
        for operation, surface in [('read', '/a'), ('click', '/a'), ('click', '/b')]:
            result = self.costs.failure(self.job['id'], operation, surface, 'Control not found @1')
            self.assertEqual(result['count'], 1)
            self.assertFalse(result['paused'])

    def test_ownership_failures_pause_immediately(self):
        result = self.costs.failure(self.job['id'], 'cvent_login_handoff', '/login', 'Browser is not agent-owned')
        self.assertTrue(result['paused']); self.assertEqual(result['count'], 1)
        with self.assertRaises(BenchmarkDenied): self.reserve()

    def test_pricing_mismatch_records_truth_and_blocks(self):
        self.reserve(upper=1); self.dispatch()
        self.receipt()
        self.assertEqual(self.costs.snapshot(self.job['id'])['cumulative_cost_micro'], 1050)
        with self.assertRaisesRegex(BenchmarkDenied, 'PRICING_RECONCILIATION'): self.reserve('next')

    def test_disabled_inference_probe_has_zero_network(self):
        import provider_probe
        with patch.dict(os.environ, {'CVENT_MODEL_BENCHMARK': '1', 'ANTHROPIC_API_KEY': 'offline'}), patch('provider_probe.urllib.request.urlopen') as network, patch('sys.stdout', new_callable=io.StringIO):
            with self.assertRaises(SystemExit): provider_probe.main()
            network.assert_not_called()

    def test_runner_pin_and_probe_do_not_spend(self):
        with patch.dict(os.environ, {'CVENT_MODEL_BENCHMARK': '1', 'CVENT_PI_PROVIDER': PROVIDER, 'CVENT_PI_MODEL': MODEL,
                                     'CVENT_PI_THINKING': 'high', 'CVENT_EXECUTION_MODE': 'simple', 'ANTHROPIC_API_KEY': 'offline'}):
            runner = JobRunner(self.store)
            with patch('job_runner.subprocess.run') as process:
                self.assertEqual(runner.verify_provider_access(self.directory)['classification'], 'credential_present_not_probed')
                process.assert_not_called()
            command = runner.pi_command(self.job, self.directory, {}, 'Offline prompt')
            self.assertTrue(command[1].endswith('run_pi_guarded.mjs'))
            active = ActiveJob(self.job['id'], self.lease['token'], 1, threading.Event(), model_token='private', execution_id='execution_one')
            runner._active[self.job['id']] = active
            env = runner.pi_environment(self.job, self.lease['token'], 1)
            self.assertEqual(env['CVENT_MODEL_TOKEN'], 'private')
            self.assertEqual(env['CVENT_PI_THINKING'], 'high')

    def test_manifest_required_and_pins_workload(self):
        with self.assertRaises(BenchmarkDenied): validate_manifest(self.directory, self.job, 'a'*40)
        path = self.directory/'evidence.txt'; path.write_text('Offline evidence fixture; never a real benchmark authorization')
        reference = {'path': path.name, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
        manifest = {'runtime': {'provider': PROVIDER, 'model': MODEL, 'thinking': 'high', 'pi_version': '0.84.4', 'execution_mode': 'simple', 'pricing_basis': PRICING, 'revision': 'a'*40},
                    'target': {'event_id': 'event', 'event_key': 'event', 'event_name': 'Selected Event'},
                    'rr_sha256': hashlib.sha256(b'offline workbook').hexdigest(), 'rr_version': 'fixture',
                    'authorized': True, 'authorized_by': 'offline-test', 'workload': 'write_heavy_full_rr', 'remaining_work': ['fixture writes'],
                    'starting_state_evidence': reference, 'remaining_work_evidence': reference, 'fault_test_evidence': reference,
                    'provider_limit_evidence': reference, 'fault_test_revision': 'a'*40, 'provider_limit_verified': True}
        (self.directory/'benchmark-manifest.json').write_text(json.dumps(manifest))
        self.assertEqual(validate_manifest(self.directory, self.job, 'a'*40)['workload'], 'write_heavy_full_rr')
        with self.assertRaises(BenchmarkDenied): validate_manifest(self.directory, self.job, 'b'*40)
        path.write_text('changed')
        with self.assertRaises(BenchmarkDenied): validate_manifest(self.directory, self.job, 'a'*40)

    def test_report_uses_flat_telemetry_and_requires_independent_review(self):
        self.reserve(); self.dispatch(); self.receipt()
        (self.directory/'performance-events.jsonl').write_text('\n'.join(json.dumps(e) for e in [
            {'kind': 'anthropic_response', 'totalTokens': 1160},
            {'kind': 'browser_operation', 'durationMs': 123, 'actionCount': 8, 'egoExecutionRound': True},
            {'kind': 'browser_preview_retrieval', 'bytes': 1234},
        ]))
        (self.directory/'model-control-events.jsonl').write_text(json.dumps({'at': '2026-01-01T00:00:00Z', 'ownership': 'AGENT', 'desiredOwnership': 'AGENT'})+'\n')
        report = write_report(self.costs, self.job, lambda _: self.directory)
        self.assertEqual(report['execution_metrics']['ego_actions'], 8)
        self.assertEqual(report['execution_metrics']['browser_execution_ms'], 123)
        self.assertEqual(report['execution_metrics']['preview_retrieval_bytes'], 1234)
        self.assertEqual(report['completion_status'], 'INDEPENDENT_FULL_RR_REVIEW_REQUIRED')
        self.assertEqual(report['telemetry_gaps'], [])
        (self.directory/'input.xlsx').write_bytes(b'changed during run')
        self.assertIn('RR changed', write_report(self.costs, self.job, lambda _: self.directory)['telemetry_gaps'][0])


if __name__ == '__main__': unittest.main()
