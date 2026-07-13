import { spawnSync } from 'node:child_process';
import 'dotenv/config';

if (!process.env.BROADCAST_TEST_DATABASE_URL && !process.env.DATABASE_URL) {
  console.error(JSON.stringify({
    ok: false,
    error: 'BROADCAST_TEST_DATABASE_URL or DATABASE_URL is required for the broadcast integration test.'
  }, null, 2));
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  ['--test', '--test-isolation=none', 'integration/broadcast-worker.integration.js'],
  {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
    windowsHide: true
  }
);

process.exit(result.status || 0);
