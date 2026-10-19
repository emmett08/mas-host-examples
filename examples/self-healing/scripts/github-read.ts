/** The ordinary host command exposes one frozen official GitHub MCP metadata read. */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { OfficialGitHubMcp, type GitHubReadGrant } from '../tools/github-mcp.js';
import { sha256 } from '../deploy/effects.js';
interface GitHubReadRequest { operationId: string; grant: GitHubReadGrant }
export async function readOfficial(input:GitHubReadRequest,invocation:string) {
  if(!invocation) throw new Error('Host invocation required');
  if(typeof input?.operationId!=='string'||!input.operationId||!input.grant||typeof input.grant!=='object') throw new Error('Frozen GitHub metadata request required');
  const adapter=new OfficialGitHubMcp(process.env.SELF_REMEDIATION_GITHUB_READ_TOKEN??'',input.grant);
  await adapter.initialise();
  return {operationId:input.operationId,invocation_id:invocation,status:'COMPLETED',result:await adapter.readWorkflowRun()};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const index=process.argv.indexOf('--invocation');
  const invocation=index>=0?process.argv[index+1]:undefined;
  if(!invocation) throw new Error('--invocation must be supplied by the maintained host adapter');
  const envelope=JSON.parse(readFileSync(0,'utf8')) as GitHubReadRequest&{requestFile?:string;requestSha256?:string};
  const input=envelope.requestFile?JSON.parse(readFileSync(envelope.requestFile,'utf8')) as GitHubReadRequest:envelope;
  if(envelope.requestFile&&(sha256(input)!==envelope.requestSha256||input.operationId!==envelope.operationId)) throw new Error('Retained GitHub metadata request changed');
  process.stdout.write(JSON.stringify(await readOfficial(input,invocation))+'\n');
}
