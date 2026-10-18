import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  root: fileURLToPath(new URL('./ui', import.meta.url)),
  base: './', plugins: [vue()],
  build: { outDir: '../dist/ui', emptyOutDir: false, cssCodeSplit: false, sourcemap: false },
  server: { host: '127.0.0.1', proxy: { '/api': 'http://127.0.0.1:4318' } },
});
