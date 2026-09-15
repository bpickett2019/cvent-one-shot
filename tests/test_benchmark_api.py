import json
import os
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from fastapi import HTTPException
from starlette.requests import Request
import app as server
from benchmark_cost import BenchmarkCost, MODEL, PRICING, PROVIDER
from browser_gate import BrowserGate
from control_store import ControlStore
from job_runner import ActiveJob, JobRunner


class BenchmarkApiTests(unittest.TestCase):
    def test_internal_capability_binding_and_operator_approval_are_separate(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {'CVENT_MODEL_BENCHMARK': '1'}):
            root = Path(folder)
            store = ControlStore(root/'control.db')
            owner = store.ensure_user('operator', 'offline@example.invalid', 'Offline', True)
            job = store.create_job(owner, SimpleNamespace(event_id='event', event_key='event', name='Event'), 'RR.xlsx')
            directory = root/'job'; directory.mkdir()
            (directory/'input.xlsx').write_bytes(b'fixture')
            (directory/'state.json').write_text(json.dumps({'status': 'running', 'deployed_sha': 'a'*40}))
            BrowserGate(directory).initialize()
            runner = JobRunner(store); runner.benchmark.bind(job, directory)
            lease = store.reserve_now(job['id'], 'operator', serialized=True)
            active = ActiveJob(job['id'], lease['token'], 1, threading.Event(), process=Mock(pid=4242),
                               model_token='private-model-token', execution_id='execution')
            runner._active[job['id']] = active
            def request(token='private-model-token', host='127.0.0.1'):
                return Request({'type': 'http', 'method': 'POST', 'headers': [(b'x-cvent-model-token', token.encode())],
                                'client': (host, 123), 'path': '/', 'query_string': b''})
            payload = {'jobId': job['id'], 'executionId': 'execution', 'operation': 'register', 'data': {'sessionId': 'session'}}
            with patch.object(server, 'store', store), patch.object(server, 'runner', runner), patch.object(server, 'directory_for', return_value=directory):
                for invalid in (request(token=lease['token']), request(host='203.0.113.1')):
                    with self.assertRaises(HTTPException) as context: server.model_benchmark_request(invalid, payload)
                    self.assertEqual(context.exception.status_code, 403)
                self.assertTrue(server.model_benchmark_request(request(), payload)['ok'])
                payload['operation'] = 'approve'; payload['data'] = {'allowance_micro': 60_000_000}
                denied = server.model_benchmark_request(request(), payload)
                self.assertEqual(denied.status_code, 400, 'Worker capability cannot authorize more spending')
                payload['operation'] = 'reserve'; payload['data'] = {'id': 'req', 'provider': PROVIDER, 'model': MODEL,
                    'pricingVersion': PRICING, 'purpose': 'probe', 'upperMicro': 1000}
                denied = server.model_benchmark_request(request(), payload)
                self.assertEqual(json.loads(denied.body)['code'], 'AUXILIARY_INFERENCE_DISABLED')
                payload['operation'] = 'handoff'; payload['data'] = {}
                self.assertTrue(server.model_benchmark_request(request(), payload)['ok'])
                gate = BrowserGate(directory).read()
                self.assertEqual(gate['ownership'], 'USER'); self.assertTrue(gate['authWaiting'])
                payload['operation'] = 'reserve'; payload['data'] = {'id': 'req', 'provider': PROVIDER, 'model': MODEL,
                    'pricingVersion': PRICING, 'purpose': 'configuration', 'upperMicro': 1000}
                self.assertEqual(json.loads(server.model_benchmark_request(request(), payload).body)['code'], 'MODEL_PAUSED_USER')
                self.assertEqual(runner.benchmark.snapshot(job['id'])['physical_attempts'], 0)
                with patch.object(server, 'current_user', return_value=owner):
                    meter = server.model_meter_status(request(), job['id'])
                    self.assertEqual(meter.headers['cache-control'], 'no-store')
                    self.assertEqual(json.loads(meter.body)['ownership'], 'USER')
                stranger = store.ensure_user('other', 'other@example.invalid', 'Other', False)
                with patch.object(server, 'current_user', return_value=stranger):
                    with self.assertRaises(HTTPException) as denied:
                        server.model_meter_status(request(), job['id'])
                    self.assertIn(denied.exception.status_code, (403, 404))


if __name__ == '__main__': unittest.main()
