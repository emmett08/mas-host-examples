// Deterministic CI provider: inspect actual supplied evidence; never call an LLM.
export function fixtureOutput(request, mode = 'review', paced = false, draftDefect = false, voteMismatch = '') {
  const input = JSON.parse(request.input_json);
  if (mode === 'investigate') {
    const tools = ['pod_overview', 'workload_spec', 'pod_logs', 'pod_metrics'];
    const turn = input.history?.length ?? 0;
    return turn < tools.length
      ? { decision: { kind: 'request', target: tools[turn], input_json: tools[turn] === 'pod_logs'
          ? JSON.stringify({ container: 'checkout', previous: false, tail_lines: 40 }) : '{}' } }
      : { decision: { kind: 'complete', output: { summary: 'Fixture investigator requested four real MCP operations; no LLM was called.',
          limitations: ['Tool results identify whether observations came from Kubernetes or retained evidence. Tool selection is scripted; no LLM judgement is claimed.'] } } };
  }
  if (mode === 'vote') {
    // Model-adapter fixture only: the native peer checks record integrity.
    // Test profiles can deliberately return a validly shaped, differently bound
    // vote; the host join must refuse to count it even when accepted is true.
    const candidate = structuredClone(input.candidate), context = structuredClone(input.review_context);
    const output = input.candidate_record.output;
    if (voteMismatch === 'candidate') candidate.sha256 = '0'.repeat(64);
    if (voteMismatch === 'context') context.criterion_id = 'different-criterion';
    return { candidate, context, accepted: output.remediation?.action === 'none' &&
      output.requires_human === true && output.evidence_ids.length === 0 && output.next_checks.length > 0,
      explanation: 'Scripted abstention vote for protocol conformance; no LLM was called.' };
  }
  const items = Array.isArray(input?.incident?.evidence?.items) ? input.incident.evidence.items : [];
  const collected = items.filter(item => item.status === 'collected');
  const pod = collected.find(item => item.id === 'pod' && item.kind === 'pod');
  const subject = input?.incident?.evidence?.subject;
  const deployment = collected.find(item => item.id === 'workload-deployment' && item.kind === 'workload');
  const logs = collected.find(item => item.id === 'logs-checkout-current' && item.kind === 'logs');
  const container = deployment?.data?.spec?.template?.spec?.containers?.find(item => item.name === 'checkout');
  const metadata = deployment?.data?.metadata;
  const lines = typeof logs?.data?.text === 'string' ? logs.data.text.split('\n').flatMap(line => {
    // Kubernetes timestamps=true prepends RFC3339 time before application JSON.
    const document = line.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})\s+/, '');
    try { return [JSON.parse(document)]; } catch { return []; }
  }) : [];
  const matched = pod?.data?.kind === 'Pod' && pod.data.metadata?.namespace === subject?.namespace && pod.data.metadata?.name === subject?.name &&
    pod.data.metadata?.uid === subject?.uid && pod.data.status?.conditions?.some(condition => condition.type === 'Ready' && condition.status === 'False') &&
    deployment?.data?.kind === 'Deployment' && metadata?.namespace === 'mas-demo' && metadata?.name === 'mas-demo-checkout' &&
    typeof metadata.uid === 'string' && metadata.uid.length > 0 && typeof metadata.resourceVersion === 'string' && metadata.resourceVersion.length > 0 &&
    container?.readinessProbe?.httpGet?.path === '/readyz' && container?.livenessProbe?.httpGet?.path === '/healthz' &&
    lines.some(line => line.method === 'GET' && line.path === '/readyz' && line.status === 404) &&
    lines.some(line => line.method === 'GET' && line.path === '/healthz' && line.status === 200) && !deployment.truncated;
  const label = paced ? 'Paced fixture' : 'Fixture';
  const finding = matched
    ? 'The Pod is not Ready. The live readiness probe requests /readyz, which actual container logs return as 404; /healthz returns 200. This prevents readiness despite a functioning health endpoint. [pod, workload-deployment, logs-checkout-current]'
    : 'The supplied evidence does not independently establish the allowlisted readiness-path diagnosis. No automatic remediation is proposed.';
  if (mode !== 'decision') return {
    summary: `${label} review: ${finding}`,
    findings: [finding, 'This is a deterministic test response; no LLM was called.',
      ...(logs?.truncated ? [`The bounded log tail is truncated; missing history prevents a complete incident history.${matched ? ' Both complete retained request records support this narrow path check.' : ''} [logs-checkout-current]`] : []),
      ...collected.filter(item => item.kind === 'metrics').map(item => `Current CPU/memory samples are available [${item.id}]; they do not establish historical absence of OOM.`)],
    checks: matched ? ['Revalidate Deployment UID, resource version and template before replacing only the readiness path. [workload-deployment]', 'Verify rollout readiness and GET /healthz 200 after a bounded patch. [logs-checkout-current]'] : ['Collect the Deployment probe specification and current application logs before selecting a remediation.'],
  };
  return {
    summary: `${label} investigation plan: ${finding}`,
    confidence: matched ? 'high' : 'low',
    next_checks: matched ? ['Revalidate live Deployment identity, version, template and readiness-path preconditions.', 'Verify rollout readiness and health after applying the single allowlisted path replacement.'] : ['Collect the Deployment specification, Pod status, Warning events, logs and CPU/memory samples; compare their timestamps.'],
    requires_human: !matched,
    evidence_ids: [...collected.map(item => item.id), ...(draftDefect && !input.candidate ? ['fixture-missing-evidence'] : [])],
    remediation: {
      action: matched ? 'replace_readiness_probe_path' : 'none',
      target: {kind: matched ? 'Deployment' : '', namespace: matched ? metadata.namespace : '', name: matched ? metadata.name : '', uid: matched ? metadata.uid : '', resource_version: matched ? metadata.resourceVersion : '', container: matched ? 'checkout' : ''},
      current_path: matched ? '/readyz' : '', proposed_path: matched ? '/healthz' : '',
      reason: matched ? 'The configured readiness path returns 404; the existing liveness endpoint /healthz returns 200 in actual logs. Replace only the readiness path after current-state validation.' : 'Insufficient independently corroborated live evidence for the allowlisted action.',
      evidence_ids: matched ? ['pod', 'workload-deployment', 'logs-checkout-current'] : [],
      verification: matched ? ['Revalidate Deployment UID, resource version, original template and /readyz readiness path.', 'Check successful rollout and available ready replicas.', 'Check health endpoint returns 200 and readiness failure events cease.'] : [],
      rollback: matched ? 'Restore the captured original readiness path /readyz on the same Deployment after revalidating identity and current template.' : 'No change proposed.',
    },
  };
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  const request = JSON.parse(text);
  if (request.version !== 'mas-provider/1') process.exit(2);
  const paced = process.argv.includes('--paced');
  if (paced) await new Promise(resolve => setTimeout(resolve, 5000));
  const voteMismatch = process.argv.includes('--wrong-candidate') ? 'candidate' : process.argv.includes('--wrong-context') ? 'context' : '';
  const output = fixtureOutput(request, process.argv[2], paced, process.argv.includes('--draft-defect'), voteMismatch);
  process.stdout.write(JSON.stringify({version: 'mas-provider/1', status: 'completed', output_json: JSON.stringify(output), evidence: {id: paced ? 'paced-evidence-aware-fixture' : 'evidence-aware-fixture', cleanup: 'confirmed'}}));
}
