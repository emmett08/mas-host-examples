/** Own a foreground controller until its exit, including bounded cancellation and output failure. */
import { spawn } from 'node:child_process';

export interface ControllerProcess {
  executable: string; arguments: string[]; directory: string; environment: NodeJS.ProcessEnv;
  deadline: number; signal: AbortSignal; onStop: (reason: string) => void;
  maxOutputBytes?: number; terminationGraceMs?: number;
}

export async function runControllerProcess(options: ControllerProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  const maxOutput = options.maxOutputBytes ?? 1_048_576, grace = options.terminationGraceMs ?? 5000;
  if (![options.deadline, maxOutput, grace].every(Number.isSafeInteger) || maxOutput < 1 || grace < 1) throw new Error('Invalid controller process bounds');
  if (options.signal.aborted || Date.now() >= options.deadline) {
    const reason = options.signal.aborted ? 'Controller cancellation requested' : 'Controller deadline reached';
    options.onStop(reason); throw new Error(reason);
  }
  return new Promise((accept, reject) => {
    const child = spawn(options.executable, options.arguments, {
      cwd: options.directory, env: options.environment, stdio: ['ignore', 'pipe', 'pipe'], detached: false,
    });
    let bytes = 0, failure: Error | undefined, stopping = false;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const stop = (reason: string) => {
      if (stopping) return;
      stopping = true; failure ??= new Error(reason);
      try { options.onStop(reason); }
      catch { failure = new Error('Controller stop intent could not be persisted'); }
      child.kill('SIGTERM');
      escalation = setTimeout(() => {
        child.kill('SIGKILL');
        // An inherited descriptor must not keep close pending after the controller
        // is killed. Descendants remain in the outer host's process ownership.
        child.stdout.destroy(); child.stderr.destroy();
      }, grace);
    };
    const cancel = () => stop('Controller cancellation requested');
    const deadline = setTimeout(() => stop('Controller deadline reached'), Math.max(1, options.deadline - Date.now()));
    options.signal.addEventListener('abort', cancel, { once: true });
    const drain = (data: Buffer) => {
      if (stopping) return; // Continue draining without retaining unbounded output.
      bytes += data.length;
      if (bytes > maxOutput) stop('Controller output exceeded bound');
    };
    child.stdout.on('data', drain); child.stderr.on('data', drain);
    child.once('error', error => { failure ??= error; });
    // close follows both process exit and pipe drainage; exit alone can miss final output.
    child.once('close', (code, signal) => {
      clearTimeout(deadline); clearTimeout(escalation);
      options.signal.removeEventListener('abort', cancel);
      if (failure) reject(failure); else accept({ code, signal });
    });
    if (options.signal.aborted) cancel();
  });
}
