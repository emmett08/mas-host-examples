#!/usr/bin/env node
// Exercise the compiled download through file:// with every network request blocked.
import assert from 'node:assert/strict';
import { access, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { readArchive } from './archive.mjs';

export async function checkArchive(directory, launchOptions = {}) {
  const html = join(resolve(directory), 'dashboard', 'index.html');
  try { await access(html); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    console.log('Offline browser check skipped: no dashboard was packaged.');
    return;
  }
  const archive = await readArchive(directory);
  assert.ok(archive, 'A packaged dashboard must have retained observations');
  const initial = archive.snapshots[0];
  const final = archive.snapshots.at(-1);
  const firstCount = new Set(initial.observation.messages.map(message => message.id)).size;
  const finalCount = new Set(final.observation.messages.map(message => message.id)).size;
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
    await page.getByRole('button', { name: 'Play', exact: true }).waitFor();
    assert.match(await page.locator('body').innerText(), /Recorded run · playback/);
    assert.equal(await page.locator('.start-button').count(), 0, 'The archive must not offer live inference');
    const envelopeCount = () => page.locator('.run-stats > div').filter({ has: page.locator('dt', { hasText: /^Envelopes$/ }) }).locator('dd').innerText().then(Number);
    assert.equal(await envelopeCount(), firstCount);
    const timeline = page.getByRole('slider', { name: 'Recorded observation timeline' });
    if (firstCount < finalCount) {
      const speed = 8;
      const firstGrowth = archive.snapshots.find(snapshot =>
        new Set(snapshot.observation.messages.map(message => message.id)).size > firstCount);
      const growthTimeout = Math.ceil((firstGrowth.observation.observed_at_ms - initial.observation.observed_at_ms) / speed) + 10_000;
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
    const evidence = final.run.input?.incident?.evidence;
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
      assert.equal(await panel.locator('#resolution-title').innerText(), `${resolution.target.namespace} / ${resolution.target.name}`);
      assert.equal(await panel.locator('.resolution-state').innerText(), resolution.status === 'verified'
        ? 'Verified recovery' : resolution.status === 'failed' ? 'Recovery not verified' : 'Needs engineer');
      assert.equal(await panel.locator('.assessment-summary').innerText(), resolution.reason);
      const checks = panel.locator('.verification-checks li');
      assert.equal(await checks.count(), resolution.checks.length);
      for (let index = 0; index < resolution.checks.length; index++) {
        const expected = resolution.checks[index], check = checks.nth(index);
        assert.equal(await check.locator('strong').innerText(), `${expected.passed ? 'Passed' : 'Failed'} · ${expected.name}`);
        assert.equal(await check.locator('span').innerText(), expected.detail);
      }
      await panel.locator('.assessment-details summary').click();
      assert.deepEqual(JSON.parse(await panel.locator('.assessment-details pre').innerText()),
        { patch: resolution.patch, before: resolution.before, after: resolution.after },
        'The recovery inspector must display the captured patch and before/after evidence unchanged');
    }
    const row = page.locator('.event-table tbody tr').first();
    const inspected = Boolean(await row.count());
    if (inspected) {
      await row.click();
      assert.match(await page.locator('#inspector-title').innerText(), /Envelope/);
    }
    const payloadInspections = [];
    if (final.observation.payloads_included === true) {
      for (const kind of ['request', 'result']) {
        const message = final.observation.messages.find(message => message.kind === kind);
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
    assert.deepEqual(errors, [], 'The standalone dashboard reported a browser error');
    assert.deepEqual(requests, [], 'The standalone dashboard attempted network access');
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(50);
    await page.screenshot({ path: join(resolve(directory), 'dashboard', 'preview.png'), fullPage: true });
    await context.close();
    const report = { runId: archive.runId, mode: final.run.mode, initialEnvelopes: firstCount,
      finalEnvelopes: finalCount, offline: true, checks: ['file-url',
        ...(firstCount < finalCount ? ['play-pause', 'speed'] : []), 'seek', 'restart',
        ...(inspected ? ['inspection'] : []), ...payloadInspections.map(kind => `${kind}-payload`), 'no-network'], errors };
    if (evidence) report.checks.push('evidence-statuses', 'evidence-provenance', 'evidence-data');
    if (resolution) report.checks.push('resolution-status', 'resolution-checks', 'resolution-patch-and-evidence',
      ...(!initial.run.resolution ? ['hide-future-resolution'] : []));
    await writeFile(join(resolve(directory), 'dashboard', 'verification.json'), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Verified portable Vue dashboard: ${firstCount} → ${finalCount} envelopes, no network access`);
    return report;
  } finally { await browser.close(); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (!process.argv[2]) { console.error('Usage: node deploy/check-archive.mjs <capture-directory>'); process.exitCode = 1; }
  else checkArchive(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
}
