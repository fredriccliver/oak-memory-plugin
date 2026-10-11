import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(path.join(root, 'desktop/manifest.json'), 'utf8'));
const output = path.resolve(process.argv[2] ?? path.join(root, `artifacts/oak-desktop-cloud-${manifest.version}.mcpb`));
if (existsSync(output)) throw new Error('Output exists; choose a new path to preserve artifacts.');
mkdirSync(path.dirname(output), { recursive: true });
const stage = mkdtempSync(path.join(os.tmpdir(), 'oak-desktop-package-'));
try {
  mkdirSync(path.join(stage, 'server'));
  await build({ absWorkingDir: root, entryPoints: ['src/desktop.ts'], bundle: true, platform: 'node', format: 'esm', target: 'node20', outfile: path.join(stage, 'server/desktop.mjs'), banner: { js: "import{createRequire}from'node:module';const require=createRequire(import.meta.url);" } });
  for (const [from, to] of [['desktop/manifest.json', 'manifest.json'], ['LICENSE', 'LICENSE'], ['NOTICE', 'NOTICE']]) cpSync(path.join(root, from), path.join(stage, to));
  // An explicit allowlist excludes .env files, caches and private profiles.
  const zipped = spawnSync('zip', ['-q', '-X', output, 'manifest.json', 'server/desktop.mjs', 'LICENSE', 'NOTICE'], { cwd: stage });
  if (zipped.status !== 0) throw new Error('Desktop packaging failed');
  console.log(`Desktop bundle: ${output}`);
} finally { rmSync(stage, { recursive: true, force: true }); }
