import { spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MODES = ['fixture', 'live'];
const USAGE = `Usage: node start.mjs [--mode fixture|live] [--port 4318] [--replay] [--disclose-source]

Uses this package's run.json and your authenticated GitHub CLI.
Downloads the exact retained incident when available, or observes an acknowledged live Check Run.
--replay requires the retained artefact and never falls back to live observation.
--disclose-source permits source payloads selected by the retained disclosure manifest.
No npm installation or local Kubernetes is required.\n`;

export function parseOptions(args) {
  const options = { port: 4318, replay: false, discloseSource: false };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (seen.has(key)) throw new Error(`Repeated option: ${key}`);
    seen.add(key);
    if (key === '--help') options.help = true;
    else if (key === '--replay') options.replay = true;
    else if (key === '--disclose-source') options.discloseSource = true;
    else if (key === '--mode') {
      options.mode = args[++i];
      if (!MODES.includes(options.mode)) throw new Error('--mode must be fixture or live');
    } else if (key === '--port') {
      const value = args[++i];
      if (!/^\d+$/.test(value ?? '') || Number(value) < 1024 || Number(value) > 65535) throw new Error('--port must be an integer from 1024 to 65535');
      options.port = Number(value);
    } else throw new Error(`Unknown option: ${key}. Use --help.`);
  }
  return options;
}

export function validateRun(value) {
  if (!value || typeof value !== 'object' || value.schema !== 'self-remediation-observer-run/1') throw new Error('run.json has an unsupported schema; download a run-bound observer package');
  if (typeof value.repository !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value.repository)) throw new Error('run.json repository must be OWNER/REPO');
  if (typeof value.sha !== 'string' || !/^[a-f0-9]{40}$/.test(value.sha)) throw new Error('run.json must identify an exact workflow SHA');
  for (const key of ['runId', 'runAttempt']) if (typeof value[key] !== 'string' || !/^[1-9]\d*$/.test(value[key])) throw new Error(`run.json ${key} must be a positive decimal string`);
  if (!MODES.includes(value.defaultMode) || !value.cases?.fixture || !value.cases[value.defaultMode]) throw new Error('run.json has no configured default incident');
  for (const [mode, entry] of Object.entries(value.cases)) {
    if (!MODES.includes(mode) || !entry || typeof entry !== 'object') throw new Error('run.json has an invalid incident case');
    const prefix = `${value.runId}-${value.runAttempt}-`;
    if (typeof entry.incidentId !== 'string' || !entry.incidentId.startsWith(prefix) || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(entry.incidentId) || entry.incidentId === prefix) throw new Error('run.json incident does not belong to the exact run attempt');
    const base = `self-remediation-${mode}-${value.runId}-${value.runAttempt}`;
    const selected = entry.incidentId.slice(prefix.length);
    if (entry.artifactName !== base && entry.artifactName !== `${base}-${selected}`)
      throw new Error('run.json artefact does not belong to the exact run attempt and case');
  }
  return value;
}

/** Credentials stay in gh. No shell interpretation or token output is used. */
export async function runGh(args, { timeoutMs = 30_000, executable = 'gh' } = {}) {
  return await new Promise((done, reject) => {
    const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let bytes = 0, settled = false;
    const finish = (error, output) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else done(output);
    };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new Error('GitHub CLI timed out. Retry this command when GitHub is reachable.')); }, timeoutMs);
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 4 * 1024 * 1024) { child.kill('SIGKILL'); finish(new Error('GitHub CLI response exceeded 4 MiB')); }
      else chunks.push(chunk);
    });
    child.stderr.resume();
    child.once('error', error => finish(new Error(error.code === 'ENOENT' ? 'GitHub CLI is missing. Install gh, run gh auth login, then retry.' : 'GitHub CLI could not start. Check your gh installation.')));
    child.once('close', code => finish(code === 0 ? undefined : new Error(`GitHub CLI failed (${code}). Check gh auth status and repository Actions/Checks read access, then retry.`), Buffer.concat(chunks).toString('utf8')));
  });
}

async function jsonRequest(gh, endpoint) {
  const text = await gh(['api', '--method', 'GET', '-H', 'Accept: application/vnd.github+json', endpoint]);
  try { return JSON.parse(text); } catch { throw new Error('GitHub returned invalid JSON'); }
}

