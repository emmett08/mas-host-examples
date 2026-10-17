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

const execute = promisify(execFile);
const namespace = 'mas-demo';
const workloadName = 'mas-demo-checkout';
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

export function failureReport(snapshot, error) {
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
export async function prepareIncident(destination, kube = kubectl) {
  await kube(['delete', 'deployment,service', workloadName, '--ignore-not-found', '--wait=true', '--timeout=60s']);
  const resources = parseAllDocuments(await readFile(join(dirname(fileURLToPath(import.meta.url)), 'failing-pod.yaml'), 'utf8'))
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
            records.some(record => record.path === '/readyz' && record.status === 404) &&
            records.some(record => record.path === '/healthz' && record.status === 200)) break;
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

export async function main() {
  const mode = process.env.DEMO_MODE;
  if (mode !== 'live' && mode !== 'fixture') throw new Error('DEMO_MODE must explicitly be live or fixture');
  const destination = resolve(process.env.DEMO_ARTIFACT_DIR ?? '/tmp/mas-demo-recording');
  await mkdir(destination, { recursive: true });
  const json = (filename, value) => writeFile(join(destination, filename), `${JSON.stringify(value, null, 2)}\n`);
  const startedAt = new Date().toISOString();
  const deadline = Date.now() + 900_000;
  let browser, context, page, forward, forwardError, forwardLog = '', runId, snapshot, resultError, failure;
  let workloadCreated = false;
  let triggerStopped = false;
  let podName;
  const browserErrors = [];
  const canvasFrames = [];
  let canvasProgress = {};
  let assessmentCaptured = false;
  let recoveryCaptured = false;
  const snapshots = join(destination, 'snapshots.ndjson');
  await writeFile(snapshots, '');
  let previousSnapshot = '';
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
      if (forwardError || forward.exitCode !== null) throw new Error('Could not start the local dashboard port-forward');
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
    const topology = await api('/api/topology');
    if (!Array.isArray(topology.nodes) || topology.nodes.length === 0) throw new Error('The dashboard topology is unavailable');
    await json('topology.json', topology);
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({
      viewport: { width: 1440, height: 1080 },
      recordVideo: { dir: join(destination, 'video'), size: { width: 1440, height: 1080 } },
    });
    page = await context.newPage();
    page.on('pageerror', error => browserErrors.push(error.message));
    page.on('console', message => {
      // Chromium may request an optional favicon which this example does not ship.
      // Keep application failures fatal without classifying that absence as one.
      if (message.type() === 'error' && !message.location().url.endsWith('/favicon.ico')) browserErrors.push(message.text());
    });
    await page.goto(baseURL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForFunction(() => {
      const button = document.querySelector('.start-button');
      return button && !button.disabled && document.querySelector('canvas')?.width > 0;
    }, undefined, { timeout: 30_000 });
    await page.screenshot({ path: join(destination, 'before-trigger.png'), fullPage: true });
    workloadCreated = true;
    const namespaceUID = JSON.parse(await kubectl(['get', 'namespace', namespace, '-o', 'json'])).metadata.uid;
    const prepared = await prepareIncident(destination);
    podName = prepared.pod.metadata.name;
    const podUID = prepared.pod.metadata.uid;
    if (!podUID) throw new Error('The demonstration Pod has no UID');
    await json('trigger.json', { namespace, namespaceUID, podName, podUID, deploymentUID: prepared.deploymentUID, mode });
    let selected = false;
    let refreshedForRun = false;
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
      canvasFrames.push({ observedAt: new Date().toISOString(), ...frame });
      canvasProgress = observeCanvasProgress(canvasProgress, frame, runId);
    };
    while (Date.now() < deadline) {
      if (forwardError || forward.exitCode !== null) throw new Error('Dashboard port-forward exited during the recording');
      if (browserErrors.length) throw new Error('The dashboard reported a browser error');
      const resources = JSON.parse(await kubectl(['get', 'masdemoruns', '-o', 'json']));
      const resource = selectRunForPod(resources.items, podUID);
      if (resource) {
        await json('run-resource.json', resource);
        // Keep the actual workload for collection and recovery. Removing this
        // Pod's opt-in label prevents new Event identities from starting paid runs.
        if (!triggerStopped) {
          await kubectl(['label', 'pod', podName, 'demo.mas.dev/trigger=false', '--overwrite']);
          triggerStopped = true;
        }
        runId = resource.status?.runId ?? `k8s-${resource.metadata.uid}`;
        snapshot = await api(`/api/runs/${encodeURIComponent(runId)}/snapshot`, true);
        if (snapshot) {
          const encoded = JSON.stringify(snapshot);
          if (encoded !== previousSnapshot) {
            await appendFile(snapshots, `${encoded}\n`);
            previousSnapshot = encoded;
          }
          await json('snapshot.json', snapshot);
          await json('run.json', snapshot.run);
          // Fetch run history immediately instead of waiting for the UI's normal
          // three-second poll. A first completed snapshot cannot demonstrate live
          // canvas growth: the UI deliberately suppresses initial-state pulses.
          if (!refreshedForRun) {
            await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
            refreshedForRun = true;
            await page.locator(`#run-picker option[value="${runId}"]`).waitFor({ state: 'attached', timeout: 15_000 });
            await page.locator('#run-picker').selectOption(runId);
            await page.locator('.topology-panel').scrollIntoViewIfNeeded();
            selected = true;
          }
          await sampleCanvas();
          if (['completed', 'failed'].includes(snapshot.run.status)) {
            validateSnapshot(snapshot, mode, runId);
            validatePracticalEvidence(snapshot);
            if (!assessmentCaptured) {
              await page.locator(`#run-picker option[value="${runId}"]`).waitFor({ state: 'attached', timeout: 15_000 });
              if (!selected) await page.locator('#run-picker').selectOption(runId);
              await page.waitForFunction(() => document.querySelector('.run-state')?.textContent?.trim() === 'completed',
                undefined, { timeout: 15_000 });
              await page.locator('.output-panel').waitFor({ state: 'visible', timeout: 15_000 });
              await sampleCanvas();
              validateCanvasProgress(canvasProgress);
              await json('evidence.json', snapshot.run.input.incident.evidence);
              if (snapshot.run.revision) await json('assessment-audit.json', snapshot.run.revision);
              assessmentCaptured = true;
            }
            // The recorder only observes. The in-cluster controller owns admission,
            // journal persistence, Kubernetes mutation, verification and publication.
            const journals = JSON.parse(await kubectl(['get', 'masremediations', '-o', 'json']));
            const journal = selectRemediationForRun(journals.items, runId);
            if (journal) await json('remediation-journal.json', journal);
            if (!validateControllerResolution(snapshot, journal, resource.metadata.uid)) {
              await delay(500);
              continue;
            }
            await json('outcome.json', snapshot.run.resolution);
            recoveryCaptured = true;
            await page.locator('.resolution-panel[data-resolution-status="verified"]').waitFor({ state: 'attached', timeout: 15_000 });
            await page.locator('.resolution-panel').scrollIntoViewIfNeeded();
            await delay(2000); // Let the last real observation pulses finish on video.
            await page.screenshot({ path: join(destination, 'completed.png'), fullPage: true });
            break;
          }
        }
      }
      await delay(500);
    }
    if (snapshot?.run?.status !== 'completed') throw new Error('No completed event investigation was captured within 900 seconds');
    if (!recoveryCaptured) throw new Error('The dedicated remediation controller did not publish verified recovery within 900 seconds');
    if (browserErrors.length) throw new Error('The dashboard reported a browser error');
    console.log(`Recorded ${mode} investigation ${runId} with ${snapshot.observation.messages.length} actual MAS envelopes`);
  } catch (error) {
    resultError = error;
    failure = failureReport(snapshot, error);
    await json('failure-diagnostics.json', failure);
    console.error(`Failure classification: ${failure.classification}`);
    if (process.env.GITHUB_STEP_SUMMARY) {
      await appendFile(process.env.GITHUB_STEP_SUMMARY,
        `### MAS investigation failed\n\nClassification: **${failure.classification}**.\n\n${failure.error}\n\nSee the retained \`failure-diagnostics.json\` artefact.\n`);
    }
    if (page) await page.screenshot({ path: join(destination, 'failure.png'), fullPage: true }).catch(() => {});
  } finally {
    if (workloadCreated) {
      await kubectl(['delete', 'deployment,service', workloadName, '--ignore-not-found', '--wait=false']).catch(() => {});
    }
    await json('browser-errors.json', browserErrors);
    await json('canvas-progress.json', { ...canvasProgress, frames: canvasFrames });
    await writeFile(join(destination, 'port-forward.log'), forwardLog);
    await writeFile(join(destination, 'events-and-runs.json'),
      await kubectl(['get', 'events,masdemoruns,masremediations', '-o', 'json']).catch(error => JSON.stringify({ error: error.message })));
    for (const container of ['dashboard', 'operator']) {
      await writeFile(join(destination, `${container}.log`),
        await kubectl(['logs', 'deployment/mas-demo', '-c', container, '--tail=200']).catch(error => error.message));
    }
    await writeFile(join(destination, 'remediator.log'),
      await kubectl(['logs', 'deployment/mas-demo-remediator', '-c', 'remediator', '--tail=200']).catch(error => error.message));
    // Closing the context finalises Playwright's video before artifact upload.
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    if (forward && forward.exitCode === null) {
      forward.kill('SIGTERM');
      const killed = setTimeout(() => forward.kill('SIGKILL'), 3000);
      killed.unref();
    }
    const description = mode === 'live'
      ? 'Real OpenAI calls from the event-driven MAS host.'
      : process.env.DEMO_FIXTURE_RECORDING === 'true'
        ? 'Paced deterministic recording fixture; no LLM calls. Each provider call waits five artificial seconds. The actual MAS host and protocol still execute; this delay does not measure model latency.'
        : 'Deterministic provider fixture; no LLM calls. The actual MAS host and protocol still execute.';
    await writeFile(join(destination, 'README.md'), [
      '# Kubernetes MAS demonstration recording', '',
      `Provider mode: **${mode}**. ${description}`, '',
      `Result: **${resultError ? 'failed' : 'completed'}**.`,
      `Capture started: ${startedAt}.`,
      `Run identity: ${runId ?? 'not admitted'}.`, '',
      'The video records the real Vue canvas while the runner-local k3s cluster exists.',
      'The cluster is removed when the workflow finishes; this artifact is a recording, not a running dashboard.',
      'JSON and NDJSON contain observed server snapshots. Envelope sequences and timestamps are retained unchanged.',
      'assessment-audit.json retains exact candidates, criterion findings, supporting evidence and supplied feedback. Fixture drafts deliberately include an unsupported citation; their correction is a control demonstration, not empirical model improvement.',
      'Successful demonstration capture requires application payloads in every envelope. These are embedded in the offline inspector.',
      'The practical incident uses real logs, resource specifications, Warning Events and metrics-server samples.',
      'A dedicated in-cluster remediation controller admits only the managed checkout Deployment readiness path /readyz to /healthz.',
      'The recorder observes that controller; it never patches workloads or reads the report credential.',
      'remediation-journal.json retains the immutable admission identity and terminal report independently of the controller Pod.',
      'outcome.json records the exact precondition-tested patch and independently checked rollout, HTTP response and fresh metrics.',
      'A completed investigation is not treated as a recovered application: successful recording requires verified recovery.',
      'NDJSON polling captures changing snapshots; it does not establish network send times or exact packet timing.', '',
      ...(resultError ? [`Failure classification: ${failure.classification}.`, `Failure: ${failure.error}`, ''] : []),
      'Successful capture requires a selected queued/running canvas and a later increase in its envelope count while still active.',
      'A run which completes before the browser observes that growth fails capture; recorded completion alone is insufficient.', '',
      'Files: `video/*.webm`, screenshots, `canvas-progress.json`, `topology.json`, `snapshot.json`, `run.json`,',
      '`snapshots.ndjson`, trigger/run resource metadata, and bounded controller/dashboard diagnostics.',
      'Failed investigations also retain `failure-diagnostics.json` with allowed inference metadata; raw provider error messages are excluded.', '',
    ].join('\n'));
  }
  if (resultError) throw resultError;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
