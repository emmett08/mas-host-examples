#!/usr/bin/env node
// Record the actual Vue dashboard while a Warning Event triggers the local host.
import { execFile, spawn } from 'node:child_process';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual, promisify } from 'node:util';
import { parseAllDocuments } from 'yaml';
import { validatePracticalEvidence } from './remediation.mjs';
import { canonicalJson, parseRevisionAudit } from '../shared/revision.mjs';
import { validatePostChangeEvidence } from '../shared/post-change-evidence.mjs';
import { managedWorkload, managedWorkloads } from '../shared/workloads.mjs';

const execute = promisify(execFile);
const namespace = 'mas-demo';
const baseURL = 'http://127.0.0.1:18080';
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export function selectRunForPod(items, uid) {
  const matches = items.filter(item => item.spec?.event?.involvedObject?.uid === uid);
  if (matches.length > 1) throw new Error('More than one investigation was admitted for the demonstration Pod');
  return matches[0];
}

export function selectRemediationForRun(items, runId) {
  const matches = items.filter(item => item.spec?.runId === runId);
  if (matches.length > 1) throw new Error('More than one durable remediation journal was created for this run');
  return matches[0];
}

class RemediationNotProposedError extends Error {
  constructor() {
    super('The completed assessment requires engineer review or proposes no permitted correction; automatic recovery will not be attempted. See run.json for the agent reason and next checks.');
    this.name = 'RemediationNotProposedError';
  }
}

export function validateControllerResolution(snapshot, journal, sourceRunUID) {
  const resolution = snapshot?.run?.resolution;
  if (!resolution) {
    const decision = snapshot?.run?.output;
    // A final abstention cannot produce a controller journal or recovery. Keep
    // this a failed practical demonstration, with its actual cause, immediately.
    if (snapshot?.run?.status === 'completed' && (decision?.requires_human !== false ||
        decision?.remediation?.action !== 'replace_readiness_probe_path')) throw new RemediationNotProposedError();
    return false;
  }
  if (resolution.status !== 'verified') throw new Error(`Practical recovery was ${resolution.status}: ${resolution.reason}`);
  if (resolution.version === 'mas-k8s-resolution/2' && (resolution.effectOutcome !== 'applied' || resolution.verificationOutcome !== 'passed')) {
    throw new Error('Practical recovery requires an acknowledged applied effect and passed verification');
  }
  if (journal?.spec?.runId !== snapshot.run.id || journal.spec.sourceRunUID !== sourceRunUID ||
      journal.status?.phase !== 'Finished' || !journal.status.reportJson) {
    throw new Error('The verified recovery has no matching finished controller journal');
  }
  if (!isDeepStrictEqual(JSON.parse(journal.status.reportJson), resolution)) {
    throw new Error('The captured recovery differs from the durable controller report');
  }
  validatePostChangeEvidence(resolution, { required: true });
  return true;
}

