#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = path.join(repoRoot, 'plugins', 'oak-memory');
const outputDir = path.join(packageRoot, 'dist');

fs.mkdirSync(outputDir, { recursive: true });
for (const file of ['index.mjs', 'hook.mjs']) {
  fs.copyFileSync(path.join(repoRoot, 'dist', file), path.join(outputDir, file));
}

console.log(`Synced Codex plugin bundles to ${path.relative(repoRoot, outputDir)}`);
