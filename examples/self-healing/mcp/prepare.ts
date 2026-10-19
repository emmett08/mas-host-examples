/** Prepare immutable host exports for one operator-selected self-healing incident. */
import { copyFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { admissionDigest, dependencyFiles, inputSchema, outputSchema, rawDigest, type Admission } from './contract.js';
import { sha256 } from '../deploy/effects.js';
import { pinnedHostIdentity } from '../host/phase.js';
import { caseNames } from '../evaluation/injectors.js';

const execute = promisify(execFile);
export interface PrepareOptions {
  directory: string; example: string; host: string; sdkRoot: string; server: string; incidentId: string;
  mode: 'fixture' | 'live'; caseName?: string; config?: string;
  /** Test-only trusted controller substitute, explicitly recorded as a boundary control. Never selected by MCP input. */
  controlController?: string;
}
export async function prepare(options: PrepareOptions) {
  const example = realpathSync(options.example), repository = resolve(example, '../..'), directory = resolve(options.directory);
  if (!/^[A-Za-z0-9_-]{1,65}$/.test(options.incidentId)) throw new Error('Incident ID requires 1..65 letters, digits, underscore or hyphen');
  if (!['fixture', 'live'].includes(options.mode) || (options.controlController && options.mode !== 'fixture')) throw new Error('Invalid execution profile');
  const caseName = options.caseName ?? 'missing-route';
  if (!caseNames.includes(caseName as never)) throw new Error('Unknown protected benchmark case');
  const host = realpathSync(options.host), sdkRoot = realpathSync(options.sdkRoot), server = realpathSync(options.server);
  await pinnedHostIdentity({ binary: host, sdkRoot, stateDir: directory });
  const sourceRevision = (await execute('git', ['-C', repository, 'rev-parse', 'HEAD'])).stdout.trim();
  const number = (name: string, fallback: number, ceiling: number) => {
    const value = Number(process.env[name] ?? fallback);
    if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) throw new Error(`Invalid ${name}`);
    return value;
  };
  const dollars = Number(process.env.SELF_REMEDIATION_MAX_USD ?? 2);
  const microUsd = Math.floor(dollars * 1_000_000);
  if (!Number.isSafeInteger(microUsd) || microUsd < 1 || microUsd > 10_000_000) throw new Error('Invalid expenditure budget');
  const limits = { calls: number('SELF_REMEDIATION_MAX_CALLS', 12, 96), candidates: number('SELF_REMEDIATION_MAX_CANDIDATES', 3, 8), operations: 160,
    wallMs: number('SELF_REMEDIATION_MAX_SECONDS', 600, 1800) * 1000, microUsd };
  const builder = process.env.MAS_SANDBOX_IMAGE ?? '';
  if (!/^sha256:[a-f0-9]{64}$/.test(builder)) throw new Error('MAS_SANDBOX_IMAGE must identify the immutable sandbox image');
  const config = options.config ? JSON.parse(readFileSync(resolve(options.config), 'utf8')) : undefined;
  if (config) {
    for (const field of ['sourceDirectory', 'repositoryDirectory']) if (config[field]) config[field] = resolve(example, config[field]);
    config.publicationMode ??= 'archive';
    if (!['archive', 'pull-request'].includes(config.publicationMode)) throw new Error('Operational MCP publication requires archive or pull-request policy');
  }
  const environment: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', MAS_HOST_BIN: host, MAS_SDK_ROOT: sdkRoot, MAS_SANDBOX_IMAGE: builder,
    SELF_REMEDIATION_MAX_CALLS: String(limits.calls), SELF_REMEDIATION_MAX_CANDIDATES: String(limits.candidates),
    SELF_REMEDIATION_MAX_SECONDS: String(limits.wallMs / 1000), SELF_REMEDIATION_MAX_USD: String(dollars),
  };
  for (const name of ['SELF_REMEDIATION_MODEL', 'SELF_REMEDIATION_MAX_CALL_MICRO_USD', 'SELF_REMEDIATION_GITHUB_MCP_SCHEMA_SHA256', 'GITHUB_REPOSITORY', 'GITHUB_RUN_ID', 'GITHUB_SHA'])
    if (process.env[name]) environment[name] = process.env[name]!;
  if (options.mode === 'live' && (!environment.SELF_REMEDIATION_MODEL || !/^[1-9][0-9]*$/.test(environment.SELF_REMEDIATION_MAX_CALL_MICRO_USD ?? '')))
    throw new Error('Live preparation requires an explicit model and positive per-call cost reservation');
  const credentialNames = ['KUBECONFIG', 'SELF_REMEDIATION_SOURCE_KUBECONFIG', ...(options.mode === 'live' ? ['OPENAI_API_KEY'] : []),
    'SELF_REMEDIATION_GITHUB_READ_TOKEN', ...(config?.publicationMode === 'pull-request' ? ['SELF_REMEDIATION_PUBLISH_TOKEN'] : [])];
  // A fresh directory prevents configuration changes from rebinding retained requests or budgets.
  mkdirSync(directory, { mode: 0o700 });
  const project = join(directory, 'project'); mkdirSync(project, { mode: 0o700 });
  const retainedHost = join(directory, 'mas-host'), retainedServer = join(directory, 'mas-mcp');
  copyFileSync(host, retainedHost); copyFileSync(server, retainedServer); chmodSync(retainedHost, 0o700); chmodSync(retainedServer, 0o700);
  const controller = join(project, 'controller.mjs');
  copyFileSync(options.controlController ?? join(example, 'dist-tools/controller.mjs'), controller);
  copyFileSync(join(example, 'dist-tools/mcp-command.mjs'), join(project, 'command.mjs'));
  const launcher = join(project, 'service.mjs');
  copyFileSync(join(example, 'dist-tools/mcp-service.mjs'), launcher);
  const arguments_ = ['--mode', options.mode, '--case', caseName, '--incident', options.incidentId, '--output', join(directory, 'incident')];
  if (config) { const file = join(project, 'incident.json'); writeFileSync(file, JSON.stringify(config), { mode: 0o400 }); arguments_.push('--config', file); }
  const files: Record<string, string> = {};
  const directories: string[] = [];
  const retain = (file: string) => { files[file] = rawDigest(readFileSync(file)); };
  const tree = (root: string) => {
    directories.push(root);
    for (const file of dependencyFiles(root)) retain(file);
  };
  for (const name of ['project', 'target-app', 'dist-tools']) tree(join(example, name));
  retain(join(example, 'evaluation/requirements.json'));
  for (const file of [host, retainedHost, process.execPath, controller, ...(config ? [join(project, 'incident.json')] : [])]) retain(file);
  if (config?.sourceDirectory) {
    tree(join(config.sourceDirectory, 'src'));
    for (const name of ['config.json', 'package.json']) retain(join(config.sourceDirectory, name));
  }
  const admission: Admission = { version: 'self-healing-mcp/1', profile: options.controlController ? 'boundary-control' : 'k3s',
    incidentId: options.incidentId, directory: join(directory, 'incident'), example, repository, sourceRevision,
    host: retainedHost, gatewayState: join(directory, 'state/runs'), node: process.execPath, controller,
    arguments: arguments_, environment, credentialNames, files, directories, limits, mode: options.mode,
    publication: config?.publicationMode ?? 'archive', requirementsDigest: sha256(config?.requirements ?? JSON.parse(readFileSync(join(example, 'evaluation/requirements.json'), 'utf8'))),
    policyDigest: sha256({ config: config ?? null, mode: options.mode, caseName, limits, environment, credentialNames }) };
  writeFileSync(join(project, 'admission.json'), JSON.stringify(admission), { mode: 0o400 });
  const operations = ['run', 'status', 'cancel'] as const;
  for (const operation of operations) writeFileSync(join(project, `${operation}.json`), JSON.stringify(inputSchema(admission, operation)));
  writeFileSync(join(project, 'output.json'), JSON.stringify(outputSchema));
  const agents = operations.map(operation => ({ name: `healing_${operation}`, operation: `self_healing_${operation}/1`, input_schema: `${operation}.json`, output_schema: 'output.json',
    environment: operation === 'run' ? credentialNames : [], implementation: { kind: 'command', executable: process.execPath,
      arguments: [{ file: 'command.mjs' }, { literal: '--admission' }, { file: 'admission.json' }, { literal: '--operation' }, { literal: operation },
        { literal: '--invocation' }, { invocation_id: true }], stdin: 'json', stdout: 'json-object', success_exit_codes: [0],
      timeout_seconds: operation === 'run' ? limits.wallMs / 1000 + 30 : 20, max_output_bytes: 32768 } }));
  writeFileSync(join(project, 'agents.json'), JSON.stringify({ version: 'mas-agents/3', agents,
    limits: { wall_seconds: limits.wallMs / 1000 + 60, max_calls: 1, max_messages: 8, max_bytes: 131072, mailbox_capacity: 4 } }));
  writeFileSync(join(project, 'topology.json'), JSON.stringify({ version: 'mas-topology/1', edges: operations.flatMap(operation => [['client', `healing_${operation}`], [`healing_${operation}`, 'client']]) }));
  const built = JSON.parse((await execute(retainedHost, ['build', '--project', project, '--sdk-root', sdkRoot], { timeout: 120000, maxBuffer: 1_048_576 })).stdout);
  const serverConfig = join(directory, 'server.json');
  writeFileSync(serverConfig, JSON.stringify({ version: 'mas-mcp/1', host: retainedHost, bundle: built.bundle, state: join(directory, 'state'),
    exports: operations.map(operation => ({ name: `self_healing_${operation}`, agent: `healing_${operation}`, description: {
      run: 'Run the prepared bounded self-healing incident once. request_id must equal the mas_submit request_id. Inspect the controller outcome separately from MCP completion.',
      status: 'Read a bounded page of committed controller progress. Use a fresh MCP request_id for each observation and next_after as the cursor.',
      cancel: 'Persist incident cancellation, including before dispatch. The active controller forwards intent to its host phase. Effects may remain unresolved.',
    }[operation] })), max_active: 4, max_tasks: 2048, allow_payloads: false }, null, 2), { mode: 0o600 });
  const registration = join(directory, 'mcp-client.json');
  const launcherArgs = [launcher, '--admission', join(project, 'admission.json'), '--digest', admissionDigest(admission), '--server', retainedServer, '--config', serverConfig];
  writeFileSync(registration, JSON.stringify({ mcpServers: { 'mas-self-healing': { command: process.execPath, args: launcherArgs } } }, null, 2), { mode: 0o600 });
  const prepared = { server: retainedServer, config: serverConfig, registration, launcherArgs, admission, contract_digest: admissionDigest(admission) };
  writeFileSync(join(directory, 'request.json'), JSON.stringify({ request_id: `${options.incidentId}.repair`, operation: 'self_healing_run',
    descriptor_digest: 'COPY_FROM_MAS_DESCRIBE', input_json: JSON.stringify({ incident_id: admission.incidentId, contract_digest: prepared.contract_digest, request_id: `${options.incidentId}.repair` }) }, null, 2));
  return prepared;
}
