import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Json } from './effects.js';
export interface RetainedGitObject { kind: 'blob' | 'tree' | 'commit'; sha: string; body: Json }
export interface IncidentGitManifest {
  version: 'mas-incident-source/1'; parentCommit: string; faultyCommit: string; gitTree: string; prefix: string;
  objects: RetainedGitObject[];
}
function run(executable: string, args: string[], env: NodeJS.ProcessEnv, input?: string): Promise<string> {
  return new Promise((accept, reject) => {
    const child = spawn(executable, args, { env, stdio: ['pipe', 'pipe', 'pipe'] }); let text = '', error = '';
    child.stdout.on('data', (x: Buffer) => { text += x.toString(); if (text.length > 4 * 1024 * 1024) child.kill(); });
    child.stderr.on('data', (x: Buffer) => { error += x.toString().slice(0, 2000); });
    child.once('error', reject); child.once('close', code => code === 0 ? accept(text) : reject(new Error(`Trusted git object preparation failed: ${error.slice(0, 200)}`)));
    child.stdin.end(input);
  });
}
/** Preserve the injected source as a genuine Git commit before evidence is frozen.
 * Only trusted setup sees this object database; source snapshots expose ordinary files only.
 * No ref, checkout, main branch or remote is changed. */
export async function freezeIncidentSource(repository: string, parentCommit: string, snapshotDirectory: string,
  prefix: string, destination: string, date = new Date().toISOString()): Promise<IncidentGitManifest> {
  if (!/^[a-f0-9]{40}$/.test(parentCommit) || !/^[A-Za-z0-9_.\/-]+$/.test(prefix) || prefix.split('/').some(x => !x || x === '..' || x === '.git')) throw new Error('Exact source parent and scoped prefix required');
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: '/tmp/mas-git-objects', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'MAS Self-healing', GIT_AUTHOR_EMAIL: 'mas-self-remediation@users.noreply.github.com', GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: 'MAS Self-healing', GIT_COMMITTER_EMAIL: 'mas-self-remediation@users.noreply.github.com', GIT_COMMITTER_DATE: date };
  const sourceObjects = (await run('git', ['-C', resolve(repository), 'rev-parse', '--path-format=absolute', '--git-path', 'objects'], env)).trim();
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const gitDirectory = join(resolve(destination), 'objects.git');
  await run('git', ['init', '--bare', gitDirectory], env);
  await mkdir(join(gitDirectory, 'objects/info'), { recursive: true });
  await writeFile(join(gitDirectory, 'objects/info/alternates'), `${await realpath(sourceObjects)}\n`, { mode: 0o600 });
  const git = (args: string[], input?: string) => run('git', ['--git-dir', gitDirectory, ...args], env, input);
  const objects: RetainedGitObject[] = [];
  const blobMap = new Map<string, string>();
  async function snapshotTree(directory: string): Promise<string> {
    const entries: Array<{ path: string; mode: string; type: string; sha: string }> = [];
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!/^[A-Za-z0-9_.-]+$/.test(entry.name) || entry.name === '.git' || entry.isSymbolicLink()) throw new Error('Candidate snapshot contains forbidden path/link');
      if (entry.isDirectory()) entries.push({ path: entry.name, mode: '040000', type: 'tree', sha: await snapshotTree(join(directory, entry.name)) });
      else if (entry.isFile()) {
        const bytes = await readFile(join(directory, entry.name));
        if (bytes.length > 256 * 1024 || bytes.includes(0)) throw new Error('Source snapshot must contain bounded UTF-8 files');
        const content = bytes.toString('utf8');
        if (!Buffer.from(content).equals(bytes)) throw new Error('Source snapshot encoding invalid');
        const sha = (await git(['hash-object', '-w', '--stdin'], content)).trim();
        if (!blobMap.has(sha)) { objects.push({ kind: 'blob', sha, body: { content, encoding: 'utf-8' } }); blobMap.set(sha, content); }
        entries.push({ path: entry.name, mode: '100644', type: 'blob', sha });
      } else throw new Error('Source snapshot must contain only ordinary files');
    }
    return makeTree(entries);
  }
  async function makeTree(entries: Array<{ path: string; mode: string; type: string; sha: string }>): Promise<string> {
    const sha = (await git(['mktree'], entries.map(e => `${e.mode} ${e.type} ${e.sha}\t${e.path}`).join('\n') + (entries.length ? '\n' : ''))).trim();
    objects.push({ kind: 'tree', sha, body: { tree: entries } }); return sha;
  }
  const originalTree = (await git(['rev-parse', `${parentCommit}^{tree}`])).trim();
  async function replace(tree: string, parts: string[], replacement: string): Promise<string> {
    const raw = await git(['ls-tree', '-z', tree]);
    const entries = raw.split('\0').filter(Boolean).map(line => {
      const [metadata, path] = line.split('\t'); const [mode, type, sha] = metadata!.split(' ');
      if (!path || !mode || !type || !sha) throw new Error('Malformed trusted tree metadata');
      return { path, mode, type, sha };
    });
    const name = parts[0]!; let entry = entries.find(item => item.path === name);
    if (entry && entry.type !== 'tree') throw new Error('Admitted source subtree conflicts with an existing file');
    if (!entry) { entry = {path: name, mode: '040000', type: 'tree', sha: await makeTree([])}; entries.push(entry); }
    entry.sha = parts.length === 1 ? replacement : await replace(entry.sha, parts.slice(1), replacement);
    return makeTree(entries);
  }
  const candidateTree = await snapshotTree(resolve(snapshotDirectory));
  const gitTree = await replace(originalTree, prefix.split('/'), candidateTree);
  const message = 'Preserve disposable self-healing incident source';
  const faultyCommit = (await git(['commit-tree', gitTree, '-p', parentCommit, '-m', message])).trim();
  const author = { name: env.GIT_AUTHOR_NAME!, email: env.GIT_AUTHOR_EMAIL!, date };
  // commit-tree retains a trailing newline in its message. Preserve those exact
  // bytes in GitHub's commit API rather than relying on server normalisation.
  objects.push({ kind: 'commit', sha: faultyCommit, body: { message: `${message}\n`, tree: gitTree, parents: [parentCommit], author, committer: author } });
  const manifest: IncidentGitManifest = { version: 'mas-incident-source/1', parentCommit, faultyCommit, gitTree, prefix, objects };
  await writeFile(join(destination, 'incident-git-manifest.json'), JSON.stringify(manifest), { mode: 0o400 });
  return manifest;
}
