import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { build } from 'esbuild';

rmSync('dist-electron', { recursive: true, force: true });
rmSync('dist-ui', { recursive: true, force: true });
mkdirSync('dist-electron', { recursive: true });
mkdirSync('dist-ui', { recursive: true });

await build({
  entryPoints: ['electron/main.ts'],
  outfile: 'dist-electron/main.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  sourcemap: false,
  logLevel: 'info',
});

await build({
  entryPoints: ['electron/preload.ts'],
  outfile: 'dist-electron/preload.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  sourcemap: false,
  logLevel: 'info',
});

await build({
  entryPoints: ['src/ui/app.ts'],
  outfile: 'dist-ui/app.js',
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'chrome128',
  sourcemap: false,
  logLevel: 'info',
});

cpSync('src/ui/index.html', 'dist-ui/index.html');
cpSync('src/ui/styles.css', 'dist-ui/styles.css');

console.log('构建完成：dist-electron/ 与 dist-ui/');