export function validateSnapshot(snapshot, mode, id) {
  if (snapshot?.run?.id !== id || snapshot.run.mode !== mode) {
    throw new Error('The recorded investigation identity or provider mode is incorrect');
  }
  if (snapshot.run.status !== 'completed') throw new Error(snapshot.run.error ?? 'The host investigation did not complete');
  if (snapshot.observationAvailable !== true || !Array.isArray(snapshot.observation?.messages)) {
    throw new Error('The completed investigation has no available observation');
  }
  const messages = snapshot.observation.messages;
  const audit = snapshot.run.revision ? parseRevisionAudit(snapshot.run.revision) : undefined;
  if (audit) {
    const selected = audit.candidates.find(candidate => candidate.id === audit.selected?.id);
    if (audit.status !== 'completed' || !selected || canonicalJson(selected.output) !== canonicalJson(snapshot.run.output)) {
      throw new Error('The recording requires a completed assessment of its exact selected candidate');
    }
    if (!audit.contexts.length || !audit.assessments.some(assessment =>
      assessment.candidate.id === audit.selected.id && assessment.candidate.sha256 === audit.selected.sha256)) {
      throw new Error('The assessed trace requires retained invocations and an assessment of the exact selected candidate');
    }
  }
  if (snapshot.observation.payloads_included !== true ||
      messages.some(message => !Object.hasOwn(message, 'payload'))) {
    throw new Error('The demonstration recording requires message payloads; deploy with SHOW_PAYLOADS=true before capturing');
  }
  const expected = audit ? audit.contexts.length * 2 : 16;
  if (messages.length !== expected || new Set(messages.map(message => message.id)).size !== expected) {
    throw new Error(audit ? 'Expected one distinct request/result pair for every retained invocation' : 'Expected sixteen distinct recorded request/result envelopes');
  }
  if (messages.some((message, index) => !Number.isSafeInteger(message.sequence) || message.sequence < 1 ||
      (index > 0 && message.sequence <= messages[index - 1].sequence))) {
    throw new Error('Recorded envelope order is not strictly increasing');
  }
  const requests = messages.filter(message => message.kind === 'request');
  const results = messages.filter(message => message.kind === 'result');
  if (requests.length !== expected / 2 || results.length !== expected / 2) {
    throw new Error(audit ? 'Expected one request and one result per retained invocation' : 'Expected eight recorded requests and eight recorded results');
  }
  for (const request of requests) {
    const replies = results.filter(result => result.correlation === request.id);
    if (replies.length !== 1 || replies[0].sender !== request.recipient ||
        replies[0].recipient !== request.sender || replies[0].sequence <= request.sequence) {
      throw new Error('Every request must have exactly one later, reverse-routed result correlated to its request ID');
    }
  }
  if (!requests.some(message => message.sender === 'platform' && message.recipient === 'security')) {
    throw new Error('The recorded trace is missing the hybrid peer exchange');
  }
  if (requests.filter(message => message.sender === 'security' && message.recipient === 'security_review').length !== 2) {
    throw new Error('The trace must contain both independent security review requests');
  }
  if (snapshot.run.output === undefined || snapshot.run.output === null) {
    throw new Error('The completed investigation has no final assessment');
  }
}

/** Bind a recorded run to its own operator admission, workload and incident Pod. */
export function validateIncidentIdentity(snapshot, resource, trigger, workload) {
  const run = snapshot?.run;
  const event = resource?.spec?.event;
  const subject = run?.input?.incident?.evidence?.subject;
  if (!resource?.metadata?.uid || run?.id !== `k8s-${resource.metadata.uid}` ||
      (resource.spec.approach ?? 'collected') !== workload.approach ||
      (run.approach ?? 'collected') !== workload.approach ||
      !isDeepStrictEqual(run.input?.incident?.event, event) ||
      event?.involvedObject?.kind !== 'Pod' || event.involvedObject.uid !== trigger.podUID ||
      event.involvedObject.name !== trigger.podName || event.involvedObject.namespace !== workload.namespace ||
      subject?.uid !== trigger.podUID || subject.name !== trigger.podName || subject.namespace !== workload.namespace) {
    throw new Error('The recorded investigation differs from its operator-admitted incident and approach');
  }
  const deployment = run.input.incident.evidence.items?.find(item => item.id === 'workload-deployment' && item.status === 'collected')?.data;
  // MCP acquisition may not have collected the Deployment in an early snapshot.
  if (deployment && (deployment.metadata?.uid !== trigger.deploymentUID ||
      deployment.metadata?.namespace !== workload.namespace || deployment.metadata?.name !== workload.name)) {
    throw new Error('The recorded investigation identifies another managed Deployment');
  }
  const repaired = run.resolution?.target;
  if (repaired && (repaired.uid !== trigger.deploymentUID || repaired.namespace !== workload.namespace || repaired.name !== workload.name)) {
    throw new Error('The controller report targets another managed Deployment');
  }
}

