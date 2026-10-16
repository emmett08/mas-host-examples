// Execute the pinned host without a shell; observation never receives or acknowledges messages.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { failureMessage, projectFailure, type FailureDiagnostics } from './diagnostics.js';

export class HostRunFailure extends Error {
  constructor(readonly diagnostics: FailureDiagnostics) {
    super(failureMessage(diagnostics));
    this.name = 'HostRunFailure';
  }
}

const execute = promisify(execFile);
export interface HostOptions { binary: string; sdk: string; project: string; payloads: boolean; fixtureRecording?: boolean }
export function fixtureConnectionProfile(mode: 'live' | 'fixture', recording = false) {
  return mode === 'fixture' ? recording ? 'connections.recording.toml' : 'connections.fixture.toml' : undefined;
}
export class Host {
  constructor(readonly options: HostOptions) {}
  async run(id: string, input: string, state: string, mode: 'live' | 'fixture') {
    const args = ['run', '--project', this.options.project, '--sdk-root', this.options.sdk,
      '--agent', 'coordinator', '--input', input, '--state', state, '--run', id];
    const profile = fixtureConnectionProfile(mode, this.options.fixtureRecording);
    if (profile) args.push('--connections', profile);
    try {
      const { stdout } = await execute(this.options.binary, args,
        { timeout: 330_000, maxBuffer: 2 * 1024 * 1024 });
      return JSON.parse(stdout).output as unknown;
    } catch {
      // The CLI has exited. Read its retained effect evidence once, without
      // replaying execution or exposing arbitrary stderr and application output.
      let observation: unknown;
      try {
        const { stdout } = await execute(this.options.binary,
          ['observe', '--state', state, '--run', id, '--include-payloads', 'true'],
          { timeout: 3000, maxBuffer: 4 * 1024 * 1024 });
        observation = JSON.parse(stdout);
      } catch { /* An absent/corrupt journal preserves the fixed generic error. */ }
      throw new HostRunFailure(projectFailure(observation, id));
    }
  }
  async observe(id: string, state: string) {
    const { stdout } = await execute(this.options.binary,
      ['observe', '--state', state, '--run', id, '--include-payloads', String(this.options.payloads)],
      { timeout: 3000, maxBuffer: 4 * 1024 * 1024 });
    const raw = JSON.parse(stdout);
    if (raw.version !== 'mas-host-observation/1') throw new Error('Unsupported host observation version');
    return { ...raw, messages: raw.messages.map((m: Record<string, unknown>) => ({
      id: m.message_id, sequence: m.sequence, sender: m.sender, recipient: m.recipient,
      kind: String(m.kind).toLowerCase(), correlation: m.reply_to ?? m.task_id,
      taskId: m.task_id, received: m.received, acked: m.acked,
      ...(m.payload === undefined ? {} : { payload: m.payload }),
    })) };
  }
  async cancel(id: string, state: string) {
    await execute(this.options.binary, ['cancel', '--state', state, '--run', id],
      { timeout: 3000, maxBuffer: 65536 });
  }
}
