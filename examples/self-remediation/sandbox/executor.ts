import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { sha256, verifySnapshot, type Snapshot } from '../tools/projection.js';
export type Status = 'passed' | 'failed' | 'inconclusive';
export type Measurement = { criterion: string; status: Status; expected?: unknown; actual?: unknown; detail?: string };
export type BuildIdentity = { baseCommit: string; candidateTree?: string; requirements: string; tests: string; environment: string; operationId?: string };
export type BuildResult = { status: Status; imageDigest?: string; imageRef?: string; measurements: Measurement[]; identity: BuildIdentity; tree: string; toolchain: string; durationMs: number };
export type HTTPCheck = { id: string; method: string; path: string; body?: unknown; status: number; json?: unknown };
export type Evaluation = { status: Status; measurements: Measurement[]; imageDigest: string; durationMs: number; suite: string; environment: string };
export class UnknownExecution extends Error { readonly operationStatus = 'UNKNOWN'; }
export type CommandResult = { code: number; stdout: string; stderr: string };
export async function execute(executable: string, argv: string[], input?: Buffer, timeoutMs = 60000, outputLimit = 262144): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, argv, { env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/nonexistent', LANG: 'C.UTF-8' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', bytes = 0, uncertain = false;
    const fail = (message: string) => { uncertain = true; child.kill('SIGKILL'); reject(new UnknownExecution(message)); };
    const timer = setTimeout(() => fail('Tool transport deadline exceeded; reconcile container before repeating'), timeoutMs);
    child.on('error', error => { clearTimeout(timer); reject(new UnknownExecution(`Tool launch unavailable: ${error.message}`)); });
    for (const [stream, kind] of [[child.stdout, 'out'], [child.stderr, 'err']] as const) stream.on('data', (chunk: Buffer) => {
      bytes += chunk.length; if (bytes > outputLimit) fail('Tool output bound exceeded; execution outcome requires reconciliation');
      else if (kind === 'out') stdout += chunk.toString(); else stderr += chunk.toString();
    });
    child.on('close', code => { clearTimeout(timer); if (!uncertain) code === null ? reject(new UnknownExecution('Tool terminated without established exit outcome')) : resolve({ code, stdout, stderr }); });
    child.stdin.on('error', () => {}); child.stdin.end(input);
  });
}
function archive(files: Record<string, string>): Buffer {
  const blocks: Buffer[] = [];
  function member(path: string, content: Buffer, directory = false) {
    const header = Buffer.alloc(512);
    if (Buffer.byteLength(path) > 99) throw new Error('Source path exceeds portable archive limit');
    header.write(path); header.write(directory ? '0000500\0' : '0000400\0', 100); header.write('0023421\0', 108); header.write('0023421\0', 116);
    header.write(content.length.toString(8).padStart(11, '0') + '\0', 124); header.write('00000000000\0', 136);
    header.fill(32, 148, 156); header.write(directory ? '5' : '0', 156); header.write('ustar\0', 257); header.write('00', 263);
    const sum = [...header].reduce((a, b) => a + b, 0); header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(header, content, Buffer.alloc((512 - content.length % 512) % 512));
  }
  const directories = new Set<string>();
  for (const path of Object.keys(files)) { const segments = path.split('/'); for (let i = 1; i < segments.length; i++) directories.add(segments.slice(0,i).join('/') + '/'); }
  for (const directory of [...directories].sort()) member(directory, Buffer.alloc(0), true);
  for (const [path, text] of Object.entries(files).sort()) member(path, Buffer.from(text));
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}
const constraints = ['--log-driver=none', '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=64', '--memory=256m', '--memory-swap=256m', '--cpus=1', '--ulimit=nofile=128:128', '--user=10001:10001', '--tmpfs=/tmp:rw,noexec,nosuid,size=16m', '--workdir=/app'];
export const executionWatchdog = ['/usr/bin/timeout', '--signal=TERM', '--kill-after=2s', '45s'];
const compiler = `const fs=require('node:fs'),cp=require('node:child_process'); function check(p){for(const e of fs.readdirSync(p,{withFileTypes:true})){const f=p+'/'+e.name;if(e.isDirectory())check(f);else if(f.endsWith('.ts'))cp.execFileSync(process.execPath,['--check',f],{stdio:'inherit'});}} check('/app/src');const c=JSON.parse(fs.readFileSync('/app/config.json'));if(!Number.isInteger(c.port)||c.port<1024||c.port>65535)throw Error('invalid application port');`;
const requestProgram = `const http=require('node:http'),q=JSON.parse(process.argv[1]);const r=http.request({host:'127.0.0.1',port:8080,path:q.path,method:q.method,headers:{'content-type':'application/json'},timeout:2000},res=>{let b='';res.on('data',x=>{b+=x;if(b.length>32768){r.destroy();process.exitCode=3;}});res.on('end',()=>{let json;try{json=JSON.parse(b)}catch{};console.log(JSON.stringify({status:res.statusCode,json,body:b.slice(0,8192)}));});});r.on('timeout',()=>r.destroy(Error('request timeout')));r.on('error',()=>{console.log(JSON.stringify({error:'request unavailable'}));process.exitCode=2;});if(q.body!==undefined)r.write(JSON.stringify(q.body));r.end();`;
/** Trusted probe joins only networking. Candidate PID and filesystem namespaces remain private. */
export function protectedProbeArguments(name: string, target: string, image: string, check: Pick<HTTPCheck,'method'|'path'|'body'>, operation: string): string[] {
  if(!/^mas-probe-[a-f0-9-]{36}$/.test(name)||!/^mas-evaluate-[a-f0-9-]{36}$/.test(target)||!/^sha256:[a-f0-9]{64}$/.test(image))throw new Error('Probe target and trusted image must be exact bounded identities');
  return ['create','--name',name,...constraints.filter(value=>value!=='--network=none'),`--network=container:${target}`,'--label',`mas.operation=${operation}`,'--entrypoint','/usr/bin/timeout',image,'--signal=TERM','--kill-after=1s','4s','node','-e',requestProgram,JSON.stringify({method:check.method,path:check.path,body:check.body})];
}
export function contains(actual: unknown, expected: unknown): boolean {
  if (expected && typeof expected === 'object') return !!actual && typeof actual === 'object' && Object.entries(expected).every(([k, v]) => contains((actual as Record<string, unknown>)[k], v));
  return Object.is(actual, expected);
}
export class DockerSandbox {
  constructor(readonly builderImage: string, readonly timeoutMs = 60000) {
    if (!/^sha256:[0-9a-f]{64}$/.test(builderImage)) throw new Error('Sandbox toolchain must be an immutable local image ID');
  }
  async command(args: string[], input?: Buffer, timeout = this.timeoutMs) { return execute('docker', args, input, timeout); }
  async require(args: string[], input?: Buffer) {
    const result = await this.command(args, input); if (result.code !== 0) throw new UnknownExecution(`Docker control operation failed: ${args[0]}`); return result.stdout.trim();
  }
  private async stage(files: Record<string,string>, tree: string, operation: string): Promise<string> {
    const name=`mas-stage-${randomUUID()}`;
    // Docker refuses cp into a read-only rootfs. This writable staging container
    // is NEVER started: the trusted daemon copies bytes, commits, and removes it.
    // Every process which can execute candidate bytes starts in a separate read-only container.
    await this.require(['create','--name',name,...constraints.filter(value=>value!=='--read-only'),'--label',`mas.operation=${operation}`,'--label',`mas.tree=${tree}`,'--entrypoint','/bin/false',this.builderImage]);
    try {
      await this.require(['cp','-a','-',`${name}:/app`],archive(files));
      const image=await this.require(['commit','--change','ENTRYPOINT []','--change','CMD ["node","--experimental-strip-types","src/server.ts"]',name]);
      if(!/^sha256:[0-9a-f]{64}$/.test(image))throw new UnknownExecution('Staged immutable image identity unavailable');
      return image;
    } finally {await this.require(['rm','-f',name]);}
  }
  async build(snapshot: Snapshot, identity: BuildIdentity): Promise<BuildResult> {
    await verifySnapshot(snapshot);
    if (identity.candidateTree && identity.candidateTree !== snapshot.tree) throw new Error('Candidate identity mismatch');
    const started = Date.now(), name = `mas-build-${randomUUID()}`;
    const bound = { ...identity, candidateTree: snapshot.tree };
    const result = (status: Status, measurements: Measurement[], image?: string): BuildResult => ({ status, measurements, imageDigest: image, imageRef: image, identity: bound, tree: snapshot.tree, toolchain: this.builderImage, durationMs: Date.now() - started });
    const image=await this.stage(snapshot.files,snapshot.tree,identity.operationId??name);
    await this.require(['create', '--name', name, ...constraints, '--label', `mas.operation=${identity.operationId ?? name}`, '--entrypoint', executionWatchdog[0]!, image, ...executionWatchdog.slice(1), 'node', '-e', compiler]);
    try {
      const compile = await this.command(['start', '-a', name]);
      // docker start -a's actual application exit code is an observed failing check.
      const state = JSON.parse(await this.require(['inspect', '--format', '{{json .State}}', name]));
      if (state.Running || state.Status !== 'exited' || typeof state.ExitCode !== 'number') throw new UnknownExecution('Build termination is unestablished');
      if (state.ExitCode !== 0) return result('failed', [{ criterion: 'build', status: 'failed', detail: compile.stderr.slice(0,8192), actual: state.ExitCode }]);
      return result('passed', [{ criterion: 'build', status: 'passed', detail: 'Node TypeScript syntax compilation and runtime configuration parsing' }], image);
    } finally { await this.require(['rm', '-f', name]); }
  }
  private async probe(target: string, check: Pick<HTTPCheck,'method'|'path'|'body'>, operation: string): Promise<CommandResult> {
    const name=`mas-probe-${randomUUID()}`;
    await this.require(protectedProbeArguments(name,target,this.builderImage,check,operation));
    try {
      const observed=await this.command(['start','-a',name],undefined,6000);
      const state=JSON.parse(await this.require(['inspect','--format','{{json .State}}',name]));
      if(state.Running||state.Status!=='exited'||typeof state.ExitCode!=='number')throw new UnknownExecution('Protected probe termination is unestablished');
      return {...observed,code:state.ExitCode};
    } finally {await this.require(['rm','-f',name]);}
  }
  async evaluate(build: BuildResult, checks: HTTPCheck[], operationId?: string): Promise<Evaluation> {
    if (build.status !== 'passed' || !build.imageDigest) throw new Error('Evaluation requires a built immutable image');
    const started = Date.now(), name = `mas-evaluate-${randomUUID()}`;
    await this.require(['run', '-d', '--name', name, ...constraints, '--label', `mas.tree=${build.tree}`, '--label', `mas.operation=${operationId ?? name}`, '--entrypoint', executionWatchdog[0]!, build.imageDigest, '--signal=TERM', '--kill-after=2s', '55s', 'node', '--experimental-strip-types', 'src/server.ts']);
    const measurements: Measurement[] = [];
    try {
      // Startup is a readiness observation, never a passing acceptance criterion.
      for (let attempt = 0; attempt < 3; attempt++) {
        const probe = await this.probe(name, {method:'GET',path:'/catalogue'}, operationId??name);
        if (probe.code === 0) break;
        await delay(100);
      }
      for (const check of checks) {
        const observed = await this.probe(name, check, operationId??name);
        if (observed.code !== 0) measurements.push({ criterion: check.id, status: 'failed', detail: 'Application request did not complete', actual: observed.stdout.slice(0,8192) });
        else {
          let actual: any;
          try { actual = JSON.parse(observed.stdout); } catch { throw new UnknownExecution('Invalid trusted HTTP probe result'); }
          const passed = actual.status === check.status && (check.json === undefined || contains(actual.json, check.json));
          measurements.push({ criterion: check.id, status: passed ? 'passed' : 'failed', expected: { status: check.status, json: check.json }, actual });
        }
      }
      return { status: measurements.every(x => x.status === 'passed') ? 'passed' : 'failed', measurements, imageDigest: build.imageDigest, suite: sha256(JSON.stringify(checks)), environment: build.identity.environment, durationMs: Date.now() - started };
    } finally { await this.require(['rm', '-f', name]); }
  }
  async experiment(snapshot: Snapshot, program: string, operationId?: string): Promise<{ status: Status; stdout: string; stderr: string; exitCode: number }> {
    if (Buffer.byteLength(program) > 16384) throw new Error('Diagnostic program exceeds bound');
    await verifySnapshot(snapshot);
    const name = `mas-experiment-${randomUUID()}`;
    const image=await this.stage({...snapshot.files,'diagnostic.ts':program},snapshot.tree,operationId??name);
    await this.require(['create', '--name', name, ...constraints, '--label', `mas.operation=${operationId ?? name}`, '--label', `mas.tree=${snapshot.tree}`, '--entrypoint', executionWatchdog[0]!, image, ...executionWatchdog.slice(1), 'node', '--experimental-strip-types', '/app/diagnostic.ts']);
    try {
      const observed = await this.command(['start', '-a', name]);
      const state = JSON.parse(await this.require(['inspect', '--format', '{{json .State}}', name]));
      if (state.Running || state.Status !== 'exited' || typeof state.ExitCode !== 'number') throw new UnknownExecution('Diagnostic termination unestablished');
      return { status: state.ExitCode === 0 ? 'passed' : 'failed', stdout: observed.stdout, stderr: observed.stderr, exitCode: state.ExitCode };
    } finally { await this.require(['rm', '-f', name]); }
  }
}
export const sandboxConstraints = constraints;