async function findArtifact(gh, run, name) {
  const matches = [];
  for (let page = 1; page <= 100; page++) {
    const result = await jsonRequest(gh, `/repos/${run.repository}/actions/runs/${run.runId}/artifacts?per_page=100&page=${page}`);
    if (!Array.isArray(result.artifacts)) throw new Error('GitHub returned an invalid artefact list');
    matches.push(...result.artifacts.filter(item => item.name === name));
    if (result.artifacts.length < 100) {
      if (matches.length > 1) throw new Error('Multiple artefacts have this exact run-attempt name; reconcile them before observation');
      return matches[0];
    }
  }
  throw new Error('Run artefact pagination limit reached');
}

function safeFile(root, path) {
  if (!existsSync(path)) return false;
  const item = lstatSync(path), rel = relative(realpathSync(root), realpathSync(path));
  if (!item.isFile() || item.isSymbolicLink() || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) throw new Error('Retained replay path is not a regular file inside its download');
  return true;
}

export function validateJournal(path, incidentId) {
  if (statSync(path).size > 64 * 1024 * 1024) throw new Error('Retained journal exceeds the 64 MiB observer limit');
  const text = readFileSync(path, 'utf8');
  if (!text.trim()) throw new Error('Retained journal contains no committed events');
  if (!text.endsWith('\n')) throw new Error('Retained journal has an incomplete final event');
  let previous = 0, count = 0;
  for (const line of text.split('\n').filter(Boolean)) {
    let event;
    try { event = JSON.parse(line); } catch { throw new Error('Retained journal contains invalid JSON'); }
    if (event.incidentId !== incidentId) throw new Error('Retained journal incident identity mismatch');
    if (!Number.isSafeInteger(event.seq) || event.seq <= previous || typeof event.time !== 'string' || !Number.isFinite(Date.parse(event.time)) || typeof event.type !== 'string' || !event.type || !event.data || typeof event.data !== 'object' || Array.isArray(event.data)) throw new Error('Retained journal contains an invalid or unordered committed event');
    previous = event.seq; count++;
  }
  return count;
}

function missingJournal(root, mode) {
  for (const base of [root, join(root, `self-remediation-${mode}`)]) {
    for (const filename of ['integration-configuration.json', 'live-preflight.json']) {
      const report = join(base, filename);
      if (!safeFile(root, report)) continue;
      const configuration = JSON.parse(readFileSync(report, 'utf8'));
      const settings = Array.isArray(configuration.errors) ? configuration.errors.map(error => error.setting).filter(setting => typeof setting === 'string' && /^[A-Z][A-Z0-9_ /-]{0,120}$/.test(setting)) : [];
      if (configuration.ready === false) throw new Error(`This run stopped at configuration preflight before recording incident events.${settings.length ? ` Missing or invalid settings: ${settings.join(', ')}.` : ''} Review ${report}. Correct the workflow environment and start a new run.`);
    }
  }
  throw new Error(`This artefact contains no incident events. The workflow may have failed before the controller started. Review its retained diagnostics in ${root}.`);
}

