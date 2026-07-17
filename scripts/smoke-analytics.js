import 'dotenv/config';

let exitCode = 0;
if (!process.env.DATABASE_URL) {
  const names = [
    'schema_preflight', 'analytics_dashboard', 'period_comparison', 'cohort_analysis',
    'user_timeline', 'retention_explorer', 'acquisition_sources',
    'revenue_dashboard', 'growth_assistant', 'excel_data_query', 'excel_generation',
    'broadcast_list', 'broadcast_stats', 'broadcast_audience_estimate',
    'user_language_profile', 'language_history', 'redirect_click_query',
    'payments_query', 'settings_query'
  ];
  const error = 'DATABASE_URL is required to run analytics smoke tests.';
  console.error(JSON.stringify({
    ok: false,
    summary: { passed: 0, failed: names.length },
    tests: Object.fromEntries(names.map(name => [name, { status: 'error', error }]))
  }, null, 2));
  exitCode = 1;
} else {
  process.env.CONFIG_SCOPE = 'database';
  const { pool } = await import('../db.js');
  const { runAnalyticsSmokeTest } = await import('../services/analyticsSmokeTest.js');
  try {
    const result = await runAnalyticsSmokeTest();
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