export function validateMcpInvestigation(snapshot, mode, id) {
  if (snapshot?.run?.id !== id || snapshot.run.mode !== mode) {
    throw new Error('The recorded investigation identity or provider mode is incorrect');
  }
  const incident = snapshot.run.input?.incident;
  const subject = incident?.evidence?.subject;
  const target = incident?.event?.involvedObject;
  const investigation = snapshot.run.investigation;
  if (snapshot.run.approach !== 'mcp' || target?.kind !== 'Pod' || !target.uid ||
      subject?.uid !== target.uid || subject.name !== target.name || subject.namespace !== target.namespace) {
    throw new Error('The MCP investigation is not bound to its admitted incident Pod');
  }
  if (investigation?.status !== 'completed' || !investigation.runId || !investigation.evidence ||
      !isDeepStrictEqual(investigation.evidence.subject, subject)) {
    throw new Error('The MCP run has no completed investigation with frozen incident evidence');
  }
  if (investigation.source !== 'kubernetes-api') {
    throw new Error('The k3s investigation requires actual Kubernetes API tool observations in either provider mode');
  }
  const requiredTools = ['pod_overview', 'workload_spec', 'pod_logs', 'pod_metrics'];
  if (!Array.isArray(investigation.calls) || investigation.calls.length !== requiredTools.length ||
      requiredTools.some(tool => investigation.calls.filter(call => call.tool === tool).length !== 1)) {
    throw new Error('The MCP investigation requires all four distinct MCP tool calls');
  }
  const observation = snapshot.investigationObservation;
  if (observation?.payloads_included !== true || !Array.isArray(observation.messages) ||
      observation.messages.some(message => !Object.hasOwn(message, 'payload'))) {
    throw new Error('The MCP investigation requires retained request/result payloads; deploy with SHOW_PAYLOADS=true');
  }
  const messages = observation.messages;
  if (!messages.length || new Set(messages.map(message => message.id)).size !== messages.length ||
      messages.some((message, index) => !Number.isSafeInteger(message.sequence) || message.sequence < 1 ||
        (index > 0 && message.sequence <= messages[index - 1].sequence))) {
    throw new Error('The MCP investigation envelopes have invalid identities or order');
  }
  const requests = messages.filter(message => message.kind === 'request');
  const results = messages.filter(message => message.kind === 'result');
  if (requests.length !== results.length || requests.length + results.length !== messages.length ||
      requests.some(request => results.filter(result => result.correlation === request.id &&
        result.sender === request.recipient && result.recipient === request.sender &&
        result.sequence > request.sequence).length !== 1)) {
    throw new Error('The MCP investigation requires one correlated reverse-routed result per request');
  }
  const evidenceIds = new Set(investigation.evidence.items.map(item => item.id));
  if (new Set(investigation.calls.map(call => call.id)).size !== investigation.calls.length ||
      investigation.calls.some(call => !call.id || !['collected', 'unavailable', 'error'].includes(call.status) ||
        !requests.some(request => request.recipient === call.tool) || !Array.isArray(call.evidenceIds) ||
        call.evidenceIds.some(id => !evidenceIds.has(id)))) {
    throw new Error('The MCP call record differs from its observed requests or frozen evidence');
  }
  if (!isDeepStrictEqual(snapshot.run.input.incident.evidence, investigation.evidence)) {
    throw new Error('The MCP assessment input differs from its frozen evidence');
  }
  const bundle = validatePracticalEvidence(snapshot);
  const deployment = bundle.items.find(item => item.id === 'workload-deployment').data;
  const workload = managedWorkload(deployment.metadata?.namespace, deployment.metadata?.name);
  const container = deployment.spec?.template?.spec?.containers?.find(item => item.name === workload?.container);
  if (workload?.approach !== 'mcp' || deployment.kind !== 'Deployment' || deployment.metadata?.namespace !== 'mas-demo' ||
      typeof deployment.metadata?.uid !== 'string' || !deployment.metadata.uid ||
      typeof deployment.metadata?.resourceVersion !== 'string' || !deployment.metadata.resourceVersion ||
      container?.readinessProbe?.httpGet?.path !== workload.currentPath || container?.livenessProbe?.httpGet?.path !== workload.proposedPath) {
    throw new Error('The MCP investigation requires the identified Deployment version and both live probe paths');
  }
  const logs = bundle.items.find(item => item.id === 'logs-checkout-current').data;
  const records = typeof logs?.text === 'string' ? logs.text.split('\n').map(line => {
    try { return JSON.parse(line.slice(line.indexOf('{'))); } catch { return {}; }
  }) : [];
  if (logs?.container !== 'checkout' || logs?.previous !== false ||
      !records.some(record => record.method === 'GET' && record.path === workload.currentPath && record.status === 404) ||
      !records.some(record => record.method === 'GET' && record.path === workload.proposedPath && record.status === 200)) {
    throw new Error(`The MCP investigation requires current checkout logs proving GET ${workload.currentPath} 404 and GET ${workload.proposedPath} 200`);
  }
}

