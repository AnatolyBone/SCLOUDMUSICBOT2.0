# Release gate

Apply the audited idempotent schema migration as a separate release step:

```powershell
npm run migrate:schema
```

Then no deployment should start until the automated gate is green:

```powershell
npm run release:check
```

The command requires `DATABASE_URL` and runs, in order:

- unit and contract tests;
- strict schema/version preflight;
- the complete analytics and XLSX smoke suite;
- the broadcast worker lifecycle against an isolated temporary PostgreSQL schema.

Broadcast safety release requirements:

- migration 010 adds `launch_confirmed_at` and `launch_confirmed_by`;
- migration 010 sets `app_settings.broadcasts_enabled=false` exactly once while upgrading from schema version 9;
- preview uses only `POST /broadcast/preview` and sends to exactly one authenticated administrator;
- launch uses only `POST /broadcast/launch`, `action=launch`, and a one-time session token;
- explicitly enable broadcasts from the broadcast admin page only after the deployed self-test is green;
- verify cancel stops a processing campaign before the next batch.

After the new version is live, open **Admin → Analytics → Self-test**. The authenticated check must report `ok` for database, analytics, broadcasts, workers, and Excel. Its broadcast write test is rolled back and never calls Telegram.

Before considering the release complete, also confirm:

- `/health` reports PostgreSQL available and the expected Redis state;
- the production webhook URL and Telegram `getWebhookInfo` match;
- Supabase credentials are configured without appearing in logs;
- the Render startup log contains the required schema version and no migration/authentication errors.
