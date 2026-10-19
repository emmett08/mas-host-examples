#!/usr/bin/env node
// Exercise the compiled download through file:// with every network request blocked.
import assert from 'node:assert/strict';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { readArchive } from './archive.mjs';
import { validatePostChangeEvidence } from '../shared/post-change-evidence.mjs';

/** New dual captures must prove two repairs; older comparison captures stay readable. */
export function checkDualCapture(archive) {
  if (archive.capture === undefined) return false;
  const capture = archive.capture;
  assert.equal(capture.version, 'mas-k8s-dual-capture/1');
  assert.equal(capture.runs?.length, 2, 'A dual capture must identify both incident approaches');
  const recordings = [archive, ...(archive.comparisons ?? [])];
  const finals = ['collected', 'mcp'].map(approach => {
    const entry = capture.runs.find(item => item.approach === approach);
    assert.ok(entry, `Missing ${approach} capture identity`);
    const matches = recordings.filter(item => (item.snapshots.at(-1)?.run.approach ?? 'collected') === approach);
    assert.equal(matches.length, 1, `Exactly one ${approach} recording is required`);
    const run = matches[0].snapshots.at(-1).run;
    assert.equal(run.id, entry.runId, `${approach} run identity was not retained`);
    assert.equal(run.status, 'completed', `${approach} investigation ${run.id} ended with status ${run.status}; see its failure-diagnostics.json`);
    const subject = run.investigation?.evidence?.subject ?? run.input?.incident?.evidence?.subject;
    assert.deepEqual(subject, entry.subject, `${approach} incident Pod identity differs`);
    assert.ok(subject?.uid, `${approach} incident Pod UID is required`);
    assert.equal(run.resolution?.status, 'verified', `${approach} must have its own verified controller repair`);
    assert.equal(run.resolution.version, 'mas-k8s-resolution/2');
    assert.equal(run.resolution.effectOutcome, 'applied');
    assert.equal(run.resolution.verificationOutcome, 'passed');
    assert.deepEqual(run.resolution.target, entry.target);
    assert.equal(run.resolution.target.name, entry.workload);
    assert.equal(run.resolution.operationId, entry.operationId);
    assert.ok(run.resolution.operationId && run.resolution.attemptId);
    validatePostChangeEvidence(run.resolution, { required: true });
    return { run, subject };
  });
  assert.notEqual(finals[0].run.id, finals[1].run.id);
  assert.notEqual(finals[0].subject.uid, finals[1].subject.uid, 'Dual capture incidents must identify different Pods');
  for (const key of ['uid', 'name']) assert.notEqual(finals[0].run.resolution.target[key], finals[1].run.resolution.target[key],
    'Dual capture repairs must identify different Deployments');
  // One controller process can own both attempts; operation identity scopes its journal.
  assert.notEqual(finals[0].run.resolution.operationId, finals[1].run.resolution.operationId);
  return true;
}

/** A tab switch replaces its canvas; await its actual-size paint before capture. */
async function checkCanvasSize(page) {
  await page.waitForFunction(async () => {
    const canvas = document.querySelector('.graph-board canvas');
    if (!(canvas instanceof HTMLCanvasElement)) return false;
    const before = canvas.getBoundingClientRect();
    for (let paint = 0; paint < 3; paint++) await new Promise(requestAnimationFrame);
    const bounds = canvas.getBoundingClientRect(), ratio = Math.min(devicePixelRatio || 1, 2);
    return before.width === bounds.width && before.height === bounds.height && bounds.width > 0 && bounds.height > 0 &&
      canvas.width === Math.round(bounds.width * ratio) && canvas.height === Math.round(bounds.height * ratio) &&
      Number(canvas.dataset.renderWidth) === bounds.width && Number(canvas.dataset.renderHeight) === bounds.height;
  });
  const dimensions = await page.locator('.graph-board canvas').evaluate(canvas => {
    const bounds = canvas.getBoundingClientRect();
    return { bitmap: [canvas.width, canvas.height], css: [bounds.width, bounds.height], ratio: Math.min(devicePixelRatio || 1, 2) };
  });
  assert.deepEqual(dimensions.bitmap, dimensions.css.map(value => Math.round(value * dimensions.ratio)),
    'Canvas bitmap dimensions must match its CSS box without stretching');
}

