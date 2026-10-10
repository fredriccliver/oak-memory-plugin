#!/usr/bin/env node
import { readdirSync, readFileSync, lstatSync, mkdirSync, mkdtempSync, cpSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'plugins/oak-memory-cloud');
const json = relative => JSON.parse(readFileSync(path.join(source, relative), 'utf8'));
const portable = json('plugin.json');
const claude = json('.claude-plugin/plugin.json');
const endpoint = 'https://www.openaikits.com/api/mcp';
assert.equal(portable.name, 'oak-memory'); // Preserve the existing OpenAI listing identity.
assert.equal(claude.name, 'oak-memory-cloud'); // Keep the local Claude plugin separate.
assert.equal(portable.version, claude.version);
assert.deepEqual(json('mcp.json').mcpServers, { 'oak-memory-cloud': { type: 'streamable-http', url: endpoint } });
assert.deepEqual(json('.mcp.json'), { mcpServers: { 'oak-memory-cloud': { type: 'http', url: endpoint } } });
const localServers = JSON.parse(readFileSync(path.join(root, '.mcp.json'), 'utf8')).mcpServers;
assert(!Object.hasOwn(localServers, 'oak-memory-cloud'), 'Cloud server must not collide with local server names');
const marketplace = JSON.parse(readFileSync(path.join(root, '.claude-plugin/marketplace.json'), 'utf8'));
assert.equal(new Set(marketplace.plugins.map(p => p.name)).size, marketplace.plugins.length);
const entry = marketplace.plugins.find(p => p.name === claude.name);
assert.equal(entry?.source, './plugins/oak-memory-cloud');
assert.equal(entry?.version, claude.version);

function files(directory, prefix = '') {
  return readdirSync(directory).sort().flatMap(name => {
    const relative = path.posix.join(prefix, name);
    const full = path.join(directory, name);
    const stat = lstatSync(full);
    assert(!stat.isSymbolicLink(), `Symlink in package: ${relative}`);
    return stat.isDirectory() ? files(full, relative) : [relative];
  });
}
const shared = files(path.join(source, 'skills'), 'skills').concat(files(path.join(source, 'assets'), 'assets'));
const skills = shared.filter(f => f.endsWith('/SKILL.md'));
assert.equal(skills.length, 10);
const openai = portable.extensions['com.openai'];
for (const relative of [openai.onboardingSkill, openai.interface.logo, openai.interface.composerIcon]) {
  assert(relative.startsWith('./') && !relative.split('/').includes('..'));
  assert(lstatSync(path.join(source, relative)).isFile());
}
const targets = {
  openai: ['plugin.json', 'mcp.json', ...shared],
  claude: ['.claude-plugin/plugin.json', '.mcp.json', ...shared],
};
// Explicit file lists keep local bundles, hooks, environment files and credentials out of ZIPs.
const selected = process.argv[2];
if (!selected || selected === '--check') {
  console.log(`Validated OAuth cloud packages: ${skills.length} shared skills; Claude and OpenAI endpoint parity.`);
} else {
  assert(Object.hasOwn(targets, selected), 'Usage: node scripts/package-cloud-plugin.mjs [--check | openai | claude] [output.zip]');
  const output = path.resolve(process.argv[3] || path.join(root, 'artifacts', `oak-memory-cloud-${portable.version}-${selected}.zip`));
  mkdirSync(path.dirname(output), { recursive: true });
  assert(!lstatExists(output), `Output already exists: ${output}. Choose a new path to preserve review artifacts.`);
  const staging = mkdtempSync(path.join(os.tmpdir(), 'oak-cloud-package-'));
  try {
    for (const file of targets[selected]) {
      mkdirSync(path.dirname(path.join(staging, file)), { recursive: true });
      cpSync(path.join(source, file), path.join(staging, file));
    }
    const result = spawnSync('zip', ['-q', '-X', output, ...targets[selected]], { cwd: staging, encoding: 'utf8' });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
    console.log(`Created ${selected} package: ${output}`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
function lstatExists(file) {
  try { lstatSync(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
