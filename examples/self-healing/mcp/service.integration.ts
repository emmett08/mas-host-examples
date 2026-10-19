/** Official JavaScript MCP client -> real Rust gateway -> real host -> bounded controller controls. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'esbuild';
import { prepare } from './prepare.js';
import { call, completed, connect, input, observeIncident } from './client.js';

async function fixture(t: any, mode: 'finish' | 'wait' | 'interrupt') {
  const root = mkdtempSync(join(tmpdir(), 'healing-mcp-host-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const controller = join(root, 'control.mjs');
  await build({ entryPoints: ['tests/fixtures/mcp-controller.ts'], outfile: controller, bundle: true, platform: 'node', format: 'esm',
    define: { MCP_CONTROL_MODE: JSON.stringify(mode) } });
  const previous = process.env.MAS_SANDBOX_IMAGE; process.env.MAS_SANDBOX_IMAGE = 'sha256:' + 'a'.repeat(64);
  try {
    return await prepare({ directory: join(root, 'service'), example: process.cwd(), incidentId: `mcp-${mode}`, mode: 'fixture', controlController: controller,
      host: resolve(process.env.MAS_HOST_BIN ?? '../../.tools/mas-host/target/debug/mas-host'), sdkRoot: resolve(process.env.MAS_SDK_ROOT ?? '../../.tools/mas-host'),
      server: resolve(process.env.MAS_MCP_BIN ?? '../../.tools/mas-mcp/target/release/mas-mcp') });
  } finally { if (previous === undefined) delete process.env.MAS_SANDBOX_IMAGE; else process.env.MAS_SANDBOX_IMAGE = previous; }
}

test('official client preserves request identity, rejection gates and completed replay across restart', { timeout: 120000 }, async t => {
  const prepared = await fixture(t, 'finish'); let session = await connect(prepared);
  try {
    const descriptor = await call(session.client, 'mas_describe');
    assert.deepEqual(descriptor.operations.map((o: any) => o.name), ['self_healing_run', 'self_healing_status', 'self_healing_cancel']);
    const request = { request_id: 'repair-1', operation: 'self_healing_run', descriptor_digest: descriptor.descriptor_digest,
      input_json: JSON.stringify({ ...input(prepared), request_id: 'repair-1' }) };
    const first = await call(session.client, 'mas_submit', request);
    assert.equal((await call(session.client, 'mas_submit', request)).task_id, first.task_id);
    const done = await completed(session.client, first);
    const view = JSON.parse(JSON.parse(done.output_json).snapshot_json);
    assert.equal(view.profile, 'boundary-control'); assert.equal(view.outcome, 'no_eligible_candidate');
    assert.equal(view.dispatch.requestId, 'repair-1');
    assert.equal((await session.client.callTool({ name: 'mas_submit', arguments: { ...request, input_json: JSON.stringify({ ...input(prepared), request_id: 'changed' }) } })).isError, true);
    assert.equal((await session.client.callTool({ name: 'mas_submit', arguments: { ...request, request_id: 'stale', descriptor_digest: '0'.repeat(64) } })).isError, true);
    const replacement = await completed(session.client, await call(session.client, 'mas_submit', { ...request, request_id: 'replacement', input_json: JSON.stringify({ ...input(prepared), request_id: 'replacement' }) }));
    const duplicate = JSON.parse(JSON.parse(replacement.output_json).snapshot_json);
    assert.deepEqual(duplicate.dispatch, view.dispatch); assert.deepEqual(duplicate.budget, view.budget);
    const observed = JSON.parse((await call(session.client, 'mas_observe', { task_id: first.task_id })).observation_json);
    assert.ok(observed.steps.some((step: any) => step.id === view.dispatch.invocationId && step.kind === 'effect'));
    await session.client.close(); session = await connect(prepared);
    assert.deepEqual(await call(session.client, 'mas_submit', request), done);
    const current = await observeIncident(session.client, prepared, descriptor.descriptor_digest);
    assert.equal(current.outcome, 'no_eligible_candidate'); assert.deepEqual(current.budget, view.budget);
  } finally { await session.client.close(); }
});

test('abrupt gateway loss preserves uncertainty and domain cancellation reaches the original active phase', { timeout: 120000 }, async t => {
  const prepared = await fixture(t, 'wait'); let session = await connect(prepared, true);
  try {
    const descriptor = await call(session.client, 'mas_describe');
    const request = { request_id: 'active-repair', operation: 'self_healing_run', descriptor_digest: descriptor.descriptor_digest,
      input_json: JSON.stringify({ ...input(prepared), request_id: 'active-repair' }) };
    await call(session.client, 'mas_submit', request);
    let view: any;
    for (let i = 0; i < 30; i++) {
      view = await observeIncident(session.client, prepared, descriptor.descriptor_digest);
      if (view.events.some((event: any) => event.type === 'phase.started')) break;
      await delay(100);
    }
    assert.ok(view.events.some((event: any) => event.type === 'phase.started'), JSON.stringify(view));
    const budget = view.budget, dispatch = view.dispatch;
    process.kill(session.transport.pid!, 'SIGKILL'); await session.client.close();
    session = await connect(prepared, true);
    assert.equal((await call(session.client, 'mas_submit', request)).state, 'unknown');
    const cancellation = await completed(session.client, await call(session.client, 'mas_submit', {
      request_id: 'cancel-incident', operation: 'self_healing_cancel', descriptor_digest: descriptor.descriptor_digest, input_json: JSON.stringify(input(prepared)),
    }));
    assert.equal(JSON.parse(JSON.parse(cancellation.output_json).snapshot_json).cancellation_requested, true);
    for (let i = 0; i < 30; i++) {
      view = await observeIncident(session.client, prepared, descriptor.descriptor_digest);
      if (view.outcome === 'cancelled') break;
      await delay(100);
    }
    assert.equal(view.outcome, 'cancelled'); assert.deepEqual(view.budget, budget); assert.deepEqual(view.dispatch, dispatch);
    assert.equal((await call(session.client, 'mas_status', { task_id: request.request_id })).state, 'unknown');
  } finally { await session.client.close(); }
});

test('lost controller outcome cannot be converted into replacement execution', { timeout: 120000 }, async t => {
  const prepared = await fixture(t, 'interrupt'), { client } = await connect(prepared);
  try {
    const descriptor = await call(client, 'mas_describe');
    const submission = (id: string) => ({ request_id: id, operation: 'self_healing_run', descriptor_digest: descriptor.descriptor_digest, input_json: JSON.stringify({ ...input(prepared), request_id: id }) });
    const first = await completed(client, await call(client, 'mas_submit', submission('lost')));
    const before = JSON.parse(JSON.parse(first.output_json).snapshot_json);
    assert.equal(before.controller_state, 'dispatched'); assert.equal(before.outcome, null);
    const next = await completed(client, await call(client, 'mas_submit', submission('replacement')));
    const after = JSON.parse(JSON.parse(next.output_json).snapshot_json);
    assert.deepEqual(after.dispatch, before.dispatch); assert.deepEqual(after.budget, before.budget);
  } finally { await client.close(); }
});

test('standard mas_cancel persists the original controller cancellation through the service supervisor', { timeout: 120000 }, async t => {
  const prepared = await fixture(t, 'wait'), { client } = await connect(prepared);
  try {
    const descriptor = await call(client, 'mas_describe');
    await call(client, 'mas_submit', { request_id: 'cancel-through-gateway', operation: 'self_healing_run', descriptor_digest: descriptor.descriptor_digest,
      input_json: JSON.stringify({ ...input(prepared), request_id: 'cancel-through-gateway' }) });
    let view: any;
    for (let i = 0; i < 30; i++) {
      view = await observeIncident(client, prepared, descriptor.descriptor_digest);
      if (view.events.some((event: any) => event.type === 'phase.started')) break;
      await delay(100);
    }
    assert.ok(view.events.some((event: any) => event.type === 'phase.started'));
    const original = view.dispatch, budget = view.budget;
    await call(client, 'mas_cancel', { task_id: 'cancel-through-gateway' });
    for (let i = 0; i < 30; i++) {
      view = await observeIncident(client, prepared, descriptor.descriptor_digest);
      if (view.cancellation_requested) break;
      await delay(100);
    }
    assert.equal(view.cancellation_requested, true); assert.deepEqual(view.dispatch, original); assert.deepEqual(view.budget, budget);
    const replacement = await completed(client, await call(client, 'mas_submit', { request_id: 'after-cancel', operation: 'self_healing_run', descriptor_digest: descriptor.descriptor_digest,
      input_json: JSON.stringify({ ...input(prepared), request_id: 'after-cancel' }) }));
    assert.deepEqual(JSON.parse(JSON.parse(replacement.output_json).snapshot_json).dispatch, original);
  } finally { await client.close(); }
});