/** Check real layout across every change that can grow a result panel. */
async function checkPlaybackPlacement(page, recording) {
  const time = snapshot => snapshot.observedAtMs ?? snapshot.observation.observed_at_ms;
  const firstTime = time(recording.snapshots[0]);
  const timeline = page.getByRole('slider', { name: 'Recorded observation timeline' });
  const geometry = () => page.evaluate(() => {
    const controls = document.querySelector('.playback-bar');
    const graph = document.querySelector('.topology-panel');
    const board = document.querySelector('.graph-board');
    const controlsBox = controls.getBoundingClientRect();
    const graphBox = graph.getBoundingClientRect();
    return {
      adjacent: controls.nextElementSibling?.classList.contains('workspace'),
      gap: graphBox.top - controlsBox.bottom,
      expectedGap: Number.parseFloat(getComputedStyle(controls).marginBottom),
      graphTop: graphBox.top + scrollY,
      boardTop: board.getBoundingClientRect().top + scrollY,
      scrollY,
      resultsFollowGraph: [...document.querySelectorAll('.investigation-panel, .evidence-panel, .assessment-panel, .output-panel, .resolution-panel, .comparison-resolution-panel')]
        .every(panel => panel.getBoundingClientRect().top >= graphBox.bottom),
    };
  });
  await page.getByRole('button', { name: 'Restart', exact: true }).click();
  await page.getByRole('combobox', { name: 'Playback speed' }).selectOption('8');
  await checkCanvasSize(page);
  // Keep the controls and upper graph visible, as a viewer watching playback would.
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    const controls = document.querySelector('.playback-bar');
    window.scrollTo(0, controls.getBoundingClientRect().top + scrollY - Number.parseFloat(getComputedStyle(controls).top));
  });
  const initial = await geometry();
  assert.equal(initial.adjacent, true, 'The communication graph must directly follow the playback controls');
  assert.ok(Math.abs(initial.gap - initial.expectedGap) < 1, 'No findings or notices may separate playback controls from the graph');
  const assertStable = async () => {
    const current = await geometry();
    assert.equal(current.adjacent, true);
    assert.equal(current.resultsFollowGraph, true, 'Growing results must be below the graph');
    for (const key of ['graphTop', 'boardTop', 'scrollY']) {
      assert.ok(Math.abs(current[key] - initial[key]) < 1, `${key} moved during playback (${initial[key]} → ${current[key]})`);
    }
  };
  await assertStable();
  let previous;
  for (const snapshot of recording.snapshots) {
    const run = snapshot.run;
    const shape = JSON.stringify([run.status, run.error, run.investigation?.status, run.investigation?.calls?.length,
      (run.investigation?.evidence ?? run.input?.incident?.evidence)?.items?.length,
      run.revision?.status, run.revision?.candidates?.length, run.revision?.assessments?.length,
      run.output !== undefined, run.resolution?.status, run.reconciliations?.length]);
    if (shape === previous) continue;
    previous = shape;
    const offset = time(snapshot) - firstTime;
    if (offset <= 0) continue;
    // Start immediately before this recorded transition, then let the actual Play
    // handler and playback timer reveal the new evidence/assessment content.
    await timeline.evaluate((input, position) => {
      input.value = String(position);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, offset - 1);
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await page.waitForFunction(position => Number(document.querySelector('.playback-timeline input').value) >= position, offset);
    const pause = page.getByRole('button', { name: 'Pause', exact: true });
    if (await pause.count()) await pause.click();
    await assertStable();
  }
  await page.getByRole('button', { name: 'View final', exact: true }).click();
  await assertStable();
  await page.getByRole('button', { name: 'Restart', exact: true }).click();
  await assertStable();
}

