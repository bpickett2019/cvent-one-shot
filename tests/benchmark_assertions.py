"""Offline assertions only: reconcile the existing meter with per-attempt SQLite rows."""
from benchmark_cost import charge
from benchmark_meter import meter


def assert_meter_consistent(costs, job, directory_for, *, previous_cost=0):
    snapshot = costs.snapshot(job['id'])
    rows = snapshot['requests']
    settled = [r for r in rows if r['state'] == 'SETTLED']
    unresolved = [r for r in rows if r['state'] in {'PENDING', 'DISPATCHED', 'UNKNOWN'}]
    # Missing receipts remain NULL, not a settled zero-dollar consumption record.
    for row in unresolved:
        assert row['usage'] is None and row['cost_micro'] is None
        assert row['settled_at'] is None
    expected_cost = sum(max(charge(r['usage']), r['sdk_cost_micro']) for r in settled)
    expected_tokens = {k: sum(r['usage'][k] for r in settled)
                       for k in ('input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens')}
    exposure = sum(r['upper_micro'] for r in unresolved)
    physical = sum(r['dispatched_at'] is not None for r in rows)
    assert snapshot['cumulative_cost_micro'] == expected_cost >= previous_cost
    assert snapshot['tokens'] == expected_tokens
    assert snapshot['physical_attempts'] == physical
    assert snapshot['model_responses'] == len(settled)
    assert snapshot['accounting_complete'] == (not unresolved)
    assert snapshot['unresolved_exposure_upper_micro'] == exposure
    view = meter(snapshot, costs.store.get_job(job['id']), directory_for, costs.store)
    assert view['logical_build_id'] == snapshot['logical_build_id']
    assert view['estimated_model_consumption_micro'] == expected_cost
    assert view['tokens'] == expected_tokens
    assert view['physical_requests'] == physical
    assert view['responses'] == len(settled)
    assert view['accounting_complete'] == (not unresolved)
    assert view['unresolved_exposure_upper_micro'] == exposure
    assert view['outstanding_requests'] == [r['id'] for r in unresolved]
    assert view['remaining_authorization_micro'] == max(0, snapshot['allowance_micro'] - expected_cost - exposure)
    assert view['request_purposes'] == snapshot['purpose_counts']
    assert view['pause_code'] == snapshot['pause_code']
    assert view['blockers'] == snapshot['blocker_episodes']
    assert view['actual_provider_charges_micro'] is None
    assert view['subscription_quota_remaining'] is None
    assert costs.snapshot(job['id']) == snapshot, 'Reading the meter must not alter accounting'
    return view
