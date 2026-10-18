/** Distinct processes preserve the original bytes, inode, mode and timestamp across restart. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { chownSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
import { spawnSync } from 'node:child_process';

test('publication files survive process restart and conflicting candidate bytes are rejected unchanged',t=>{
  const directory=mkdtempSync(join(tmpdir(),'mas-immutable-publication-'));
  try {
    // Copy the exact production helper outside root-only workspace ancestors.
    const helper=join(directory,'immutable-file.mjs');
    writeFileSync(helper,stripTypeScriptTypes(readFileSync(new URL('../controller/immutable-file.ts',import.meta.url),'utf8')),{mode:0o444});
    let asOwner:{uid?:number;gid?:number}={};
    if(process.getuid?.()===0){
      try {chownSync(directory,65534,65534);asOwner={uid:65534,gid:65534};}
      catch(error){if(!['EINVAL','EPERM'].includes((error as NodeJS.ErrnoException).code??''))throw error;}
    }
    const candidate=JSON.stringify({baseCommit:'a'.repeat(40),sourceTree:'b'.repeat(64),files:{'src/app.ts':'export const value = 1;'}});
    const execute=(bytes:string,ordinaryWrite=false)=>spawnSync(process.execPath,['--input-type=module','-e',`
      import {writeFileSync} from 'node:fs';
      import {writeImmutableFile} from ${JSON.stringify(pathToFileURL(helper).href)};
      const directory=process.argv[1], bytes=process.argv[2];
      if (${ordinaryWrite}) writeFileSync(directory+'/candidate-source.json',bytes,{mode:0o400});
      else {
        writeImmutableFile(directory+'/publication-manifest.json','{"operationId":"publication-control"}',0o600);
        writeImmutableFile(directory+'/candidate-source.json',bytes);
      }
    `,directory,bytes],{cwd:directory,encoding:'utf8',timeout:5000,...asOwner});
    const first=execute(candidate);assert.equal(first.status,0,first.stderr);
    const path=join(directory,'candidate-source.json');
    assert.equal(statSync(path).mode&0o777,0o400);
    const oldBehavior=execute(candidate,true);
    if(process.getuid?.()!==0||asOwner.uid!==undefined){assert.notEqual(oldBehavior.status,0);assert.match(oldBehavior.stderr,/EACCES/);}
    else t.diagnostic('Only UID 0 is mapped here; timestamp preservation still detects reopening/truncating an existing file. Ordinary CI users additionally verify EACCES.');
    utimesSync(path,new Date('2020-01-01T00:00:00Z'),new Date('2020-01-01T00:00:00Z'));
    const before=statSync(path,{bigint:true});
    const resumed=execute(candidate);assert.equal(resumed.status,0,resumed.stderr);
    const after=statSync(path,{bigint:true});assert.equal(after.ino,before.ino);assert.equal(after.mtimeNs,before.mtimeNs);assert.equal(after.mode,before.mode);
    const changed=execute(candidate.replace('value = 1','value = 2'));assert.notEqual(changed.status,0);assert.match(changed.stderr,/Frozen publication artefact changed/);
    assert.equal(readFileSync(path,'utf8'),candidate);assert.equal(statSync(path,{bigint:true}).mtimeNs,before.mtimeNs);
  } finally {rmSync(directory,{recursive:true,force:true});}
});
