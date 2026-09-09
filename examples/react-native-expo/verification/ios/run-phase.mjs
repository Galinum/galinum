import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
const [device, phase, output] = process.argv.slice(2);
if (!device || !/^[a-z-]+$/.test(phase || '') || !output) throw Error('Usage: node run-phase.mjs DEVICE PHASE OUTPUT');
const bundle = 'com.galinum.nativefoundation';
const simctl = (...args) => execFileSync('xcrun', ['simctl', ...args], { encoding: 'utf8' }).trim();
const container = simctl('get_app_container', device, bundle, 'data');
mkdirSync(join(container, 'Documents'), { recursive: true });
writeFileSync(join(container, 'Documents/journal-config.json'), JSON.stringify({ phase, receipts: process.env.GALINUM_RECEIPT_PROOF === '1', scope: createHash('sha256').update(output).digest('hex') }));
const file = join(container, `Documents/journal-${phase}.json`);
rmSync(file, { force: true });
simctl('launch', '--terminate-running-process', device, bundle);
const start = Date.now();
let result;
while (Date.now() - start < 45000) {
  if (existsSync(file)) {
    result = JSON.parse(readFileSync(file, 'utf8'));
    break;
  }
  await new Promise(resolve => setTimeout(resolve, 200));
}
if (!result) throw Error(`No ${phase} result within 45 seconds`);
mkdirSync(output, { recursive: true });
writeFileSync(join(output, `${phase}.json`), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ phase, ok: result.ok, checks: result.checks, error: result.error, pid: result.pid }));
if (!result.ok) process.exitCode = 1;
