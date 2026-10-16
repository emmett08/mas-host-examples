// Execute the pinned host without a shell; observation never receives or acknowledges messages.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { failureMessage, projectFailure, type FailureDiagnostics } from './diagnostics.js';
import { canonicalJson, parseRevisionAudit, redactRevisionAudit, type RevisionAudit } from '../shared/revision.mjs';

export class HostRunFailure extends Error {
  constructor(readonly diagnostics: FailureDiagnostics) {
    super(failureMessage(diagnostics));
    this.name = 'HostRunFailure';
  }
}

const execute = promisify(execFile);
function hostEnvironment() {
  const { DEMO_VERIFIER_TOKEN: _verifierToken, ...environment } = process.env;
  return environment;
}
export interface HostOptions { binary: string; sdk: string; project: string; payloads: boolean; fixtureRecording?: boolean; revisionPlan?: string }
export function fixtureConnectionProfile(mode: 'live' | 'fixture', recording = false) {
  return mode === 'fixture' ? recording ? 'connections.recording.toml' : 'connections.fixture.toml' : undefined;
}
export class Host {
  constructor(readonly options: HostOptions) {}
  async run(id: string, input: string, state: string, mode: 'live' | 'fixture') {
    return (await this.invoke(id, input, state, mode, false)).output as unknown;
  }
  async runAssessed(id: string, input: string, state: string, mode: 'live' | 'fixture'): Promise<{ output: unknown; revision: RevisionAudit }> {
    const result = await this.invoke(id, input, state, mode, true);
    const revision = parseRevisionAudit(result.revision);
    const selected = revision.candidates.find(candidate => candidate.id === revision.selected?.id);
    if (!selected || canonicalJson(selected.output) !== canonicalJson(result.output)) throw new Error('Selected output differs from the assessed candidate');
    return { output: result.output, revision: this.options.payloads ? revision : redactRevisionAudit(revision) };
  }
  private async invoke(id: string, input: string, state: string, mode: 'live' | 'fixture', assessed: boolean) {
    const args = ['run', '--project', this.options.project, '--sdk-root', this.options.sdk,
      '--agent', assessed ? 'assessed_draft' : 'coordinator', '--input', input, '--state', state, '--run', id];
    if (assessed) {
      if (!this.options.revisionPlan) throw new Error('An assessed run requires a frozen revision plan');
      args.push('--revision-plan', this.options.revisionPlan);
    }
    const profile = mode === 'fixture' && assessed
      ? this.options.fixtureRecording ? 'connections.assessment-recording.toml' : 'connections.assessment-fixture.toml'
      : fixtureConnectionProfile(mode, this.options.fixtureRecording);
    if (profile) args.push('--connections', profile);
    // The verifier credential belongs to the HTTP report channel, never to
    // MAS workers or provider adapters. Other credentials keep their scope.
    const environment = hostEnvironment();
    try {
      const { stdout } = await execute(this.options.binary, args,
        { timeout: 330_000, maxBuffer: 2 * 1024 * 1024, env: environment });
      return JSON.parse(stdout) as { output: unknown; revision?: unknown };
    } catch {
      // The CLI has exited. Read its retained effect evidence once, without
      // replaying execution or exposing arbitrary stderr and application output.
      let observation: unknown;
      try {
        const { stdout } = await execute(this.options.binary,
          ['observe', '--state', state, '--run', id, '--include-payloads', 'true'],
          { timeout: 3000, maxBuffer: 4 * 1024 * 1024, env: environment });
        observation = JSON.parse(stdout);
      } catch { /* An absent/corrupt journal preserves the fixed generic error. */ }
      throw new HostRunFailure(projectFailure(observation, id));
    }
  }
  async observe(id: string, state: string) {
    const { stdout } = await execute(this.options.binary,
      ['observe', '--state', state, '--run', id, '--include-payloads', String(this.options.payloads)],
      { timeout: 3000, maxBuffer: 4 * 1024 * 1024, env: hostEnvironment() });
    const raw = JSON.parse(stdout);
    if (raw.version !== 'mas-host-observation/1') throw new Error('Unsupported host observation version');
    if (raw.revision) parseRevisionAudit(raw.revision);
    return { ...raw, messages: raw.messages.map((m: Record<string, unknown>) => ({
      id: m.message_id, sequence: m.sequence, sender: m.sender, recipient: m.recipient,
      kind: String(m.kind).toLowerCase(), correlation: m.reply_to ?? m.task_id,
      taskId: m.task_id, received: m.received, acked: m.acked,
      ...(m.payload === undefined ? {} : { payload: m.payload }),
    })) };
  }
  async cancel(id: string, state: string) {
    await execute(this.options.binary, ['cancel', '--state', state, '--run', id],
      { timeout: 3000, maxBuffer: 65536, env: hostEnvironment() });
  }
}
