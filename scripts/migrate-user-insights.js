import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
process.env.CONFIG_SCOPE = 'database';

if (!process.env.DATABASE_URL) {
  console.error(JSON.stringify({ ok: false, error: 'DATABASE_URL is required.' }, null, 2));
  process.exit(1);
}
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '012_user_insights_indexes.sql'), 'utf8');
const statements = sql.split(';').map(value => value.trim()).filter(Boolean);
const { query, pool } = await import('../db.js');
try {
  const passes = [];
  for (let pass = 1; pass <= 2; pass += 1) {
    for (const statement of statements) await query(statement);
    await query(
      `INSERT INTO public.app_settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      ['schema_version', '12']
    );
    passes.push({ pass, statements: statements.length, status: 'ok' });
  }
  console.log(JSON.stringify({ ok: true, migration: '012_user_insights_indexes.sql', passes }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exitCode = 1;
} finally {
  await pool.end();
}