export async function checkArchive(directory, launchOptions = {}) {
  const html = join(resolve(directory), 'dashboard', 'index.html');
  try { await access(html); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    console.log('Offline browser check skipped: no dashboard was packaged.');
    return;
  }
  assert.ok(await readArchive(directory), 'A packaged dashboard must have retained observations');
  const embedded = (await readFile(html, 'utf8')).match(/<script id="mas-demo-archive" type="application\/json">([\s\S]*?)<\/script>/);
  assert.ok(embedded, 'The packaged dashboard must embed its captures');
  const archive = JSON.parse(embedded[1]);
  const dualCapture = checkDualCapture(archive);
  const trace = snapshot => snapshot.run.approach === 'mcp'
    ? snapshot.investigationObservation ?? { messages: [] } : snapshot.observation;
  const recordedTime = snapshot => snapshot.observedAtMs ?? snapshot.observation.observed_at_ms;
  const initial = archive.snapshots[0];
  const final = archive.snapshots.at(-1);
  const firstCount = new Set(trace(initial).messages.map(message => message.id)).size;
  const finalCount = new Set(trace(final).messages.map(message => message.id)).size;
  const browser = await chromium.launch({ headless: true, ...launchOptions });
  const errors = [], requests = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
    await context.route(/^https?:/, route => route.abort());
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('request', request => {
      if (/^https?:/.test(request.url())) requests.push(request.url());
    });
    await page.goto(pathToFileURL(html).href, { waitUntil: 'load' });
    const archiveError = page.locator('.error-notice');
    await page.getByRole('button', { name: 'Play', exact: true }).or(archiveError).first().waitFor();
    if (await archiveError.isVisible()) assert.fail(`Archive UI rejected the recording: ${await archiveError.innerText()}`);
    assert.match(await page.locator('body').innerText(), /Recorded run · playback/);
    assert.equal(await page.locator('.start-button').count(), 0, 'The archive must not offer live inference');
    const envelopeCount = () => page.locator('.run-stats > div').filter({ has: page.locator('dt', { hasText: /^Envelopes$/ }) }).locator('dd').innerText().then(Number);
    assert.equal(await envelopeCount(), firstCount);
    const timeline = page.getByRole('slider', { name: 'Recorded observation timeline' });
    if (firstCount < finalCount) {
      const speed = 8;
      const firstGrowth = archive.snapshots.find(snapshot =>
        new Set(trace(snapshot).messages.map(message => message.id)).size > firstCount);
      const growthTimeout = Math.ceil((recordedTime(firstGrowth) - recordedTime(initial)) / speed) + 10_000;
      await page.getByRole('combobox', { name: 'Playback speed' }).selectOption(String(speed));
      await page.getByRole('button', { name: 'Play', exact: true }).click();
      await page.waitForFunction(first => {
        const item = [...document.querySelectorAll('.run-stats > div')].find(element => element.querySelector('dt')?.textContent?.trim() === 'Envelopes');
        return Number(item?.querySelector('dd')?.textContent) > first;
      }, firstCount, { timeout: growthTimeout });
      // Pause before inspecting; finished short traces have already stopped.
      const pause = page.getByRole('button', { name: 'Pause', exact: true });
      if (await pause.count()) await pause.click();
      const pausedPosition = await timeline.inputValue();
      const pausedCount = await envelopeCount();
      await page.waitForTimeout(300);
      assert.equal(await timeline.inputValue(), pausedPosition);
      assert.equal(await envelopeCount(), pausedCount);
    }
    await page.getByRole('button', { name: 'View final', exact: true }).click();
    assert.equal(await envelopeCount(), finalCount);
    if (final.run.output !== undefined && final.run.output !== null) {
      await page.locator('.output-panel').waitFor({ state: 'visible' });
    }
    const audit = final.run.revision;
    if (audit) {
      const panel = page.locator('.assessment-panel');
      await panel.waitFor({ state: 'visible' });
      assert.equal(await panel.getAttribute('data-revision-status'), audit.status);
      assert.equal(await panel.locator('.candidate-card').count(), audit.candidates.length);
      for (const candidate of audit.candidates) {
        const card = panel.locator(`[data-candidate-id="${candidate.id}"]`);
        assert.equal(await card.getAttribute('data-selected'), String(audit.selected?.id === candidate.id));
        await card.locator('details > summary').first().click();
        assert.deepEqual(JSON.parse(await card.locator('details > pre').first().innerText()), candidate.output);
        for (const assessment of audit.assessments.filter(item => item.candidate.id === candidate.id)) {
          const item = card.locator(`[data-assessment-id="${assessment.id}"]`);
          assert.match(await item.innerText(), new RegExp(assessment.candidate.sha256));
          assert.equal(await item.locator('.criterion-finding').count(), assessment.findings.length);
          assert.match(await item.locator('h4').innerText(), assessment.evaluator.kind === 'model' ? /Model judgement/ : /Deterministic check/);
        }
      }
      assert.match(await panel.innerText(), /higher internal score does not establish improvement/);
    }
    const evidence = final.run.investigation?.evidence ?? final.run.input?.incident?.evidence;
    if (evidence) {
      const panel = page.locator('.evidence-panel');
      await panel.waitFor({ state: 'visible' });
      assert.equal(await panel.locator('#evidence-title').innerText(), `${evidence.subject.namespace} / ${evidence.subject.name}`);
      assert.equal(await panel.locator('.output-note code').innerText(), evidence.subject.uid);
      const collected = evidence.items.filter(item => item.status === 'collected').length;
      assert.equal(await panel.locator('.output-label').innerText(), `${collected} / ${evidence.items.length} collected`);
      const items = panel.locator('.evidence-item');
      assert.equal(await items.count(), evidence.items.length, 'The archive must retain every evidence item and its status');
      for (let index = 0; index < evidence.items.length; index++) {
        const expected = evidence.items[index], item = items.nth(index);
        assert.equal(await item.getAttribute('data-evidence-id'), expected.id);
        assert.equal(await item.getAttribute('data-evidence-status'), expected.status);
        assert.equal(await item.locator('.evidence-id').innerText(), expected.id);
        assert.equal(await item.locator('.evidence-state').innerText(), `${expected.status}${expected.truncated ? ' · bounded / truncated' : ''}`);
        await item.locator('summary').click();
        assert.ok((await item.locator('.evidence-source').innerText()).startsWith(`${expected.source} · `), 'Evidence provenance must remain visible');
        if (expected.reason) assert.equal(await item.locator('.output-note').innerText(), expected.reason);
        if (expected.status === 'collected') {
          const raw = await item.locator('pre').innerText();
          if (typeof expected.data === 'string') {
            let parsed;
            try { parsed = JSON.parse(expected.data); } catch { /* Plain log text is displayed verbatim. */ }
            if (parsed === undefined) assert.equal(raw, expected.data);
            else assert.deepEqual(JSON.parse(raw), parsed);
          } else assert.deepEqual(JSON.parse(raw), expected.data, `The ${expected.id} inspector must display its captured data unchanged`);
        } else assert.equal(await item.locator('pre').count(), 0, 'Unavailable evidence must not display invented data');
        await item.locator('summary').click();
      }
    }
    const resolution = final.run.resolution;
    if (resolution) {
      const panel = page.locator('.resolution-panel');
      await panel.waitFor({ state: 'visible' });
      assert.equal(await panel.getAttribute('data-resolution-status'), resolution.status);
      assert.equal(await panel.getAttribute('data-source-run-id'), final.run.id);
      assert.equal(await panel.locator('#resolution-title').innerText(), `${resolution.target.namespace} / ${resolution.target.name}`);
      assert.equal(await panel.locator('.resolution-state').innerText(), resolution.status === 'verified'
        ? 'Verified recovery' : resolution.status === 'failed' ? 'Recovery not verified' : 'Needs engineer');
      assert.equal(await panel.locator('.assessment-summary').innerText(), resolution.reason);
      const effects = { not_started: 'Not started', rejected: 'Rejected by the target API', applied: 'Application acknowledged', unknown: 'Unknown — no automatic retry' };
      const verification = { not_run: 'Not run', passed: 'Passed', failed: 'Failed', inconclusive: 'Inconclusive' };
      assert.equal(await panel.locator('[data-effect-outcome]').innerText(), resolution.version === 'mas-k8s-resolution/2' ? effects[resolution.effectOutcome] : 'Not separately recorded (legacy report)');
      assert.equal(await panel.locator('[data-verification-outcome]').innerText(), resolution.version === 'mas-k8s-resolution/2' ? verification[resolution.verificationOutcome] : 'Not separately recorded (legacy report)');
      assert.equal(await panel.locator('.reconciliation-observations details').count(), final.run.reconciliations?.length ?? 0);
      const checks = panel.locator('.verification-checks li');
      assert.equal(await checks.count(), resolution.checks.length);
      for (let index = 0; index < resolution.checks.length; index++) {
        const expected = resolution.checks[index], check = checks.nth(index);
        assert.equal(await check.locator('strong').innerText(), `${expected.passed ? 'Passed' : 'Failed'} · ${expected.name}`);
        assert.equal(await check.locator('span').innerText(), expected.detail);
      }
      await panel.locator('.assessment-details summary').first().click();
      assert.deepEqual(JSON.parse(await panel.locator('.assessment-details pre').first().innerText()),
        { patch: resolution.patch, before: resolution.before, after: resolution.after,
          ...(resolution.verificationEvidence ? { verificationEvidence: resolution.verificationEvidence } : {}) },
        'The recovery inspector must display the captured patch and before/after evidence unchanged');
    }
    const row = page.locator('.event-table tbody tr').first();
    const inspected = Boolean(await row.count());
    if (inspected) {
      await row.click();
      assert.match(await page.locator('#inspector-title').innerText(), /Envelope/);
    }
    const payloadInspections = [];
    if (trace(final).payloads_included === true) {
      for (const kind of ['request', 'result']) {
        const message = trace(final).messages.find(message => message.kind === kind);
        if (!message) continue; // Failed captures can end before a result exists.
        assert.ok(Object.hasOwn(message, 'payload'), `The recorded ${kind} must retain its payload`);
        await page.getByRole('button', {
          name: `Inspect message ${message.sequence}: ${message.sender} to ${message.recipient}`, exact: true,
        }).click();
        assert.deepEqual(JSON.parse(await page.locator('.inspector-panel .payload').innerText()), message.payload,
          `The offline inspector must display the captured ${kind} payload unchanged`);
        assert.equal(await page.locator('.payload-hidden').count(), 0);
        payloadInspections.push(kind);
      }
    }
    await timeline.focus();
    await timeline.press('Home');
    assert.equal(await envelopeCount(), firstCount);
    if (resolution && !initial.run.resolution) {
      await page.locator('.resolution-panel').waitFor({ state: 'detached' });
      assert.equal(await page.locator('.resolution-panel').count(), 0, 'Seeking backwards must hide a future recovery report');
    }
    if (audit && !initial.run.revision) assert.equal(await page.locator('.assessment-panel').count(), 0, 'Seeking backwards must hide later assessments and supplied feedback');
    await timeline.press('End');
    assert.equal(await envelopeCount(), finalCount);
    if (resolution) await page.locator(`.resolution-panel[data-resolution-status="${resolution.status}"]`).waitFor({ state: 'visible' });
    await page.getByRole('button', { name: 'Restart', exact: true }).click();
    assert.equal(await envelopeCount(), firstCount);
    assert.equal(await timeline.inputValue(), '0');
    if (initial.run.output === undefined || initial.run.output === null) {
      assert.equal(await page.locator('.output-panel').count(), 0, 'Seeking backwards must hide a future assessment');
    }
    if (resolution && !initial.run.resolution) {
      await page.locator('.resolution-panel').waitFor({ state: 'detached' });
      assert.equal(await page.locator('.resolution-panel').count(), 0, 'Restarting must hide a future recovery report');
    }
    const comparisonChecks = [];
    const other = archive.comparisons?.[0];
    const primaryApproach = initial.run.approach ?? 'collected';
    const otherApproach = primaryApproach === 'collected' ? 'mcp' : 'collected';
    const tab = approach => page.getByRole('tab', { name: approach === 'mcp' ? 'LLM tools + MCP' : 'Collected evidence', exact: true });
    await tab(otherApproach).click();
    assert.equal(await tab(otherApproach).getAttribute('aria-selected'), 'true');
    if (other) {
      const otherFinal = other.snapshots.at(-1);
      await page.getByRole('button', { name: 'View final', exact: true }).click();
      const otherTrace = otherApproach === 'mcp' ? otherFinal.investigationObservation : otherFinal.observation;
      assert.equal(await envelopeCount(), new Set((otherTrace?.messages ?? []).map(message => message.id)).size);
      assert.equal(await page.locator('#run-picker').inputValue(), other.runId);
      if (otherFinal.run.investigation) {
        const panel = page.locator('.investigation-panel');
        assert.equal(await panel.getAttribute('data-investigation-status'), otherFinal.run.investigation.status);
        assert.equal(await panel.locator('[data-tool-call-id]').count(), otherFinal.run.investigation.calls?.length ?? 0);
        for (const call of otherFinal.run.investigation.calls ?? []) {
          const item = panel.locator(`[data-tool-call-id="${call.id}"]`);
          assert.equal(await item.locator('strong').innerText(), call.tool);
          assert.deepEqual(await item.locator('.tool-evidence a').allTextContents(), call.evidenceIds);
        }
        await page.locator('.phase-controls').getByRole('button', { name: 'Assessment', exact: true }).click();
        assert.equal(await envelopeCount(), new Set(otherFinal.observation.messages.map(message => message.id)).size);
        await page.locator('.phase-controls').getByRole('button', { name: 'Investigation', exact: true }).click();
        comparisonChecks.push('separate-phase-traces', 'tool-call-evidence-links');
      }
      comparisonChecks.push('comparison-capture');
    } else {
      assert.match(await page.locator('body').innerText(), /no recording for this approach/);
      assert.equal(await page.getByRole('button', { name: 'Play', exact: true }).count(), 0);
      comparisonChecks.push('uncaptured-approach');
    }
    await tab(primaryApproach).click();
    assert.equal(await page.locator('#run-picker').inputValue(), archive.runId);
    assert.equal(await envelopeCount(), firstCount, 'Returning to a tab restores its playback position');
    if (other) {
      await tab(otherApproach).click();
      assert.equal(await page.locator('#run-picker').inputValue(), other.runId);
      const otherFinal = other.snapshots.at(-1);
      assert.equal(Number(await page.getByRole('slider', { name: 'Recorded observation timeline' }).inputValue()),
        recordedTime(otherFinal) - recordedTime(other.snapshots[0]));
      await checkCanvasSize(page);
      await page.screenshot({ path: join(resolve(directory), 'dashboard', 'comparison-preview.png'), fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      await checkCanvasSize(page);
      await page.screenshot({ path: join(resolve(directory), 'dashboard', 'comparison-mobile-preview.png'), fullPage: true });
      await page.setViewportSize({ width: 1440, height: 1100 });
      comparisonChecks.push('canvas-size-desktop-mobile');
      await tab(primaryApproach).click();
    }
    const recordings = [archive, ...(archive.comparisons ?? [])];
    const collectedRecording = recordings.find(item => (item.snapshots[0].run.approach ?? 'collected') === 'collected');
    const mcpRecording = recordings.find(item => item.snapshots[0].run.approach === 'mcp');
    const collectedRun = collectedRecording?.snapshots.at(-1).run;
    const mcpRun = mcpRecording?.snapshots.at(-1).run;
    const comparisonSubject = mcpRun?.investigation?.evidence?.subject;
    const collectedSubject = collectedRun?.input?.incident?.evidence?.subject;
    if (mcpRun?.resolution) {
      await tab('mcp').click();
      await page.getByRole('button', { name: 'View final', exact: true }).click();
      const panel = page.locator('.resolution-panel');
      const report = mcpRun.resolution;
      assert.equal(await panel.getAttribute('data-source-run-id'), mcpRun.id);
      assert.equal(await panel.getAttribute('data-resolution-status'), report.status);
      assert.equal(await panel.locator('#resolution-title').innerText(), `${report.target.namespace} / ${report.target.name}`);
      assert.equal(await panel.locator('.resolution-state').innerText(), report.status === 'verified'
        ? 'Verified recovery' : report.status === 'failed' ? 'Recovery not verified' : 'Needs engineer');
      assert.equal(await panel.locator('.assessment-summary').innerText(), report.reason);
      assert.equal(await page.locator('.comparison-resolution-panel').count(), 0,
        'The MCP run must display its own controller outcome without attributing it to the other approach');
      const checks = panel.locator('.verification-checks li');
      assert.deepEqual(await checks.locator('strong').allTextContents(), report.checks.map(check => `${check.passed ? 'Passed' : 'Failed'} · ${check.name}`));
      assert.deepEqual(await checks.locator('span').allTextContents(), report.checks.map(check => check.detail));
      const details = panel.locator('.assessment-details').first();
      if (!await details.evaluate(element => element.open)) await details.locator('summary').click();
      assert.deepEqual(JSON.parse(await details.locator('pre').innerText()), {
        patch: report.patch, before: report.before, after: report.after,
        ...(report.verificationEvidence ? { verificationEvidence: report.verificationEvidence } : {}),
      }, 'The MCP repair must retain its own exact patch, replacement Pod logs and events');
      await page.getByRole('button', { name: 'Restart', exact: true }).click();
      if (!mcpRecording.snapshots[0].run.resolution) {
        assert.equal(await panel.count(), 0, 'Restarting MCP playback must hide its future repair report');
      }
      await page.getByRole('button', { name: 'View final', exact: true }).click();
      assert.equal(await panel.getAttribute('data-source-run-id'), mcpRun.id);
      if (dualCapture) comparisonChecks.push('independent-incident-repair-identities');
      comparisonChecks.push('mcp-own-resolution', 'mcp-repair-checks-and-evidence', 'hide-future-mcp-resolution');
    } else if (collectedRun?.resolution && comparisonSubject?.uid && ['namespace', 'name', 'uid'].every(key => comparisonSubject[key] === collectedSubject?.[key])) {
      await tab('mcp').click();
      await page.getByRole('button', { name: 'View final', exact: true }).click();
      const pointer = page.locator('.comparison-resolution-panel');
      assert.equal(await pointer.getAttribute('data-source-run-id'), collectedRun.id);
      assert.match(await pointer.innerText(), /did not execute a second repair/);
      assert.match(await pointer.innerText(), /separate playback timelines/);
      assert.equal(await page.locator('.resolution-panel').count(), 0, 'The comparison must not inherit the other run\'s resolution');
      await pointer.getByRole('button', { name: 'View controller verification', exact: true }).click();
      assert.equal(await tab('collected').getAttribute('aria-selected'), 'true');
      assert.equal(await page.locator('.resolution-panel').getAttribute('data-resolution-status'), collectedRun.resolution.status);
      assert.equal(await page.locator('#run-picker').inputValue(), collectedRun.id);
      assert.equal(await page.locator('#resolution-title').evaluate(element => element === document.activeElement), true);
      await tab('mcp').click();
      await page.getByRole('button', { name: 'Restart', exact: true }).click();
      if (!mcpRecording.snapshots[0].run.output) assert.equal(await pointer.count(), 0, 'The comparison pointer follows its assessment during playback');
      comparisonChecks.push('attributed-controller-outcome-navigation');
    }
    for (const viewport of [{ width: 1440, height: 1100 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      for (const recording of [archive, ...(archive.comparisons ?? [])]) {
        await tab(recording.snapshots[0].run.approach ?? 'collected').click();
        await checkPlaybackPlacement(page, recording);
      }
    }
    comparisonChecks.push('stable-playback-graph-desktop-mobile');
    await page.setViewportSize({ width: 1440, height: 1100 });
    await tab(primaryApproach).click();
    assert.deepEqual(errors, [], 'The standalone dashboard reported a browser error');
    assert.deepEqual(requests, [], 'The standalone dashboard attempted network access');
    await page.evaluate(() => window.scrollTo(0, 0));
    await checkCanvasSize(page);
    await page.screenshot({ path: join(resolve(directory), 'dashboard', 'preview.png'), fullPage: true });
    await context.close();
    const report = { runId: archive.runId, mode: final.run.mode, initialEnvelopes: firstCount,
      finalEnvelopes: finalCount, offline: true, checks: ['file-url',
        ...(firstCount < finalCount ? ['play-pause', 'speed'] : []), 'seek', 'restart',
        ...(inspected ? ['inspection'] : []), ...payloadInspections.map(kind => `${kind}-payload`), ...comparisonChecks, 'no-network'], errors };
    if (evidence) report.checks.push('evidence-statuses', 'evidence-provenance', 'evidence-data');
    if (resolution) report.checks.push('resolution-status', 'resolution-checks', 'resolution-patch-and-evidence',
      ...(!initial.run.resolution ? ['hide-future-resolution'] : []));
    if (audit) report.checks.push('exact-candidates', 'assessment-candidate-digests', 'criterion-findings', 'measurement-kind-labels',
      ...(!initial.run.revision ? ['hide-future-assessments'] : []));
    await writeFile(join(resolve(directory), 'dashboard', 'verification.json'), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Verified portable Vue dashboard: ${firstCount} → ${finalCount} envelopes, no network access`);
    return report;
  } finally { await browser.close(); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (!process.argv[2]) { console.error('Usage: node deploy/check-archive.mjs <capture-directory>'); process.exitCode = 1; }
  else checkArchive(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
}
