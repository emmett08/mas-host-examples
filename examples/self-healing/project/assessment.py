"""Trusted structural assessment only. This never authorises a repair or deployment."""
import hashlib
import json


def assess(_ctx, invocation):
    output = invocation['candidate']['output']
    # The operation schema has already checked the phase output. This final
    # independent boundary rejects oversized records before subsequent frames.
    encoded = json.dumps(output, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()
    evidence = []
    for item in invocation['evidence']:
        raw = json.dumps(item, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()
        evidence.append({'id': item['id'], 'sha256': hashlib.sha256(raw).hexdigest()})
    passed = len(encoded) <= 12288
    return {'status': 'completed', 'findings': [{
        'criterion_id': 'bounded-record', 'verdict': 'pass' if passed else 'fail',
        'score': 1 if passed else 0, 'evidence': evidence,
        'explanation': 'Phase output fits the application frame budget. This structural check establishes no product correctness or release authority.'
    }]}


def receipt(ctx, invocation):
    """Exercise the real native SDK with an admitted application operation binding."""
    from mas_host import EffectResult
    operation = invocation['operationId']
    descriptor = {'format': 'self-remediation-receipt/1', 'operationId': operation,
                  'measurement': invocation.get('measurement', 'passed')}
    def execute(effect_id):
        result = {'status': 'COMPLETED', 'measurement': descriptor['measurement'],
                  'operationId': operation, 'invocation_id': effect_id,
                  'native_invocation_id': ctx.invocation_id}
        return EffectResult(result, {'operationId': operation, 'invocation_id': effect_id,
                                     'kind': 'native-binding-control'})
    return ctx.effect('receipt', descriptor, execute)
