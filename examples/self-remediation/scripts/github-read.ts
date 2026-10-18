/** The ordinary host command exposes one frozen official GitHub MCP metadata read. */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { OfficialGitHubMcp, type GitHubReadGrant } from '../tools/github-mcp.js';
export async function readOfficial(input:{operationId:string;grant:GitHubReadGrant},invocation:string) {
  if(!invocation) throw new Error('Host invocation required');
  const adapter=new OfficialGitHubMcp(process.env.SELF_REMEDIATION_GITHUB_READ_TOKEN??'',input.grant);
  await adapter.initialise();
  return {operationId:input.operationId,invocation_id:invocation,status:'COMPLETED',result:await adapter.readWorkflowRun()};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const index=process.argv.indexOf('--invocation');
  process.stdout.write(JSON.stringify(await readOfficial(JSON.parse(readFileSync(0,'utf8')),process.argv[index+1]??''))+'\n');
}
