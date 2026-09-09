import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
const [device, expected, output, transfer, selected] = process.argv.slice(2);
if (!device || !['baseline', 'fixed'].includes(expected) || !output || transfer !== '--device-transferred') {
  throw Error('Usage: node run-repairs.mjs DEVICE baseline|fixed OUTPUT --device-transferred [permission|CASE]');
}
const bundle = 'com.galinum.nativefoundation';
const simctl = (...args) => execFileSync('xcrun', ['simctl', ...args], { encoding: 'utf8' }).trim();
const documents = join(simctl('get_app_container', device, bundle, 'data'), 'Documents');
mkdirSync(documents, { recursive: true }); mkdirSync(output, { recursive: true });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const cases = ['first-claim', 'main-consent', 'responses', 'response-kill', 'receipts', 'direct-switch', 'control-kill'];
if (expected === 'fixed') cases.push('lease-tail', 'control-lost-reply');
if (selected && selected !== 'permission' && !cases.includes(selected)) throw Error('Unknown case');
async function phase(name, group, kill = false) {
  try { simctl('terminate', device, bundle); } catch {}
  const scope = createHash('sha256').update(resolve(output) + ':' + group).digest('hex');
  writeFileSync(join(documents, 'journal-config.json'), JSON.stringify({ phase: name, scope, expected }));
  const file = join(documents, `journal-${kill ? 'kill-ready' : name}.json`);
  rmSync(file, { force: true });
  const launch = simctl('launch', device, bundle);
  const pid = Number(launch.match(/: (\d+)$/)?.[1]);
  if (!pid) throw Error('Missing launch PID');
  const deadline = Date.now() + 90000;
  while (!existsSync(file) && Date.now() < deadline) await wait(100);
  if (!existsSync(file)) throw Error('No result: ' + name);
  const result = JSON.parse(readFileSync(file, 'utf8'));
  if (result.pid !== pid) throw Error('Result does not belong to the launched process');
  if (kill) {
    process.kill(pid, 'SIGKILL');
    result.kill = { signal: 'SIGKILL', pid };
  }
  writeFileSync(join(output, `${group}-${name}.json`), JSON.stringify(result, null, 2) + '\n');
  if (!result.ok) throw Error(`${name}: ${JSON.stringify(result.error)}`);
  console.log(JSON.stringify({ phase: name, group, pid: result.pid, checks: result.checks, observations: result.observations, kill: result.kill }));
  return result;
}
if (selected === 'permission') await phase('permission', 'permission');
else for (const name of selected ? [selected] : cases) {
  await phase('seed', name);
  const killed = await phase(name, name, name.endsWith('-kill'));
  if (name.endsWith('-kill')) {
    const reopened = await phase(name.replace('-kill', '-reopen'), name);
    if (reopened.pid === killed.pid) throw Error('Kill did not replace process');
  }
}
