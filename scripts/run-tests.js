import { spawnSync } from 'node:child_process';

const env = {
  ...process.env,
  NODE_ENV: 'test',
  BOT_TOKEN: process.env.BOT_TOKEN || '000000000:test-token-not-used',
  ADMIN_ID: process.env.ADMIN_ID || '1',
  DATABASE_URL: process.env.DATABASE_URL || 'postgresql://test:test@127.0.0.1:1/test',
  SESSION_SECRET: process.env.SESSION_SECRET || 'test-session-secret-not-used'
};
const result = spawnSync(process.execPath, ['--test', '--test-isolation=none'], { env, stdio: 'inherit' });
process.exit(result.status ?? 1);
