import 'dotenv/config';

if (!process.env.DATABASE_URL) {
  console.error(JSON.stringify({
    ok: false,
    error: 'DATABASE_URL is required to apply the schema migration.'
  }, null, 2));
  process.exit(1);
}

process.env.CONFIG_SCOPE = 'database';
const { checkSchemaPreflight, pool, runPreflightFixesMigration } = await import('../db.js');

try {
  await runPreflightFixesMigration();
  const result = await checkSchemaPreflight({ throwOnMissing: true });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exitCode = 1;
} finally {
  await pool.end().catch(() => {});
}
