/** The outer controller delegates bounded inference to the pinned host, never a second agent runtime. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PINNED_HOST = 'c71d958ee774c4e60bd74b4780f3f695a5d818b7';
export type PhaseKind = 'investigation' | 'synthesis' | 'review';
export type PhaseOptions = {
  mode: 'fixture' | 'live'; stateDir?: string; model?: string; maxCalls?: number; wallSeconds?: number;
  fixtureOutput?: unknown; fixturePlanner?: unknown; onObservation?: (value: any) => void | Promise<void>;
  signal?: AbortSignal;
};
export type HostConfiguration = {
  binary: string; sdkRoot: string; stateDir: string; projectTemplate?: string;
  onObservation?: (value: any) => void | Promise<void>;
};
export class HostPhaseError extends Error {
  constructor(message: string, readonly phaseId: string, readonly observation: any, readonly uncertain: boolean) { super(message); }
}
const actors: Record<PhaseKind, string> = { investigation: 'investigator', synthesis: 'repair_agent', review: 'independent_reviewer' };
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const canonical = (value: any): string => {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return JSON.stringify(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  throw new Error('MAS requires exact integers and JSON values');
};
export function assertFrameInput(input: unknown, maximum = 10_000) {
  // Revision adds candidate/evidence copies and inference configuration framing.
  // Reject before dispatch, leaving headroom beneath the strict 65,536-byte frame.
  const bytes = Buffer.byteLength(canonical(input));
  if (bytes > maximum) throw new Error(`Frozen phase input is ${bytes} bytes; retain large content as admitted artefact references (limit ${maximum})`);
  return bytes;
}
function hostEnvironment(includeProvider = false) {
  const result: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin' };
  // The maintained provider owns its sole credential. No GitHub, cluster or
  // publication credentials enter the host process or inference workers.
  if (includeProvider && process.env.OPENAI_API_KEY) result.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  return result;
}
export async function hostCommand(binary: string, args: string[], options: { timeout?: number; env?: NodeJS.ProcessEnv } = {}) {
  return new Promise<string>((accept, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], env: options.env ?? hostEnvironment() });
    let out = '', err = '', bytes = 0, settled = false;
    const finish = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : accept(out); };
    const timer = setTimeout(() => { child.kill('SIGTERM'); finish(new Error('Host command deadline reached; reconcile retained effects')); }, options.timeout ?? 15_000);
    child.stdout.on('data', data => { bytes += data.length; if (bytes > 4 * 1024 * 1024) { child.kill('SIGTERM'); finish(new Error('Host output bound exceeded')); } else out += data; });
    child.stderr.on('data', data => { if (err.length < 16_384) err += data; });
    child.on('error', error => finish(error));
    child.on('exit', code => finish(code === 0 ? undefined : new Error(`Host process exited ${code}: ${err.slice(0, 1000)}`)));
  });
}
export async function pinnedHostIdentity(configuration: HostConfiguration) {
  const revision = (await hostCommand('git', ['-C', configuration.sdkRoot, 'rev-parse', 'HEAD'])).trim();
  if (revision !== PINNED_HOST) throw new Error(`Host SDK revision ${revision} differs from pinned ${PINNED_HOST}`);
  await hostCommand('git', ['-C', configuration.sdkRoot, 'diff', '--quiet', 'HEAD', '--']);
  return { sourceRevision: revision, binarySha256: hash(await readFile(configuration.binary)) };
}
function plan(kind: PhaseKind, maxCalls: number) {
  return { version: 'mas-host-revision/1', draft_agent: actors[kind], revision_agent: actors[kind], max_revisions: 0,
    max_invocations: maxCalls + 4, draft_inputs: ['incident'], revision_inputs: ['incident'],
    allowed_agents: kind === 'investigation' ? ['experiment_planner'] : [], feedback_evaluators: [],
    rubric: { schema_version: 1, id: 'self-remediation-structure/1', criteria: [{ id: 'bounded-record', measurement: 'deterministic', minimum: 0, maximum: 1 }] },
    evaluators: [{ actor: 'record_check', identity: { id: 'record_check', version: '1', kind: 'deterministic' }, inputs: ['incident'] }] };
}
function manifest(kind: PhaseKind, model: string, maxCalls: number, wallSeconds: number, fixture: boolean) {
  const agent: any = { name: actors[kind], operation: `${kind}/1`, output_schema: `schemas/${kind}.json`,
    implementation: { kind: 'llm', connection: 'reasoning', model, instructions: `prompts/${kind === 'investigation' ? 'investigator' : kind === 'synthesis' ? 'repair' : 'reviewer'}.md`, max_output_tokens: 4096 } };
  const agents = [agent];
  if (kind === 'investigation') {
    Object.assign(agent.implementation, { delegates: ['experiment_planner'], required_delegates: ['experiment_planner'], max_turns: 2 });
    agents.push({ name: 'experiment_planner', operation: 'plan_discriminating_experiment/1', output_schema: 'schemas/planner.json', implementation: {
      kind: 'llm', connection: 'planner', model, instructions: 'prompts/planner.md', max_output_tokens: 2048 } });
  }
  agents.push({ name: 'record_check', operation: 'check_bounded_record/1', implementation: { kind: 'native', language: 'python', source: 'assessment.py', handler: 'assess' } });
  const connection = (role: string) => fixture ? { kind: 'command', command: ['python3', 'fixture-provider.py', role] } : { kind: 'openai', api_key_env: 'OPENAI_API_KEY' };
  return { version: 'mas-agents/3', agents, connections: { reasoning: connection(kind), ...(kind === 'investigation' ? { planner: connection('planner') } : {}) },
    limits: { wall_seconds: wallSeconds, max_calls: maxCalls, max_messages: 40, max_bytes: 524288, mailbox_capacity: 8 } };
}
function topology(kind: PhaseKind) {
  const edges = [['client', actors[kind]], [actors[kind], 'client'], ['client', 'record_check'], ['record_check', 'client']];
  if (kind === 'investigation') edges.push(['investigator', 'experiment_planner'], ['experiment_planner', 'investigator']);
  return { version: 'mas-topology/1', edges };
}
function fixtureProvider(output: unknown, planner: unknown) {
  // This file is created only for explicitly labelled controls. It is never
  // copied into a live phase or into the candidate source projection.
  const data = JSON.stringify({ output, planner });
  return `#!/usr/bin/env python3\nimport json,sys\nCONTROL=json.loads(${JSON.stringify(data)})\nr=json.load(sys.stdin)\nassert r['version']=='mas-provider/1'\nt=json.loads(r['input_json'])\nrole=sys.argv[1]\nif role=='planner': o=CONTROL['planner']\nelif role=='investigation':\n if not t.get('history'): o={'decision':{'kind':'request','target':'experiment_planner','input_json':json.dumps({'incident':t.get('task',t).get('sources',{}).get('incident',{})})}}\n else: o={'decision':{'kind':'complete','output':CONTROL['output']}}\nelse: o=CONTROL['output']\njson.dump({'version':'mas-provider/1','status':'completed','output_json':json.dumps(o),'evidence':{'id':'explicit-scripted-control','cleanup':'confirmed'}},sys.stdout)\n`;
}
export class HostPhaseRunner {
  constructor(readonly configuration: HostConfiguration) {}
  async observe(phaseId: string, stateDir = this.configuration.stateDir, payloads = false) {
    return JSON.parse(await hostCommand(this.configuration.binary, ['observe', '--state', stateDir, '--run', phaseId, '--include-payloads', String(payloads)]));
  }
  async cancel(phaseId: string, stateDir = this.configuration.stateDir) {
    return JSON.parse(await hostCommand(this.configuration.binary, ['cancel', '--state', stateDir, '--run', phaseId]));
  }
  /** Resume only the retained original frozen phase. This cannot bypass an unresolved effect. */
  async resume(phaseId: string, stateDir = this.configuration.stateDir) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(phaseId)) throw new Error('Invalid frozen phase identity');
    const folder = join(resolve(stateDir), 'phases', phaseId), project = join(folder, 'project');
    const identity = JSON.parse(await readFile(join(folder, 'identity.json'), 'utf8'));
    if (canonical(identity.host) !== canonical(await pinnedHostIdentity(this.configuration))) throw new Error('Frozen host identity changed');
    const input = JSON.parse(await readFile(join(folder, 'input.json'), 'utf8'));
    if (hash(canonical(input.sources?.[0]?.content)) !== identity.input) throw new Error('Frozen phase input changed');
    const bundlePath = join(project, '.mas/build/bundle.json'), bundleSha256 = hash(await readFile(bundlePath));
    if (bundleSha256 !== await readFile(join(folder, 'bundle-sha256.txt'), 'utf8')) throw new Error('Frozen phase bundle changed');
    let observation: any = null;
    try {
      const value = JSON.parse(await hostCommand(this.configuration.binary, ['run', '--bundle', bundlePath,
        '--agent', actors[identity.kind as PhaseKind], '--input', join(folder, 'input.json'), '--state', resolve(stateDir),
        '--run', phaseId, '--revision-plan', join(project, 'revision.json')], { timeout: (identity.wallSeconds + 15) * 1000, env: hostEnvironment(identity.mode === 'live') }));
      observation = await this.observe(phaseId, stateDir, true);
      await writeFile(join(folder, 'observation.json'), JSON.stringify(observation), { mode: 0o600 });
      if (value.revision?.status !== 'completed') throw new HostPhaseError('Resumed phase remains incomplete', phaseId, observation, false);
      await this.configuration.onObservation?.(await this.observe(phaseId, stateDir));
      const effects = observation.steps.filter((step: any) => step.kind === 'effect');
      return { output: value.output, observation, revision: value.revision, identity: { ...identity, bundleSha256 },
        invocationIds: effects.map((step: any) => step.id), calls: observation.calls.length, usage: observation.run?.usage,
        providerUsage: effects.filter((step: any) => step.input?.format === 'mas-inference/2').map((step: any) => ({ invocationId: step.id,
          requestedModel: step.evidence?.requested_model ?? null, resolvedModel: step.evidence?.model ?? null,
          usage: step.evidence?.usage ?? null, status: step.evidence?.output_status ?? null })) };
    } catch (error) {
      try { observation = await this.observe(phaseId, stateDir, true); } catch { /* Unknown remains unresolved. */ }
      if (error instanceof HostPhaseError) throw error;
      throw new HostPhaseError('Original phase could not resume; reconcile retained effects', phaseId, observation,
        !observation || observation.steps.some((step: any) => step.kind === 'effect' && ['executing', 'unknown', 'prepared'].includes(step.state)));
    }
  }
  async run(kind: PhaseKind, phaseId: string, frozenInput: unknown, options: PhaseOptions) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(phaseId)) throw new Error('Invalid frozen phase identity');
    if (options.mode === 'live' && (options.fixtureOutput !== undefined || options.fixturePlanner !== undefined)) throw new Error('Fixture solution material is forbidden in live mode');
    if (options.mode === 'fixture' && options.fixtureOutput === undefined) throw new Error('Fixture mode requires an explicit scripted control response');
    assertFrameInput(frozenInput);
    const stateDir = resolve(options.stateDir ?? this.configuration.stateDir), folder = join(stateDir, 'phases', phaseId), project = join(folder, 'project');
    const maxCalls = options.maxCalls ?? (kind === 'investigation' ? 3 : 1), wallSeconds = options.wallSeconds ?? 180;
    if (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 16 || !Number.isInteger(wallSeconds) || wallSeconds < 1 || wallSeconds > 600) throw new Error('Invalid bounded phase limits');
    const model = options.model ?? 'gpt-5.4-mini-2026-03-17';
    const host = await pinnedHostIdentity(this.configuration);
    const identity = { host, kind, phaseId, input: hash(canonical(frozenInput)), mode: options.mode, model, maxCalls, wallSeconds,
      fixture: options.mode === 'fixture' ? hash(canonical({ output: options.fixtureOutput, planner: options.fixturePlanner ?? null })) : null };
    await mkdir(folder, { recursive: true });
    const identityPath = join(folder, 'identity.json');
    try { if (canonical(JSON.parse(await readFile(identityPath, 'utf8'))) !== canonical(identity)) throw new Error('Phase identity already binds different frozen input or policy'); }
    catch (error: any) { if (error.code !== 'ENOENT') throw error; await writeFile(identityPath, canonical(identity), { flag: 'wx', mode: 0o600 }); }
    try { await access(join(project, 'agents.json')); }
    catch {
      const template = this.configuration.projectTemplate ?? fileURLToPath(new URL('../project', import.meta.url));
      await cp(template, project, { recursive: true });
      await writeFile(join(project, 'agents.json'), canonical(manifest(kind, model, maxCalls, wallSeconds, options.mode === 'fixture')));
      await writeFile(join(project, 'topology.json'), canonical(topology(kind)));
      await writeFile(join(project, 'revision.json'), canonical(plan(kind, maxCalls)));
      if (options.mode === 'fixture') await writeFile(join(project, 'fixture-provider.py'), fixtureProvider(options.fixtureOutput, options.fixturePlanner ?? (options.fixtureOutput as any)?.experiment ?? {}));
      await writeFile(join(folder, 'input.json'), canonical({ sources: [{ id: 'incident', kind: 'evidence', content: frozenInput, readers: ['*'] }] }));
    }
    const built = JSON.parse(await hostCommand(this.configuration.binary, ['build', '--project', project, '--sdk-root', this.configuration.sdkRoot,
      '--agents', 'agents.json', '--topology', 'topology.json'], { timeout: 60_000 }));
    const bundle = await readFile(built.bundle);
    if (bundle.length > 65_536) throw new Error('Compiled host bundle exceeds 65,536 bytes');
    const bundleHash = hash(bundle), bundleReceipt = join(folder, 'bundle-sha256.txt');
    try { if ((await readFile(bundleReceipt, 'utf8')) !== bundleHash) throw new Error('Retained phase bundle changed'); }
    catch (error: any) { if (error.code !== 'ENOENT') throw error; await writeFile(bundleReceipt, bundleHash, { flag: 'wx' }); }
    const onObservation = options.onObservation ?? this.configuration.onObservation;
    let observing = false, observation: any = null;
    const poll = async () => { if (observing) return; observing = true; try { observation = await this.observe(phaseId, stateDir); await onObservation?.(observation); } catch { /* Active journal creation and SQLite busy are transient. */ } finally { observing = false; } };
    const timer = setInterval(() => { void poll(); }, 750);
    const cancel = () => { void this.cancel(phaseId, stateDir).catch(() => {}); };
    options.signal?.addEventListener('abort', cancel, { once: true });
    try {
      if (options.signal?.aborted) throw new Error('Cancelled before host phase dispatch');
      const value = JSON.parse(await hostCommand(this.configuration.binary, ['run', '--bundle', built.bundle, '--agent', actors[kind], '--input', join(folder, 'input.json'),
        '--state', stateDir, '--run', phaseId, '--revision-plan', join(project, 'revision.json')], { timeout: (wallSeconds + 15) * 1000, env: hostEnvironment(options.mode === 'live') }));
      observation = await this.observe(phaseId, stateDir, true); await onObservation?.(await this.observe(phaseId, stateDir));
      await writeFile(join(folder, 'observation.json'), JSON.stringify(observation), { mode: 0o600 });
      if (value.revision?.status !== 'completed') throw new HostPhaseError('Phase structural assessment did not complete', phaseId, observation, false);
      const effects = observation.steps.filter((step: any) => step.kind === 'effect');
      return { output: value.output, observation, revision: value.revision, identity: { ...identity, bundleSha256: bundleHash },
        invocationIds: effects.map((step: any) => step.id), calls: observation.calls.length, usage: observation.run?.usage,
        providerUsage: effects.filter((step: any) => step.input?.format === 'mas-inference/2').map((step: any) => ({ invocationId: step.id,
          requestedModel: step.evidence?.requested_model ?? null, resolvedModel: step.evidence?.model ?? null,
          usage: step.evidence?.usage ?? null, status: step.evidence?.output_status ?? null })) };
    } catch (error) {
      try { observation = await this.observe(phaseId, stateDir, true); await writeFile(join(folder, 'observation.json'), JSON.stringify(observation), { mode: 0o600 }); } catch { /* Retain unknown rather than manufacture a failed measurement. */ }
      if (error instanceof HostPhaseError) throw error;
      const uncertain = !observation || observation.steps?.some((step: any) => step.kind === 'effect' && ['executing', 'unknown', 'prepared'].includes(step.state));
      throw new HostPhaseError('Host phase failed; inspect retained observation before any new phase', phaseId, observation, uncertain);
    } finally { clearInterval(timer); options.signal?.removeEventListener('abort', cancel); }
  }
}
