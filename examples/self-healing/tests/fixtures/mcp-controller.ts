/** Scripted boundary control using the real controller and journal; no sandbox or Kubernetes measurements. */
import { parseArgs } from 'node:util';
import { Journal, Boundary } from '../../controller/journal.js';
import { watchCancellation } from '../../controller/cancellation.js';
import { Controller, type LoopPorts, type Incident } from '../../controller/loop.js';
import { sha256 } from '../../deploy/effects.js';
declare const MCP_CONTROL_MODE: 'finish' | 'wait' | 'interrupt';
const { values } = parseArgs({ options: { mode: { type: 'string' }, case: { type: 'string' }, incident: { type: 'string' }, output: { type: 'string' } } });
const journal = new Journal(values.output!, values.incident!);
const abort = new AbortController(), stop = watchCancellation(journal, abort);
const source = { tree: sha256('original'), files: { 'src/app.ts': 'original' }, ref: 'sha256:' + sha256('original') };
const incident: Incident = { id: values.incident!, mode: 'fixture', baseCommit: 'a'.repeat(40), targetRevision: 'rv-1', source,
  requirements: { required: 'Scripted control measurement must pass.' }, requirementsHash: 'requirements', testsHash: 'tests', environmentHash: 'environment', configurationHash: 'configuration',
  policy: { mode: 'archive', repository: 'fixture/control', baseRef: 'demo/incidents/control', disposable: true,
    mandatoryCriteria: ['required'], evaluator: 'scripted-boundary-control', allowedCapabilities: [], allowedResources: [] }, trigger: {}, unresolvedIntent: [] };
const ports: LoopPorts = {
  async current() { return { baseCommit: incident.baseCommit, targetRevision: incident.targetRevision }; },
  async build(source) { return { source, imageDigest: 'sha256:' + sha256(source.tree), evidence: 'control-build', status: 'passed' }; },
  async check() { return { authority: 'independent', tests: 'tests', environment: 'environment', evidence: 'control-check', changedCapabilities: [], changedResources: [],
    criteria: [{ id: 'required', mandatory: true, status: 'failed', evidence: ['control-failure'] }] }; },
  async phase<T>(kind: string, id: string, input: Record<string, unknown>): Promise<T> {
    journal.admitPhase(id, input, { calls: 1 });
    if (MCP_CONTROL_MODE === 'interrupt') process.exit(4);
    if (MCP_CONTROL_MODE === 'wait') {
      await new Promise<void>((_, reject) => {
        const cancel = () => reject(new Boundary('cancelled'));
        if (abort.signal.aborted) cancel(); else abort.signal.addEventListener('abort', cancel, { once: true });
      });
    }
    const result = kind === 'investigation' ? { hypotheses: [], disposition: 'investigate', unresolvedIntent: [], experiment: { kind: 'http', rationale: 'control', predictions: [] } }
      : { edits: [{ path: 'src/app.ts', content: id }], rationale: 'control', changedCapabilities: [], changedResources: [] };
    journal.finishPhase(id, 'completed', result); return result as T;
  },
  async experiment() { return { measurement: 'failed', evidence: 'scripted-control' }; },
  async edit(_base, changes) { return { tree: sha256(changes), files: { 'src/app.ts': changes.edits[0]!.content! }, ref: 'sha256:' + sha256(changes) }; },
  async trial() { throw new Error('A failing mandatory measurement must block trial'); },
  async publish() { throw new Error('A failing mandatory measurement must block publication'); },
};
try { await new Controller(journal, ports).run(incident); }
catch (error) { journal.append('outcome', { outcome: error instanceof Boundary ? error.outcome : 'unknown_effect' }); }
finally { stop(); journal.close(); }
