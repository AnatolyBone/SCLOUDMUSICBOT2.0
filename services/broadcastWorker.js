import { ADMIN_ID } from '../config.js';
import {
  areBroadcastsEnabled,
  createBroadcastSnapshot,
  getAndStartPendingBroadcastTask,
  getBroadcastExecutionState,
  getBroadcastProgress,
  getUsersForBroadcastBatch,
  updateBroadcastStatus
} from '../db.js';
import { runBroadcastBatch } from './broadcastManager.js';

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_BATCH_DELAY_MS = 1000;
const DEFAULT_MAX_DURATION_MS = 30 * 60 * 1000;

function drawProgressBar(current, total) {
  const size = 10;
  const progress = total > 0 ? Math.round((current / total) * size) : 0;
  return `<code>[${'■'.repeat(progress)}${'□'.repeat(size - progress)}]</code>`;
}

async function notifyAdmin(bot, adminId, text) {
  if (adminId === null || adminId === undefined) return null;
  return bot.telegram.sendMessage(adminId, text, { parse_mode: 'HTML' });
}

export async function processNextBroadcastTask({
  bot,
  adminId = ADMIN_ID,
  batchSize = DEFAULT_BATCH_SIZE,
  batchDelayMs = DEFAULT_BATCH_DELAY_MS,
  maxDurationMs = DEFAULT_MAX_DURATION_MS,
  shouldStop = () => false,
  onTaskClaimed = () => {},
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
} = {}) {
  if (!bot?.telegram) throw new Error('Broadcast worker requires a Telegram transport.');

  if (!(await areBroadcastsEnabled())) {
    return { status: 'disabled', taskId: null, reason: 'kill-switch' };
  }

  const task = await getAndStartPendingBroadcastTask();
  if (!task) return { status: 'idle', taskId: null };

  const startedAt = Date.now();
  let reportMessageId = null;
  let successCount = 0;
  let errorCount = 0;
  let blockedCount = 0;

  try {
    await onTaskClaimed(task);
    console.log(`[Broadcast] Starting campaign #${task.id}.`);

    const initialState = await getBroadcastExecutionState(task.id);
    if (!initialState?.launch_confirmed || initialState.status !== 'processing') {
      return { status: initialState?.status || 'stopped', taskId: task.id, reason: 'not-launchable' };
    }
    if (!initialState.broadcasts_enabled) {
      await updateBroadcastStatus(task.id, 'pending');
      return { status: 'disabled', taskId: task.id, reason: 'kill-switch' };
    }

    try {
      const initialReport = await notifyAdmin(
        bot,
        adminId,
        `⏳ <b>Подготовка рассылки #${task.id}...</b>`
      );
      reportMessageId = initialReport?.message_id ?? null;
    } catch (reportError) {
      console.warn(`[Broadcast] Campaign #${task.id} will continue without an admin report: ${reportError.message}`);
    }

    const insertedRecipients = await createBroadcastSnapshot(
      task.id,
      task.target_audience,
      task.target_languages,
      task.unknown_language_policy,
      task.language_source_filter,
      task.messages_json,
      task.fallback_language || 'ru'
    );
    const snapshotProgress = await getBroadcastProgress(task.id, task.target_audience);

    console.log(
      `[Broadcast] Snapshot #${task.id}: ${snapshotProgress.total} recipients ` +
      `(${insertedRecipients} inserted).`
    );

    if (snapshotProgress.total === 0) {
      throw new Error('Broadcast audience is empty: recipient snapshot contains 0 users.');
    }

    while (true) {
      const executionState = await getBroadcastExecutionState(task.id);
      if (!executionState || executionState.status === 'cancelled') {
        return { status: 'cancelled', taskId: task.id };
      }
      if (!executionState.broadcasts_enabled) {
        await updateBroadcastStatus(task.id, 'pending');
        return { status: 'disabled', taskId: task.id, reason: 'kill-switch' };
      }
      if (!executionState.launch_confirmed || executionState.status !== 'processing') {
        return { status: executionState.status, taskId: task.id, reason: 'state-changed' };
      }

      if (shouldStop() || Date.now() - startedAt > maxDurationMs) {
        await updateBroadcastStatus(task.id, 'pending');
        return {
          status: 'pending',
          taskId: task.id,
          reason: shouldStop() ? 'shutdown' : 'timeout'
        };
      }

      const users = await getUsersForBroadcastBatch(task.id, task.target_audience, batchSize);
      if (users.length === 0) break;

      const batchResults = await runBroadcastBatch(bot, task, users);
      for (const result of batchResults) {
        if (result.status === 'ok') successCount++;
        else if (result.status === 'blocked') blockedCount++;
        else errorCount++;
      }

      const { total, processed } = await getBroadcastProgress(task.id, task.target_audience);
      const percent = total > 0 ? ((processed / total) * 100).toFixed(1) : '0';

      if (reportMessageId !== null && adminId !== null && adminId !== undefined) {
        try {
          await bot.telegram.editMessageText(
            adminId,
            reportMessageId,
            null,
            `⏳ <b>Выполнение рассылки #${task.id}</b>\n\n` +
              `${drawProgressBar(processed, total)} <b>${percent}%</b>\n\n` +
              `📦 Обработано: <b>${processed} / ${total}</b>\n` +
              `👤 Аудитория: <code>${task.target_audience}</code>`,
            { parse_mode: 'HTML' }
          );
        } catch {
          // Telegram rejects edits when the visible progress text has not changed.
        }
      }

      if (batchDelayMs > 0) await sleep(batchDelayMs);
    }

    const completedTask = await updateBroadcastStatus(task.id, 'completed');
    if (!completedTask) {
      return { status: 'cancelled', taskId: task.id };
    }
    const progress = await getBroadcastProgress(task.id, task.target_audience);
    const durationSeconds = Math.round((Date.now() - startedAt) / 1000);

    if (reportMessageId !== null && adminId !== null && adminId !== undefined) {
      try {
        await bot.telegram.editMessageText(
          adminId,
          reportMessageId,
          null,
          `✅ <b>Рассылка #${task.id} завершена!</b>\n\n` +
            `${drawProgressBar(progress.processed, progress.total)} <b>100%</b>\n\n` +
            `👥 Всего обработано: <b>${progress.total}</b>\n` +
            `✅ Успешно: <b>${successCount}</b>\n` +
            `🚫 Заблокировали бота: <b>${blockedCount}</b>\n` +
            `❌ Ошибок: <b>${errorCount}</b>\n` +
            `⏱ Время выполнения: <b>${durationSeconds} сек.</b>`,
          { parse_mode: 'HTML' }
        );
      } catch (reportError) {
        console.warn(`[Broadcast] Campaign #${task.id} completed, but the final admin report failed: ${reportError.message}`);
      }
    }

    return {
      status: 'completed',
      taskId: task.id,
      insertedRecipients,
      ...progress
    };
  } catch (error) {
    console.error('[Broadcast] Worker error:', error);
    const executionState = await getBroadcastExecutionState(task.id).catch(() => null);
    if (executionState?.status === 'cancelled') {
      return { status: 'cancelled', taskId: task.id };
    }
    await updateBroadcastStatus(task.id, 'failed', error.message);

    if (reportMessageId !== null && adminId !== null && adminId !== undefined) {
      await notifyAdmin(bot, adminId, `❌ Ошибка рассылки #${task.id}: ${error.message}`).catch(() => {});
    }

    return { status: 'failed', taskId: task.id, error: error.message };
  }
}