export function failureReport(snapshot, error) {
  if (error instanceof IncidentCaptureError) return error.report;
  const notProposed = error instanceof RemediationNotProposedError;
  const decision = snapshot?.run?.output;
  return {
    runId: snapshot?.run?.id,
    classification: snapshot?.run?.diagnostics?.classification ?? (notProposed ? 'remediation-not-proposed' : 'host-or-capture-failure'),
    error: snapshot?.run?.error ?? error.message,
    ...(snapshot?.run?.diagnostics ? { diagnostics: snapshot.run.diagnostics } : {}),
    ...(notProposed ? { proposal: {
      requiresHuman: decision?.requires_human,
      action: decision?.remediation?.action,
      reason: decision?.remediation?.reason,
    } } : {}),
  };
}

class IncidentCaptureError extends Error {
  constructor(report, cause) {
    super(`Incident capture failed: ${report.error}`, { cause });
    this.name = 'IncidentCaptureError';
    this.report = report;
  }
}

export function observeCanvasProgress(previous, frame, runId) {
  if (frame.selectedRunId !== runId || !Number.isSafeInteger(frame.envelopeCount) || frame.envelopeCount < 0 ||
      !['queued', 'running'].includes(frame.status)) return previous;
  if (previous.firstActiveCount === undefined) return { firstActiveCount: frame.envelopeCount, grewWhileActive: false };
  return { ...previous, grewWhileActive: previous.grewWhileActive || frame.envelopeCount > previous.firstActiveCount };
}

export function validateCanvasProgress(progress) {
  if (progress.firstActiveCount === undefined || !progress.grewWhileActive) {
    throw new Error('The recording did not observe increasing envelope counts on the selected active canvas before completion');
  }
}

async function kubectl(args) {
  return (await execute('kubectl', ['-n', namespace, ...args], {
    encoding: 'utf8', timeout: 20_000, maxBuffer: 8 * 1024 * 1024,
  })).stdout;
}

async function api(path, allowMissing = false) {
  const response = await fetch(`${baseURL}${path}`, { signal: AbortSignal.timeout(10_000) });
  if (allowMissing && response.status === 404) return undefined;
  if (!response.ok) throw new Error(`Dashboard ${path} returned HTTP ${response.status}`);
  return response.json();
}

// Keep the actual faulty Pod unlabelled until its real metrics sample and probe
// logs are available. Labelling that same UID then admits the existing Warning.
export async function prepareIncident(destination, kube = kubectl, workload = managedWorkloads[0]) {
  const workloadName = workload.name;
  await kube(['delete', 'deployment,service', workloadName, '--ignore-not-found', '--wait=true', '--timeout=60s']);
  const resources = parseAllDocuments(await readFile(join(dirname(fileURLToPath(import.meta.url)), workload.approach === 'mcp' ? 'failing-mcp-pod.yaml' : 'failing-pod.yaml'), 'utf8'))
    .map(document => document.toJSON());
  const deployment = resources.find(resource => resource.kind === 'Deployment');
  deployment.metadata.labels['demo.mas.dev/trigger'] = 'false';
  deployment.spec.template.metadata.labels['demo.mas.dev/trigger'] = 'false';
  const warm = join(destination, 'warm-workload.json');
  await writeFile(warm, JSON.stringify({ apiVersion: 'v1', kind: 'List', items: resources }));
  await kube(['apply', '-f', warm]);
  let sample;
  let pod;
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const pods = JSON.parse(await kube(['get', 'pods', '-l', `app.kubernetes.io/name=${workloadName}`, '-o', 'json']));
    pod = pods.items.find(item => !item.metadata.deletionTimestamp && item.status?.phase === 'Running');
    if (pod) {
      try {
        sample = JSON.parse(await kube(['get', '--raw', `/apis/metrics.k8s.io/v1beta1/namespaces/${namespace}/pods/${pod.metadata.name}`]));
        const logs = await kube(['logs', pod.metadata.name, '-c', 'checkout', '--tail=100']);
        const records = logs.trim().split('\n').map(line => { try { return JSON.parse(line); } catch { return {}; } });
        if (sample.metadata?.name === pod.metadata.name && sample.metadata?.namespace === namespace &&
            Date.parse(sample.timestamp) >= Date.parse(pod.metadata.creationTimestamp) && Date.parse(sample.timestamp) <= Date.now() + 5000 &&
            Date.now() - Date.parse(sample.timestamp) < 120_000 &&
            sample.containers?.some(container => container.name === 'checkout' && container.usage?.cpu && container.usage?.memory) &&
            records.some(record => record.path === workload.currentPath && record.status === 404) &&
            records.some(record => record.path === workload.proposedPath && record.status === 200)) break;
      } catch { /* Metrics-server needs a real scrape before it can return usage. */ }
    }
    sample = undefined;
    await delay(2000);
  }
  if (!sample) throw new Error('The practical demonstration requires a genuine metrics-server sample before triggering the incident');
  await writeFile(join(destination, 'warm-metrics.json'), JSON.stringify(sample, null, 2));
  const updated = JSON.parse(await kube(['get', 'deployment', workloadName, '-o', 'json']));
  await kube(['label', 'pod', pod.metadata.name, 'demo.mas.dev/trigger=true', '--overwrite']);
  return { pod, deploymentUID: updated.metadata.uid };
}

