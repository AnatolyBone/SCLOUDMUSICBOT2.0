// services/broadcastManager.js
import pMap from 'p-map';
import pTimeout from 'p-timeout';
import { ADMIN_ID, CONFIG } from '../config.js';
import { logBroadcastSent, updateUserField, getBroadcastProgress } from '../db.js';
import { createRedirectToken } from './cryptoService.js';

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

function deliveryLogError(error, taskId, userId) {
  const wrapped = new Error(
    `Telegram delivery state could not be persisted for campaign ${taskId}, user ${userId}: ${error.message}`
  );
  wrapped.code = 'BROADCAST_DELIVERY_LOG_FAILED';
  wrapped.cause = error;
  return wrapped;
}

function getTelegramMethod(mimeType) {
  const prefix = Object.keys(MEDIA_TYPES).find(k => mimeType?.startsWith(k));
  return MEDIA_TYPES[prefix] || 'sendDocument';
}

/**
 * Отправляет сообщение одному пользователю с retry на 429
 */
async function sendToUser(bot, task, user, retryCount = 0) {
  const MAX_RETRIES = 3;
  
  try {
    const userLang = user.delivered_language || 'ru';
    // Находим сообщение для этого языка
    const langData = task.messages_json?.[userLang] || task.messages_json?.[task.fallback_language || 'ru'] || task.messages_json?.['ru'] || {};
    
    let rawMessage = langData.message || task.message || '';
    let keyboard = langData.keyboard || task.keyboard || [];
    
    // Персонализация
    const personalMessage = rawMessage
      .replace(/{first_name}/g, escapeHtml(user.first_name || 'дорогой друг'));
    
    const options = {
      parse_mode: 'HTML',
      disable_web_page_preview: task.disable_web_page_preview,
      disable_notification: task.disable_notification
    };
    
    // Заменяем оригинальные ссылки на подписанные redirect-ссылки
    const processedKeyboard = [];
    let buttonCount = 0;
    if (keyboard?.length > 0) {
      for (const row of keyboard) {
        const processedRow = [];
        for (const button of row) {
          if (button.url) {
            const isTest = !task.id || task.isTest;
            const token = isTest 
              ? createRedirectToken(0, user.id, buttonCount, button.url)
              : createRedirectToken(task.id, user.id, buttonCount);
            // Если это тест, можно добавить флаг test=1 в URL или закодировать в токене (будет обработано в cryptoService)
            // Но мы передаем реальный token, в котором campaign_id = 0, что указывает на тестовый режим
            const redirectUrl = `${CONFIG.WEBHOOK_URL}/r?t=${token}`;
            processedRow.push({ ...button, url: redirectUrl });
          } else {
            processedRow.push(button);
          }
          buttonCount++;
        }
        processedKeyboard.push(processedRow);
      }
    }

    if (processedKeyboard.length > 0) {
      options.reply_markup = { inline_keyboard: processedKeyboard };
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
      if (task.id && !task.isTest) {
        await logBroadcastSent(task.id, user.id, 'sent', user.audience_language_segment || userLang, userLang);
      }
    } catch (logErr) {
      throw deliveryLogError(logErr, task.id, user.id);
    }
    
    return { status: 'ok', userId: user.id };
    
  } catch (e) {
    // Continuing would select the still-pending snapshot row again and could duplicate delivery.
    if (e.code === 'BROADCAST_DELIVERY_LOG_FAILED') throw e;

    // Rate limit (429)
    if (e.response?.error_code === 429 && retryCount < MAX_RETRIES) {
      const retryAfter = e.response.parameters?.retry_after || 5;
      await new Promise(r => setTimeout(r, retryAfter * 1000));
      return sendToUser(bot, task, user, retryCount + 1);
    }
    
    // Блокировка бота (403)
    const isBlocked = e.response?.error_code === 403 || e.response?.description?.includes('chat not found');
    const status = isBlocked ? 'blocked' : 'failed';

    if (isBlocked) {
      try {
        await updateUserField(user.id, { can_receive_broadcasts: false });
      } catch (err) {}
    }
    
    try {
      if (task.id && !task.isTest) {
        await logBroadcastSent(task.id, user.id, status, user.audience_language_segment || user.delivered_language, user.delivered_language);
      }
    } catch (logErr) {
      throw deliveryLogError(logErr, task.id, user.id);
    }
    
    return { status, userId: user.id };
  }
}

/**
 * Обрабатывает одну пачку пользователей
 */
export async function runBroadcastBatch(bot, task, users) {
  const results = await pMap(
    users,
    user => sendToUser(bot, task, user),
    { concurrency: 25 }
  );
  
  const stats = {
    total: results.length,
    success: results.filter(r => r.status === 'ok').length,
    blocked: results.filter(r => r.status === 'blocked').length,
    errors: results.filter(r => r.status === 'failed' || r.status === 'error').length
  };
  
  console.log(`[Broadcast] Batch finished: ${stats.success}/${stats.total} sent, ${stats.blocked} blocked, ${stats.errors} errors.`);
  return results;
}

// Рисование полоски прогресса
function drawProgressBar(current, total) {
  const size = 12;
  const progress = total > 0 ? Math.round((current / total) * size) : 0;
  const empty = size - progress;
  return `<code>[${'■'.repeat(progress)}${'□'.repeat(empty)}]</code>`;
}

/**
 * Отправляет отчет администратору
 */
export async function sendAdminReport(bot, taskId, task, isFinal = true) {
  try {
    const { total, processed, sent, failed, blocked, pending } = await getBroadcastProgress(taskId, task.target_audience);
    
    const percent = total > 0 ? ((processed / total) * 100).toFixed(1) : '0.0';
    const progressBar = drawProgressBar(processed, total);
    
    const statusEmoji = isFinal ? '✅' : '⏳';
    const statusText = isFinal ? 'завершена' : 'в процессе';

    const reportMessage = 
      `${statusEmoji} <b>Рассылка #${taskId} ${statusText}</b>\n` +
      `📌 Название: <b>${task.campaign_name || 'Без названия'}</b>\n` +
      `🏷 Тип: <code>${task.broadcast_type || 'marketing'}</code>\n\n` +
      `${progressBar} <b>${percent}%</b>\n\n` +
      `📦 Обработано: <b>${processed}</b>\n` +
      `✅ Доставлено: <b>${sent}</b>\n` +
      `❌ Ошибки: <b>${failed}</b> · 🚫 Блокировки: <b>${blocked}</b> · ⏳ Ожидают: <b>${pending}</b>\n` +
      `👥 Targeted (snapshot): <b>${total}</b>\n` +
      `👤 Аудитория: <code>${task.target_audience}</code>`;
    
    await bot.telegram.sendMessage(ADMIN_ID, reportMessage, { parse_mode: 'HTML' });
  } catch (e) {
    console.error('[Broadcast] Ошибка отчета:', e.message);
  }
}
