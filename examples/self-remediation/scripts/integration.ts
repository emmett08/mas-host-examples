/** Run the real host/source-repair/k3s path and publish progress while it runs. */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, createWriteStream } from 'node:fs';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';

const { values } = parseArgs({ options: {
  mode: { type: 'string', default: 'fixture' }, case: { type: 'string', default: 'missing-route' },
  output: { type: 'string', default: '.state/integration' }, incident: { type: 'string' },
} });
if (!['fixture', 'live'].includes(values.mode!)) throw new Error('Expected fixture or live mode');
const output = resolve(values.output!);
const incident = values.incident ?? `${process.env.GITHUB_RUN_ID ?? 'local'}-${process.env.GITHUB_RUN_ATTEMPT ?? Date.now()}-${values.case}`;
if (!/^[a-zA-Z0-9_-]{1,120}$/.test(incident)) throw new Error('Invalid incident identity');
mkdirSync(output, { recursive: true, mode: 0o700 });

function bounded(name: string, fallback: number, ceiling: number): number {
  const n = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(n) || n <= 0 || n > ceiling) throw new Error(`${name} must be positive and at most ${ceiling}`);
  return n;
}
const budget = {
  calls: bounded('SELF_REMEDIATION_MAX_CALLS', 12, 12),
  candidates: bounded('SELF_REMEDIATION_MAX_CANDIDATES', 3, 3),
  wallSeconds: bounded('SELF_REMEDIATION_MAX_SECONDS', 600, 600),
  usd: bounded('SELF_REMEDIATION_MAX_USD', 2, 2),
  callReservationMicroUsd: values.mode === 'live' ? bounded('SELF_REMEDIATION_MAX_CALL_MICRO_USD', 150_000, 2_000_000) : 0,
};
if (!Number.isSafeInteger(budget.callReservationMicroUsd)) throw new Error('Per-call reservation must be a positive integer number of micro-USD in live mode');
const started = new Date().toISOString();
const scope = {
  schema: 'self-remediation-integration/1', incident, mode: values.mode, case: values.case,
  workflow: process.env.GITHUB_RUN_ID ?? null, attempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
  source: process.env.GITHUB_SHA ?? null, started, budget,
  spendAccounting: 'Reserved policy upper bounds; actual provider billing is separately observed when available.',
  hostRevision: readFileSync(resolve('../../host-revision.txt'), 'utf8').trim(),
  fixtureLimitation: values.mode === 'fixture' ? 'Scripted control responses exercise mechanisms, not provider repair competence.' : null,
};
writeFileSync(join(output, 'integration-start.json'), JSON.stringify(scope, null, 2) + '\n', { flag: 'wx', mode: 0o400 });
process.stdout.write(`Incident ${incident}; source ${scope.source ?? 'local checkout'}; mode ${values.mode}.\n`);
if (process.env.SELF_REMEDIATION_PROGRESS === 'true') process.stdout.write(
  `Live observer: node observe.mjs --repo ${process.env.GITHUB_REPOSITORY} --sha ${process.env.GITHUB_SHA} --incident ${incident}\n`);

