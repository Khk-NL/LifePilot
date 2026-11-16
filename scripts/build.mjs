import { build } from 'esbuild';
import { cp, mkdir } from 'node:fs/promises';

await Promise.all([
  build({ entryPoints: ['plugins/obsidian/main.ts'], bundle: true, format: 'cjs', platform: 'browser',
    target: 'es2020', external: ['obsidian'], outfile: 'dist/obsidian/main.js', legalComments: 'linked' }),
  build({ entryPoints: ['plugins/dsh/main.ts'], bundle: true, format: 'esm', platform: 'node',
    target: 'node22', packages: 'external', outfile: 'dist/dsh/main.mjs', legalComments: 'linked' })
]);
await mkdir('dist/obsidian', { recursive: true });
await cp('manifest.json', 'dist/obsidian/manifest.json');
await cp('plugins/obsidian/styles.css', 'dist/obsidian/styles.css');
await cp('LICENSE', 'dist/obsidian/LICENSE');
await cp('node_modules/zod/LICENSE', 'dist/obsidian/LICENSE-Zod.txt');
