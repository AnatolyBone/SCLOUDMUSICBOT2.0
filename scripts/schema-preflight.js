let exitCode = 0;
if (!process.env.DATABASE_URL) {
  console.error(JSON.stringify({
    ok: false,
    error: 'DATABASE_URL is required to run schema preflight.'
  }, null, 2));
  exitCode = 1;
} else {
  process.env.CONFIG_SCOPE = 'database';
  const { checkSchemaPreflight, pool } = await import('../db.js');
  try {
    const result = await checkSchemaPreflight({ throwOnMissing: false });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
    exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
}

process.exitCode = exitCode;
