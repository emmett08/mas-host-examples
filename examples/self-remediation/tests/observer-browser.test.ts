import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EventHub, createObserverServer } from '../server/index.js';
import { makeWindow, type ObservationEvent } from '../ui/events.js';

test('browser receives committed live updates before completion; offline seeking and mobile remain read-only', { skip: process.env.SELF_REMEDIATION_BROWSER_TEST !== '1' }, async () => {
  const incidentId = 'browser-control-test';
  const e = (seq: number, type: string, data: Record<string, unknown>): ObservationEvent => ({ seq, type, incidentId, time: new Date(1_792_300_000_000 + seq * 1000).toISOString(), data });
  const patch = [{ path: 'src/quote.ts', before: 'return quantity + price;', content: 'return quantity * price;' }, { path: 'src/livez.ts', before: null, content: '<img src=x onerror=alert(1)> source text' }];
  const patchJSON = JSON.stringify(patch), patchDigest = createHash('sha256').update(patchJSON).digest('hex');
  const events = [
    e(1, 'incident.opened', { repository: 'example/disposable', baseCommit: '1'.repeat(40), namespace: 'isolated-control-trial', provider: 'scripted-control' }),
    e(2, 'lifecycle', { phase: 'Investigating' }),
    e(3, 'mas.message', { from: 'investigator', to: 'experiment-planner', messageType: 'delegation' }),
    e(4, 'measurement', { criterion: 'quote contract', status: 'failed', expected: 2500, actual: 5000, summary: 'Baseline measurement failed' }),
    e(5, 'hypotheses', { summary: 'Structured control hypothesis', mechanism: 'A duplicated computation can change the observed amount', contradictions: [] }),
    e(6, 'candidate.created', { patchRef: `sha256:${patchDigest}`, candidateId: 'candidate-control' }),
    e(7, 'outcome', { outcome: 'FUTURE_VERIFIED_RECOVERY' }),
  ];
  const hub = new EventHub(), server = createObserverServer(hub, resolve('dist/ui'));
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? {executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}: {}) });
  const temp = mkdtempSync(join(tmpdir(), 'observer-browser-'));
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${address.port}`);
    await page.getByRole('heading', { name: 'Self-remediation', exact: true }).waitFor();
    hub.accept(makeWindow(events.slice(0, 3), incidentId));
    await page.getByRole('heading', { name: 'Investigating', exact: true }).waitFor();
    assert.equal(hub.status.completed, false);
    hub.accept(makeWindow(events.slice(0, 5), incidentId));
    await page.getByRole('heading', { name: 'Baseline measurement failed', exact: true }).waitFor();
    await page.screenshot({ path: '/tmp/self-remediation-observer-desktop.png', fullPage: true });
    const position = await page.locator('.controls').boundingBox(), graph = await page.locator('.graph-card').boundingBox();
    assert.ok(position && graph && Math.abs(graph.y - (position.y + position.height)) < 2);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: '/tmp/self-remediation-observer-mobile.png', fullPage: true });
    assert.deepEqual(errors, []);
    const eventsFile = join(temp, 'events.jsonl'); writeFileSync(eventsFile, events.map(e => JSON.stringify(e)).join('\n') + '\n');
    // This is a labelled browser control fixture, never provider competence evidence.
    const { createArchive } = await import(pathToFileURL(resolve('scripts/archive.mjs')).href);
    writeFileSync(join(temp, patchDigest), patchJSON);
    const disclosures = join(temp, 'disclosures.json'); writeFileSync(disclosures, JSON.stringify([`sha256:${patchDigest}`]));
    await createArchive({ eventsFile, output: join(temp, 'archive'), incidentId, disclose: true, artefactsRoot: temp, disclosures, discloseSource: true });
    const offline = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const network: string[] = []; offline.on('request', request => { if (/^https?:/.test(request.url())) network.push(request.url()); });
    await offline.goto(pathToFileURL(join(temp, 'archive/index.html')).href);
    await offline.getByRole('heading', { name: 'Self-remediation', exact: true }).waitFor();
    assert.ok(!(await offline.locator('body').innerText()).includes('FUTURE_VERIFIED_RECOVERY'));
    await offline.getByRole('slider').fill('4');
    await offline.getByRole('heading', { name: 'Baseline measurement failed', exact: true }).waitFor();
    assert.ok(!(await offline.locator('body').innerText()).includes('FUTURE_VERIFIED_RECOVERY'));
    await offline.getByRole('slider').fill('6');
    assert.equal(await offline.getByRole('button', { name: 'Inspect disclosed candidate diff' }).count(), 0);
    await offline.getByRole('checkbox', { name: 'Show redacted details' }).check();
    await offline.getByRole('button', { name: 'Inspect disclosed candidate diff' }).click();
    await offline.locator('.source-comparison').first().waitFor();
    assert.equal(await offline.getByLabel('Original source', { exact: true }).first().locator('pre').innerText(), 'return quantity + price;');
    assert.equal(await offline.getByLabel('Candidate source', { exact: true }).first().locator('pre').innerText(), 'return quantity * price;');
    assert.equal(await offline.locator('.source-comparison img').count(), 0);
    assert.ok(!(await offline.locator('body').innerText()).includes('FUTURE_VERIFIED_RECOVERY'));
    await offline.getByRole('slider').fill('7');
    await offline.getByRole('heading', { name: 'FUTURE_VERIFIED_RECOVERY', exact: true }).first().waitFor();
    await offline.getByRole('slider').fill('2');
    assert.ok(!(await offline.locator('body').innerText()).includes('FUTURE_VERIFIED_RECOVERY'));
    assert.equal(await offline.locator('.source-comparison').count(), 0);
    assert.ok(!(await offline.locator('body').innerText()).includes('return quantity * price;'));
    assert.deepEqual(network, []);
  } finally { await browser.close(); hub.close(); await new Promise<void>(done => server.close(() => done())); rmSync(temp, { recursive: true, force: true }); }
});
