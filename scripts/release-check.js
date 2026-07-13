import { spawnSync } from 'node:child_process';
import 'dotenv/config';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error(JSON.stringify({
    ok: false,
    error: 'DATABASE_URL is required for the release gate.'
  }, null, 2));
  process.exit(1);
}

const npmCli = process.env.npm_execpath;
const npmCommand = npmCli ? process.execPath : (process.platform === 'win32' ? 'npm.cmd' : 'npm');
const steps = [
  ['Tests', ['test']],
  ['Schema preflight', ['run', 'check:schema']],
  ['Analytics and XLSX smoke', ['run', 'smoke:analytics']],
  ['Broadcast lifecycle integration', ['run', 'test:broadcast:integration']]
];

const results = [];
for (const [name, args] of steps) {
  console.log(`\n[Release Gate] ${name}`);
  const startedAt = Date.now();
  const commandArgs = npmCli ? [npmCli, ...args] : args;
  const result = spawnSync(npmCommand, commandArgs, {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
    windowsHide: true
  });
  if (result.error) {
    console.error(`[Release Gate] Unable to start ${name}: ${result.error.message}`);
  }
  const ok = result.status === 0;
  results.push({
    name,
    ok,
    durationMs: Date.now() - startedAt,
    ...(result.signal ? { signal: result.signal } : {}),
    ...(result.error ? { error: result.error.message } : {})
  });
  if (!ok) {
    console.error(JSON.stringify({ ok: false, failedStep: name, results }, null, 2));
    process.exit(result.status || 1);
  }
}

console.log(JSON.stringify({ ok: true, results }, null, 2));
