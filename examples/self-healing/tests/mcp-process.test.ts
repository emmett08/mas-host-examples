/** Exercise controller process ownership with actual children that resist graceful shutdown. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { runControllerProcess } from '../mcp/controller-process.js';

test('output overflow is retained as failure and an uncooperative child is stopped before return', async t => {
  const root = mkdtempSync(join(tmpdir(), 'mcp-process-output-')), pidFile = join(root, 'pid');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const reasons: string[] = [];
  await assert.rejects(runControllerProcess({ executable: process.execPath,
    arguments: ['--input-type=module', '-e', `import {writeFileSync} from 'node:fs'; process.on('SIGTERM',()=>{}); writeFileSync(${JSON.stringify(pidFile)},String(process.pid)); process.stdout.write('x'.repeat(65536)); setInterval(()=>{},1000);`],
    directory: root, environment: {}, deadline: Date.now() + 5000, signal: new AbortController().signal,
    onStop: reason => reasons.push(reason), maxOutputBytes: 1024, terminationGraceMs: 30,
  }), /output exceeded/);
  assert.deepEqual(reasons, ['Controller output exceeded bound']);
  assert.throws(() => process.kill(Number(readFileSync(pidFile, 'utf8')), 0), { code: 'ESRCH' });
});

test('cancellation waits for confirmed child exit and preserves stop intent', async t => {
  const root = mkdtempSync(join(tmpdir(), 'mcp-process-cancel-')), pidFile = join(root, 'pid');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const abort = new AbortController(), reasons: string[] = [];
  const running = runControllerProcess({ executable: process.execPath,
    arguments: ['--input-type=module', '-e', `import {writeFileSync} from 'node:fs'; process.on('SIGTERM',()=>{}); writeFileSync(${JSON.stringify(pidFile)},String(process.pid)); setInterval(()=>{},1000);`],
    directory: root, environment: {}, deadline: Date.now() + 5000, signal: abort.signal,
    onStop: reason => reasons.push(reason), terminationGraceMs: 30,
  });
  const rejected = assert.rejects(running, /cancellation requested/);
  for (let i = 0; i < 100 && !existsSync(pidFile); i++) await delay(10);
  assert.ok(existsSync(pidFile)); abort.abort(); await rejected;
  assert.deepEqual(reasons, ['Controller cancellation requested']);
  assert.throws(() => process.kill(Number(readFileSync(pidFile, 'utf8')), 0), { code: 'ESRCH' });
});

test('the original deadline stops a stalled child and final output is included in its bound', async () => {
  const reasons: string[] = [];
  await assert.rejects(runControllerProcess({ executable: process.execPath,
    arguments: ['-e', "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);"], directory: tmpdir(), environment: {},
    deadline: Date.now() + 200, signal: new AbortController().signal, onStop: reason => reasons.push(reason), terminationGraceMs: 30,
  }), /deadline reached/);
  assert.deepEqual(reasons, ['Controller deadline reached']);
  await assert.rejects(runControllerProcess({ executable: process.execPath,
    arguments: ['-e', "process.on('exit',()=>process.stdout.write('x'.repeat(2048)));"], directory: tmpdir(), environment: {},
    deadline: Date.now() + 5000, signal: new AbortController().signal, onStop: () => {}, maxOutputBytes: 1024, terminationGraceMs: 30,
  }), /output exceeded/);
});

test('an inherited descendant pipe cannot keep failed controller shutdown pending', async t => {
  const root = mkdtempSync(join(tmpdir(), 'mcp-process-pipe-')), pidFile = join(root, 'descendant');
  t.after(() => {
    if (existsSync(pidFile)) { try { process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch {} }
    rmSync(root, { recursive: true, force: true });
  });
  const start = Date.now();
  await assert.rejects(runControllerProcess({ executable: process.execPath,
    arguments: ['--input-type=module', '-e', `import {spawn} from 'node:child_process'; import {writeFileSync} from 'node:fs'; process.on('SIGTERM',()=>{}); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','inherit','inherit']}); writeFileSync(${JSON.stringify(pidFile)},String(child.pid)); process.stdout.write('x'.repeat(65536)); setInterval(()=>{},1000);`],
    directory: root, environment: {}, deadline: Date.now() + 5000, signal: new AbortController().signal,
    onStop: () => {}, maxOutputBytes: 1024, terminationGraceMs: 30,
  }), /output exceeded/);
  assert.ok(Date.now() - start < 3000, 'must finish before the unrelated descendant exits');
});
