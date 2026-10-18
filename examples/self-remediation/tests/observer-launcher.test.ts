import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseOptions, prepareObservation, runGh, validateJournal, validateRun } from '../scripts/start-observer.mjs';
import { decodeWindow, encodeWindow } from '../server/github-check.js';
import { makeWindow } from '../ui/events.js';

const repository = 'emmett08/mas-host-examples', runId = '39140657270', runAttempt = '2', sha = 'a'.repeat(40);
const incidentId = `${runId}-${runAttempt}-missing-route`;
const fixtureName = `self-remediation-fixture-${runId}-${runAttempt}`;
const liveName = `self-remediation-live-${runId}-${runAttempt}`;
const run = { schema: 'self-remediation-observer-run/1', repository, runId, runAttempt, sha, defaultMode: 'fixture',
  cases: { fixture: { incidentId, artifactName: fixtureName }, live: { incidentId, artifactName: liveName } } };
const event = { seq: 1, incidentId, time: '2026-10-18T17:00:00Z', type: 'incident.opened', data: {} };
const artifact = { id: 12141133965, name: fixtureName, expired: false, workflow_run: { id: Number(runId) } };
const attempt = { id: Number(runId), run_attempt: Number(runAttempt), status: 'in_progress', head_sha: 'b'.repeat(40) };
const check = { id: 42, head_sha: sha, external_id: incidentId, output: { text: encodeWindow(makeWindow([event], incidentId)) } };

function workspace() { return mkdtempSync(join(tmpdir(), 'observer bundle with spaces ')); }
function progress(found: unknown = check) {
  return { GhCheckApi: class { constructor(public repo: string) {} },
    findCheck: async (_api: unknown, repo: string, requestedSha: string, requestedIncident: string) => {
      assert.equal(repo, repository); assert.equal(requestedSha, sha); assert.equal(requestedIncident, incidentId); return found;
    }, decodeWindow };
}
function client({ artifacts = [artifact], status = attempt, populate = (path: string) => {
  const root = join(path, 'self-remediation-fixture'); mkdirSync(root);
  writeFileSync(join(root, 'events.jsonl'), JSON.stringify(event) + '\n');
  writeFileSync(join(root, 'integration-start.json'), JSON.stringify({ schema: 'self-remediation-integration/1', incident: incidentId, mode: 'fixture' }));
  mkdirSync(join(root, 'archive')); writeFileSync(join(root, 'archive/index.html'), '<html>Retained replay</html>');
} } = {}) {
  const calls: string[][] = [];
  const gh = async (args: string[]) => {
    calls.push(args);
    if (args[0] === 'run') {
      assert.deepEqual(args.slice(0, 7), ['run', 'download', runId, '--repo', repository, '--name', artifacts[0]!.name]);
      const output = args[args.indexOf('--dir') + 1]!; populate(output); return '';
    }
    const endpoint = args.at(-1)!;
    if (endpoint.includes('/artifacts?')) return JSON.stringify({ artifacts });
    assert.equal(endpoint, `/repos/${repository}/actions/runs/${runId}/attempts/${runAttempt}`);
    return JSON.stringify(status);
  };
  return { gh, calls };
}

test('prepared fixture command downloads its exact attempt and opens replay from a path with spaces', async () => {
  const bundleRoot = workspace(), transport = client();
  try {
    const result = await prepareObservation({ bundleRoot, run, gh: transport.gh });
    assert.equal(result.mode, 'replay'); assert.equal(result.eventCount, 1); assert.equal(result.artifactId, artifact.id);
    assert.equal(result.args[result.args.indexOf('--incident') + 1], incidentId);
    assert.equal(result.args[result.args.indexOf('--ui') + 1], join(bundleRoot, 'ui'));
    assert.equal(result.args.includes('--repo'), false);
    assert.equal(readFileSync(result.args[result.args.indexOf('--events') + 1], 'utf8'), JSON.stringify(event) + '\n');
    assert.match(result.archive, /archive\/index.html$/);
    assert.equal(transport.calls.length, 2);
    assert.equal(result.args.includes('--disclose-source'), false);
  } finally { rmSync(bundleRoot, { recursive: true, force: true }); }
});

