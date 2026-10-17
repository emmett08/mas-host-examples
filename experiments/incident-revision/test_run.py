import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('incident_run', Path(__file__).with_name('run.py'))
study = importlib.util.module_from_spec(spec)
spec.loader.exec_module(study)


class ExperimentTests(unittest.TestCase):
    def test_reference_labels_and_family_names_are_not_worker_inputs(self):
        case = {'id': 'oom-1', 'title': 'memory-limit answer', 'family': 'oom',
                'split': 'held-out', 'answer': 'memory_limit', 'evidence': [{'id': 'pod', 'text': 'Observed exit 137'}]}
        supplied = study.public_incident(case)
        self.assertNotIn('oom', study.canonical(supplied))
        self.assertNotIn('memory_limit', study.canonical(supplied))
        self.assertEqual(set(supplied), {'id', 'title', 'evidence'})

    def test_bad_evidence_never_becomes_passing_assessment(self):
        bad = {'evidence_ids': ['invented'], 'abstain': False}
        self.assertEqual(study.internal_check(bad, {'evidence': []})['verdict'], 'fail')
        self.assertEqual(study.internal_check({'evidence_ids': [], 'abstain': True, 'action': 'collect_evidence'}, {'evidence': []})['verdict'], 'inconclusive')

    def test_independent_measurement_distinguishes_correct_unsafe_and_abstention(self):
        reference = {'diagnosis': 'memory_limit', 'acceptable_actions': ['inspect_memory'], 'unsafe_actions': ['delete_namespace', 'disable_probe'], 'abstain': False}
        self.assertEqual(study.measure({'diagnosis': 'memory_limit', 'action': 'delete_namespace', 'abstain': False}, reference),
                         {'diagnosis_correct': 1, 'unsafe_proposal': 1, 'appropriate_abstention': 1, 'missing_output': 0})
        self.assertEqual(study.measure(None, reference)['missing_output'], 1)
        reference = {'diagnosis': 'unknown', 'acceptable_actions': ['collect_evidence'], 'unsafe_actions': ['delete_namespace', 'disable_probe'], 'abstain': True}
        self.assertEqual(study.measure({'diagnosis': 'unknown', 'action': 'collect_evidence', 'abstain': True}, reference)['appropriate_abstention'], 1)

    def test_usage_counts_effect_once_and_does_not_fabricate_missing_cost(self):
        evidence = {'usage': {'input_tokens': 7, 'output_tokens': 3}}
        self.assertEqual(study.usage_from({'steps': [{'kind': 'effect', 'evidence': evidence}, {'kind': 'call', 'evidence': evidence}]}), {'input_tokens': 7, 'output_tokens': 3})
        self.assertIsNone(study.usage_from({'steps': [{'kind': 'effect', 'evidence': {}}]}))

    def test_restart_reuses_completed_job_and_resample_receives_no_feedback(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            plan = json.loads((study.ROOT / 'plan.json').read_text())
            lock = {'freeze_id': 'fixed', 'mode': 'fixture', 'rates': None, 'plan': plan}
            case = {'id': 'case-1', 'title': 'Case', 'evidence': []}
            seen = []
            def invoke(out, lock, job_id, index, actor, task, deadline):
                seen.append(task)
                return {'candidate_id': str(index), 'status': 'completed', 'output': {'sample': index},
                        'output_sha256': study.digest(index), 'usage': None, 'actor': actor}
            job = {'case': case['id'], 'family': 'f', 'repeat': 0, 'arm': 'resample'}
            with patch.object(study, 'invoke', invoke):
                first = study.run_job(out, lock, job, case)
                second = study.run_job(out, lock, job, case)
            self.assertEqual(len(seen), 4)
            self.assertEqual(first, second)
            self.assertEqual(first['selected_id'], '3')
            for task in seen:
                self.assertEqual(task['feedback'], [])
                self.assertIsNone(task['candidate'])

    def test_resampling_stops_after_unknown_inference_without_new_retry_identity(self):
        with tempfile.TemporaryDirectory() as tmp:
            plan = json.loads((study.ROOT / 'plan.json').read_text())
            lock = {'freeze_id': 'fixed', 'mode': 'fixture', 'rates': None, 'plan': plan}
            seen = []
            def invoke(out, lock, job_id, index, actor, task, deadline):
                seen.append(index)
                return {'candidate_id': str(index), 'status': 'completed' if index == 0 else 'timeout_unknown',
                        'output': {}, 'output_sha256': study.digest({}), 'usage': None, 'actor': actor}
            with patch.object(study, 'invoke', invoke):
                result = study.run_job(Path(tmp), lock, {'case': 'x', 'family': 'f', 'repeat': 0, 'arm': 'resample'},
                                       {'id': 'x', 'title': 'x', 'evidence': []})
            self.assertEqual(seen, [0, 1])
            self.assertEqual(result['selected_id'], '0')
            self.assertFalse(result['complete'])

    def test_revision_arm_uses_host_controller_and_retains_assessment_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            plan = json.loads((study.ROOT / 'plan.json').read_text())
            lock = {'freeze_id': 'fixed', 'mode': 'fixture', 'rates': None, 'plan': plan}
            case = {'id': 'case-1', 'title': 'Case', 'evidence': []}
            seen = []
            def invoke(out, lock, job_id, index, actor, task, deadline, revision=False):
                seen.append((task, revision))
                return {'candidate_id': 'run', 'status': 'completed', 'output': {}, 'output_sha256': study.digest({}),
                        'usage': None, 'actor': actor, 'provider_calls': 2,
                        'revision': {'candidates': [{'id': 'candidate-0', 'output': {}, 'output_sha256': study.digest({})}],
                                     'assessments': [{'status': 'error'}]}}
            with patch.object(study, 'invoke', invoke):
                result = study.run_job(Path(tmp), lock, {'case': 'case-1', 'family': 'f', 'repeat': 0, 'arm': 'revision'}, case)
            self.assertTrue(seen[0][1])
            self.assertEqual(len(seen), 1)
            self.assertEqual(result['selected_id'], 'candidate-0')
            self.assertEqual(result['provider_calls'], 2)
            self.assertFalse(result['complete'])

    def test_declared_budget_is_checked_against_execution(self):
        plan = json.loads((study.ROOT / 'plan.json').read_text())
        study.validate_plan(plan)
        plan['budgets']['max_provider_calls_per_arm'] = 2
        with self.assertRaisesRegex(ValueError, 'cap'):
            study.validate_plan(plan)

    def test_missing_usage_in_one_effect_makes_total_unknown(self):
        self.assertIsNone(study.usage_from({'steps': [
            {'kind': 'effect', 'evidence': {'usage': {'input_tokens': 1, 'output_tokens': 2}}},
            {'kind': 'effect', 'evidence': {}}]}))

    def test_analysis_uses_families_not_repeated_rows_and_failure_vetoes(self):
        plan = json.loads((study.ROOT / 'plan.json').read_text())
        records, answers = [], {}
        for family in ('a', 'b'):
            answers[family] = {'diagnosis': 'unknown', 'abstain': True, 'unsafe_actions': ['delete_namespace']}
            for repeat in range(3):
                for arm in study.ARMS:
                    records.append({'case': family, 'family': family, 'arm': arm,
                        'selected': {'diagnosis': 'unknown', 'abstain': True, 'action': 'collect_evidence'},
                        'wall_seconds': 1, 'provider_calls': 1, 'estimated_cost_usd': None,
                        'complete': True})
        records[0]['selected'] = None
        records[0]['complete'] = False
        report = study.summarise(records, answers, plan, 'fixture')
        self.assertEqual(report['independent_families'], 2)
        self.assertEqual(report['by_arm']['one_pass']['runs'], 6)
        self.assertTrue(report['failure_override'])
        self.assertFalse(report['promotion'])
        self.assertEqual(report['missing_or_failed_runs'], 1)
        self.assertIsNone(report['by_arm']['revision']['estimated_cost_usd'])

    def test_changed_reference_and_worker_bytes_reject_existing_freeze(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            host, bundle, worker = out/'host', out/'bundle', out/'worker'
            for file in (host, bundle, worker):
                file.write_text('original')
            lock = {'sources': {'answers.json': 'expected'}, 'host': str(host), 'host_sha256': study.file_hash(host),
                    'bundle': str(bundle), 'bundle_sha256': study.file_hash(bundle),
                    'artifacts': {str(worker): study.file_hash(worker)}}
            lock['freeze_id'] = study.digest(lock)
            study.write_once(out/'lock.json', lock)
            with patch.object(study, 'source_hashes', return_value={'answers.json': 'changed'}):
                with self.assertRaisesRegex(ValueError, 'source'):
                    study.verify_lock(out)
            worker.write_text('changed')
            with patch.object(study, 'source_hashes', return_value={'answers.json': 'expected'}):
                with self.assertRaisesRegex(ValueError, 'asset'):
                    study.verify_lock(out)

    def test_tampered_freeze_identity_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            study.write_once(Path(tmp) / 'lock.json', {'freeze_id': 'false', 'jobs': []})
            with self.assertRaisesRegex(ValueError, 'identity'):
                study.verify_lock(Path(tmp))

    def test_immutable_write_rejects_duplicate_identity(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'assessment.json'
            study.write_once(path, {'value': 1})
            with self.assertRaises(FileExistsError):
                study.write_once(path, {'value': 2})


if __name__ == '__main__':
    unittest.main()
