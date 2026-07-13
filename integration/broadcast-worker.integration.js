import assert from 'node:assert/strict';
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

  after(async () => {
    await db?.pool.end().catch(() => {});
    await adminClient.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => {});
    await adminClient.end().catch(() => {});
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
      fallback_language: 'ru'
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

  test('a stale processing campaign is reclaimed and completed idempotently', async () => {
    const task = await db.createBroadcastTask({
      message: 'Stale campaign',
      targetAudience: 'all_users',
      scheduledAt: new Date(0),
      target_languages: ['all'],
      unknown_language_policy: 'use_ru',
      language_source_filter: 'all',
      messages_json: { ru: { message: 'Recovered campaign' } },
      fallback_language: 'ru'
    });
    await db.query(
      `UPDATE broadcast_tasks
       SET status = 'processing', started_at = NOW() - INTERVAL '1 hour'
       WHERE id = $1`,
      [task.id]
    );

    const sentBefore = recipientMessages.length;
    const result = await processNextBroadcastTask({ bot, adminId, batchDelayMs: 0 });
    assert.equal(result.status, 'completed');
    assert.equal(result.taskId, task.id);
    assert.equal(recipientMessages.length, sentBefore + recipientIds.length);

    const persistedTask = await db.getBroadcastTaskById(task.id);
    assert.equal(persistedTask.status, 'completed');
    assert.ok(persistedTask.completed_at instanceof Date);
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
      fallback_language: 'ru'
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