test('completed live artefact uses the root layout, accepts failure journals and preserves source opt-in', async () => {
  const bundleRoot = workspace();
  const transport = client({ artifacts: [{ ...artifact, name: liveName }], populate: path => {
    writeFileSync(join(path, 'events.jsonl'), JSON.stringify({ ...event, type: 'outcome', data: { outcome: 'NO_ELIGIBLE_CANDIDATE' } }) + '\n');
    mkdirSync(join(path, 'artefacts')); writeFileSync(join(path, 'disclosed-artefacts.json'), '[]');
    writeFileSync(join(path, 'integration-start.json'), JSON.stringify({ schema: 'self-remediation-integration/1', incident: incidentId, mode: 'live' }));
  } });
  try {
    const result = await prepareObservation({ bundleRoot, run, options: parseOptions(['--mode', 'live', '--disclose-source']), gh: transport.gh });
    assert.equal(result.mode, 'replay'); assert.ok(result.args.includes('--disclose-source')); assert.ok(result.args.includes('--disclosures'));
    assert.equal(dirname(result.args[result.args.indexOf('--events') + 1]), result.args[result.args.indexOf('--artefacts') + 1].slice(0, -'/artefacts'.length));
  } finally { rmSync(bundleRoot, { recursive: true, force: true }); }
});

test('active live observation binds the workflow SHA and acknowledged incident Check Run', async () => {
  const transport = client({ artifacts: [] });
  const result = await prepareObservation({ bundleRoot: '/tmp/bundle', run: { ...run, defaultMode: 'live' }, gh: transport.gh, checkTools: progress() });
  assert.equal(result.mode, 'live'); assert.equal(result.checkId, 42);
  assert.equal(result.args[result.args.indexOf('--sha') + 1], sha);
  assert.equal(result.args[result.args.indexOf('--check') + 1], '42');
  assert.equal(transport.calls.length, 2);
});

test('fixture pending, unacknowledged live, forced replay and completed missing artefacts never advertise empty observation', async () => {
  const bundleRoot = '/tmp/bundle', transport = client({ artifacts: [] });
  await assert.rejects(prepareObservation({ bundleRoot, run, gh: transport.gh }), /still running/);
  await assert.rejects(prepareObservation({ bundleRoot, run: { ...run, defaultMode: 'live' }, gh: transport.gh, checkTools: progress(null) }), /has no acknowledged/);
  const emptyCheck = { ...check, output: { text: encodeWindow(makeWindow([], incidentId)) } };
  await assert.rejects(prepareObservation({ bundleRoot, run: { ...run, defaultMode: 'live' }, gh: transport.gh, checkTools: progress(emptyCheck) }), /not published committed/);
  await assert.rejects(prepareObservation({ bundleRoot, run: { ...run, defaultMode: 'live' }, options: parseOptions(['--replay']), gh: transport.gh }), /still running/);
  const completed = client({ artifacts: [], status: { ...attempt, status: 'completed' } });
  await assert.rejects(prepareObservation({ bundleRoot, run: { ...run, defaultMode: 'live' }, gh: completed.gh }), /finished without retaining/);
});

test('expired, ambiguous or mismatched artefacts and workflow attempts are rejected before observation', async () => {
  const bundleRoot = '/tmp/bundle';
  for (const [artifacts, pattern] of [
    [[{ ...artifact, expired: true }], /expired/],
    [[artifact, artifact], /Multiple artefacts/],
    [[{ ...artifact, workflow_run: { id: 999 } }], /mismatched artefact/],
  ] as const) {
    await assert.rejects(prepareObservation({ bundleRoot, run, gh: client({ artifacts: [...artifacts] }).gh }), pattern);
  }
  await assert.rejects(prepareObservation({ bundleRoot, run, gh: client({ artifacts: [], status: { ...attempt, run_attempt: 3 } }).gh }), /mismatched workflow attempt/);
  await assert.rejects(prepareObservation({ bundleRoot, run: { ...run, defaultMode: 'live' }, gh: client({ artifacts: [] }).gh, checkTools: progress({ ...check, head_sha: 'b'.repeat(40) }) }), /Check Run identity mismatch/);
});

test('artefact lookup paginates inside the recorded run and never selects another attempt', async () => {
  const bundleRoot = workspace(), download = client(), pages: string[] = [];
  const gh = async (args: string[]) => {
    if (args[0] === 'run') return download.gh(args);
    const endpoint = args.at(-1)!; pages.push(endpoint);
    const prefix = `/repos/${repository}/actions/runs/${runId}/artifacts?per_page=100&page=`;
    assert.ok(endpoint.startsWith(prefix));
    if (endpoint.endsWith('=1')) return JSON.stringify({ artifacts: Array.from({ length: 100 }, (_, index) => ({ ...artifact, id: index + 1, name: `self-remediation-fixture-${runId}-1-${index}` })) });
    assert.equal(endpoint, prefix + '2');
    return JSON.stringify({ artifacts: [artifact] });
  };
  try {
    const result = await prepareObservation({ bundleRoot, run, gh });
    assert.equal(result.mode, 'replay'); assert.equal(result.artifactId, artifact.id); assert.equal(pages.length, 2);
  } finally { rmSync(bundleRoot, { recursive: true, force: true }); }
});

