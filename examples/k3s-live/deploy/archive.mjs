#!/usr/bin/env node
// Bundle the live Vue application and retained observations into an offline HTML file.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkSelectedOutput, parseRevisionAudit, verifyRevisionDigests, verifySelectedOutput } from '../shared/revision.mjs';

const application = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function optionalText(directory, filename) {
  try { return await readFile(join(directory, filename), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

function parse(text, filename) {
  try { return JSON.parse(text); }
  catch { throw new Error(`Cannot archive malformed JSON in ${filename}`); }
}

/** Retain actual observation timestamps; unavailable observations have no replay frame. */
export async function readArchive(directory) {
  const [topologyText, snapshotText, observationsText] = await Promise.all([
    optionalText(directory, 'topology.json'),
    optionalText(directory, 'snapshot.json'),
    optionalText(directory, 'snapshots.ndjson'),
  ]);
  const topology = topologyText === undefined ? undefined : parse(topologyText, 'topology.json');
  const final = snapshotText === undefined ? undefined : parse(snapshotText, 'snapshot.json');
  const observed = observationsText === undefined ? undefined : observationsText.split(/\r?\n/)
    .filter(line => line.trim()).map((line, index) => parse(line, `snapshots.ndjson line ${index + 1}`));
  if (topology === undefined || final === undefined || observed === undefined) return undefined;
  if (!Array.isArray(topology?.nodes) || !topology.nodes.length || !Array.isArray(topology.edges) ||
      !topology.nodes.every(node => typeof node.id === 'string' && typeof node.label === 'string' &&
        ['client', 'workflow', 'llm', 'tool'].includes(node.kind)) ||
      !topology.edges.every(edge => typeof edge.from === 'string' && typeof edge.to === 'string')) {
    throw new Error('Cannot archive malformed topology');
  }
  if (!final?.run || typeof final.run.id !== 'string' || !final.run.id ||
      !['live', 'fixture'].includes(final.run.mode) ||
      typeof final.run.startedAt !== 'string' || !Number.isFinite(Date.parse(final.run.startedAt))) {
    throw new Error('Cannot archive malformed run identity');
  }
  const candidates = [...observed];
  if (JSON.stringify(candidates.at(-1)) !== JSON.stringify(final)) candidates.push(final);
  const snapshots = [];
  let retainedRevision;
  for (const snapshot of candidates) {
    if (snapshot?.run?.id !== final.run.id || snapshot.run.mode !== final.run.mode ||
        snapshot.run.startedAt !== final.run.startedAt || typeof snapshot.run.status !== 'string') {
      throw new Error('Cannot archive inconsistent run identities');
    }
    if (snapshot.run.revision) {
      retainedRevision = parseRevisionAudit(snapshot.run.revision, retainedRevision);
      if (snapshot.run.output !== undefined) {
        checkSelectedOutput(retainedRevision, snapshot.run.output);
      }
    } else if (retainedRevision) throw new Error('Cannot archive disappearing revision history');
    const timestamp = snapshot.observation?.observed_at_ms;
    if (snapshot.observationAvailable === false && timestamp === undefined) continue;
    if (!Number.isSafeInteger(timestamp) || timestamp < 0 ||
        !Array.isArray(snapshot.observation?.messages)) {
      throw new Error('Cannot archive an observation without a valid recorded timestamp and envelopes');
    }
    const messages = snapshot.observation.messages;
    if (messages.some((message, index) => typeof message.id !== 'string' ||
        !Number.isSafeInteger(message.sequence) || message.sequence < 1 ||
        typeof message.sender !== 'string' || typeof message.recipient !== 'string' ||
        typeof message.kind !== 'string' ||
        (index > 0 && message.sequence <= messages[index - 1].sequence)) ||
        new Set(messages.map(message => message.id)).size !== messages.length) {
      throw new Error('Cannot archive malformed or unordered envelopes');
    }
    if (snapshots.length && timestamp < snapshots.at(-1).observation.observed_at_ms) {
      throw new Error('Cannot archive observations whose recorded timestamps move backwards');
    }
    snapshots.push(snapshot);
  }
  if (!snapshots.length) return undefined;
  if (retainedRevision) {
    await verifyRevisionDigests(retainedRevision);
    if (final.run.output !== undefined) await verifySelectedOutput(retainedRevision, final.run.output);
  }
  return { version: 'mas-demo-archive/1', capturedAt: new Date(snapshots.at(-1).observation.observed_at_ms).toISOString(),
    topology, runId: final.run.id, snapshots };
}

export function archiveDocument(archive, javascript, css) {
  const escapes = { '<': '\\u003c', '>': '\\u003e', '&': '\\u0026', '\u2028': '\\u2028', '\u2029': '\\u2029' };
  const data = JSON.stringify(archive).replace(/[<>&\u2028\u2029]/g, character => escapes[character]);
  const script = javascript.replace(/<\/script/gi, match => `<\\/${match.slice(2)}`);
  const style = css.replace(/<\/style/gi, match => `<\\/${match.slice(2)}`);
  return `<!doctype html>
<html lang="en-GB"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="theme-color" content="#0b111b">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'">
<title>MAS · Retained Kubernetes investigation</title>
<style>${style}</style>
</head><body><div id="app"></div>
<script id="mas-demo-archive" type="application/json">${data}</script>
<script>${script}</script>
</body></html>
`;
}

/** Return undefined for missing capture data; reject malformed captures or incomplete bundles. */
export async function createArchive(captureDirectory) {
  const directory = resolve(captureDirectory);
  const archive = await readArchive(directory);
  if (!archive) {
    console.log('Offline dashboard skipped: no retained timed observation is available yet.');
    return undefined;
  }
  const { build } = await import('vite');
  const result = await build({
    root: application,
    configFile: join(application, 'vite.config.ts'),
    logLevel: 'warn',
    // Vite library mode leaves this expression for consumers by default.
    // This bundle is the final browser application, with no Node environment.
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    build: {
      write: false, emptyOutDir: false, sourcemap: false, cssCodeSplit: false,
      lib: { entry: join(application, 'ui/main.ts'), name: 'MASDemoArchive', formats: ['iife'] },
      rolldownOptions: { output: { codeSplitting: false } },
    },
  });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap(bundle => bundle.output);
  const scripts = outputs.filter(output => output.type === 'chunk');
  const styles = outputs.filter(output => output.type === 'asset' && output.fileName.endsWith('.css'));
  if (scripts.length !== 1 || !scripts[0].isEntry || scripts[0].imports.length || scripts[0].dynamicImports.length ||
      outputs.length !== scripts.length + styles.length) {
    throw new Error('The offline dashboard must contain one JavaScript bundle, inline CSS and no external assets');
  }
  const css = styles.map(style => typeof style.source === 'string' ? style.source :
    Buffer.from(style.source).toString('utf8')).join('\n');
  if (/@import\b|url\((?!\s*['"]?data:)/i.test(css)) {
    throw new Error('The offline dashboard stylesheet contains an external resource');
  }
  const destination = join(directory, 'dashboard');
  await mkdir(destination, { recursive: true });
  const html = join(destination, 'index.html');
  await writeFile(html, archiveDocument(archive, scripts[0].code, css));
  await writeFile(join(destination, 'README.md'), [
    '# Retained MAS dashboard', '',
    'Open `index.html` in a browser. The Vue application, styles and captured observations are embedded in this one file.',
    'No server, npm install, CDN or network connection is required.', '',
    `Run: ${archive.runId}. Provider mode: ${archive.snapshots.at(-1).run.mode}.`,
    archive.snapshots.at(-1).observation.payloads_included === true
      ? 'Payloads are included. Select a message in the log to inspect its recorded request input or agent result.'
      : 'Payloads were omitted when this recording was captured. A new capture with SHOW_PAYLOADS=true is required to include them.',
    'This is a replay of retained observations. It performs no inference and sends no cluster commands.',
    'Candidate identities, criterion findings, exact evidence references and supplied invocation feedback are retained at their recorded observations.',
    'Disclosure-withheld content is absent from the archive. Internal deterministic checks and model judgements are separate from held-out outcome measurements.',
    'Replay uses the recorded observation times; intervals between samples do not establish network message timing.',
    'The same Vue application connects to the live host when deployed to a cluster without embedded archive data.', '',
  ].join('\n'));
  console.log(`Created offline Vue dashboard: ${html}`);
  return html;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (!process.argv[2]) {
    console.error('Usage: npm run archive -- <capture-directory>');
    process.exitCode = 1;
  } else {
    createArchive(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
  }
}
