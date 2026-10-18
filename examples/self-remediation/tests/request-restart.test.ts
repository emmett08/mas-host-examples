/** Controller recovery is real; the trusted host transport is an explicit no-effect control. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { chownSync, chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';

for(const kind of ['deployment','external','checkpoint'])test(`${kind} frozen files survive separate-process replay and reject altered bytes`,async t=>{
  const directory=mkdtempSync(join(tmpdir(),`mas-${kind}-request-restart-`));
  try {
    const entry=join(directory,'control.mjs'),root=resolve('.');
    await build({stdin:{contents:`
      import assert from 'node:assert/strict';
      import {readFileSync,writeFileSync,statSync,chmodSync,utimesSync} from 'node:fs';
      import {join} from 'node:path';
      import {Journal} from './controller/journal.ts';
      import {Deployment} from './controller/deployment.ts';
      import {ExternalReads} from './controller/external.ts';
      import {sha256} from './deploy/effects.ts';
      const [directory,kind,step]=process.argv.slice(2),id='retained-'+kind;
      const journal=new Journal(directory,'restart-control');journal.put('attempt','attempt-1');
      const host={binary:'/unused-host',sdkRoot:'/unused-sdk',stateDir:join(directory,'host')};
      const adapter=kind==='deployment'?new Deployment(journal,host,'control',[]):new ExternalReads(journal,host);
      const invoke=()=>kind==='deployment'?adapter.operation(id,{operation:'current',spec:{fixture:true}}):adapter.github(id,{fixture:true});
      const request=kind==='checkpoint'?join(directory,'checkpoints','checkpoint-0.sqlite.json'):join(directory,'contexts',(kind==='deployment'?'trial-':'external-')+sha256(id)+'.json');
      try {
        if(step==='setup'){
          if(kind==='checkpoint')journal.checkpoint();else await assert.rejects(invoke(),/lost transport control/);
          assert.equal(statSync(request).mode&0o777,0o400);
          utimesSync(request,new Date('2020-01-01T00:00:00Z'),new Date('2020-01-01T00:00:00Z'));
          const stat=statSync(request,{bigint:true});
          writeFileSync(join(directory,'expected.json'),JSON.stringify({bytes:readFileSync(request,'utf8'),ino:String(stat.ino),mtime:String(stat.mtimeNs)}));
        }else{
          const expected=JSON.parse(readFileSync(join(directory,'expected.json'),'utf8'));
          const recover=()=>kind==='checkpoint'?Promise.resolve().then(()=>journal.checkpoint()):adapter.recover();
          if(step==='conflict'){
            chmodSync(request,0o600);writeFileSync(request,'changed frozen bytes');chmodSync(request,0o400);
            await assert.rejects(recover(),/Frozen artefact changed/);
            assert.equal(readFileSync(request,'utf8'),'changed frozen bytes');
            if(kind!=='checkpoint')assert.equal(readFileSync(join(directory,'transport.log'),'utf8').trim().split('\\n').length,1,'changed input must not reach host transport');
          }else{
            await recover();
            const stat=statSync(request,{bigint:true});assert.equal(String(stat.ino),expected.ino);assert.equal(String(stat.mtimeNs),expected.mtime);
            assert.equal(readFileSync(request,'utf8'),expected.bytes);assert.equal(stat.mode&0o777n,0o400n);
            if(kind!=='checkpoint')assert.equal(journal.db.prepare('SELECT status FROM phases WHERE id=?').get(id).status,'completed');
          }
        }
      }finally{journal.close();}
    `,resolveDir:root,loader:'ts'},outfile:entry,bundle:true,platform:'node',format:'esm',target:'node24',external:['node:*'],plugins:[{
      name:'explicit-host-transport-control',setup(plugin){
        plugin.onResolve({filter:/host\/tool\.js$/},()=>({path:'host-control',namespace:'control'}));
        plugin.onLoad({filter:/.*/,namespace:'control'},()=>({contents:`
          import {appendFileSync,readFileSync} from 'node:fs';
          import {join} from 'node:path';
          import {HostPhaseError} from ${JSON.stringify(join(root,'host/phase.ts'))};
          export async function runTrustedOperation(_host,id,envelope){
            const request=JSON.parse(readFileSync(envelope.requestFile,'utf8'));
            appendFileSync(join(process.argv[2],'transport.log'),id+'\\n');
            if(process.argv[4]==='setup')throw new HostPhaseError('lost transport control',id,null,true);
            return {receipt:{operationId:request.operationId,invocation_id:'retained-control-invocation',status:'COMPLETED',result:{status:'pass',fixture:true}}};
          }
        `,resolveDir:root,loader:'ts'}));
      }
    }]});
    chmodSync(entry,0o444);
    let asOwner:{uid?:number;gid?:number}={};
    if(process.getuid?.()===0){try{chownSync(directory,65534,65534);asOwner={uid:65534,gid:65534};}catch(error){if(!['EINVAL','EPERM'].includes((error as NodeJS.ErrnoException).code??''))throw error;}}
    if(process.getuid?.()===0&&asOwner.uid===undefined)t.diagnostic('Only UID 0 is mapped; preserved historical timestamps detect rewrites. CI runs the same replay as an ordinary file owner.');
    const execute=(step:string)=>spawnSync(process.execPath,[entry,directory,kind,step],{cwd:directory,encoding:'utf8',timeout:10000,...asOwner});
    for(const step of ['setup','recover']){const result=execute(step);assert.equal(result.status,0,result.stderr);}
    // Recover has completed. Re-arm only the explicit control phase to exercise
    // changed retained request rejection, without dispatching a second real effect.
    if(kind!=='checkpoint'){
      const {DatabaseSync}=await import('node:sqlite');const database=new DatabaseSync(join(directory,'journal.sqlite'));
      database.prepare("UPDATE phases SET status='unknown' WHERE id=?").run('retained-'+kind);database.close();
      // The existing transport log contains one initial dispatch and one replay.
      // Keep the original control count for the conflict assertion.
      const {writeFileSync,readFileSync}=await import('node:fs');const log=join(directory,'transport.log');writeFileSync(log,readFileSync(log,'utf8').split('\n')[0]+'\n');
    }
    const rejected=execute('conflict');assert.equal(rejected.status,0,rejected.stderr);
  }finally{rmSync(directory,{recursive:true,force:true});}
});