test('downloaded configuration failure explains missing settings instead of launching a zero-event viewer', async () => {
  for (const filename of ['integration-configuration.json', 'live-preflight.json']) {
    const bundleRoot = workspace();
    const transport = client({ populate: path => {
      const root = join(path, 'self-remediation-fixture'); mkdirSync(root);
      writeFileSync(join(root, filename), JSON.stringify({ ready: false,
        errors: [{ setting: 'OPENAI_API_KEY', reason: 'secret must not be printed' }, { setting: 'SELF_REMEDIATION_MODEL' }] }));
    } });
    try {
      await assert.rejects(prepareObservation({ bundleRoot, run, gh: transport.gh }), error => {
        assert.match(error.message, /configuration preflight/); assert.match(error.message, /OPENAI_API_KEY, SELF_REMEDIATION_MODEL/);
        assert.ok(!error.message.includes('secret must not be printed')); return true;
      });
    } finally { rmSync(bundleRoot, { recursive: true, force: true }); }
  }
});

test('same incident in the other integration mode and another incident journal are rejected', async () => {
  for (const [body, scopeMode, pattern] of [
    [{ ...event, incidentId: `${runId}-1-missing-route` }, 'fixture', /journal incident identity mismatch/],
    [event, 'live', /integration mode or incident identity mismatch/],
  ] as const) {
    const bundleRoot = workspace();
    const transport = client({ populate: path => {
      writeFileSync(join(path, 'events.jsonl'), JSON.stringify(body) + '\n');
      writeFileSync(join(path, 'integration-start.json'), JSON.stringify({ schema: 'self-remediation-integration/1', incident: incidentId, mode: scopeMode }));
    } });
    try { await assert.rejects(prepareObservation({ bundleRoot, run, gh: transport.gh }), pattern); }
    finally { rmSync(bundleRoot, { recursive: true, force: true }); }
  }
});

test('journal validation rejects empty, partial and duplicate sequences while retaining honest sequence gaps', () => {
  const directory = workspace(), path = join(directory, 'events.jsonl');
  try {
    for (const [text, pattern] of [['', /no committed events/], [JSON.stringify(event), /incomplete/],
      [[event, event].map(item => JSON.stringify(item)).join('\n') + '\n', /unordered/]] as const) {
      writeFileSync(path, text); assert.throws(() => validateJournal(path, incidentId), pattern);
    }
    writeFileSync(path, [event, { ...event, seq: 3 }].map(item => JSON.stringify(item)).join('\n') + '\n');
    assert.equal(validateJournal(path, incidentId), 2);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('metadata and options reject invented identities, arguments and unsafe ports', () => {
  assert.equal(validateRun(run), run);
  for (const changed of [{ sha: 'main' }, { runId: 42 }, { runAttempt: '../1' }, { repository: '-x/repo' }, { defaultMode: 'unknown' },
    { cases: { fixture: { incidentId, artifactName: 'latest' } } }, { cases: { fixture: { incidentId: 'foreign-incident', artifactName: fixtureName } } }]) {
    assert.throws(() => validateRun({ ...run, ...changed }));
  }
  for (const args of [['--port', '80'], ['--port', '1e4'], ['--mode', 'other'], ['--repo', 'other/repo'], ['--mode', 'live', '--mode', 'fixture']]) assert.throws(() => parseOptions(args));
  assert.equal(parseOptions(['--port', '4319']).port, 4319);
  assert.equal(parseOptions(['--help']).help, true);
});

test('GitHub CLI transport preserves literal arguments and spaces without shell execution', async () => {
  const directory = workspace(), executable = join(directory, 'fake gh');
  try {
    writeFileSync(executable, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o700 });
    const args = ['run', 'download', runId, '--dir', join(directory, 'literal $(not-a-command)')];
    assert.deepEqual(JSON.parse(await runGh(args, { executable })), args);
    await assert.rejects(runGh(['api'], { executable: join(directory, 'missing') }), /GitHub CLI is missing/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