function command(program: string, args: string[]): string {
  const result = spawnSync(program, args, { encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`${program} ${args[0] ?? ''} unavailable: ${result.error?.message ?? result.stderr}`);
  return result.stdout;
}

let provider: ChildProcess | undefined;
let observer: ChildProcess | undefined;
let observerExit: Promise<number | null> | undefined;
let checkpointer: ChildProcess | undefined;
let checkpointExit: Promise<number | null> | undefined;
let interrupted = false;
let controllerCode: number | null = null;
let failure: string | undefined;
const done = join(output, 'observation.done');
const log = createWriteStream(join(output, 'controller.log'), { flags: 'wx', mode: 0o600 });
const stop = () => {
  if (interrupted) return;
  interrupted = true;
  const signal = (kind: NodeJS.Signals) => {
    if (!provider?.pid || provider.exitCode !== null || provider.signalCode !== null) return;
    try {
      if (process.platform === 'win32') provider.kill(kind);
      else process.kill(-provider.pid, kind);
    } catch { /* The process may have exited between inspection and signalling. */ }
  };
  signal('SIGTERM');
  setTimeout(() => signal('SIGKILL'), 5_000).unref();
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);

try {
  if (!process.env.MAS_HOST_BIN || !existsSync(process.env.MAS_HOST_BIN)) throw new Error('Set MAS_HOST_BIN to the exact pinned built host');
  if (!/^sha256:[a-f0-9]{64}$/.test(process.env.MAS_SANDBOX_IMAGE ?? '')) throw new Error('MAS_SANDBOX_IMAGE must be the built immutable sandbox image ID');
  if (values.mode === 'live' && !process.env.OPENAI_API_KEY) throw new Error('Live provider credential unavailable');
  const preflight = {
    host: command(process.env.MAS_HOST_BIN, ['--version']).trim(),
    docker: command('docker', ['info', '--format', '{{.ServerVersion}}']).trim(),
    context: command('kubectl', ['config', 'current-context']).trim(),
    nodes: JSON.parse(command('kubectl', ['get', 'nodes', '-o', 'json'])),
    sandboxImage: process.env.MAS_SANDBOX_IMAGE,
  };
  if (preflight.context !== 'k3d-self-remediation') throw new Error('Integration requires the disposable k3d-self-remediation context');
  writeFileSync(join(output, 'integration-preflight.json'), JSON.stringify(preflight, null, 2) + '\n', { flag: 'wx', mode: 0o400 });
  const checkpointEnv: NodeJS.ProcessEnv = { SELF_REMEDIATION_MODE: values.mode, ACTIONS_ARTIFACT_UPLOAD_TIMEOUT_MS: '30000' };
  for (const key of ['PATH', 'HOME', 'GITHUB_ACTIONS', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_SHA', 'GITHUB_SERVER_URL',
    'GITHUB_WORKSPACE', 'ACTIONS_RUNTIME_TOKEN', 'ACTIONS_RESULTS_URL', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY'])
    if (process.env[key]) checkpointEnv[key] = process.env[key];
  checkpointer = spawn(process.execPath, ['--import', 'tsx', 'scripts/checkpoint.ts', '--watch', '--directory', output, '--stop-file', done],
    { env: checkpointEnv, stdio: ['ignore', 'inherit', 'inherit'] });
  checkpointExit = new Promise(accept => {
    checkpointer!.once('error', () => { failure ??= 'Recovery checkpoint sidecar could not start'; accept(null); });
    checkpointer!.once('exit', accept);
  });
  if (process.env.SELF_REMEDIATION_PROGRESS === 'true') {
    if (!process.env.GH_TOKEN || !process.env.GITHUB_REPOSITORY || !process.env.GITHUB_SHA) throw new Error('During-run observation requires Check Run credentials and exact repository/SHA');
    // Only the observer receives its gh credential; no provider key or kubeconfig.
    observer = spawn(process.execPath, ['dist/server/check-publisher.js', '--events', join(output, 'events.jsonl'),
      '--incident', incident, '--repo', process.env.GITHUB_REPOSITORY, '--sha', process.env.GITHUB_SHA,
      '--state', join(output, 'check-state.json'), '--done', done], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, GH_TOKEN: process.env.GH_TOKEN }, stdio: ['ignore', 'inherit', 'inherit'],
    });
    observerExit = new Promise((accept) => {
      observer!.once('error', error => { failure ??= `Check Run publisher could not start: ${error.message}`; accept(null); });
      observer!.once('exit', accept);
    });
  }
  const args = ['--import', 'tsx', 'scripts/run.ts', '--mode', values.mode!, '--case', values.case!, '--output', output,
    '--incident', incident, '--trial', 'k3s'];
  // Artifact credentials belong only to the sidecar. Candidate Docker execution
  // separately uses its own credential-free environment allowlist.
  const providerEnv = { ...process.env };
  for (const key of ['ACTIONS_RUNTIME_TOKEN', 'ACTIONS_RUNTIME_URL', 'ACTIONS_RESULTS_URL', 'ACTIONS_CACHE_URL']) delete providerEnv[key];
  provider = spawn(process.execPath, args, { detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], env: {
    ...providerEnv, SELF_REMEDIATION_MAX_CALLS: String(budget.calls), SELF_REMEDIATION_MAX_CANDIDATES: String(budget.candidates),
    SELF_REMEDIATION_MAX_SECONDS: String(budget.wallSeconds), SELF_REMEDIATION_MAX_USD: String(budget.usd),
    ...(values.mode === 'live' ? { SELF_REMEDIATION_MAX_CALL_MICRO_USD: String(budget.callReservationMicroUsd) } : {}),
  } });
  provider.stdout?.on('data', chunk => { log.write(chunk); process.stdout.write(chunk); });
  provider.stderr?.on('data', chunk => { log.write(chunk); process.stderr.write(chunk); });
  const timer = setTimeout(stop, (budget.wallSeconds + 30) * 1000);
  controllerCode = await new Promise<number | null>((accept, reject) => {
    provider!.once('error', reject); provider!.once('exit', accept);
  });
  clearTimeout(timer);
  if (controllerCode !== 0) throw new Error(`Controller exited ${controllerCode ?? 'by signal'}; retained effects may require reconciliation`);
  if (!existsSync(join(output, 'events.jsonl'))) throw new Error('Controller retained no committed events');
  const result = JSON.parse(readFileSync(join(output, 'result.json'), 'utf8'));
  const events = readFileSync(join(output, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  const statuses = (value: unknown, wanted: string): boolean => {
    if (!value || typeof value !== 'object') return false;
    if (!Array.isArray(value) && (value as Record<string, unknown>).status === wanted) return true;
    return Object.values(value).some(child => statuses(child, wanted));
  };
  if (result.outcome === 'verified_recovery') {
    const baseline = events.findIndex(e => e.type === 'measurement' && e.data.subject === 'baseline' && statuses(e.data, 'failed'));
    const candidate = events.findIndex((e, i) => i > baseline && e.type === 'candidate.created');
    const verification = events.findIndex((e, i) => i > candidate && e.type === 'verification' && e.data.eligible === true);
    const trial = events.findIndex((e, i) => i > verification && e.type === 'trial' && e.data.recovered === true);
    if (baseline < 0 || candidate < 0 || verification < 0 || trial < 0 || !/isolated.*trial/i.test(result.scope ?? ''))
      throw new Error('Recovery is missing its ordered baseline failure, generated candidate, independent verification or real isolated trial');
  }
  if (values.mode === 'fixture' && values.case === 'missing-route') {
    if (result.outcome !== 'verified_recovery') throw new Error(`Expected fixture recovery, observed ${result.outcome}`);
    if (events.filter(e => e.type === 'candidate.created').length < 2 || !events.some(e => e.type === 'verification' && e.data.eligible === false))
      throw new Error('Fixture did not demonstrate a rejected candidate followed by a useful revision');
  }
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${failure}\n`);
} finally {
  log.end();
  writeFileSync(done, JSON.stringify({ controllerCode, interrupted, failure: failure ?? null }) + '\n', { mode: 0o600 });
  if (checkpointer) {
    const timer = setTimeout(() => checkpointer?.kill('SIGKILL'), 45_000);
    await checkpointExit; clearTimeout(timer);
    if (checkpointer.exitCode !== 0) failure ??= 'Recovery checkpoint sidecar failed or has an unknown upload; retained local evidence requires inspection';
    try {
      const state = JSON.parse(readFileSync(join(output, 'checkpoint-summary.json'), 'utf8'));
      if (!state.localCuts || (process.env.GITHUB_ACTIONS === 'true' && !state.duringRunAcknowledged))
        failure ??= 'No acknowledged recovery checkpoint before controller completion';
    } catch { failure ??= 'No recovery checkpoint summary'; }
  }
  if (observer) {
    const timer = setTimeout(() => observer?.kill('SIGTERM'), 20_000);
    await observerExit;
    clearTimeout(timer);
    if (observer.exitCode !== 0) failure ??= `During-run Check Run publication failed (${observer.exitCode ?? 'signal'})`;
    try {
      const state = JSON.parse(readFileSync(join(output, 'check-state.json'), 'utf8'));
      if (!state.completed || !(state.lastSeq > 0) || !(state.inProgressUpdates > 0) || !state.firstPublishedAt)
        failure ??= 'No acknowledged nonempty Check Run update before controller completion';
    } catch { failure ??= 'No retained during-run Check Run acknowledgement'; }
  }
  // Archive is a separate completion artefact. Its existence never proves live visibility.
  if (existsSync(join(output, 'events.jsonl'))) {
    // Only the trusted disclosure manifest selects demo source/results. A failed
    // run without that manifest still receives a redacted event-only replay.
    const disclosed = existsSync(join(output, 'disclosed-artefacts.json')) && existsSync(join(output, 'artefacts'));
    const archive = spawnSync(process.execPath, ['scripts/archive.mjs', '--events', join(output, 'events.jsonl'), '--output', join(output, 'archive'), '--incident', incident,
      ...(disclosed ? ['--artefacts', join(output, 'artefacts'), '--disclosures', join(output, 'disclosed-artefacts.json'), '--disclose-source'] : [])], { encoding: 'utf8', timeout: 30_000 });
    writeFileSync(join(output, 'archive.log'), (archive.stdout ?? '') + (archive.stderr ?? ''), { mode: 0o600 });
    if (archive.status !== 0) failure ??= 'Offline archive construction failed; see archive.log';
  }
  const events = existsSync(join(output, 'events.jsonl')) ? readFileSync(join(output, 'events.jsonl')) : Buffer.alloc(0);
  writeFileSync(join(output, 'integration-result.json'), JSON.stringify({ ...scope, finished: new Date().toISOString(), controllerCode,
    interrupted, status: failure ? 'FAILED_OR_UNEXECUTED' : 'COMPLETED', failure: failure ?? null,
    eventsSha256: createHash('sha256').update(events).digest('hex'),
    requiresExternalEvidence: ['GitHub repair PR', 'browser observed before workflow completion', 'live-provider competence'],
  }, null, 2) + '\n', { flag: 'wx', mode: 0o400 });
  process.off('SIGTERM', stop); process.off('SIGINT', stop);
}
if (failure) process.exitCode = 1;
