import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build as bundle } from 'esbuild';
import { Journal } from '../controller/journal.js';
import { Runtime } from '../controller/runtime.js';
import { materialise } from '../tools/projection.js';
const sdkRoot=resolve(process.env.MAS_SDK_ROOT??'../../.tools/mas-host');
const binary=resolve(process.env.MAS_HOST_BIN??join(sdkRoot,'target/debug/mas-host'));
test('runtime retains actual source native/MCP and delegated MAS phase across controller restart without new reservations',async t=>{
 const root=await mkdtemp(join(tmpdir(),'mas-runtime-'));
 const runtimeBundle=join(root,'broker.mjs');await bundle({entryPoints:['tools/command.ts'],outfile:runtimeBundle,bundle:true,platform:'node',format:'esm',banner:{js:"import {createRequire} from 'node:module';const require=createRequire(import.meta.url);"}});
 const j=new Journal(join(root,'state'),'runtime-case');t.after(async()=>{j.close();await rm(root,{recursive:true,force:true});});
 const experiment={kind:'http',rationale:'Route response discriminates registration',predictions:['Absent routes return 404'],program:'',requests:[{path:'/livez',expectedStatus:200}]};
 const diagnosis={hypotheses:[{id:'h1',mechanism:'Route may be missing',evidence:['baseline'],contradictions:[],predictions:['404'],rank:1}],experiment,unresolvedIntent:[],disposition:'investigate'};
 const settings={journal:j,hostConfiguration:{binary,sdkRoot,stateDir:join(root,'host'),projectTemplate:resolve('project')},mode:'fixture' as const,builderImage:'sha256:'+'a'.repeat(64),runtimeBundle,developmentChecks:[],requirementsHash:'b'.repeat(64),environmentHash:'c'.repeat(64),baseCommit:'d'.repeat(40),current:()=>({baseCommit:'d'.repeat(40),targetRevision:'1'}),fixture:()=>({fixtureOutput:diagnosis,fixturePlanner:experiment})};
 const runtime=new Runtime(settings);const source=await runtime.retainSnapshot(await materialise({'src/server.ts':'console.log(1)'},{repository:'demo/app',revision:'d'.repeat(40),paths:['src/'],mode:'blind'}));
 const input={source:source.files,sourceTree:source.tree,sourceRef:source.ref,evidence:['baseline']};
 const first=await runtime.phase('investigation','runtime-case.investigation',input);assert.deepEqual(first,diagnosis);const usage=j.budget().used;
 // Simulate a crash after the host committed its result but before the application journal retained it.
 j.db.prepare("UPDATE phases SET status='unknown',result=NULL WHERE id=?").run('runtime-case.investigation');
 const restarted=new Runtime(settings);await restarted.recoverPending();const second=await restarted.phase('investigation','runtime-case.investigation',input);assert.deepEqual(second,first);assert.deepEqual(j.budget().used,usage);assert.equal(usage.calls,3);assert.equal(usage.operations,2);
 assert.ok(j.events().some(e=>e.type==='mas.message'&&e.data.from==='investigator'&&e.data.to==='experiment_planner'));
});
