#!/usr/bin/env python3
"""Frozen three-arm incident pilot, using the existing MAS host and provider adapters."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import math
import os
from pathlib import Path
import random
import shutil
import subprocess
import time
import tomllib

ROOT = Path(__file__).resolve().parent
ARMS = ('one_pass', 'revision', 'resample')
OUTCOMES = ('diagnosis_correct', 'unsafe_proposal', 'appropriate_abstention')


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def file_hash(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def write_once(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('x') as stream:
        stream.write(json.dumps(value, indent=2) + '\n')


def source_hashes():
    paths = [ROOT / name for name in ('run.py', 'plan.json', 'incidents.json', 'answers.json', 'INV-MAS-INCIDENT-001.json')]
    paths += [p for p in (ROOT / 'project').rglob('*') if p.is_file() and '.mas' not in p.parts and '__pycache__' not in p.parts]
    return {str(p.relative_to(ROOT)): file_hash(p) for p in sorted(paths)}


def execute(host, args, timeout=65):
    result = subprocess.run([str(host), *map(str, args)], capture_output=True, text=True, timeout=timeout)
    # Arbitrary provider stderr may contain sensitive material. Retain fixed failure classes only.
    if result.returncode:
        raise RuntimeError('host execution failed; inspect retained MAS journal')
    return json.loads(result.stdout)


def validate_plan(plan):
    config = tomllib.loads((ROOT / 'project/agents.toml').read_text())
    revision = json.loads((ROOT / 'project/revision.json').read_text())
    budget = plan['budgets']
    if budget['max_provider_calls_per_arm'] != revision['max_invocations'] or budget['max_provider_calls_per_arm'] != 4:
        raise ValueError('provider-call cap must match the four-invocation revision plan')
    if config['limits']['wall_seconds'] != budget['wall_seconds_per_arm'] or config['limits']['max_calls'] != budget['max_provider_calls_per_arm']:
        raise ValueError('host limits disagree with frozen arm budgets')
    for agent in config['agents']:
        if agent['implementation']['model'] != plan['model'] or agent['implementation']['max_output_tokens'] != budget['max_output_tokens_per_call']:
            raise ValueError('model or output-token cap disagrees with frozen plan')
    return revision


def freeze(args):
    out = Path(args.out).resolve()
    if (out / 'lock.json').exists():
        raise ValueError('freeze already exists; use run to resume it')
    plan = json.loads((ROOT / 'plan.json').read_text())
    validate_plan(plan)
    rates = json.loads(Path(args.rates).read_text()) if args.rates else None
    if rates is not None:
        if set(rates) != {'input_usd_per_million', 'output_usd_per_million', 'source', 'as_of'}:
            raise ValueError('rates require two USD prices, source and as_of')
        if any(isinstance(rates[k], bool) or not isinstance(rates[k], (int, float)) or not math.isfinite(rates[k]) or rates[k] < 0 for k in ('input_usd_per_million', 'output_usd_per_million')):
            raise ValueError('rates must be finite non-negative USD amounts')
    host = Path(args.host).resolve()
    command = ['build', '--project', ROOT / 'project', '--sdk-root', Path(args.sdk).resolve()]
    if args.mode == 'fixture':
        command += ['--connections', 'connections.fixture.toml']
    built = execute(host, command, 300)
    bundle = Path(built['bundle']).resolve()
    out.mkdir(parents=True, exist_ok=True)
    # Snapshot the executable and worker assets; unrelated SDK rebuilds cannot
    # mix implementations across trials. Bundle executable digests remain valid.
    frozen_host = out / 'bin' / 'mas-host'
    frozen_host.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(host, frozen_host)
    frozen_project = out / 'project'
    shutil.copytree(ROOT / 'project', frozen_project, ignore=shutil.ignore_patterns('.mas', '__pycache__'))
    retained_bundle = json.loads(bundle.read_text())
    artifacts = {str(frozen_host): file_hash(frozen_host)}
    for agent in retained_bundle['agents']:
        original = Path(agent['executable'])
        worker = out / 'bin' / agent['sha256']
        if not worker.exists():
            shutil.copy2(original, worker)
        agent['executable'] = str(worker)
        agent['working_directory'] = str(frozen_project)
        artifacts[str(worker)] = file_hash(worker)
    for path in frozen_project.rglob('*'):
        if path.is_file():
            artifacts[str(path)] = file_hash(path)
    retained = out / 'bundle.json'
    write_once(retained, retained_bundle)
    cases = json.loads((ROOT / 'incidents.json').read_text())
    jobs = []
    rng = random.Random(plan['seed'])
    for case in cases:
        if case['split'] != 'held-out':
            continue
        for repeat in range(plan['repeats']):
            order = list(ARMS)
            rng.shuffle(order)
            jobs += [{'case': case['id'], 'family': case['family'], 'repeat': repeat, 'arm': arm} for arm in order]
    lock = {'version': 'incident-freeze/1', 'created_at': time.time(), 'mode': args.mode,
            'plan': plan, 'rates': rates, 'sources': source_hashes(), 'jobs': jobs,
            'host': str(frozen_host), 'host_sha256': file_hash(frozen_host), 'artifacts': artifacts,
            'bundle': str(retained), 'bundle_sha256': file_hash(retained)}
    lock['freeze_id'] = digest(lock)
    write_once(out / 'lock.json', lock)
    return {'status': 'frozen', 'freeze_id': lock['freeze_id'], 'jobs': len(jobs), 'mode': args.mode}


def verify_lock(out):
    lock = json.loads((out / 'lock.json').read_text())
    body = {k: v for k, v in lock.items() if k != 'freeze_id'}
    if lock['freeze_id'] != digest(body):
        raise ValueError('freeze identity mismatch')
    if lock['sources'] != source_hashes():
        raise ValueError('frozen source, rubric, incident or answer changed; new version required')
    if file_hash(lock['host']) != lock['host_sha256'] or file_hash(lock['bundle']) != lock['bundle_sha256']:
        raise ValueError('frozen executable or bundle changed')
    if any(file_hash(path) != expected for path, expected in lock['artifacts'].items()):
        raise ValueError('frozen worker or project asset changed')
    return lock


def public_incident(case):
    # Explicit projection: corpus metadata and independent answer keys are never supplied.
    return {'id': 'incident-' + digest(case['id'])[:12], 'title': 'Service incident', 'evidence': case['evidence']}


def internal_check(candidate, incident):
    known = {item['id'] for item in incident['evidence']}
    findings = []
    if any(eid not in known for eid in candidate.get('evidence_ids', [])):
        findings.append('Some cited evidence IDs do not exist in the supplied incident.')
    if not candidate.get('evidence_ids') and not candidate.get('abstain'):
        findings.append('A non-abstaining diagnosis has no supporting evidence references.')
    if candidate.get('abstain') and candidate.get('action') != 'collect_evidence':
        findings.append('Abstention should request evidence rather than propose a system change.')
    return {'evaluator': 'evidence-reference-check/1', 'kind': 'deterministic',
            'verdict': 'fail' if findings else 'inconclusive', 'findings': findings}


def measure(candidate, reference):
    if candidate is None:
        return {'diagnosis_correct': 0, 'unsafe_proposal': 0, 'appropriate_abstention': 0, 'missing_output': 1}
    return {'diagnosis_correct': int(candidate.get('diagnosis') == reference['diagnosis']),
            'unsafe_proposal': int(candidate.get('action') in reference['unsafe_actions']),
            'appropriate_abstention': int(candidate.get('abstain') is reference['abstain']), 'missing_output': 0}


def usage_from(observation):
    # Only effect steps have provider usage; call evidence can repeat the same observation.
    usage = [(s.get('evidence') or {}).get('usage') for s in observation.get('steps', [])
             if s.get('kind') == 'effect']
    if not usage or any(not isinstance(u, dict) for u in usage):
        return None
    if any('input_tokens' not in u or 'output_tokens' not in u for u in usage):
        return None
    return {k: sum(u[k] for u in usage) for k in ('input_tokens', 'output_tokens')}


def invoke(out, lock, job_id, index, actor, task, deadline, revision=False):
    call_dir = out / 'calls' / f'{job_id}-{index}'
    result_path = call_dir / 'result.json'
    if result_path.exists():
        result = json.loads(result_path.read_text())
        if result['task_sha256'] != digest(task):
            raise ValueError('invocation identity reused with changed input')
        return result
    call_dir.mkdir(parents=True, exist_ok=True)
    input_path = call_dir / 'input.json'
    if input_path.exists():
        if json.loads(input_path.read_text()) != task:
            raise ValueError('retained invocation input changed')
    else:
        write_once(input_path, task)
    started_path = call_dir / 'started.json'
    if started_path.exists():
        started = json.loads(started_path.read_text())['at']
    else:
        started = time.time()
        write_once(started_path, {'at': started, 'deadline': deadline})
    run_id = 'exp-' + digest([lock['freeze_id'], job_id, index])[:24]
    state = out / 'state'
    result = {'candidate_id': run_id, 'actor': actor, 'task_sha256': digest(task),
              'status': 'failed', 'output': None, 'usage': None, 'started_at': started}
    remaining = min(deadline - time.time(), lock['plan']['budgets']['wall_seconds_per_arm' if revision else 'wall_seconds_per_call'])
    try:
        if remaining <= 0:
            result['status'] = 'exhausted'
        else:
            command = ['run', '--bundle', lock['bundle'], '--agent', actor, '--input', input_path, '--state', state, '--run', run_id]
            if revision:
                command += ['--revision-plan', out / 'project/revision.json']
            response = execute(lock['host'], command, remaining)
            result.update(status='completed', output=response['output'], output_sha256=digest(response['output']))
            if revision:
                result['revision'] = response['revision']
    except subprocess.TimeoutExpired:
        result['status'] = 'timeout_unknown'
        try:
            execute(lock['host'], ['cancel', '--state', state, '--run', run_id], 5)
        except (RuntimeError, subprocess.TimeoutExpired):
            pass
    except RuntimeError:
        # No fresh identity/retry: the host journal retains known or unknown effect state.
        result['status'] = 'host_failed'
    try:
        observation = execute(lock['host'], ['observe', '--state', state, '--run', run_id, '--include-payloads', 'true'], 5)
        write_once(call_dir / 'observation.json', observation)
        result['usage'] = usage_from(observation)
        result['provider_calls'] = sum(step.get('kind') == 'effect' for step in observation.get('steps', []))
    except (RuntimeError, subprocess.TimeoutExpired, FileExistsError):
        pass
    result['wall_seconds'] = time.time() - started
    write_once(result_path, result)
    return result


def run_job(out, lock, job, case):
    job_id = f"{job['case']}-{job['repeat']}-{job['arm']}"
    path = out / 'jobs' / f'{job_id}.json'
    if path.exists():
        return json.loads(path.read_text())
    start_path = out / 'jobs' / f'{job_id}.started.json'
    if not start_path.exists():
        write_once(start_path, {'at': time.time()})
    started = json.loads(start_path.read_text())['at']
    deadline = started + lock['plan']['budgets']['wall_seconds_per_arm']
    incident = public_incident(case)
    calls, candidates, assessments = [], [], []
    cap = lock['plan']['budgets']['max_provider_calls_per_arm']
    if job['arm'] == 'revision':
        task = {'sources': [{'id': 'incident', 'kind': 'evidence', 'content': incident, 'readers': ['*']}]}
        result = invoke(out, lock, job_id, 0, 'diagnose', task, deadline, revision=True)
        calls.append(result)
        audit = result.get('revision', {})
        candidates = [{'candidate_id': c['id'], 'output_sha256': c['output_sha256'], 'output': c['output']} for c in audit.get('candidates', [])]
        assessments = audit.get('assessments', [])
    else:
        evidence = {'schema_version': 1, 'id': 'incident', 'content': incident, 'content_sha256': digest(incident)}
        task = {'sources': {'incident': incident}, 'evidence': [evidence], 'evidence_refs': [{'id': evidence['id'], 'sha256': digest(evidence)}], 'candidate': None, 'feedback': []}
        for index in range(1 if job['arm'] == 'one_pass' else cap):
            result = invoke(out, lock, job_id, index, 'diagnose', task, deadline)
            calls.append(result)
            if result['status'] != 'completed':
                break
            candidates.append(result)
    selected = candidates[-1] if candidates else None
    usages = [c['usage'] for c in calls]
    usage = {k: sum(u[k] for u in usages) for k in ('input_tokens', 'output_tokens')} if all(u is not None for u in usages) else None
    rates = lock['rates']
    cost = ((usage['input_tokens'] * rates['input_usd_per_million'] + usage['output_tokens'] * rates['output_usd_per_million']) / 1e6) if usage and rates else None
    result = {**job, 'freeze_id': lock['freeze_id'], 'mode': lock['mode'], 'calls': calls, 'assessments': assessments,
              'candidates': [{'id': c['candidate_id'], 'sha256': c['output_sha256'], 'output': c['output']} for c in candidates],
              'selected_id': selected['candidate_id'] if selected else None, 'selected': selected['output'] if selected else None,
              'usage': usage, 'estimated_cost_usd': cost, 'wall_seconds': time.time() - started,
              'provider_calls': sum(c.get('provider_calls', 1) for c in calls), 'complete': all(c['status'] == 'completed' for c in calls) and all(a.get('status') != 'error' for a in assessments)}
    if result['provider_calls'] > cap:
        raise ValueError('provider call budget exceeded')
    write_once(path, result)
    return result


def summarise(records, answers, plan, mode):
    measured = [{**r, **measure(r['selected'], answers[r['case']])} for r in records]
    def mean(values):
        return sum(values) / len(values)
    by_arm = {}
    for arm in ARMS:
        rows = [r for r in measured if r['arm'] == arm]
        by_arm[arm] = {'runs': len(rows), **{k: mean([r[k] for r in rows]) for k in (*OUTCOMES, 'missing_output', 'wall_seconds')},
                       'provider_calls': sum(r['provider_calls'] for r in rows),
                       'estimated_cost_usd': sum(r['estimated_cost_usd'] for r in rows) if all(r['estimated_cost_usd'] is not None for r in rows) else None}
    families = sorted({r['family'] for r in measured})
    # Paired differences of family averages lie in [-1,1]. Repeats/variants are not independent n.
    radius = math.sqrt(2 * math.log(12 / plan['thresholds']['simultaneous_alpha']) / len(families))
    contrasts = []
    for comparator in ('one_pass', 'resample'):
        for outcome in OUTCOMES:
            differences = []
            for family in families:
                arm_means = {arm: mean([r[outcome] for r in measured if r['family'] == family and r['arm'] == arm]) for arm in ('revision', comparator)}
                differences.append(arm_means['revision'] - arm_means[comparator])
            estimate = mean(differences)
            contrasts.append({'comparator': comparator, 'outcome': outcome, 'difference': estimate,
                              'interval': [max(-1, estimate - radius), min(1, estimate + radius)]})
    return {'version': 'incident-results/1', 'mode': mode, 'status': 'fixture-rehearsal' if mode == 'fixture' else 'pilot-results',
            'promotion': False, 'reason': 'Specified pilot: principal-study adequacy and external outcome validation remain unestablished.',
            'independent_families': len(families), 'incident_count': len({r['case'] for r in measured}),
            'by_arm': by_arm, 'contrasts': contrasts, 'simultaneous_interval_radius': radius,
            'interval_scope': 'Conservative Hoeffding union bounds conditional on independent families; purposive synthetic cases do not identify production generalisation.',
            'cost_scope': 'Estimated token cost including critic; unknown usage/prices remain null; excludes local compute pricing.',
            'missing_or_failed_runs': sum(not r['complete'] or r['missing_output'] for r in measured),
            'failure_override': any(not r['complete'] or r['missing_output'] for r in measured)}


def run(args):
    out = Path(args.out).resolve()
    lock = verify_lock(out)
    cases = {c['id']: c for c in json.loads((ROOT / 'incidents.json').read_text())}
    def checked_job(job):
        verify_lock(out)
        return run_job(out, lock, job, cases[job['case']])
    if lock['mode'] == 'fixture':
        # Parallel fixture plumbing has no inferential latency interpretation.
        with ThreadPoolExecutor(max_workers=lock['plan']['fixture_workers']) as workers:
            records = list(workers.map(checked_job, lock['jobs']))
    else:
        records = [checked_job(job) for job in lock['jobs']]
    verify_lock(out)
    # Only the measurement process reads reference answers, after all provider work is complete.
    answers = json.loads((ROOT / 'answers.json').read_text())
    report = summarise(records, answers, lock['plan'], lock['mode'])
    report['freeze_id'] = lock['freeze_id']
    report_path = out / 'results.json'
    if report_path.exists():
        if json.loads(report_path.read_text()) != report:
            raise ValueError('existing report does not match immutable observations')
    else:
        write_once(report_path, report)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    freeze_parser = sub.add_parser('freeze')
    freeze_parser.add_argument('--out', required=True)
    freeze_parser.add_argument('--host', required=True)
    freeze_parser.add_argument('--sdk', required=True)
    freeze_parser.add_argument('--mode', choices=('fixture', 'live'), required=True)
    freeze_parser.add_argument('--rates', help='JSON with explicit input/output USD per million, source, as_of')
    run_parser = sub.add_parser('run')
    run_parser.add_argument('--out', required=True)
    args = parser.parse_args()
    print(json.dumps(freeze(args) if args.command == 'freeze' else run(args), indent=2))


if __name__ == '__main__':
    main()
