import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(packageRoot, '../..');
const nativeRequire = createRequire(resolve(packageRoot, 'package.json'));
const manifest = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8'));
const outputArg = process.argv.indexOf('--output');
assert(outputArg !== -1 && process.argv[outputArg + 1], 'Pass --output with an evidence path outside the checkout');
const output = resolve(process.argv[outputArg + 1]);
assert(!output.startsWith(root + sep) && output !== root, 'Keep evidence outside the checkout');
assert.equal(process.versions.node.split('.')[0], '24', 'Use Node 24');
assert.equal(process.cwd(), root, 'Run from the checkout root');
const pnpm = spawnSync('pnpm', ['--version'], { encoding: 'utf8', cwd: root });
assert.equal(pnpm.status, 0, pnpm.stderr);
assert.equal(pnpm.stdout.trim(), '10.15.0', 'Use pnpm 10.15.0');
const installed = [];
for (const name of [
  'react', 'react-test-renderer', 'react-native', '@react-native/jest-preset',
  '@react-native/babel-preset', 'jest', 'babel-jest', '@babel/core', '@babel/runtime',
  'typescript', 'vitest',
]) {
  const path = nativeRequire.resolve(`${name}/package.json`);
  const { version } = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(version, manifest.devDependencies[name], `Unexpected installed ${name}`);
  installed.push({ name, version, path: relative(root, path) });
}
const rendererRequire = createRequire(nativeRequire.resolve('react-test-renderer'));
assert.equal(rendererRequire.resolve('react'), nativeRequire.resolve('react'), 'Renderer and host must share React');
function git(args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
function hash(path) {
  return { path: relative(root, path), sha256: createHash('sha256').update(readFileSync(path)).digest('hex') };
}
function sourceInputs() {
  return [...new Set(git(['ls-files', '-co', '--exclude-standard', '-z']).split('\0').filter(Boolean))]
    .sort().map(path => hash(resolve(root, path)));
}
const evidence = {
  node: process.versions.node, pnpm: pnpm.stdout.trim(), head: git(['rev-parse', 'HEAD']).trim(),
  status: git(['status', '--short']), installed, sourceInputs: sourceInputs(), checks: [],
};
for (const name of ['verify:workspace', 'check:native']) {
  const result = spawnSync('pnpm', [name], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  evidence.checks.push({ command: `pnpm ${name}`, status: result.status, stdout: result.stdout, stderr: result.stderr, error: result.error?.message });
  if (result.status !== 0) break;
}
evidence.sourceInputsAfter = sourceInputs();
evidence.sourceUnchanged = JSON.stringify(evidence.sourceInputs) === JSON.stringify(evidence.sourceInputsAfter);
evidence.artifacts = readdirSync(resolve(packageRoot, 'dist'), { recursive: true, withFileTypes: true })
  .filter(entry => entry.isFile()).map(entry => hash(resolve(entry.parentPath, entry.name)));
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n');
console.log(`Source hashes, installed resolutions, artifacts, and normal gate output: ${output}`);
process.exitCode = evidence.sourceUnchanged && evidence.checks.every(check => check.status === 0) ? 0 : 1;
