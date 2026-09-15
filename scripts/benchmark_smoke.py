#!/usr/bin/env python3
"""One bounded paid no-Cvent call, then a deliberately denied second call.

Diagnostic-only isolated ControlStore. No browser, agent tools, live job, manifest
bypass, or production allowance changes. Credentials must come from deployment.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from benchmark_cost import BenchmarkCost, BenchmarkDenied
from benchmark_meter import meter
from benchmark_runtime import sdk_environment
from browser_gate import BrowserGate
from control_store import ControlStore


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--allow-paid-no-cvent', action='store_true', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if not os.environ.get('ANTHROPIC_API_KEY'):
        raise SystemExit('Deployed Anthropic API key is required; no OAuth/key fallback')
    revision = subprocess.check_output(['git', '-c', f'safe.directory={ROOT}', '-C', str(ROOT), 'rev-parse', 'HEAD'], text=True).strip()
    folder = args.output.resolve()
    folder.mkdir(mode=0o700, parents=False, exist_ok=False)
    store = ControlStore(folder / 'control.db', lease_seconds=300)
    user = store.ensure_user('diagnostic-only', 'diagnostic@example.invalid', 'No Cvent diagnostic', True)
    job = store.create_job(user, SimpleNamespace(event_id='NO_CVENT_DIAGNOSTIC', event_key='NO_CVENT_DIAGNOSTIC', name='NO CVENT'), 'diagnostic-only.txt')
    directory = folder / 'job'; directory.mkdir(mode=0o700)
    (directory / 'input.xlsx').write_bytes(b'Diagnostic binding only; not a workbook or RR benchmark')
    (directory / 'state.json').write_text(json.dumps({'status': 'running', 'deployed_sha': revision}))
    BrowserGate(directory).initialize()
    costs = BenchmarkCost(store); costs.bind(job, directory)
    lease = store.reserve_now(job['id'], 'diagnostic-only', serialized=True)
    execution = 'execution_no_cvent_smoke'
    costs.register_execution(job['id'], execution, 'no_cvent_diagnostic', revision)
    env = {k: os.environ[k] for k in ('PATH', 'LANG', 'ANTHROPIC_API_KEY') if k in os.environ}
    env.update(sdk_environment(), CVENT_NO_CVENT_PAID_SMOKE='1', PI_OFFLINE='1', PI_TELEMETRY='0')
    process = subprocess.Popen(['node', str(ROOT / 'scripts/benchmark_smoke.mjs')], env=env,
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, cwd=directory)
    trace, result, persisted = [], {}, False
    try:
        for line in process.stdout:
            item = json.loads(line); op, data = item['operation'], item.get('data', {})
            trace.append({'operation': op})
            reply = {'ok': True}
            try:
                if op == 'reserve': costs.reserve(job, lease['token'], directory, execution, data)
                elif op == 'dispatch': costs.begin_dispatch(job, lease['token'], directory, execution, data['id'])
                elif op == 'settle': costs.settle(execution, data['id'], data)
                elif op in {'uncertain', 'cancel'}: costs.terminal(execution, data['id'], 'UNKNOWN' if op == 'uncertain' else 'CANCELLED')
                elif op == 'denied': trace[-1]['code'] = data.get('code')
                elif op == 'reopen_and_reduce_test_allowance':
                    before = costs.snapshot(job['id'])
                    store = ControlStore(folder / 'control.db', lease_seconds=300); costs = BenchmarkCost(store)
                    persisted = costs.snapshot(job['id']) == before
                    if not persisted or not before['accounting_complete'] or before['physical_attempts'] != 1:
                        raise ValueError('Persistence/receipt validation failed')
                    (folder / 'after-genuine-response-meter.json').write_text(json.dumps(meter(before, store.get_job(job['id']), lambda _: directory, store), indent=2))
                    # Deliberately lower ONLY this synthetic isolated test allowance.
                    # Production API still allows increases only and never resets usage.
                    with store.immediate() as conn:
                        conn.execute('UPDATE benchmark_builds SET allowance_micro=? WHERE id=?',
                                     (before['cumulative_cost_micro'] + 1, before['logical_build_id']))
                elif op in {'finished', 'failed'}:
                    result = data; break
                else: raise ValueError('Unsupported diagnostic operation')
            except BenchmarkDenied as exc:
                reply = {'ok': False, 'code': exc.code}; trace[-1]['denied'] = exc.code
            except (ValueError, KeyError, TypeError):
                reply = {'ok': False, 'code': 'DIAGNOSTIC_FAILED'}
            process.stdin.write(json.dumps(reply) + '\n'); process.stdin.flush()
        process.wait(timeout=10)
    finally:
        if process.poll() is None: process.kill(); process.wait()
        process.stdin.close()
        process.stdout.close()
    snapshot = costs.snapshot(job['id'])
    passed = bool(result.get('secondBlocked') and persisted and snapshot['accounting_complete']
                  and snapshot['physical_attempts'] == 1 and snapshot['cumulative_cost_micro'] > 0)
    evidence = {'passed': passed, 'revision': revision, 'authentication_mode': 'deployed Anthropic API key',
                'scope': 'One no-tools/no-Cvent diagnostic; not a production RR or billing reconciliation',
                'persistence_verified': persisted, 'result': result, 'trace': trace, 'cost': snapshot,
                'meter': meter(snapshot, store.get_job(job['id']), lambda _: directory, store)}
    (folder / 'smoke-evidence.json').write_text(json.dumps(evidence, indent=2))
    print(json.dumps({'passed': passed, 'evidence': str(folder / 'smoke-evidence.json'),
                      'estimated_consumption_micro': snapshot['cumulative_cost_micro'],
                      'accounting_complete': snapshot['accounting_complete']}))
    return 0 if passed else 1


if __name__ == '__main__':
    raise SystemExit(main())
