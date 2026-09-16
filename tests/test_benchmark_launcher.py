"""Actual installed Pi + actual controller route + fake fetch. No Cvent/network."""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from benchmark_cost import BenchmarkCost, MODEL, PROVIDER
from benchmark_runtime import sdk_environment
from browser_gate import BrowserGate
from control_store import ControlStore

ROOT = Path(__file__).resolve().parents[1]


class BenchmarkLauncherTests(unittest.TestCase):
    def launch(self, scenario, *, paused=False, resume=False):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve()
            store = ControlStore(root/'control.db', lease_seconds=3600)
            owner = store.ensure_user('offline', 'offline@example.invalid', 'Offline', True)
            job = store.create_job(owner, SimpleNamespace(event_id='event', event_key='event', name='Offline Event'), 'RR.xlsx')
            directory = root/'workspaces'/job['workspace_id']/'jobs'/job['id']; directory.mkdir(parents=True)
            (directory/'input.xlsx').write_bytes(b'offline fixture, never used for browser work')
            (directory/'state.json').write_text(json.dumps({'status': 'running', 'deployed_sha': 'a'*40}))
            (directory/'pi-config').mkdir()
            (directory/'pi-config/settings.json').write_text(json.dumps({'retry': {'enabled': False}, 'defaultProjectTrust': 'never'}))
            gate = BrowserGate(directory); gate.initialize()
            if paused: gate.update({'ownership': 'USER', 'desiredOwnership': 'USER', 'agentPaused': True})
            costs = BenchmarkCost(store); costs.bind(job, directory)
            lease = store.reserve_now(job['id'], 'offline', serialized=True)
            env = {'PATH': os.environ['PATH'], 'PYTHONPATH': str(ROOT), 'CVENT_ENV': 'development', 'CVENT_DATA_ROOT': str(root),
                   'CVENT_JOB_DIR': str(directory), 'CVENT_REPO_ROOT': str(ROOT), 'CVENT_JOB_ID': job['id'],
                   'CVENT_WORKSPACE_ID': job['workspace_id'], 'CVENT_WORKER_SLOT': '1', 'CVENT_PYTHON': sys.executable,
                   'CVENT_MODEL_BENCHMARK': '1', 'CVENT_PI_PROVIDER': PROVIDER, 'CVENT_PI_MODEL': MODEL,
                   'CVENT_PI_THINKING': 'high', 'CVENT_EXECUTION_MODE': 'simple',
                   'CVENT_MODEL_TOKEN': 'offline-model-capability', 'CVENT_MODEL_EXECUTION_ID': 'execution_offline',
                   'CVENT_MODEL_ADMISSION_URL': 'http://127.0.0.1:8877/internal/model-benchmark',
                   'CVENT_AUTHORIZED_EVENT_ID': 'event', 'CVENT_AUTHORIZED_EVENT_KEY': 'event', 'CVENT_AUTHORIZED_EVENT_NAME': 'Offline Event',
                   'CVENT_LEASE_TOKEN': lease['token'], 'CVENT_LEASE_VALIDATE_URL': 'http://unused.invalid',
                   'PI_CODING_AGENT_DIR': str(directory/'pi-config'), 'PI_OFFLINE': '1', 'PI_TELEMETRY': '0',
                   'ANTHROPIC_API_KEY': 'offline-not-a-real-key', 'OFFLINE_SCENARIO': scenario, **sdk_environment()}
            completed = subprocess.run(['node', '--import', str(ROOT/'tests/benchmark_preload.mjs'),
                str(ROOT/'scripts/run_pi_guarded.mjs'), '--job', 'Offline fixture. Never operate a browser.'],
                cwd=directory, env=env, text=True, capture_output=True, timeout=120)
            if resume:
                self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
                before = costs.snapshot(job['id'])
                sessions = list((directory/'pi-sessions').glob('*.jsonl'))
                self.assertEqual(len(sessions), 1)
                env['CVENT_MODEL_EXECUTION_ID'] = 'execution_resumed'
                completed = subprocess.run(['node', '--import', str(ROOT/'tests/benchmark_preload.mjs'),
                    str(ROOT/'scripts/run_pi_guarded.mjs'), '--job', '--session', str(sessions[0]),
                    'Offline continuation only. No browser.'], cwd=directory, env=env,
                    text=True, capture_output=True, timeout=120)
                self.assertEqual(costs.snapshot(job['id'])['logical_build_id'], before['logical_build_id'])
                self.assertEqual(costs.snapshot(job['id'])['cumulative_cost_micro'], before['cumulative_cost_micro'] + 45)
            snapshot = costs.snapshot(job['id'])
            checks = [json.loads(line) for line in (directory/'offline-meter-checks.jsonl').read_text().splitlines()]
            self.assertTrue(checks)
            self.assertEqual([r['cost_micro'] for r in checks], sorted(r['cost_micro'] for r in checks))
            self.assertEqual(checks[-1]['cost_micro'], snapshot['cumulative_cost_micro'])
            self.assertEqual(checks[-1]['physical_requests'], snapshot['physical_attempts'])
            trace_path = directory/'offline-network.jsonl'
            trace = [json.loads(l) for l in trace_path.read_text().splitlines()] if trace_path.exists() else []
            markers = list(directory.glob('model-admission-stop-*.json'))
            contract = directory/'offline-contract.json'
            self.contract = json.loads(contract.read_text()) if contract.exists() else None
            return completed, snapshot, trace, bool(markers)

    def test_actual_launcher_settles_one_response_without_browser_tools(self):
        completed, snapshot, trace, stopped = self.launch('normal')
        self.assertEqual(completed.returncode, 0, (completed.stdout+completed.stderr)[-5000:])
        self.assertEqual(snapshot['physical_attempts'], 1, completed.stdout+completed.stderr)
        self.assertEqual(snapshot['cumulative_cost_micro'], 45)
        self.assertEqual(snapshot['tokens']['input'], 10)
        self.assertTrue(snapshot['accounting_complete'])
        self.assertFalse(stopped)
        self.assertEqual([r['operation'] for r in trace if r['kind'] == 'controller'], ['register', 'reserve', 'dispatch', 'settle'])

    def test_effective_simple_system_and_tools_use_only_cvent_contract(self):
        completed, _, _, _ = self.launch('normal')
        self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
        system = json.dumps(self.contract['system'])
        self.assertIn('You configure the selected Cvent event', system)
        self.assertIn('not a general coding assistant', system)
        self.assertIn('does not independently reason', system)
        self.assertNotIn('expert coding assistant', system)
        self.assertNotIn('Use bash for file operations', system)
        self.assertNotIn('available_skills', system)
        self.assertNotIn('skills/ego-browser', system)
        tools = {tool['name']: tool for tool in self.contract['tools']}
        self.assertEqual(set(tools), {'read','bash','cvent_open_event','cvent_login_handoff','cvent_job_update','cvent_finish'})
        self.assertIn('No shell or Node.js imports', tools['bash']['description'])
        self.assertNotIn('upstream', tools['bash']['description'])
        mission = (ROOT/'PI_SIMPLE_PROMPT.md').read_text()
        self.assertNotIn('skills/ego-browser/SKILL.md', mission)
        self.assertIn('locator/getByRole result (no other methods or chaining)', mission)
        self.assertIn('operator reconciliation', mission)

    def test_actual_launcher_resume_in_new_process_keeps_previous_consumption(self):
        completed, snapshot, trace, stopped = self.launch('normal', resume=True)
        self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
        self.assertEqual(snapshot['physical_attempts'], 2)
        self.assertEqual(snapshot['cumulative_cost_micro'], 90)
        self.assertEqual(len(snapshot['executions']), 2)
        self.assertEqual(len({e['session_id'] for e in snapshot['executions']}), 1)
        self.assertEqual(sum(r['kind'] == 'provider' for r in trace), 2)
        self.assertTrue(snapshot['accounting_complete'])
        self.assertFalse(stopped)

    def test_actual_launcher_user_pause_makes_zero_provider_calls(self):
        completed, snapshot, trace, stopped = self.launch('normal', paused=True)
        self.assertNotEqual(completed.returncode, 0)
        self.assertEqual(snapshot['physical_attempts'], 0)
        self.assertFalse(any(r['kind'] == 'provider' for r in trace))
        self.assertTrue(stopped)

    def test_truncated_stream_is_unknown_not_a_zero_output_receipt(self):
        completed, snapshot, trace, stopped = self.launch('missing_usage')
        self.assertNotEqual(completed.returncode, 0)
        self.assertEqual(snapshot['physical_attempts'], 1)
        self.assertFalse(snapshot['accounting_complete'])
        self.assertEqual(snapshot['requests'][0]['state'], 'UNKNOWN')
        self.assertTrue(stopped)

    def test_actual_tool_error_hook_stops_after_three_interleaved_failures(self):
        completed, snapshot, trace, stopped = self.launch('failures')
        self.assertNotEqual(completed.returncode, 0, completed.stdout+completed.stderr)
        self.assertEqual(snapshot['physical_attempts'], 5, (completed.stdout+completed.stderr)[-6000:])
        self.assertEqual(sum(r.get('operation') == 'failure' for r in trace), 3)
        self.assertTrue(snapshot['pause_code'].startswith('BLOCKER_'))
        self.assertTrue(stopped)

    def test_handoff_or_auth_wait_blocks_native_compaction_before_transport(self):
        for scenario in ('compaction_pause', 'compaction_auth'):
            with self.subTest(scenario=scenario):
                completed, snapshot, trace, stopped = self.launch(scenario)
                self.assertNotEqual(completed.returncode, 0)
                self.assertEqual(snapshot['physical_attempts'], 1, json.dumps(trace))
                self.assertEqual(snapshot['purpose_counts']['compaction'], 0)
                self.assertTrue(snapshot['accounting_complete'])
                self.assertTrue(stopped)

    def test_native_auto_compaction_is_guarded_and_accounted(self):
        completed, snapshot, trace, stopped = self.launch('compaction')
        self.assertEqual(completed.returncode, 0, (completed.stdout+completed.stderr)[-6000:])
        self.assertGreaterEqual(snapshot['purpose_counts']['compaction'], 1, json.dumps(trace))
        self.assertGreaterEqual(snapshot['physical_attempts'], 3)
        self.assertTrue(snapshot['accounting_complete'])
        self.assertFalse(stopped)


if __name__ == '__main__': unittest.main()
