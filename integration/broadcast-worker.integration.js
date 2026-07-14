import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import pg from 'pg';

const databaseUrl = process.env.BROADCAST_TEST_DATABASE_URL || process.env.DATABASE_URL;

if (!databaseUrl) {
  test('broadcast lifecycle integration requires PostgreSQL', { skip: 'Set BROADCAST_TEST_DATABASE_URL or DATABASE_URL.' }, () => {});
} else {
  const { Client } = pg;
  const schemaName = `broadcast_it_${process.pid}_${Date.now()}`;
  const adminId = -9_000_000_001;
  const recipientIds = [-9_000_000_011, -9_000_000_012];
  const databaseHost = new URL(databaseUrl).hostname;
  const useSsl = !['localhost', '127.0.0.1', '::1'].includes(databaseHost);
  const adminClient = new Client({
    connectionString: databaseUrl,
    ssl: useSsl ? { rejectUnauthorized: false } : false
  });

  let db;
  let processNextBroadcastTask;
  let bot;
  let recipientMessages;
  let userActivityFkDefinition;

  before(async () => {
    await adminClient.connect();
    await adminClient.query(`CREATE SCHEMA ${schemaName}`);

    const scopedUrl = new URL(databaseUrl);
    scopedUrl.searchParams.set('options', `-c search_path=${schemaName}`);
    process.env.DATABASE_URL = scopedUrl.toString();
    process.env.CONFIG_SCOPE = 'database';

    ({ processNextBroadcastTask } = await import(`../services/broadcastWorker.js?integration=${Date.now()}`));
    db = await import('../db.js');

    await db.query(`
      CREATE TABLE app_settings (
        key TEXT PRIMARY KEY,
        value TEXT
      );

      INSERT INTO app_settings (key, value) VALUES ('broadcasts_enabled', 'true');

      CREATE TABLE users (
        id BIGINT PRIMARY KEY,
        first_name TEXT,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        can_receive_broadcasts BOOLEAN NOT NULL DEFAULT TRUE,
        premium_until TIMESTAMPTZ,
        premium_limit INTEGER DEFAULT 3,
        language_source TEXT,
        language_code TEXT,
        telegram_language_code TEXT
      );

      CREATE TABLE user_activity (
        id BIGSERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        activity_type TEXT,
        CONSTRAINT user_activity_user_id_fkey
          FOREIGN KEY (user_id) REFERENCES users(id)
          ON UPDATE CASCADE ON DELETE CASCADE
      );

      CREATE TABLE broadcast_tasks (
        id BIGSERIAL PRIMARY KEY,
        message TEXT,
        file_id TEXT,
        file_mime_type TEXT,
        keyboard JSONB,
        disable_web_page_preview BOOLEAN NOT NULL DEFAULT FALSE,
        target_audience TEXT NOT NULL DEFAULT 'all_users',
        status TEXT NOT NULL DEFAULT 'pending',
        scheduled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        disable_notification BOOLEAN NOT NULL DEFAULT FALSE,
        target_languages TEXT[] NOT NULL DEFAULT ARRAY['all'],
        unknown_language_policy TEXT NOT NULL DEFAULT 'use_ru',
        messages_json JSONB,
        language_source_filter TEXT NOT NULL DEFAULT 'all',
        broadcast_type TEXT DEFAULT 'marketing',
        campaign_name TEXT,
        campaign_tag TEXT,
        fallback_language TEXT DEFAULT 'ru',
        report JSONB,
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        launch_confirmed_at TIMESTAMPTZ,
        launch_confirmed_by BIGINT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE broadcast_log (
        id BIGSERIAL PRIMARY KEY,
        broadcast_id BIGINT NOT NULL,
        user_id BIGINT NOT NULL,
        audience_language_segment TEXT,
        delivered_language TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        sent_at TIMESTAMPTZ,
        UNIQUE (broadcast_id, user_id)
      );
    `);

    const fkBefore = await db.query(
      `SELECT pg_get_constraintdef(oid, true) AS definition
         FROM pg_constraint
        WHERE conname = 'user_activity_user_id_fkey'
          AND conrelid = 'user_activity'::regclass`
    );
    userActivityFkDefinition = fkBefore.rows[0].definition;
    const migration011 = await readFile(
      new URL('../migrations/011_user_activity_bigint.sql', import.meta.url),
      'utf8'
    );
    const scopedMigration011 = migration011.replaceAll('public.', `${schemaName}.`);
    await db.query(scopedMigration011);
    await db.query(scopedMigration011);

    await db.query(
      `INSERT INTO users (id, first_name, language_source, language_code, telegram_language_code)
       VALUES ($1, 'One', 'user_selected', 'ru', 'ru'),
              ($2, 'Two', 'telegram_auto', 'en', 'en')`,
      recipientIds
    );

    recipientMessages = [];
    let messageId = 0;
    bot = {
      telegram: {
        async sendMessage(chatId, text) {
          if (chatId !== adminId) {
            const snapshotState = await db.query(
              'SELECT status FROM broadcast_log WHERE user_id = $1 ORDER BY id DESC LIMIT 1',
              [chatId]
            );
            recipientMessages.push({
              chatId,
              text,
              snapshotStatusAtSend: snapshotState.rows[0]?.status
            });
          }
          return { message_id: ++messageId };
        },
        async editMessageText() {
          return true;
        }
      }
    };
  });

  test('migration 011 preserves the FK and accepts Telegram IDs above int4', async () => {
    const telegramId = 4_294_967_296;
    const typeResult = await db.query(
      `SELECT a.atttypid::regtype::text AS data_type
         FROM pg_attribute a
        WHERE a.attrelid = 'user_activity'::regclass
          AND a.attname = 'user_id'
          AND NOT a.attisdropped`
    );
    assert.equal(typeResult.rows[0].data_type, 'bigint');

    const fkAfter = await db.query(
      `SELECT pg_get_constraintdef(oid, true) AS definition
         FROM pg_constraint
        WHERE conname = 'user_activity_user_id_fkey'
          AND conrelid = 'user_activity'::regclass`
    );
    assert.equal(fkAfter.rows[0].definition, userActivityFkDefinition);

    await db.query(`INSERT INTO users (id, first_name) VALUES ($1, 'BIGINT regression')`, [telegramId]);
    await db.query(
      `INSERT INTO user_activity (user_id, activity_type) VALUES ($1, 'bigint_regression')`,
      [telegramId]
    );
    const activity = await db.query(
      `SELECT user_id FROM user_activity WHERE user_id = $1`,
      [telegramId]
    );
    assert.equal(activity.rows[0].user_id, String(telegramId));
    await db.query(`DELETE FROM users WHERE id = $1`, [telegramId]);
  });

  after(async () => {
    await db?.pool.end().catch(() => {});
    await adminClient.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => {});
    await adminClient.end().catch(() => {});
  });

  test('worker never claims a pending campaign without launch confirmation', async () => {
    const inserted = await db.query(
      `INSERT INTO broadcast_tasks (
         message, target_audience, status, scheduled_at, target_languages,
         unknown_language_policy, messages_json, fallback_language
       ) VALUES ('Unconfirmed', 'all_users', 'pending', $1, ARRAY['all'], 'use_ru',
                 '{"ru":{"message":"Unconfirmed"}}'::jsonb, 'ru')
       RETURNING id`,
      [new Date(0)]
    );
    const taskId = inserted.rows[0].id;
    const sentBefore = recipientMessages.length;

    const result = await processNextBroadcastTask({ bot, adminId, batchDelayMs: 0 });
    assert.equal(result.status, 'idle');
    assert.equal(recipientMessages.length, sentBefore);

    const persistedTask = await db.getBroadcastTaskById(taskId);
    assert.equal(persistedTask.status, 'pending');
    assert.equal(persistedTask.launch_confirmed_at, null);
    await db.cancelBroadcastTask(taskId);
  });

  test('global kill switch prevents a confirmed campaign from being claimed', async () => {
    const task = await db.createBroadcastTask({
      message: 'Kill switch',
      targetAudience: 'all_users',
      scheduledAt: new Date(0),
      target_languages: ['all'],
      unknown_language_policy: 'use_ru',
      language_source_filter: 'all',
      messages_json: { ru: { message: 'Kill switch' } },
      fallback_language: 'ru',
      launch_confirmed_at: new Date(),
      launch_confirmed_by: adminId
    });
    await db.setBroadcastsEnabled(false);
    const sentBefore = recipientMessages.length;

    const result = await processNextBroadcastTask({ bot, adminId, batchDelayMs: 0 });
    assert.equal(result.status, 'disabled');
    assert.equal(recipientMessages.length, sentBefore);
    assert.equal((await db.getBroadcastTaskById(task.id)).status, 'pending');

    await db.cancelBroadcastTask(task.id);
    await db.setBroadcastsEnabled(true);
  });

  test('full broadcast lifecycle creates a snapshot and completes delivery', async () => {
    const task = await db.createBroadcastTask({
      message: 'Integration fallback',
      targetAudience: 'all_users',
      // Use an unambiguous database-past value; CI hosts and managed PostgreSQL
      // can differ by a few seconds, which must not turn this into a scheduler test.
      scheduledAt: new Date(0),
      target_languages: ['all'],
      unknown_language_policy: 'use_ru',
      language_source_filter: 'all',
      messages_json: {
        ru: { message: 'Привет, {first_name}!' },
        en: { message: 'Hello, {first_name}!' }
      },
      fallback_language: 'ru',
      launch_confirmed_at: new Date(),
      launch_confirmed_by: adminId
    });

    const result = await processNextBroadcastTask({
      bot,
      adminId,
      batchDelayMs: 0
    });

    assert.equal(result.status, 'completed');
    assert.equal(result.taskId, task.id);
    assert.equal(result.total, 2);
    assert.equal(result.sent, 2);
    assert.deepEqual(
      recipientMessages.map(item => String(item.chatId)).sort(),
      recipientIds.map(String).sort()
    );
    assert.deepEqual(recipientMessages.map(item => item.snapshotStatusAtSend), ['pending', 'pending']);

    const persistedTask = await db.getBroadcastTaskById(task.id);
    assert.equal(persistedTask.status, 'completed');
    assert.ok(persistedTask.completed_at instanceof Date);

    const log = await db.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
              COUNT(*) FILTER (WHERE status = 'sent')::int AS sent
       FROM broadcast_log
       WHERE broadcast_id = $1`,
      [task.id]
    );
    assert.deepEqual(log.rows[0], { total: 2, pending: 0, sent: 2 });

    const taskList = await db.getAllBroadcastTasks({ limit: 10 });
    const taskStats = taskList.find(item => item.id === task.id);
    assert.equal(taskStats.sent_count, 2);
    assert.equal(taskStats.pending_count, 0);
  });

  test('restarting the worker does not deliver a completed campaign twice', async () => {
    const sentBefore = recipientMessages.length;
    const result = await processNextBroadcastTask({ bot, adminId, batchDelayMs: 0 });

    assert.equal(result.status, 'idle');
    assert.equal(recipientMessages.length, sentBefore);
  });

  test('cancelling between batches stops all remaining recipients', async () => {
    const task = await db.createBroadcastTask({
      message: 'Cancel between batches',
      targetAudience: 'all_users',
      scheduledAt: new Date(0),
      target_languages: ['all'],
      unknown_language_policy: 'use_ru',
      language_source_filter: 'all',
      messages_json: { ru: { message: 'Cancel between batches' } },
      fallback_language: 'ru',
      launch_confirmed_at: new Date(),
      launch_confirmed_by: adminId
    });
    const sentBefore = recipientMessages.length;
    let cancelIssued = false;
    const cancellingBot = {
      telegram: {
        ...bot.telegram,
        async sendMessage(chatId, text, options) {
          const sent = await bot.telegram.sendMessage(chatId, text, options);
          if (Number(chatId) !== adminId && !cancelIssued) {
            cancelIssued = true;
            await db.cancelBroadcastTask(task.id);
          }
          return sent;
        }
      }
    };
    const result = await processNextBroadcastTask({
      bot: cancellingBot,
      adminId,
      batchSize: 1,
      batchDelayMs: 0
    });
    assert.equal(result.status, 'cancelled');
    assert.equal(result.taskId, task.id);
    assert.equal(recipientMessages.length, sentBefore + 1);

    const persistedTask = await db.getBroadcastTaskById(task.id);
    assert.equal(persistedTask.status, 'cancelled');
    assert.ok(persistedTask.completed_at instanceof Date);

    const log = await db.query(
      `SELECT COUNT(*) FILTER (WHERE status = 'sent')::int AS sent,
              COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
              COUNT(*) FILTER (WHERE status = 'pending')::int AS pending
       FROM broadcast_log WHERE broadcast_id = $1`,
      [task.id]
    );
    assert.deepEqual(log.rows[0], { sent: 1, cancelled: 1, pending: 0 });
  });

  test('empty audience fails explicitly without completing the campaign', async () => {
    const task = await db.createBroadcastTask({
      message: 'Premium only',
      targetAudience: 'premium_users',
      scheduledAt: new Date(0),
      target_languages: ['all'],
      unknown_language_policy: 'use_ru',
      language_source_filter: 'all',
      messages_json: { ru: { message: 'Premium only' } },
      fallback_language: 'ru',
      launch_confirmed_at: new Date(),
      launch_confirmed_by: adminId
    });

    const result = await processNextBroadcastTask({ bot, adminId, batchDelayMs: 0 });
    assert.equal(result.status, 'failed');
    assert.match(result.error, /snapshot contains 0 users/);

    const persistedTask = await db.getBroadcastTaskById(task.id);
    assert.equal(persistedTask.status, 'failed');
    assert.equal(persistedTask.completed_at, null);

    const log = await db.query(
      'SELECT COUNT(*)::int AS total FROM broadcast_log WHERE broadcast_id = $1',
      [task.id]
    );
    assert.equal(log.rows[0].total, 0);
  });
}
