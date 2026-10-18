import { cpSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Names mirror integration.ts and the workflow uploads; GitHub assigns numeric artefact IDs later. */
export function runManifest(env = process.env) {
  const fields = [env.GITHUB_REPOSITORY, env.GITHUB_SHA, env.GITHUB_RUN_ID, env.GITHUB_RUN_ATTEMPT];
  if (fields.every(value => !value)) return null;
  const [repository, sha, runId, runAttempt] = fields;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '') || !/^[a-f0-9]{40}$/.test(sha ?? '')
    || !/^[1-9][0-9]*$/.test(runId ?? '') || !/^[1-9][0-9]*$/.test(runAttempt ?? '')) {
    throw new Error('Observer packaging needs exact repository, workflow SHA, run ID and attempt together');
  }
  const live = env.SELF_REMEDIATION_OBSERVER_LIVE === 'true';
  const selectedCase = env.SELF_REMEDIATION_OBSERVER_CASE || 'missing-route';
  const cases = ['missing-route', 'business-logic', 'runtime-config', 'held-out-combination', 'unavailable-dependency', 'ambiguous-requirement', 'no-defect', 'verification-bypass'];
  if (!cases.includes(selectedCase)) throw new Error('Unknown observer case');
  const entry = (mode, name) => ({ incidentId: `${runId}-${runAttempt}-${name}`, artifactName: `self-remediation-${mode}-${runId}-${runAttempt}` });
  return { schema: 'self-remediation-observer-run/1', repository, sha, runId, runAttempt,
    defaultMode: live ? 'live' : 'fixture',
    cases: { fixture: entry('fixture', 'missing-route'), ...(live ? { live: entry('live', selectedCase) } : {}) } };
}

function command(entry) {
  return `#!/bin/bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
# Finder can have a minimal PATH. Try the selected Node first, then Homebrew Node 24.
for candidate in "$(command -v node || true)" /opt/homebrew/opt/node@24/bin/node /usr/local/opt/node@24/bin/node; do
  if [[ -n "$candidate" && -x "$candidate" ]] && "$candidate" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>24 || (a===24 && b>=19) ? 0 : 1)' >/dev/null 2>&1; then
    export PATH="$(dirname -- "$candidate"):/opt/homebrew/bin:/usr/local/bin:$PATH"
    exec "$candidate" ${entry} "$@"
  fi
done
printf '%s\n' 'A working Node 24.19.0 or later is required. Install/select node@24, then rerun this script.' >&2
exit 1
`;
}

export function buildObserver(target = resolve(root, 'dist/observer'), env = process.env) {
  const metadata = runManifest(env);
  for (const path of ['dist/server/index.js', 'dist/server/github-check.js', 'dist/ui/events.js', 'dist/ui/index.html']) {
    if (!existsSync(resolve(root, path))) throw new Error(`Build required first: ${path}`);
  }
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  cpSync(resolve(root, 'dist/server'), resolve(target, 'server'), { recursive: true });
  cpSync(resolve(root, 'dist/ui'), resolve(target, 'ui'), { recursive: true });
  for (const [source, destination] of [['start-observer.mjs', 'start.mjs'], ['discover-github-mcp-schema.mjs', 'discover-github-mcp-schema.mjs']]) {
    cpSync(resolve(root, 'scripts', source), resolve(target, destination));
  }
  writeFileSync(resolve(target, 'package.json'), JSON.stringify({ name: 'mas-self-remediation-observer', private: true, type: 'module', engines: { node: '>=24.19.0' } }, null, 2) + '\n');
  writeFileSync(resolve(target, 'observe.mjs'), "import { main } from './server/index.js';\nawait main();\n");
  writeFileSync(resolve(target, 'start.command'), command('start.mjs'), { mode: 0o755 });
  writeFileSync(resolve(target, 'setup-github-mcp.command'), command('discover-github-mcp-schema.mjs --configure'), { mode: 0o755 });
  if (metadata) writeFileSync(resolve(target, 'run.json'), JSON.stringify(metadata, null, 2) + '\n');
  const identity = metadata
    ? `Repository: ${metadata.repository}\nWorkflow: https://github.com/${metadata.repository}/actions/runs/${metadata.runId}/attempts/${metadata.runAttempt}\nWorkflow SHA: ${metadata.sha}\nDefault: ${metadata.defaultMode}\n\n${Object.entries(metadata.cases).map(([mode, item]) => `${mode}: ${item.incidentId}\nDownload: ${item.artifactName}`).join('\n\n')}`
    : 'This local build has no workflow identity. Use observe.mjs with explicit --events/--incident or --repo/--sha/--incident arguments. Workflow-produced bundles include run.json automatically.';
  writeFileSync(resolve(target, 'README.md'), `# Self-remediation observer

Requires a working Node 24.19.0 or later and GitHub CLI authenticated to github.com with read access to Actions and Checks. No npm install or local Kubernetes is required.

## Start

Extract the entire ZIP, open a terminal in this folder and run:

\`\`\`sh
bash start.command
\`\`\`

On macOS you can also open start.command if your extraction preserved its executable permission. Cross-platform alternative: \`node start.mjs\`.
Open http://127.0.0.1:4318 after the launcher reports that the observer is ready.

The bundled run.json selects this exact workflow attempt and incident. For an available completed artefact the launcher downloads the journal and starts replay. For an active live incident it finds the acknowledged progress Check Run. Pending or failed setup gives an explanation instead of an empty viewer. The fixture is always a separate choice: \`node start.mjs --mode fixture\`.

The complete downloaded replay also includes archive/index.html, which opens without Node. Numeric artefact IDs are assigned after upload, so the launcher resolves the exact retained name within the recorded run. Expired or unavailable artefacts produce an explicit error.

## Optional GitHub MCP setup

Viewing requires only gh authentication. To discover and review the runtime MCP schema, then save its digest in self-remediation-live:

\`\`\`sh
bash setup-github-mcp.command
\`\`\`

The helper uses SELF_REMEDIATION_GITHUB_READ_TOKEN when set, otherwise the local gh credential. It saves github-mcp-actions_get.schema.json and github-mcp-actions_get.sha256, displays the schema, and asks you to type configure before setting SELF_REMEDIATION_GITHUB_MCP_SCHEMA_SHA256 in the recorded repository/environment. Discovery alone is \`node discover-github-mcp-schema.mjs\`.

The workflow still needs its separate SELF_REMEDIATION_GITHUB_READ_TOKEN secret when optional MCP access is enabled. Local gh authentication does not install that secret. No credential is included in this ZIP or written to a schema file. Setup does not dispatch a workflow or incur provider spend.

## Recorded identifiers

${identity}

## Advanced observation

observe.mjs retains its explicit --repo/--sha/--incident/--check and --events/--incident interfaces. Credentials stay with the local gh process and the server binds to loopback. Live Check Runs contain a bounded event window refreshed about every 12 seconds, so late connections can show gaps. Completed replay uses the retained journal. Publication and promotion have separate consolidated archives.

For a broken Homebrew Node installation, select node@24 and verify node --version. If it reports a missing llhttp library, repair the Homebrew packages before retrying.
`);
  return target;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(`Built portable observer: ${buildObserver()}`);
}
