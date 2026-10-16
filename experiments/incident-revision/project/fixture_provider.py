#!/usr/bin/env python3
"""Scripted plumbing rehearsal. It is deliberately ineligible for benefit claims."""
import json
import sys
request = json.load(sys.stdin)
if request.get('version') != 'mas-provider/1':
    raise SystemExit(2)
task = json.loads(request['input_json'])
if 'rubric' in task:
    output = {'status': 'inconclusive', 'findings': [
        {'criterion_id': c['id'], 'verdict': 'inconclusive', 'score': None, 'evidence': [],
         'explanation': 'Scripted rehearsal: review available evidence; no measured judgement.'}
        for c in task['rubric']['criteria']]}
else:
    output = {'diagnosis': 'unknown', 'action': 'collect_evidence', 'abstain': True,
              'evidence_ids': [e['id'] for e in task['sources']['incident']['evidence']],
              'reasoning': 'Scripted fixture always abstains; this is not a live model result.'}
json.dump({'version': 'mas-provider/1', 'status': 'completed', 'output_json': json.dumps(output),
           'evidence': {'id': 'incident-rehearsal-only', 'cleanup': 'confirmed'}}, sys.stdout)