/** Observe one Warning-admitted run through its own controller-owned repair. */
export async function captureIncident({ workload, mode, destination, page, deadline,
  kube = kubectl, fetchSnapshot = api, prepare = prepareIncident, checkHealth = () => {}, sleep = delay }) {
  await mkdir(destination, { recursive: true });
  const json = (filename, value) => writeFile(join(destination, filename), `${JSON.stringify(value, null, 2)}\n`);
  const snapshotsPath = join(destination, 'snapshots.ndjson');
  await writeFile(snapshotsPath, '');
  await json('topology.json', await fetchSnapshot('/api/topology'));
  let snapshot, runId, previous = '', refreshed = false, triggerStopped = false, assessmentCaptured = false;
  let canvasProgress = {};
  const frames = [];
  const sampleCanvas = async () => {
    const frame = await page.evaluate(() => {
      const statistic = [...document.querySelectorAll('.run-stats > div')]
        .find(item => item.querySelector('dt')?.textContent?.trim() === 'Envelopes');
      return {
        selectedRunId: document.querySelector('#run-picker')?.value ?? '',
        status: document.querySelector('.run-state')?.textContent?.trim() ?? '',
        envelopeCount: Number(statistic?.querySelector('dd')?.textContent?.trim() ?? Number.NaN),
      };
    });
    frames.push({ observedAt: new Date().toISOString(), ...frame });
    canvasProgress = observeCanvasProgress(canvasProgress, frame, runId);
  };
  try {
    const namespaceUID = JSON.parse(await kube(['get', 'namespace', workload.namespace, '-o', 'json'])).metadata.uid;
    const prepared = await prepare(destination, kube, workload);
    const trigger = { namespace: workload.namespace, namespaceUID, podName: prepared.pod.metadata.name,
      podUID: prepared.pod.metadata.uid, deploymentUID: prepared.deploymentUID,
      workload: workload.name, approach: workload.approach, mode };
    if (!trigger.podUID || !trigger.deploymentUID) throw new Error('The demonstration workload or Pod has no UID');
    await json('trigger.json', trigger);
    while (Date.now() < deadline) {
      checkHealth();
      const resources = JSON.parse(await kube(['get', 'masdemoruns', '-o', 'json']));
      const resource = selectRunForPod(resources.items, trigger.podUID);
      if (resource) {
        await json('run-resource.json', resource);
        // Stop further admissions for this Pod without changing its template or
        // delaying either controller. Its retained warning remains the trigger.
        if (!triggerStopped) {
          await kube(['label', 'pod', trigger.podName, 'demo.mas.dev/trigger=false', '--overwrite']);
          triggerStopped = true;
        }
        runId = resource.status?.runId ?? `k8s-${resource.metadata.uid}`;
        snapshot = await fetchSnapshot(`/api/runs/${encodeURIComponent(runId)}/snapshot`, true);
        if (snapshot) {
          validateIncidentIdentity(snapshot, resource, trigger, workload);
          const encoded = JSON.stringify(snapshot);
          if (encoded !== previous) { await appendFile(snapshotsPath, `${encoded}\n`); previous = encoded; }
          await json('snapshot.json', snapshot);
          await json('run.json', snapshot.run);
          if (snapshot.run.investigation) {
            await json('investigation.json', snapshot.run.investigation);
            await json('tool-calls.json', snapshot.run.investigation.calls ?? []);
            if (snapshot.run.investigation.evidence) await json('evidence.json', snapshot.run.investigation.evidence);
          }
          if (snapshot.investigationObservation) await json('investigation-observation.json', snapshot.investigationObservation);
          if (!refreshed) {
            await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
            await page.getByRole('tab', { name: workload.approach === 'mcp' ? 'LLM tools + MCP' : 'Collected evidence', exact: true }).click();
            await page.locator(`#run-picker option[value="${runId}"]`).waitFor({ state: 'attached', timeout: 15_000 });
            await page.locator('#run-picker').selectOption(runId);
            await page.locator('.topology-panel').scrollIntoViewIfNeeded();
            refreshed = true;
          }
          await sampleCanvas();
          if (['completed', 'failed'].includes(snapshot.run.status)) {
            validateSnapshot(snapshot, mode, runId);
            validatePracticalEvidence(snapshot);
            if (workload.approach === 'mcp') validateMcpInvestigation(snapshot, mode, runId);
            if (!assessmentCaptured) {
              await page.waitForFunction(() => document.querySelector('.run-state')?.textContent?.trim() === 'completed',
                undefined, { timeout: 15_000 });
              if (workload.approach === 'mcp') {
                await page.locator('.investigation-panel[data-investigation-status="completed"]').waitFor({ state: 'visible', timeout: 15_000 });
                await page.screenshot({ path: join(destination, 'investigation-completed.png'), fullPage: true });
                await page.locator('.phase-controls').getByRole('button', { name: 'Assessment', exact: true }).click();
              }
              await page.locator('.output-panel').waitFor({ state: 'visible', timeout: 15_000 });
              await sampleCanvas();
              validateCanvasProgress(canvasProgress);
              await json('evidence.json', snapshot.run.input.incident.evidence);
              if (snapshot.run.revision) await json('assessment-audit.json', snapshot.run.revision);
              await page.screenshot({ path: join(destination, 'assessment-completed.png'), fullPage: true });
              assessmentCaptured = true;
            }
            const journals = JSON.parse(await kube(['get', 'masremediations', '-o', 'json']));
            const journal = selectRemediationForRun(journals.items, runId);
            if (journal) await json('remediation-journal.json', journal);
            if (validateControllerResolution(snapshot, journal, resource.metadata.uid)) {
              await json('outcome.json', snapshot.run.resolution);
              await page.locator('.resolution-panel[data-resolution-status="verified"]').waitFor({ state: 'attached', timeout: 15_000 });
              await page.locator('.resolution-panel').scrollIntoViewIfNeeded();
              await sleep(2000);
              await page.screenshot({ path: join(destination, 'completed.png'), fullPage: true });
              return snapshot;
            }
          }
        }
      }
      await sleep(500);
    }
    throw new Error(`No independently verified ${workload.approach} recovery was captured within the recording deadline`);
  } catch (error) {
    const report = failureReport(snapshot, error);
    await json('failure-diagnostics.json', report);
    await page.screenshot({ path: join(destination, 'failure.png'), fullPage: true }).catch(() => {});
    throw new IncidentCaptureError(report, error);
  } finally {
    await json('canvas-progress.json', { ...canvasProgress, frames });
  }
}

