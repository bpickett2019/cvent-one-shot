"""Read-only projection of benchmark accounting and existing job telemetry.

No inference, writes, pricing decisions, completion claims, or separate ledger.
"""
from datetime import datetime, timezone
import json
from pathlib import Path

from benchmark_cost import MODEL, PROVIDER
from mutation_outcome import mutation_outcome


def _json(path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return {}


def _time(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()


def meter(cost, job, directory_for, store, *, clock=None):
    clock = clock or datetime.now(timezone.utc).timestamp()
    directory = Path(directory_for(job))
    state, gate = _json(directory / 'state.json'), _json(directory / 'browser-gate.json')
    counts = {'browser_batches': 0, 'browser_actions': 0, 'zero_progress_responses': 0,
              'acknowledged_persisted_outcomes': 0, 'operator_resolved_persisted_outcomes': 0}
    gaps, active_seconds, wait_seconds = [], 0, 0
    for job_id in sorted({job['id'], *(e['job_id'] for e in cost['executions'])}):
        linked = store.get_job(job_id)
        folder = Path(directory_for(linked))
        progress = _json(folder / 'state.json')
        for name in ('performance-events.jsonl', 'model-control-events.jsonl'):
            if not (folder / name).exists():
                gaps.append(f'{job_id}: {name} absent')
        try:
            events = (folder / 'performance-events.jsonl').read_text().splitlines()
            for line in events:
                event = json.loads(line)
                if event.get('kind') in {'browser_operation', 'browser_operation_failed'}:
                    counts['browser_batches'] += bool(event.get('egoExecutionRound'))
                    counts['browser_actions'] += event.get('actionCount', 0) or 0
                counts['zero_progress_responses'] += event.get('kind') == 'MODEL_RESPONSE_WITH_ZERO_PROGRESS'
        except (OSError, ValueError, TypeError):
            gaps.append(f'{job_id}: browser/progress counters incomplete')
        outcome = mutation_outcome(folder)
        counts['acknowledged_persisted_outcomes'] += outcome['succeeded']
        counts['operator_resolved_persisted_outcomes'] += outcome['persistedResolved']
        if outcome['unresolved']:
            gaps.append(f'{job_id}: mutation outcome unresolved')
        try:
            controls = [json.loads(line) for line in (folder / 'model-control-events.jsonl').read_text().splitlines()]
            live = linked['state'] in {'starting', 'running', 'stopping'}
            end = clock if live else _time(progress['updated_at'])
            executions = [e for e in cost['executions'] if e['job_id'] == job_id]
            windows = []
            for execution in executions:
                start = _time(execution['started_at'])
                receipts = [r for r in cost['requests'] if r['execution_id'] == execution['id']]
                finish = end if live and execution == executions[-1] else max(
                    [_time(r['settled_at'] or r['dispatched_at'] or r['created_at']) for r in receipts] or [start])
                windows.append((start, finish))
            for index, control in enumerate(controls):
                start = _time(control['at'])
                finish = min(end, _time(controls[index + 1]['at'])) if index + 1 < len(controls) else end
                seconds = sum(max(0, min(finish, b) - max(start, a)) for a, b in windows)
                if control.get('ownership') == 'USER' or control.get('desiredOwnership') == 'USER' or control.get('authWaiting'):
                    wait_seconds += seconds
                else:
                    active_seconds += seconds
        except (OSError, ValueError, KeyError, TypeError):
            gaps.append(f'{job_id}: ownership timing incomplete')
    requests = cost['requests']
    latest = next((r['usage'] for r in reversed(requests) if r['usage']), None)
    spent, allowance, exposure = (cost[k] for k in ('cumulative_cost_micro', 'allowance_micro', 'unresolved_exposure_upper_micro'))
    return {
        'logical_build_id': cost['logical_build_id'], 'job_id': job['id'], 'status': job['state'],
        'provider': PROVIDER, 'model': MODEL, 'reasoning': 'high', 'authentication_mode': 'Anthropic API key',
        'estimated_model_consumption_micro': spent, 'allowance_micro': allowance,
        'remaining_authorization_micro': max(0, allowance - spent - exposure),
        'unresolved_exposure_upper_micro': exposure, 'accounting_complete': cost['accounting_complete'],
        'actual_provider_charges_micro': None, 'subscription_quota_remaining': None,
        'billing_basis': 'Token-derived API estimate, not actual billed charges. No subscription quota measurement. OAuth/direct charges never replace consumption accounting.',
        'pricing_basis': cost['accounting_basis'], 'warnings_usd': cost['warnings'],
        'warning_thresholds_usd': [25, 40, 45, 50],
        'physical_requests': cost['physical_attempts'], 'responses': cost['model_responses'],
        'request_purposes': cost['purpose_counts'], 'tokens': cost['tokens'],
        'latest_context_tokens': sum(latest[k] for k in ('input', 'cacheRead', 'cacheWrite')) if latest else None,
        'context_tokens': cost['context_tokens'], 'ownership': gate.get('ownership', 'UNKNOWN'),
        'desired_ownership': gate.get('desiredOwnership', 'UNKNOWN'),
        'auth_waiting': bool(gate.get('authWaiting') or state.get('status') == 'login_required'),
        'pause_code': cost['pause_code'], 'outstanding_requests': cost['outstanding_requests'],
        'blockers': cost['blocker_episodes'], 'counters': counts,
        'observed_agent_owned_seconds': round(active_seconds, 1), 'observed_human_wait_seconds': round(wait_seconds, 1),
        'model_request_wall_ms': cost['model_request_wall_ms'], 'telemetry_gaps': gaps,
        'measurement_notes': 'Context is last settled input, not a live prompt estimate. Timing covers recorded ownership intervals within registered executions (stopped executions bounded by their last request), not compute time. Persisted outcomes are existing audit acknowledgments, not independent full-RR completion. Missing telemetry is incomplete, not proof of zero work.'}
