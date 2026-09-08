import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
if (process.platform !== 'darwin') throw new Error('This Foundation/SQLite regression requires macOS and Apple command-line tools.');
const root = resolve(import.meta.dirname, '..');
const output = mkdtempSync(join(tmpdir(), 'galinum-native-text-'));
try {
  for (const [command, args] of [
    ['xcrun', ['clang++', '-fobjc-arc', '-framework', 'Foundation', '-lsqlite3', '-I', join(root, 'ios'), join(root, 'test/native-text-roundtrip.mm'), '-o', join(output, 'roundtrip')]],
    [join(output, 'roundtrip'), []],
  ]) {
    const result = spawnSync(command, args, { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error('Native text regression failed: ' + command);
  }
} finally { rmSync(output, { recursive: true, force: true }); }
