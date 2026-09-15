import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from job_runner import ActiveJob, JobRunner


class UsageMonitorTests(unittest.TestCase):
    def test_model_admission_stop_overrides_an_old_success_report(self):
        with tempfile.TemporaryDirectory() as folder:
            directory = Path(folder)
            (directory/'model-admission-stop-42.json').write_text('{"reason":"OUTSTANDING_USAGE"}')
            (directory/'final-report.json').write_text('{"status":"DRAFT_COMPLETE","completion_reason":"old success"}')
            (directory/'state.json').write_text('{"pending":["Remaining work"]}')
            runner = JobRunner(Mock())
            runner.store.get_job.return_value = None
            runner.benchmark = Mock()
            runner.benchmark.snapshot.return_value = {'accounting_complete': False, 'pause_code': None}
            active = ActiveJob('job_test', 'token', 1, threading.Event(), Mock(pid=42))
            active.process.wait.return_value = 0
            with patch('job_runner.job_dir', return_value=directory), patch('job_runner.benchmark_enabled', return_value=True), \
                 patch('job_runner.mutation_outcome', return_value={'hasAttempts': True, 'unresolved': True}), \
                 patch.object(runner, '_provider_failure', return_value=None), patch.object(runner, 'steel_command'), \
                 patch.object(runner, '_finish_after_lease_loss') as finish, patch.object(runner, 'prepare_environment', return_value={}), \
                 patch('job_runner.subprocess.run'), patch('job_runner.write_telemetry_report'), patch('job_runner.benchmark_report', return_value={}):
                runner._monitor({'id':'job_test','workspace_id':'ws','state':'running','original_filename':'RR.xlsx',
                                 'event_name':'Event','event_id':'event','event_key':'event'}, active)
            self.assertEqual(finish.call_args.args[2], 'failed_uncertain')
            self.assertEqual(json.loads((directory/'final-report.json').read_text())['status'], 'INCOMPLETE')
            self.assertEqual(json.loads((directory/'state.json').read_text())['pending'], ['Remaining work'])

    def test_budget_stop_never_claims_completion_or_clears_uncertainty(self):
        for attempted, unresolved, expected in [(False, False, 'failed_prewrite'),
                                                (True, False, 'failed_recoverable'),
                                                (True, True, 'failed_uncertain')]:
            with self.subTest(expected=expected), tempfile.TemporaryDirectory() as folder:
                directory = Path(folder)
                (directory/'usage-budget-stop-42.json').write_text(json.dumps({'reason': 'Estimated API spend checkpoint reached'}))
                (directory/'final-report.json').write_text('{"status":"DRAFT_COMPLETE"}')
                (directory/'state.json').write_text('{"pending":["Untouched RR requirement"]}')
                evidence = directory/'browser-write-readback-required.json'
                evidence.write_text('{"uncertain":"preserve"}')
                runner = JobRunner(Mock())
                runner.store.get_job.return_value = None
                active = ActiveJob('job_test', 'test-token', 1, threading.Event(), Mock(pid=42))
                active.process.wait.return_value = 0
                with patch('job_runner.job_dir', return_value=directory), \
                     patch('job_runner.mutation_outcome', return_value={'hasAttempts': attempted, 'unresolved': unresolved}), \
                     patch.object(runner, '_provider_failure', return_value=None), \
                     patch.object(runner, 'steel_command') as steel, \
                     patch.object(runner, '_finish_after_lease_loss') as finish, \
                     patch.object(runner, 'prepare_environment', return_value={}), \
                     patch('job_runner.subprocess.run'), patch('job_runner.write_telemetry_report'):
                    runner._monitor({'id': 'job_test', 'workspace_id': 'ws_test', 'state': 'running',
                                     'original_filename': 'rr.xlsx', 'event_name': 'Test',
                                     'event_id': 'test-event', 'event_key': 'test-event'}, active)
                self.assertEqual(finish.call_args.args[2], expected)
                self.assertIn('Usage checkpoint', finish.call_args.args[3])
                self.assertEqual(json.loads(evidence.read_text()), {'uncertain': 'preserve'})
                self.assertEqual(json.loads((directory/'state.json').read_text())['pending'], ['Untouched RR requirement'])
                self.assertEqual(json.loads((directory/'final-report.json').read_text())['status'], 'INCOMPLETE')
                steel.assert_called_once()
