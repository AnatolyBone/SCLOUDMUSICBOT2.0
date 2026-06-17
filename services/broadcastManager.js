// services/broadcastManager.js (Финальная версия: Без спама админу)

import pMap from 'p-map';
import pTimeout from 'p-timeout';
import { ADMIN_ID } from '../config.js';
import { logBroadcastSent, updateUserField, getBroadcastProgress } from '../db.js';

// --- Helper Functions ---

function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const MEDIA_TYPES = {
  'image/': 'sendPhoto',
  'video/': 'sendVideo',
  'audio/': 'sendAudio'
};

function getTelegramMethod(mimeType) {
  const prefix = Object.keys(MEDIA_TYPES).find(k => mimeType?.startsWith(k));
  return MEDIA_TYPES[prefix] || 'sendDocument';
}

// --- Core Functions ---

/**
 * Отправляет сообщение одному пользователю с retry на 429
 */
async function sendToUser(bot, task, user, retryCount = 0) {
  const MAX_RETRIES = 3;
  
  try {
    // Персонализация
    const personalMessage = (task.message || '')
      .replace(/{first_name}/g, escapeHtml(user.first_name || 'дорогой друг'));
    
    const options = {
      parse_mode: 'HTML',
      disable_web_page_preview: task.disable_web_page_preview,
      disable_notification: task.disable_notification
    };
    
    if (task.keyboard?.length > 0) {
      options.reply_markup = { inline_keyboard: task.keyboard };
    }
    
    // Таймаут 15 секунд
    await pTimeout(
      (async () => {
        if (task.file_id) {
          if (personalMessage) options.caption = personalMessage;
          const method = getTelegramMethod(task.file_mime_type);
          await bot.telegram[method](user.id, task.file_id, options);
        } else if (personalMessage) {
          await bot.telegram.sendMessage(user.id, personalMessage, options);
        }
      })(),
      {
        milliseconds: 15000,
        message: `Timeout`
      }
    );
    
    // Логируем успех
    try {
      if (task.id) await logBroadcastSent(task.id, user.id);
    } catch (logErr) {}
    
    return { status: 'ok', userId: user.id };
    
  } catch (e) {
    // Rate limit (429)
    if (e.response?.error_code === 429 && retryCount < MAX_RETRIES) {
      const retryAfter = e.response.parameters?.retry_after || 5;
      await new Promise(r => setTimeout(r, retryAfter * 1000));
      return sendToUser(bot, task, user, retryCount + 1);
    }
    
    // Блокировка бота (403)
    if (e.response?.error_code === 403 || e.response?.description?.includes('chat not found')) {
      try {
        await updateUserField(user.id, { can_receive_broadcasts: false });
      } catch (err) {}
    }
    
    // Логируем неудачу, чтобы не зацикливаться
    try {
      if (task.id) await logBroadcastSent(task.id, user.id);
    } catch (err) {}
    
    return { status: 'error', userId: user.id };
  }
}

/**
 * Обрабатывает одну пачку пользователей.
 * ВАЖНО: Мы убрали отправку сообщений админу отсюда, чтобы не спамить.
 */
export async function runBroadcastBatch(bot, task, users) {
  const results = await pMap(
    users,
    user => sendToUser(bot, task, user),
    { concurrency: 25 } // Чуть снизил для стабильности
  );
  
  const stats = {
    total: results.length,
    success: results.filter(r => r.status === 'ok').length,
    errors: results.filter(r => r.status === 'error').length
  };
  
  console.log(`[Broadcast] Batch finished: ${stats.success}/${stats.total} sent.`);
  return results;
}

/**
 * Отправляет финальный отчёт администратору
 */
// Вспомогательная функция для рисования полоски
function drawProgressBar(current, total) {
  const size = 12; // Длина полоски
  const progress = total > 0 ? Math.round((current / total) * size) : 0;
  const empty = size - progress;
  
  // Используем спецсимволы: закрашенные и пустые квадраты
  return `<code>[${'■'.repeat(progress)}${'□'.repeat(empty)}]</code>`;
}

export async function sendAdminReport(bot, taskId, task, isFinal = true) {
  try {
    const { total, sent } = await getBroadcastProgress(taskId, task.target_audience);
    
    const percent = total > 0 ? ((sent / total) * 100).toFixed(1) : '0.0';
    const progressBar = drawProgressBar(sent, total);
    
    const statusEmoji = isFinal ? '✅' : '⏳';
    const statusText = isFinal ? 'завершена' : 'в процессе';

    const reportMessage = 
      `${statusEmoji} <b>Рассылка #${taskId} ${statusText}</b>\n\n` +
      `${progressBar} <b>${percent}%</b>\n\n` +
      `📦 Отправлено: <b>${sent}</b>\n` +
      `👥 Всего: <b>${total}</b>\n` +
      `👤 Аудитория: <code>${task.target_audience}</code>`;
    
    await bot.telegram.sendMessage(ADMIN_ID, reportMessage, { parse_mode: 'HTML' });
  } catch (e) {
    console.error('[Broadcast] Ошибка отчета:', e.message);
  }
}