export async function prepareObservation({ bundleRoot, run: input, options = parseOptions([]), gh = runGh, checkTools }) {
  const run = validateRun(input), mode = options.mode ?? run.defaultMode, incident = run.cases[mode];
  if (!incident) throw new Error(`This workflow attempt did not configure a ${mode} incident. Use --mode fixture.`);
  const artifact = await findArtifact(gh, run, incident.artifactName);
  const common = ['--incident', incident.incidentId, '--port', String(options.port ?? 4318), '--ui', resolve(bundleRoot, 'ui')];
  if (artifact) {
    if (artifact.expired !== false) throw new Error(`The retained ${mode} artefact has expired or its availability is unknown. Start a new workflow and download its observer package.`);
    if (!Number.isSafeInteger(artifact.id) || artifact.id < 1 || (artifact.workflow_run?.id !== undefined && String(artifact.workflow_run.id) !== run.runId)) throw new Error('GitHub returned a mismatched artefact identity');
    const cache = resolve(bundleRoot, '.recorded-runs'); mkdirSync(cache, { recursive: true, mode: 0o700 });
    const download = mkdtempSync(join(cache, `${mode}-${run.runId}-${run.runAttempt}-`));
    await gh(['run', 'download', run.runId, '--repo', run.repository, '--name', incident.artifactName, '--dir', download], { timeoutMs: 180_000 });
    const paths = [join(download, 'events.jsonl'), join(download, `self-remediation-${mode}`, 'events.jsonl')].filter(path => safeFile(download, path));
    if (!paths.length) missingJournal(download, mode);
    if (paths.length !== 1) throw new Error('Retained artefact has ambiguous journal locations');
    const events = paths[0], count = validateJournal(events, incident.incidentId), base = dirname(events);
    const start = join(base, 'integration-start.json');
    if (safeFile(download, start)) {
      const scope = JSON.parse(readFileSync(start, 'utf8'));
      if (scope.schema !== 'self-remediation-integration/1' || scope.incident !== incident.incidentId || scope.mode !== mode) throw new Error('Retained integration mode or incident identity mismatch');
    }
    const args = ['--events', events, '--disclose', ...common];
    const disclosures = join(base, 'disclosed-artefacts.json'), artefacts = join(base, 'artefacts');
    if (safeFile(download, disclosures) && existsSync(artefacts) && lstatSync(artefacts).isDirectory() && !lstatSync(artefacts).isSymbolicLink()) {
      args.push('--artefacts', artefacts, '--disclosures', disclosures);
      if (options.discloseSource) args.push('--disclose-source');
    }
    const archive = join(base, 'archive', 'index.html');
    return { mode: 'replay', args, incidentId: incident.incidentId, artifactId: artifact.id, eventCount: count,
      ...(safeFile(download, archive) ? { archive } : {}) };
  }
  const attempt = await jsonRequest(gh, `/repos/${run.repository}/actions/runs/${run.runId}/attempts/${run.runAttempt}`);
  if (String(attempt.id) !== run.runId || String(attempt.run_attempt) !== run.runAttempt || typeof attempt.status !== 'string') throw new Error('GitHub returned a mismatched workflow attempt');
  const runUrl = `https://github.com/${run.repository}/actions/runs/${run.runId}/attempts/${run.runAttempt}`;
  if (options.replay || mode === 'fixture' || attempt.status === 'completed') throw new Error(`The exact ${mode} replay artefact is not available. ${attempt.status === 'completed' ? 'The workflow finished without retaining it, or it was deleted.' : 'The workflow is still running; rerun this command after the artefact upload.'} Inspect ${runUrl}.`);
  const { GhCheckApi, findCheck, decodeWindow } = checkTools ?? await import(pathToFileURL(resolve(bundleRoot, 'server/github-check.js')).href);
  const check = await findCheck(new GhCheckApi(run.repository), run.repository, run.sha, incident.incidentId);
  if (!check) throw new Error(`The live incident has no acknowledged progress Check Run yet. It may be queued behind the fixture or blocked by configuration. Retry shortly, or inspect ${runUrl}.`);
  if (!Number.isSafeInteger(check.id) || check.id < 1 || check.head_sha !== run.sha || check.external_id !== incident.incidentId) throw new Error('Live Check Run identity mismatch');
  const window = decodeWindow(check.output?.text ?? '');
  if (window.incidentId !== incident.incidentId) throw new Error('Live progress incident identity mismatch');
  if (!window.events.length) throw new Error(`The live Check Run has not published committed events yet. Retry shortly, or inspect ${runUrl}.`);
  return { mode: 'live', incidentId: incident.incidentId, checkId: check.id,
    args: ['--repo', run.repository, '--sha', run.sha, '--check', String(check.id), ...common] };
}

export async function main(args = process.argv.slice(2), bundleRoot = dirname(fileURLToPath(import.meta.url))) {
  const options = parseOptions(args);
  if (options.help) { process.stdout.write(USAGE); return; }
  const manifest = resolve(bundleRoot, 'run.json');
  if (!existsSync(manifest)) throw new Error('This observer has no run.json. Download a workflow-built observer package, or use observe.mjs with explicit identifiers.');
  const prepared = await prepareObservation({ bundleRoot, run: JSON.parse(readFileSync(manifest, 'utf8')), options });
  process.stdout.write(`${prepared.mode === 'replay' ? `Recorded replay (${prepared.eventCount} committed events)` : 'Live GitHub observation'}: ${prepared.incidentId}\n`);
  if (prepared.archive) process.stdout.write(`Offline HTML: ${prepared.archive}\n`);
  process.argv = [process.execPath, resolve(bundleRoot, 'observe.mjs'), ...prepared.args];
  const observer = await import(pathToFileURL(resolve(bundleRoot, 'server/index.js')).href);
  await observer.main();
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => {
  process.stderr.write(`Observer: ${error.message}\n`); process.exitCode = 1;
});
