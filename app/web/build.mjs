import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist', { recursive: true });

await build({
  entryPoints: ['src/main.js'],
  bundle: true,
  format: 'esm',
  minify: true,
  target: 'es2022',
  outfile: 'dist/app.js',
  logLevel: 'warning',
});

cpSync('src/index.html', 'dist/index.html');
cpSync('src/style.css', 'dist/style.css');
cpSync('node_modules/pdfjs-dist/build/pdf.worker.min.mjs', 'dist/pdf.worker.min.mjs');
cpSync('node_modules/pdfjs-dist/wasm', 'dist/wasm', { recursive: true });
console.log('built app/web/dist');