export function validateDistinctRecoveries(collected, mcp) {
  const first = collected?.run, second = mcp?.run;
  if (!first?.id || !second?.id || first.id === second.id ||
      (first.approach ?? 'collected') !== 'collected' || second.approach !== 'mcp' ||
      !first.resolution?.operationId || !second.resolution?.operationId ||
      first.resolution.operationId === second.resolution.operationId ||
      !first.resolution?.attemptId || !second.resolution?.attemptId ||
      first.resolution.attemptId === second.resolution.attemptId ||
      !first.input?.incident?.evidence?.subject?.uid || !second.input?.incident?.evidence?.subject?.uid ||
      !first.resolution?.target?.uid || !second.resolution?.target?.uid ||
      first.input?.incident?.evidence?.subject?.uid === second.input?.incident?.evidence?.subject?.uid ||
      first.resolution?.target?.uid === second.resolution?.target?.uid ||
      first.resolution?.status !== 'verified' || second.resolution?.status !== 'verified') {
    throw new Error('Both approaches require distinct incident Pods, target Deployments, runs and verified controller repairs');
  }
}

export async function main() {
  const mode = process.env.DEMO_MODE;
  if (mode !== 'live' && mode !== 'fixture') throw new Error('DEMO_MODE must explicitly be live or fixture');
  const destination = resolve(process.env.DEMO_ARTIFACT_DIR ?? '/tmp/mas-demo-recording');
  await mkdir(destination, { recursive: true });
  const json = (filename, value) => writeFile(join(destination, filename), `${JSON.stringify(value, null, 2)}\n`);
  const startedAt = new Date().toISOString();
  // Sequential incidents make each live investigation and its repair visible.
  // Both controllers remain enabled throughout; the recorder observes only.
  const deadline = Date.now() + 1_200_000;
  let browser, context, page, forward, forwardError, forwardLog = '', resultError, failure;
  const captures = [];
  const capture = { version: 'mas-k8s-dual-capture/1', runs: managedWorkloads.map(workload => ({ approach: workload.approach, workload: workload.name })) };
  await json('capture.json', capture);
  const browserErrors = [];
  const checkHealth = () => {
    if (forwardError || forward.exitCode !== null) throw new Error('Dashboard port-forward exited during the recording');
    if (browserErrors.length) throw new Error('The dashboard reported a browser error');
  };
  try {
    forward = spawn('kubectl', ['-n', namespace, 'port-forward', '--address=127.0.0.1', 'svc/mas-demo', '18080:8080'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    forward.on('error', error => { forwardError = error; });
    const logForward = chunk => { forwardLog = (forwardLog + chunk.toString()).slice(-32_768); };
    forward.stdout.on('data', logForward);
    forward.stderr.on('data', logForward);
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      checkHealth();
      try {
        const health = await api('/api/health');
        if (health.mode !== mode) throw new Error(`Dashboard provider mode ${health.mode} differs from DEMO_MODE=${mode}`);
        ready = true;
        break;
      } catch (error) {
        if (error.message?.includes('differs from DEMO_MODE')) throw error;
      }
      await delay(1000);
    }
    if (!ready) throw new Error('The dashboard port-forward did not become ready');
    const remediator = JSON.parse(await kubectl(['get', 'deployment', 'mas-demo-remediator', '-o', 'json']));
    if ((remediator.spec.replicas ?? 1) !== 1) throw new Error('Recording requires the single dedicated remediation controller to be enabled');
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1440, height: 1080 },
      recordVideo: { dir: join(destination, 'video'), size: { width: 1440, height: 1080 } } });
    page = await context.newPage();
    page.on('pageerror', error => browserErrors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error' && !message.location().url.endsWith('/favicon.ico')) browserErrors.push(message.text());
    });
    await page.goto(baseURL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForFunction(() => {
      const button = document.querySelector('.start-button');
      return button && !button.disabled && document.querySelector('canvas')?.width > 0;
    }, undefined, { timeout: 30_000 });
    await page.screenshot({ path: join(destination, 'before-trigger.png'), fullPage: true });
    for (const workload of managedWorkloads) {
      const captureDirectory = workload.approach === 'mcp' ? join(destination, 'mcp') : destination;
      const snapshot = await captureIncident({ workload, mode, destination: captureDirectory, page, deadline, checkHealth });
      captures.push(snapshot);
      Object.assign(capture.runs.find(run => run.approach === workload.approach), { runId: snapshot.run.id,
        subject: snapshot.run.input.incident.evidence.subject, target: snapshot.run.resolution.target,
        operationId: snapshot.run.resolution.operationId });
      await json('capture.json', capture);
    }
    validateDistinctRecoveries(captures[0], captures[1]);
    checkHealth();
    console.log(`Recorded two independently repaired ${mode} incidents: ${captures.map(snapshot => snapshot.run.id).join(' and ')}, with ${captures[1].run.investigation.calls.length} actual MCP tool calls`);
  } catch (error) {
    resultError = error;
    failure = failureReport(captures.at(-1), error);
    await json('failure-diagnostics.json', failure);
    console.error(`Failure classification: ${failure.classification}`);
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
      `### MAS investigation failed\n\nClassification: **${failure.classification}**.\n\n${failure.error}\n\nSee the retained \`failure-diagnostics.json\` artefact.\n`);
    if (page) await page.screenshot({ path: join(destination, 'failure.png'), fullPage: true }).catch(() => {});
  } finally {
    for (const workload of managedWorkloads) {
      await kubectl(['delete', 'deployment,service', workload.name, '--ignore-not-found', '--wait=false']).catch(() => {});
    }
    await json('browser-errors.json', browserErrors);
    await writeFile(join(destination, 'port-forward.log'), forwardLog);
    await writeFile(join(destination, 'events-and-runs.json'),
      await kubectl(['get', 'events,masdemoruns,masremediations', '-o', 'json']).catch(error => JSON.stringify({ error: error.message })));
    for (const container of ['dashboard', 'operator']) {
      await writeFile(join(destination, `${container}.log`),
        await kubectl(['logs', 'deployment/mas-demo', '-c', container, '--tail=200']).catch(error => error.message));
    }
    await writeFile(join(destination, 'remediator.log'),
      await kubectl(['logs', 'deployment/mas-demo-remediator', '-c', 'remediator', '--tail=200']).catch(error => error.message));
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    if (forward && forward.exitCode === null) {
      forward.kill('SIGTERM');
      const killed = setTimeout(() => forward.kill('SIGKILL'), 3000);
      killed.unref();
    }
    const description = mode === 'live' ? 'Real OpenAI calls from the event-driven MAS host.'
      : process.env.DEMO_FIXTURE_RECORDING === 'true'
        ? 'Paced deterministic recording fixture; no LLM calls. Each provider call waits five artificial seconds. The actual MAS host and protocol still execute; this delay does not measure model latency.'
        : 'Deterministic provider fixture; no LLM calls. The actual MAS host and protocol still execute.';
    await writeFile(join(destination, 'README.md'), [
      '# Kubernetes MAS demonstration recording', '',
      `Provider mode: **${mode}**. ${description}`, '',
      `Result: **${resultError ? 'failed' : 'completed'}**.`, `Capture started: ${startedAt}.`, '',
      `Collected-evidence run: ${captures[0]?.run?.id ?? 'not completed; inspect retained snapshots'}.`,
      `MCP run: ${captures[1]?.run?.id ?? 'not completed; inspect mcp/ retained snapshots'}.`, '',
      'Each tab records a separate Warning-triggered incident and its own dedicated-controller repair.',
      'The collected-evidence workload is mas-demo-checkout with the incorrect readiness path /readyz.',
      'The LLM tools + MCP workload is mas-demo-checkout-mcp with the incorrect readiness path /ready.',
      'Both bundled applications implement /healthz. Each patch changes only its own readiness path after independent evidence collection and admission.',
      'Both controllers remain running. The recorder creates demonstration workloads, enables their Pod triggers and observes; it never submits API-only investigations or patches a workload.',
      'Root files and mcp/ each retain trigger.json, run-resource.json, assessment-audit.json, remediation-journal.json and outcome.json for their own run.',
      'mcp/ also retains all four actual Kubernetes API tool calls, host request/result envelopes and the frozen investigation evidence.',
      'Each outcome retains the precondition-tested patch, rollout, HTTP response, fresh metrics and post-change logs/events with their observation window.',
      'Successful capture requires two distinct Pod and Deployment identities, two controller journals and two verified recoveries.',
      'The video records the real Vue canvas while the runner-local k3s cluster exists. The cluster is removed when the workflow finishes; this artefact is a recording.',
      'JSON and NDJSON preserve observed envelope sequences and timestamps. Polling does not establish exact network packet timing.',
      'Successful capture requires growing envelope counts on each selected active canvas. Completed-only captures fail.',
      'Fixture drafts deliberately contain an unsupported citation; correction demonstrates controls and does not measure model improvement.',
      'Failed investigations retain failure-diagnostics.json with allowed inference metadata; raw provider error messages are excluded.',
      ...(resultError ? ['', `Failure classification: ${failure.classification}.`, `Failure: ${failure.error}`] : []), '',
    ].join('\n'));
  }
  if (resultError) throw resultError;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
