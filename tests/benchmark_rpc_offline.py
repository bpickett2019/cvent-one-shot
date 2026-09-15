"""Test-only process bridge: exercise the REAL controller route, no HTTP server."""
import json
import os
import sys
import threading
from unittest.mock import Mock
from starlette.requests import Request

# Parent test supplies an isolated temporary DATA_ROOT and fake capability/key.
import app as server
from job_runner import ActiveJob

payload = json.load(sys.stdin)
job = server.store.get_job(os.environ['CVENT_JOB_ID'])
active = ActiveJob(job['id'], os.environ['CVENT_LEASE_TOKEN'], 1, threading.Event(),
                   process=Mock(pid=int(os.environ['OFFLINE_GUARD_PID'])),
                   model_token=os.environ['CVENT_MODEL_TOKEN'], execution_id=os.environ['CVENT_MODEL_EXECUTION_ID'])
server.runner._active[job['id']] = active
request = Request({'type': 'http', 'method': 'POST', 'path': '/internal/model-benchmark',
                   'headers': [(b'x-cvent-model-token', os.environ['CVENT_MODEL_TOKEN'].encode())],
                   'client': ('127.0.0.1', 12345), 'server': ('127.0.0.1', 8877), 'scheme': 'http', 'query_string': b''})
if payload['operation'] == 'reserve' and payload['data'].get('purpose') == 'compaction':
    from browser_gate import BrowserGate
    if os.environ.get('OFFLINE_SCENARIO') == 'compaction_pause':
        BrowserGate(server.directory_for(job)).request_user()
    if os.environ.get('OFFLINE_SCENARIO') == 'compaction_auth':
        BrowserGate(server.directory_for(job)).update({'authWaiting': True})
response = server.model_benchmark_request(request, payload)
if hasattr(response, 'body'):
    print(json.dumps({'status': response.status_code, 'body': json.loads(response.body)}))
else:
    print(json.dumps({'status': 200, 'body': response}))
