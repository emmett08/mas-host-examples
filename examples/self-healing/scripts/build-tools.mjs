import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
await mkdir('dist-tools', {recursive:true});
for (const [name,source] of Object.entries({broker:'tools/command.ts',trial:'scripts/trial.ts',publisher:'scripts/publish.ts',github:'scripts/github-read.ts'})) {
  await build({entryPoints:[source],outfile:`dist-tools/${name}.mjs`,platform:'node',target:'node24',bundle:true,format:'esm',banner:{js:"import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"}});
}
