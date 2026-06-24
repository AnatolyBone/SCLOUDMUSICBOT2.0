// ======================= ФИНАЛЬНАЯ ВЕРСИЯ BOT.JS =======================

import { Telegraf, Markup, TelegramError } from 'telegraf';
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { ADMIN_ID, BOT_TOKEN, WEBHOOK_URL, CHANNEL_USERNAME, STORAGE_CHANNEL_ID, PROXY_URL } from './config.js';
import { getSetting } from './services/settingsManager.js';
import { updateUserField, getUser, createUser, setPremium, getAllUsers, resetDailyLimitIfNeeded, getCachedTracksCount, logUserAction, getTopFailedSearches, getTopRecentSearches, getNewUsersCount,findCachedTrack,
    incrementDownloadsAndSaveTrack, getReferrerInfo, getReferredUsers, resetExpiredPremiumIfNeeded, getReferralStats, getUserUniqueDownloadedUrls, findCachedTrackByFileId, cleanUpDatabase, updateFileId, createSupportMessage} from './db.js';
import { T, allTextsSync } from './config/texts.js';
import { performInlineSearch } from './services/searchManager.js';
import { handleSpotifyUrl, handleQualitySelection as handleSpotifyQuality, registerSpotifyCallbacks } from './services/spotifyManager.js';
import { handleYouTubeUrl, handleYouTubeQualitySelection } from './services/youtubeManager.js';
import { downloadQueue, enqueue } from './services/downloadManager.js';
import execYoutubeDl from 'youtube-dl-exec';
import { identifyTrack } from './services/shazamService.js';
import { handleReferralCommand, processNewUserReferral } from './services/referralManager.js';
import { isShuttingDown, isMaintenanceMode, setMaintenanceMode } from './services/appState.js';



// --- Глобальные переменные и хелперы ---
const playlistSessions = new Map();
const adminReplySessions = new Map();
const TRACKS_PER_PAGE = 5;

// ===== PROXY CIRCUIT BREAKER (bot.js) =====
const BOT_PROXY_ERR = [
    'Unable to connect to proxy', 'ProxyError',
    'Tunnel connection failed', 'Failed to establish a new connection', 'Cannot connect to proxy',
];
let _botProxyCircuitOpen = false;
let _botProxyFailCount = 0;
const BOT_PROXY_FAIL_THRESHOLD = 2;
const BOT_PROXY_RESET_MS = 5 * 60 * 1000;

/** Динамически читает URL прокси из настроек бота */
function getBotProxyUrl() {
    try {
        if (getSetting('use_proxy') !== 'true') return null;
        return getSetting('proxy_url') || null;
    } catch {
        return null;
    }
}

async function execYoutubeDlSafe(url, flags, options) {
    try {
        return await execYoutubeDl(url, flags, options);
    } catch (err) {
        if (flags.dumpSingleJson || flags['dump-single-json'] || flags.dumpJson || flags['dump-json']) {
            if (err.stdout && err.stdout.trim().startsWith('{')) {
                try {
                    console.warn('[youtube-dl] Процесс завершился с ошибкой, но вернул JSON на stdout. Парсим и продолжаем...');
                    return JSON.parse(err.stdout);
                } catch (parseErr) {
                    console.error('[youtube-dl] Ошибка парсинга JSON из stdout ошибки:', parseErr.message);
                }
            }
        }
        throw err;
    }
}

function getYoutubeDl() {
    const defaultFlags = {
        'no-warnings': true,
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'no-check-certificates': true,
        'socket-timeout': 15,
    };

    return async (url, flags) => {
        const currentProxy = getBotProxyUrl();
        const mergedFlags = { ...defaultFlags, ...flags };

        // Прокси выключен — убираем из флагов
        if (!currentProxy) {
            delete mergedFlags.proxy;
            return await execYoutubeDlSafe(url, mergedFlags);
        }

        mergedFlags.proxy = currentProxy;

        // Цепь открыта — работаем без прокси
        if (_botProxyCircuitOpen) {
            console.warn('[youtube-dl] Proxy circuit breaker OPEN — работаю напрямую');
            delete mergedFlags.proxy;
            return await execYoutubeDlSafe(url, mergedFlags);
        }

        try {
            const result = await execYoutubeDlSafe(url, mergedFlags);
            if (_botProxyFailCount > 0) _botProxyFailCount = 0;
            return result;
        } catch (err) {
            const errText = err.stderr || err.message || '';
            const isProxyErr = BOT_PROXY_ERR.some(p => errText.includes(p));

            if (isProxyErr) {
                _botProxyFailCount++;
                console.warn(`[youtube-dl] Ошибка proxy #${_botProxyFailCount}: ${errText.slice(0, 200)}`);

                if (_botProxyFailCount >= BOT_PROXY_FAIL_THRESHOLD && !_botProxyCircuitOpen) {
                    _botProxyCircuitOpen = true;
                    console.error(`[youtube-dl] 🔴 Proxy circuit breaker OPENED. Следующие ${BOT_PROXY_RESET_MS / 60000} мин. — без прокси.`);
                    setTimeout(() => {
                        _botProxyCircuitOpen = false;
                        _botProxyFailCount = 0;
                        console.log('[youtube-dl] 🟡 Proxy circuit breaker RESET');
                    }, BOT_PROXY_RESET_MS);
                }

                const flagsCopy = { ...mergedFlags };
                delete flagsCopy.proxy;
                return await execYoutubeDlSafe(url, flagsCopy);
            }
            throw err;
        }
    };
}


async function addTaskToQueue(task) {
    try {
        // Валидируем payload (проверяем, что задача не "пустая")
        const url = task.url || task.originalUrl;
        if (!url && !task.metadata) {
            console.error('[Queue] Задача без url/originalUrl/metadata — не добавляю:', task);
            return;
        }
        
        // Получаем приоритет из тарифа пользователя
        const user = await getUser(task.userId);
        const dailyLimitFree = parseInt(getSetting('daily_limit_free') || '3', 10);
        const priority = user ? (user.premium_limit || dailyLimitFree) : dailyLimitFree;
        
        // Новый, правильный лог
        console.log('[Queue] Добавляю задачу', {
            userId: task.userId,
            prio: priority,
            url,
            hasMeta: !!task.metadata
        });
        
        // ВАЖНО: передаем в очередь ОБЪЕКТ ЗАДАЧИ, а не функцию
        downloadQueue.add({ ...task, priority }).catch(err => {
          if (err.message === 'TASK_TIMEOUT') {
            console.error(`[TaskQueue] Задача отменена по таймауту: ${task.url || task.originalUrl}`);
          } else {
            console.error('[TaskQueue] Ошибка выполнения задачи:', err.message);
          }
        });
    } catch (e) {
        console.error(`[Queue] Ошибка при добавлении задачи в очередь для ${task.userId}:`, e);
    }
}
// --- Вспомогательные функции ---
function escapeHtml(text) {
    if (typeof text !== 'string') return '';
    return text.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/&/g, '&amp;');
}
async function isSubscribed(userId) {
    if (!CHANNEL_USERNAME) return false;
    try {
        const member = await bot.telegram.getChatMember(CHANNEL_USERNAME, userId);
        return ['creator', 'administrator', 'member'].includes(member.status);
    } catch (e) {
        console.error(`Ошибка проверки подписки для ${userId} на ${CHANNEL_USERNAME}:`, e.message);
        return false;
    }
}

function getTariffName(limit) {
    if (limit >= 10000) return 'Unlimited — 💎';
    if (limit >= 100) return 'Pro — 100 💪';
    if (limit >= 30) return 'Plus — 30 🎯';
    return '🆓 Free — 5 🟢';
}

function getDaysLeft(premiumUntil) {
    if (!premiumUntil) return 0;
    const diff = new Date(premiumUntil) - new Date();
    return Math.max(Math.ceil(diff / 86400000), 0);
}

// bot.js

// bot.js

function formatMenuMessage(user, botUsername) {
    // 1. Сначала получаем все динамические данные (как и раньше)
    const tariffLabel = getTariffName(user.premium_limit);
    const downloadsToday = user.downloads_today || 0;
    const daysLeft = getDaysLeft(user.premium_until);
    const referralCount = user.referral_count || 0;
    const referralLink = `https://t.me/${botUsername}?start=ref_${user.id}`;
    
    // 2. Собираем основной блок статистики (он нередактируемый, т.к. это данные)
    const statsBlock = [
        `💼 <b>Тариф:</b> <i>${tariffLabel}</i>`,
        `⏳ <b>Осталось дней подписки:</b> <i>${daysLeft}</i>`,
        `🎧 <b>Сегодня скачано:</b> <i>${downloadsToday}</i> из <i>${user.premium_limit}</i>`
    ].join('\n');
    
    // 3. Берем шаблоны из T() и заменяем плейсхолдеры
    const header = T('menu_header').replace('{first_name}', escapeHtml(user.first_name) || 'пользователь');
    
    const referralBlock = T('menu_referral_block')
        .replace('{referral_count}', referralCount)
        .replace('{referral_link}', referralLink);
    
    let bonusBlock = '';
    if (!user.subscribed_bonus_used && CHANNEL_USERNAME) {
        const cleanUsername = CHANNEL_USERNAME.replace('@', '');
        const channelLink = `<a href="https://t.me/${cleanUsername}">наш канал</a>`;
        bonusBlock = T('menu_bonus_block').replace('{channel_link}', channelLink);
    }
    
    const footer = T('menu_footer');
    
    // 4. Собираем все части вместе, отфильтровывая пустые блоки
    const messageParts = [
        header,
        statsBlock,
        '\n- - - - - - - - - - - - - - -',
        referralBlock,
        bonusBlock, // Этот блок добавится, только если он не пустой
        footer
    ];
    
    return messageParts.filter(Boolean).join('\n\n');
}

// --- Инициализация Telegraf ---
const telegrafOptions = { handlerTimeout: 300_000 };
// if (PROXY_URL) {
   //  const agent = new HttpsProxyAgent(PROXY_URL);
   //  telegrafOptions.telegram = { agent };
   //  console.log('[App] Использую прокси для подключения к Telegram API.');
// }
export const bot = new Telegraf(BOT_TOKEN, telegrafOptions);

// --- Безопасный ответ на callback-запросы (предотвращает краш из-за таймаутов Telegram) ---
bot.use(async (ctx, next) => {
    if (ctx.callbackQuery && ctx.answerCbQuery) {
        const originalAnswerCbQuery = ctx.answerCbQuery.bind(ctx);
        ctx.answerCbQuery = async (...args) => {
            try {
                return await originalAnswerCbQuery(...args);
            } catch (err) {
                console.warn(`[CallbackQuery] Ошибка при ответе на callback (ID: ${ctx.callbackQuery.id}):`, err.message || err);
            }
        };
    }
    return await next();
});

// --- Режим обслуживания (Глобальный Middleware) ---
bot.use(async (ctx, next) => {
    if (isShuttingDown()) return;
    if (isMaintenanceMode() && ctx.from && Number(ctx.from.id) !== Number(ADMIN_ID)) {
        if (ctx.callbackQuery) {
            return await ctx.answerCbQuery('⏳ Бот на плановом обслуживании.', { show_alert: true });
        }
        return await ctx.reply('⏳ Бот на плановом обслуживании.');
    }
    return await next();
});

// Регистрируем Spotify callbacks
registerSpotifyCallbacks(bot);

// --- Middleware ---
// ЗАМЕНИ СТАРЫЙ БЛОК bot.catch НА ЭТОТ В ФАЙЛЕ bot.js

bot.catch(async (err, ctx) => {
    console.error(`🔴 [Telegraf Catch] Ошибка для update ${ctx.update?.update_id}:`, err.message);

    // 403 — юзер заблокировал бота. Тихо помечаем неактивным, не алертим админа.
    if (err instanceof TelegramError && err.response?.error_code === 403) {
        if (ctx.from?.id) {
            await updateUserField(ctx.from.id, 'active', false).catch(() => {});
            console.log(`[Bot] Пользователь ${ctx.from.id} заблокировал бота — помечен неактивным.`);
        }
        return;
    }

    // TimeoutError — логируем, но не алертим (плейлисты на 1000+ треков)
    if (err.name === 'TimeoutError') {
        console.warn(`[Bot] Таймаут обработчика (update ${ctx.update?.update_id})`);
        return;
    }

    // Остальные ошибки — отправляем админу
    try {
        const updateInfo = ctx.update ? JSON.stringify(ctx.update, null, 2) : 'N/A';
        const errorMessage = `
🔴 <b>Критическая ошибка в боте!</b>

<b>Тип ошибки:</b>
<code>${err.name || 'UnknownError'}</code>

<b>Сообщение:</b>
<code>${err.message || 'No message'}</code>

<b>Где произошла:</b>
<code>${err.stack ? err.stack.split('\n')[1].trim() : 'Stack trace unavailable'}</code>

<b>Update, вызвавший ошибку:</b>
<pre><code class="language-json">${updateInfo.slice(0, 3500)}</code></pre>
        `;
        await bot.telegram.sendMessage(ADMIN_ID, errorMessage, { parse_mode: 'HTML' });
    } catch (sendError) {
        console.error('🔥 Не удалось отправить уведомление админу:', sendError.message);
    }
});
bot.use(async (ctx, next) => {
    if (!ctx.from) return next();
    
    // Пытаемся достать payload из deep link:
    // 1) ctx.startPayload — есть на /start
    // 2) запасной способ — из текста '/start ref_xxx'
    const payload =
        (typeof ctx.startPayload === 'string' && ctx.startPayload) ||
        (ctx.message?.text?.startsWith('/start ') ? ctx.message.text.split(' ')[1] : null) ||
        null;
    
    // ВАЖНО: передаём payload в getUser — он сам проставит referrer_id при создании
    const user = await getUser(ctx.from.id, ctx.from.first_name, ctx.from.username, payload);
    ctx.state.user = user;
    
    if (user && user.active === false) return;
    
    // По желанию: восстанавливаем флаг рассылок
    if (user && user.can_receive_broadcasts === false) {
        try { await updateUserField(user.id, { can_receive_broadcasts: true }); } catch (e) {
            console.error('[Broadcast flag] update error:', e.message);
        }
    }
    
    await resetDailyLimitIfNeeded(ctx.from.id);
    await resetExpiredPremiumIfNeeded(ctx.from.id);
    return next();
});
const getMainKeyboard = () => {
    const buttons = [
        [T('menu'), '🆔 Распознать', T('upgrade')],
        [T('mytracks'), T('help')]
    ];
    if (getSetting('use_vpn') !== 'false') {
        const vpnText = getSetting('vpn_button_text') || '🔐 VPN (YouTube 4K)';
        buttons.push([vpnText]);
    }
    return Markup.keyboard(buttons).resize();
};

bot.start(async (ctx) => {
  try {
    console.log('[START] got start for', ctx.from.id, 'payload=', ctx.startPayload);

    const user = await getUser(ctx.from.id, ctx.from.first_name, ctx.from.username, ctx.startPayload || null);

    const isNewRegistration = (Date.now() - new Date(user.created_at).getTime()) < 5000;

    if (isNewRegistration) {
        await logUserAction(ctx.from.id, 'registration');
        await processNewUserReferral(user, ctx);
    }

    const startMessage = isNewRegistration ? T('start_new_user') : T('start');

    await ctx.reply(startMessage, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...getMainKeyboard()
    });
  } catch (err) {
    console.error(`[bot.start] Ошибка для userId=${ctx.from?.id}:`, err.message);
    await ctx.reply('Произошла ошибка при запуске. Попробуйте ещё раз: /start').catch(() => {});
  }
});

function sanitizeFilename(name) {
  if (!name || typeof name !== 'string') return 'track';
  return name.replace(/[<>:"/\\|?*]+/g, '').trim() || 'track';
}
// bot.js
// handlers/commands.js - добавьте команду для теста
bot.command('cleantrash', async (ctx) => {
    // Проверка на админа
    if (ctx.from.id !== ADMIN_ID) return;

    await ctx.reply('🧹 Начинаю очистку базы от битых треков...');
    
    // Вызываем функцию из db.js
    const success = await cleanUpDatabase();
    
    if (success) {
        await ctx.reply('✅ База очищена:\n1. Трек "Wrong Side of Heaven" удален.\n2. Все треки короче 20 сек удалены.\n\nПопробуйте скачать ссылку снова.');
    } else {
        await ctx.reply('❌ Произошла ошибка при очистке. Проверьте логи.');
    }
});

bot.command('fixuser', async (ctx) => {
  // 1. Проверяем, что это админ
  if (ctx.from.id !== ADMIN_ID) {
    return;
  }

  const args = ctx.message.text.split(' ');
  const targetUserId = parseInt(args[1], 10);

  if (!targetUserId) {
    return ctx.reply('Пожалуйста, укажите ID пользователя. Пример: /fixuser 123456789');
  }

  await ctx.reply(`✅ Запускаю фоновую задачу по исправлению кэша для пользователя ID: ${targetUserId}. Это может занять много времени. Отчет будет прислан вам по завершении.`);

  // 2. Запускаем всю тяжелую работу в фоновом режиме, чтобы бот не "зависал"
  (async () => {
    let fixedCount = 0;
    let checkedCount = 0;
    let failedCount = 0;
    const BATCH_DELAY = 3000; // 3 секунды между проверками

    try {
      // 3. Получаем все URL пользователя
      const urls = await getUserUniqueDownloadedUrls(targetUserId);
      if (urls.length === 0) {
        await bot.telegram.sendMessage(ADMIN_ID, `ℹ️ Для пользователя ${targetUserId} не найдено скачанных треков в логах.`);
        return;
      }
      
      await bot.telegram.sendMessage(ADMIN_ID, `[FixUser] Найдено ${urls.length} уникальных URL для пользователя ${targetUserId}. Начинаю проверку...`);

      // 4. Перебираем URL и лечим файлы
      for (const url of urls) {
        checkedCount++;
        try {
          const track = await findCachedTrack(url);
          if (!track || !track.fileId || !track.title) {
            continue; // Трека нет в кэше или запись неполная
          }

          const fileInfo = await bot.telegram.getFile(track.fileId);
          const cleanTitle = sanitizeFilename(track.title);
          const hasCorrectName = fileInfo.file_path && fileInfo.file_path.includes(encodeURIComponent(cleanTitle.split('.mp3')[0]));

          if (hasCorrectName) {
            continue; // Файл уже в порядке
          }

          // Файл "сломан", лечим
          const fileLink = await bot.telegram.getFileLink(track.fileId);
          const filename = cleanTitle.toLowerCase().endsWith('.mp3') ? cleanTitle : `${cleanTitle}.mp3`;
          
          const sentToStorage = await bot.telegram.sendAudio(
            STORAGE_CHANNEL_ID,
            { url: fileLink.href, filename },
            { title: track.title, performer: track.artist }
          );

          const newFileId = sentToStorage?.audio?.file_id;
          if (newFileId) {
            await updateFileId(track.fileId, newFileId);
            fixedCount++;
          }
        } catch (e) {
          failedCount++;
          console.error(`[FixUser] Ошибка при обработке URL ${url} для юзера ${targetUserId}:`, e.message);
        }
        // Пауза между запросами к API
        await new Promise(resolve => setTimeout(resolve, BATCH_DELAY));
      }

      // 5. Отправляем финальный отчет админу
      await bot.telegram.sendMessage(ADMIN_ID, `✅ [FixUser] Задача для пользователя ${targetUserId} завершена.\n\n- Проверено треков: ${checkedCount}\n- Исправлено файлов: ${fixedCount}\n- Ошибок при обработке: ${failedCount}`);

    } catch (e) {
      console.error(`[FixUser] Критическая ошибка в задаче для ${targetUserId}:`, e);
      await bot.telegram.sendMessage(ADMIN_ID, `❌ [FixUser] Произошла критическая ошибка в задаче для пользователя ${targetUserId}. Подробности в логах.`);
    }
  })(); // Немедленно вызываем асинхронную функцию
});
bot.command('fix', async (ctx) => {
  console.log(`[FIX_COMMAND] Команда /fix инициирована пользователем ${ctx.from.id}`);

  // --- ПРОВЕРКИ ---
  if (!ctx.message.reply_to_message) {
    console.log('[FIX_COMMAND] Сбой: Нет реплая.');
    return ctx.reply('ℹ️ Чтобы исправить файл, ответьте на сообщение с аудиозаписью этой командой.');
  }
  const repliedMessage = ctx.message.reply_to_message;

  if (!repliedMessage.audio) {
    console.log('[FIX_COMMAND] Сбой: Нет аудио.');
    return ctx.reply('❌ Это не аудиофайл. Пожалуйста, ответьте на сообщение с музыкой.');
  }
  
  if (!STORAGE_CHANNEL_ID) {
      console.log('[FIX_COMMAND] Сбой: Нет STORAGE_CHANNEL_ID.');
      return ctx.reply('🛠 Функция временно недоступна.');
  }

  const oldFileId = repliedMessage.audio.file_id;
  console.log(`[FIX_COMMAND] Старый file_id: ${oldFileId}`);
  
  let statusMessage;

  try {
    // Отправляем сообщение о начале (если упадет - не страшно)
    try {
        statusMessage = await ctx.reply('🔬 Начинаю процедуру "лечения" файла...');
    } catch (e) { console.warn('Не удалось отправить статусное сообщение:', e); }

    // 1. Находим трек в БД
    console.log('[FIX_COMMAND] Шаг 1: Поиск трека в БД...');
    const trackInfo = await findCachedTrackByFileId(oldFileId);
    
    if (!trackInfo) {
      console.log('[FIX_COMMAND] Шаг 1: Провал. Трек не найден.');
      if (statusMessage) {
          await ctx.telegram.editMessageText(ctx.chat.id, statusMessage.message_id, undefined, '🤔 Не могу найти этот трек в базе. Возможно, он был скачан не мной.').catch(()=>{});
      }
      return;
    }
    console.log('[FIX_COMMAND] Шаг 1: Успех. Найден трек:', trackInfo);

    // 2. Получаем ссылку
    console.log('[FIX_COMMAND] Шаг 2: Получение ссылки...');
    const fileLink = await ctx.telegram.getFileLink(oldFileId);
    console.log('[FIX_COMMAND] Шаг 2: Успех.');

    // 3. Перезагружаем в хранилище
    const title = trackInfo.title || 'Track';
    const artist = trackInfo.artist || 'Artist';
    console.log(`[FIX_COMMAND] Шаг 3: Перезагрузка "${title}"...`);
    
    const cleanTitle = sanitizeFilename(title);
    const filename = cleanTitle.toLowerCase().endsWith('.mp3') ? cleanTitle : `${cleanTitle}.mp3`;

    const sentToStorage = await bot.telegram.sendAudio(STORAGE_CHANNEL_ID, { 
        url: fileLink.href, 
        filename: filename,
        title: title,        // Добавляем метаданные сразу
        performer: artist 
    });
    
    const newFileId = sentToStorage?.audio?.file_id;
    if (!newFileId) throw new Error('Не удалось получить новый file_id.');
    
    console.log(`[FIX_COMMAND] Шаг 3: Успех. Новый file_id: ${newFileId}`);

    // 4. Обновляем БД
    console.log('[FIX_COMMAND] Шаг 4: Обновление БД...');
    const updatedCount = await updateFileId(oldFileId, newFileId);
    console.log(`[FIX_COMMAND] Шаг 4: Успех. Обновлено строк: ${updatedCount}`);
    
    if (updatedCount > 0) {
        // --- УСПЕХ: Сначала шлем файл (самое важное) ---
        try {
            await ctx.replyWithAudio(newFileId, {
                caption: '✅ Файл восстановлен и обновлен в базе!',
                title: title,
                performer: artist,
                reply_to_message_id: repliedMessage.message_id // Отвечаем на оригинал
            });
        } catch (sendErr) {
            console.error('Ошибка отправки исправленного файла:', sendErr);
            await ctx.reply('✅ Файл исправлен в базе, но я не смог отправить его вам сюда.');
        }

        // --- Потом обновляем статус (менее важно) ---
        if (statusMessage) {
            try {
                await ctx.telegram.deleteMessage(ctx.chat.id, statusMessage.message_id);
            } catch (delErr) {
                // Если не смогли удалить - пробуем отредактировать
                await ctx.telegram.editMessageText(ctx.chat.id, statusMessage.message_id, undefined, '✅ Готово!').catch(()=>{});
            }
        }
    } else {
        if (statusMessage) {
             await ctx.telegram.editMessageText(ctx.chat.id, statusMessage.message_id, undefined, '⚠️ Файл перезалит, но база данных не обновилась.').catch(()=>{});
        }
    }

  } catch (error) {
    console.error('❌ КРИТИЧЕСКАЯ ОШИБКА в команде /fix:', error);
    if (statusMessage) {
      // Пытаемся сообщить об ошибке, но не крашимся если не выйдет
      await ctx.telegram.editMessageText(ctx.chat.id, statusMessage.message_id, undefined, `❌ Ошибка при лечении файла.`).catch(()=>{});
    }
  }
});
async function getAdminStatsData() {
    const [
        users,
        cachedTracksCount,
        topFailed,
        topRecent,
        newUsersToday,
        newUsersWeek,
        refStats
    ] = await Promise.all([
        getAllUsers(true),
        getCachedTracksCount(),
        getTopFailedSearches(5),
        getTopRecentSearches(5),
        getNewUsersCount(1),
        getNewUsersCount(7),
        getReferralStats().catch(() => ({ totalReferred: 0 }))
    ]);
    
    const totalUsers = users.length;
    const activeUsers = users.filter(u => u.active).length;
    const activeToday = users.filter(u => u.last_active && new Date(u.last_active).toDateString() === new Date().toDateString()).length;
    const totalDownloads = users.reduce((sum, u) => sum + (u.total_downloads || 0), 0);
    const storageStatusText = STORAGE_CHANNEL_ID ? '✅ Доступен' : '⚠️ Не настроен';
    const maintenanceText = isMaintenanceMode() ? '🛠️ ВКЛЮЧЕН' : '🟢 Выключен';
    
    let statsMessage = `<b>📊 Статистика Бота</b>\n\n` +
        `<b>👤 Пользователи:</b>\n` +
        `   - Всего: <i>${totalUsers}</i>\n` +
        `   - Активных: <i>${activeUsers}</i>\n` +
        `   - <b>Новых за 24ч: <i>${newUsersToday}</i></b>\n` +
        `   - <b>Новых за 7 дней: <i>${newUsersWeek}</i></b>\n` +
        `   - Активных сегодня: <i>${activeToday}</i>\n\n` +
        `<b>📥 Загрузки:</b>\n   - Всего за все время: <i>${totalDownloads}</i>\n\n` +
        `<b>👥 Рефералы:</b>\n   - Всего приглашено: <i>${refStats.totalReferred}</i>\n\n`;
    
    if (topFailed.length > 0) {
        statsMessage += `---\n\n<b>🔥 Топ-5 неудачных запросов (всего):</b>\n`;
        topFailed.forEach((item, index) => {
            statsMessage += `${index + 1}. <code>${item.query.slice(0, 30)}</code> (искали <i>${item.search_count}</i> раз)\n`;
        });
        statsMessage += `\n`;
    }
    
    if (topRecent.length > 0) {
        statsMessage += `<b>📈 Топ-5 запросов (за 24 часа):</b>\n`;
        topRecent.forEach((item, index) => {
            statsMessage += `${index + 1}. <code>${item.query.slice(0, 30)}</code> (искали <i>${item.total}</i> раз)\n`;
        });
        statsMessage += `\n`;
    }
    
    statsMessage += `---\n\n<b>⚙️ Система:</b>\n` +
        `   - Очередь: <i>${downloadQueue.size}</i> в ож. / <i>${downloadQueue.pending}</i> в раб.\n` +
        `   - Канал-хранилище: <i>${storageStatusText}</i>\n` +
        `   - Режим обслуживания: <i>${maintenanceText}</i>\n` +
        `   - Треков в кэше: <i>${cachedTracksCount}</i>\n\n` +
        `<b>🔗 Админ-панель:</b>\n<a href="${WEBHOOK_URL.replace(/\/$/, '')}/dashboard">Открыть дашборд</a>`;
    
    const markup = Markup.inlineKeyboard([
        [
            Markup.button.callback(isMaintenanceMode() ? '🟢 Выключить тех. работы' : '🛠️ Включить тех. работы', 'admin_toggle_maintenance'),
            Markup.button.callback('🧹 Очистить кэш', 'admin_clean_trash')
        ],
        [
            Markup.button.callback('🔄 Обновить статистику', 'admin_refresh')
        ]
    ]);
    
    return { text: statsMessage, markup };
}

bot.command('admin', async (ctx) => {
    if (Number(ctx.from.id) !== Number(ADMIN_ID)) return;
    let loaderMsg;
    try {
        loaderMsg = await ctx.reply('⏳ Собираю статистику...');
        const { text, markup } = await getAdminStatsData();
        await ctx.telegram.editMessageText(ctx.chat.id, loaderMsg.message_id, undefined, text, {
            parse_mode: 'HTML',
            disable_web_page_preview: true,
            ...markup
        });
    } catch (e) {
        console.error('❌ Ошибка в команде /admin:', e);
        if (loaderMsg) {
            await ctx.telegram.editMessageText(ctx.chat.id, loaderMsg.message_id, undefined, '❌ Не удалось собрать статистику.').catch(() => {});
        } else {
            await ctx.reply('❌ Не удалось собрать статистику.').catch(() => {});
        }
    }
});

async function updateAdminStatsMessage(ctx) {
    try {
        const { text, markup } = await getAdminStatsData();
        await ctx.editMessageText(text, {
            parse_mode: 'HTML',
            disable_web_page_preview: true,
            ...markup
        });
    } catch (e) {
        console.error('❌ Ошибка при обновлении статистики:', e.message);
    }
}

bot.action('admin_toggle_maintenance', async (ctx) => {
    if (Number(ctx.from.id) !== Number(ADMIN_ID)) {
        return ctx.answerCbQuery('Доступ запрещен ❌', { show_alert: true });
    }
    const current = isMaintenanceMode();
    await setMaintenanceMode(!current);
    await ctx.answerCbQuery(`Режим обслуживания: ${!current ? 'ВКЛЮЧЕН 🛠️' : 'ВЫКЛЮЧЕН 🟢'}`);
    await updateAdminStatsMessage(ctx);
});

bot.action('admin_clean_trash', async (ctx) => {
    if (Number(ctx.from.id) !== Number(ADMIN_ID)) {
        return ctx.answerCbQuery('Доступ запрещен ❌', { show_alert: true });
    }
    await ctx.answerCbQuery('🧹 Начинаю очистку...', { show_alert: false });
    const success = await cleanUpDatabase();
    if (success) {
        await ctx.reply('✅ База успешно очищена от битых треков.');
    } else {
        await ctx.reply('❌ Произошла ошибка при очистке базы.');
    }
    await updateAdminStatsMessage(ctx);
});

bot.action('admin_refresh', async (ctx) => {
    if (Number(ctx.from.id) !== Number(ADMIN_ID)) {
        return ctx.answerCbQuery('Доступ запрещен ❌', { show_alert: true });
    }
    await ctx.answerCbQuery('🔄 Статистика обновлена!');
    await updateAdminStatsMessage(ctx);
});

bot.action('support_enter', async (ctx) => {
    try {
        await ctx.answerCbQuery();
        await updateUserField(ctx.from.id, 'support_mode', true);
        await ctx.reply('✉️ Вы вошли в чат с поддержкой.\n\nНапишите ваш вопрос или проблему прямо сюда, и мы ответим вам в ближайшее время.', Markup.inlineKeyboard([
            [Markup.button.callback('❌ Выйти из поддержки', 'support_exit')]
        ]));
    } catch (e) {
        console.error('Ошибка в support_enter:', e.message);
    }
});

bot.action('support_exit', async (ctx) => {
    try {
        await ctx.answerCbQuery();
        await updateUserField(ctx.from.id, 'support_mode', false);
        await ctx.reply('❌ Вы вышли из чата поддержки. Вы можете продолжать отправлять ссылки для скачивания треков.', getMainKeyboard());
    } catch (e) {
        console.error('Ошибка в support_exit:', e.message);
    }
});

bot.action(/^reply_user:(.+)$/, async (ctx) => {
    if (Number(ctx.from.id) !== Number(ADMIN_ID)) return ctx.answerCbQuery('Доступ запрещен ❌', { show_alert: true });
    const targetUserId = ctx.match[1];
    adminReplySessions.set(ctx.from.id, targetUserId);
    await ctx.answerCbQuery();
    await ctx.reply(`✍️ Введите ответ для пользователя (ID: ${targetUserId}):\n\n(Для отмены отправьте /cancel)`);
});

bot.command('referral', handleReferralCommand);
// bot.js

bot.command('maintenance', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    
    const command = ctx.message.text.split(' ')[1]?.toLowerCase();
    
    if (command === 'on') {
        await setMaintenanceMode(true);
        await ctx.reply('✅ Режим обслуживания ВКЛЮЧЕН.');
    } else if (command === 'off') {
        await setMaintenanceMode(false);
        await ctx.reply('☑️ Режим обслуживания ВЫКЛЮЧЕН.');
    } else {
        await ctx.reply('ℹ️ Статус: ' + (isMaintenanceMode() ? 'ВКЛЮЧЕН' : 'ВЫКЛЮЧЕН') + '\n\nИспользуйте: `/maintenance on` или `/maintenance off`');
    }
});
bot.command('premium', (ctx) => ctx.reply(T('upgradeInfo'), { parse_mode: 'HTML', disable_web_page_preview: true }));
// bot.js
// ==========================================================
//    ДОБАВЬ ЭТОТ БЛОК ДЛЯ ОБРАБОТКИ КНОПКИ "ПОЛУЧИТЬ БОНУС"
// ==========================================================

bot.action('check_subscription', async (ctx) => {
    try {
        console.log(`[Bonus] User ${ctx.from.id} пытается получить бонус.`);

        // Убедимся, что у нас есть актуальные данные о пользователе
        const user = await getUser(ctx.from.id);
        if (user.subscribed_bonus_used) {
            console.log(`[Bonus] User ${ctx.from.id} уже использовал бонус.`);
            return await ctx.answerCbQuery('Вы уже использовали этот бонус.', { show_alert: true });
        }

        console.log(`[Bonus] Проверяю подписку для ${ctx.from.id} на канал ${CHANNEL_USERNAME}`);
        const subscribed = await isSubscribed(ctx.from.id);

        if (subscribed) {
            console.log(`[Bonus] User ${ctx.from.id} подписан. Начисляю бонус.`);
            await setPremium(ctx.from.id, 30, 7); // 30 скачиваний в день на 7 дней
            await updateUserField(ctx.from.id, 'subscribed_bonus_used', true);
            await logUserAction(ctx.from.id, 'bonus_received');
            
            // Завершаем "загрузку" кнопки
            await ctx.answerCbQuery('Бонус начислен!');
            // Меняем сообщение, чтобы кнопка исчезла
            await ctx.editMessageText('🎉 Поздравляем! Вам начислено 7 дней тарифа Plus. Спасибо за подписку!');

        } else {
            console.log(`[Bonus] User ${ctx.from.id} НЕ подписан.`);
            return await ctx.answerCbQuery(`Вы еще не подписаны на канал ${CHANNEL_USERNAME}. Пожалуйста, подпишитесь и нажмите кнопку снова.`, { show_alert: true });
        }
    } catch (e) {
        console.error(`🔴 КРИТИЧЕСКАЯ ОШИБКА в check_subscription для user ${ctx.from.id}:`, e);
        // В случае любой ошибки, мы должны завершить "загрузку" кнопки
        await ctx.answerCbQuery('Произошла ошибка. Пожалуйста, попробуйте позже.', { show_alert: true });
    }
});

// ========================= ОБРАБОТЧИКИ ВЫБОРА КАЧЕСТВА =========================

// Spotify качество
bot.action(/^spq:(.+):(.+)$/, async (ctx) => {
    const sessionId = ctx.match[1];
    const quality = ctx.match[2];
    console.log(`[Spotify] Выбор качества: session=${sessionId}, quality=${quality}`);
    await handleSpotifyQuality(ctx, sessionId, quality);
});

// YouTube качество
bot.action(/^ytq:(.+):(.+)$/, async (ctx) => {
    const sessionId = ctx.match[1];
    const quality = ctx.match[2];
    console.log(`[YouTube] Выбор качества: session=${sessionId}, quality=${quality}`);
    await handleYouTubeQualitySelection(ctx, sessionId, quality);
});
const menuHandler = async (ctx) => {
    const user = await getUser(ctx.from.id);
    const message = formatMenuMessage(user, ctx.botInfo.username);
    const extraOptions = { 
        parse_mode: 'HTML',
        disable_web_page_preview: true
    };
    if (!user.subscribed_bonus_used && CHANNEL_USERNAME) {
        extraOptions.reply_markup = { 
            inline_keyboard: [[ Markup.button.callback('✅ Я подписался и хочу бонус!', 'check_subscription') ]] 
        };
    } else {
        Object.assign(extraOptions, getMainKeyboard());
    }
    await ctx.reply(message, extraOptions);
};

const recognizeHandler = (ctx) => ctx.reply('Просто отправьте или перешлите мне:\n🎤 Голосовое сообщение\n📹 Видео-кружок\n🎧 Аудиофайл\n\n...и я скажу, что это за трек!', getMainKeyboard());

const mytracksHandler = async (ctx) => {
    try {
        const user = await getUser(ctx.from.id);
        if (!user.tracks_today || user.tracks_today.length === 0) return await ctx.reply(T('noTracks'), getMainKeyboard());
        for (let i = 0; i < user.tracks_today.length; i += 10) {
            const chunk = user.tracks_today.slice(i, i + 10).filter(t => t && t.fileId);
            if (chunk.length > 0) await ctx.replyWithMediaGroup(chunk.map(t => ({ type: 'audio', media: t.fileId })));
        }
    } catch (e) { console.error(`🔴 Ошибка в mytracks для ${ctx.from.id}:`, e.message); }
};

const supportCommandHandler = async (ctx) => {
    try {
        await updateUserField(ctx.from.id, 'support_mode', true);
        await ctx.reply('✉️ Вы вошли в чат с поддержкой.\n\nНапишите ваш вопрос или проблему прямо сюда, и мы ответим вам в ближайшее время.', Markup.inlineKeyboard([
            [Markup.button.callback('❌ Выйти из поддержки', 'support_exit')]
        ]));
    } catch (e) {
        console.error('Ошибка при входе в поддержку:', e.message);
        await ctx.reply('Не удалось войти в чат поддержки. Попробуйте еще раз.').catch(() => {});
    }
};

const helpHandler = (ctx) => ctx.reply(T('helpInfo'), { 
    parse_mode: 'HTML', 
    disable_web_page_preview: true,
    ...getMainKeyboard(),
    ...Markup.inlineKeyboard([
        [Markup.button.callback('✉️ Написать в поддержку', 'support_enter')]
    ])
});
const upgradeHandler = (ctx) => ctx.reply(T('upgradeInfo'), { 
    parse_mode: 'HTML', 
    disable_web_page_preview: true,
    ...getMainKeyboard()
});

bot.hears(T('menu'), menuHandler);
bot.hears('🆔 Распознать', recognizeHandler);
bot.hears(T('mytracks'), mytracksHandler);
bot.hears(T('help'), helpHandler);
bot.hears(T('upgrade'), upgradeHandler);

bot.command('menu', menuHandler);
bot.command('subs', menuHandler);
bot.command('mytracks', mytracksHandler);
bot.command('help', helpHandler);
bot.command('support', supportCommandHandler);
bot.command('upgrade', upgradeHandler);
bot.command('tariffs', upgradeHandler);
bot.command('shazam', recognizeHandler);

const vpnHandler = (ctx) => {
    if (getSetting('use_vpn') === 'false') return;

    const message = getSetting('vpn_message_text') ||
        '🚀 <b>YouTube тормозит, а Spotify не работает?</b>\n\n' +
        'Рекомендую VPN, которым пользуюсь сам — <b>South Networks</b>.\n\n' +
        '✅ YouTube в 4K без лагов\n' +
        '✅ Instagram, Netflix, Spotify\n' +
        '✅ Высокая скорость (приватные серверы)\n\n' +
        '🎁 <b>Дают 2 дня бесплатного теста</b> всем новым пользователям. Попробуйте сами:';

    const btnText = getSetting('vpn_button_url_text') || '⚡️ Попробовать бесплатно';
    const btnLink = getSetting('vpn_link') || 'https://t.me/southnetworksvpnbot?start=783629145';

    return ctx.reply(message, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...Markup.inlineKeyboard([
            [Markup.button.url(btnText, btnLink)]
        ])
    });
};

bot.hears((text) => {
    if (getSetting('use_vpn') === 'false') return false;
    const vpnText = getSetting('vpn_button_text') || '🔐 VPN (YouTube 4K)';
    return text === vpnText || text === T('vpn');
}, vpnHandler);

bot.command('vpn', vpnHandler);

bot.on('inline_query', async (ctx) => {
    const query = ctx.inlineQuery.query;
    if (!query || query.trim().length < 2) return await ctx.answerInlineQuery([], { switch_pm_text: 'Введите название трека для поиска...', switch_pm_parameter: 'start' });
    try {
        const results = await performInlineSearch(query, ctx.from.id);
        await ctx.answerInlineQuery(results, { cache_time: 60 });
    } catch (error) {
        console.error('[Inline Query] Глобальная ошибка:', error);
        await ctx.answerInlineQuery([]);
    }
});

// --- Логика обработки плейлистов ---
async function getPlaylistLimitForUser(userId) {
    try {
        const user = await getUser(userId);
        const limitFree = parseInt(getSetting('daily_limit_free') || '3', 10);
        const limitPlus = parseInt(getSetting('daily_limit_plus') || '30', 10);
        const limitPro = parseInt(getSetting('daily_limit_pro') || '100', 10);
        
        const userLimit = user ? (user.premium_limit || limitFree) : limitFree;
        
        if (userLimit <= limitFree) {
            return parseInt(getSetting('playlist_limit_free') || '3', 10);
        } else if (userLimit <= limitPlus) {
            return parseInt(getSetting('playlist_limit_plus') || '30', 10);
        } else if (userLimit <= limitPro) {
            return parseInt(getSetting('playlist_limit_pro') || '100', 10);
        } else {
            return parseInt(getSetting('playlist_limit_unlim') || '10000', 10);
        }
    } catch (e) {
        console.error('Ошибка в getPlaylistLimitForUser:', e.message);
        return 3;
    }
}

function generateInitialPlaylistMenu(playlistId, trackCount, playlistLimit) {
    const buttons = [
        [Markup.button.callback(`📥 Скачать все (${trackCount})`, `pl_download_all:${playlistId}`)]
    ];
    if (trackCount > playlistLimit) {
        buttons.push([Markup.button.callback(`📥 Скачать первые ${playlistLimit}`, `pl_download_limit:${playlistId}`)]);
    }
    buttons.push([Markup.button.callback('📝 Выбрать треки вручную', `pl_select_manual:${playlistId}`)]);
    buttons.push([Markup.button.callback('❌ Отмена', `pl_cancel:${playlistId}`)]);
    return Markup.inlineKeyboard(buttons);
}

function generateSelectionMenu(userId) {
    const session = playlistSessions.get(userId);
    if (!session) return null;
    const { tracks, selected, currentPage, playlistId, title } = session;
    const totalPages = Math.ceil(tracks.length / TRACKS_PER_PAGE);
    const startIndex = currentPage * TRACKS_PER_PAGE;
    const tracksOnPage = tracks.slice(startIndex, startIndex + TRACKS_PER_PAGE);
    const trackRows = tracksOnPage.map((track, index) => {
        const absoluteIndex = startIndex + index;
        const isSelected = selected.has(absoluteIndex);
        const icon = isSelected ? '✅' : '⬜️';
        const trackTitleText = track.title || 'Трек без названия';
        const trackTitle = trackTitleText.length > 50 ? trackTitleText.slice(0, 47) + '...' : trackTitleText;
        return [Markup.button.callback(`${icon} ${trackTitle}`, `pl_toggle:${playlistId}:${absoluteIndex}`)];
    });
    const navRow = [];
    if (currentPage > 0) navRow.push(Markup.button.callback('⬅️ Назад', `pl_page:${playlistId}:${currentPage - 1}`));
    navRow.push(Markup.button.callback(`${currentPage + 1}/${totalPages}`, 'pl_nop'));
    if (currentPage < totalPages - 1) navRow.push(Markup.button.callback('Вперед ➡️', `pl_page:${playlistId}:${currentPage + 1}`));
    const actionRow = [
        Markup.button.callback(`✅ Готово (${selected.size})`, `pl_finish:${playlistId}`),
        Markup.button.callback(`❌ Отмена`, `pl_cancel:${playlistId}`)
    ];
    const messageText = `🎶 <b>${title}</b>\n\nВыберите треки (Стр. ${currentPage + 1}/${totalPages}):`;
    return {
        text: messageText,
        options: { parse_mode: 'HTML', ...Markup.inlineKeyboard([...trackRows, navRow, actionRow]) }
    };
}

// --- Обработчики кнопок плейлистов (actions) ---
bot.action('pl_nop', (ctx) => ctx.answerCbQuery());

async function processPlaylistDownload(ctx, session, isAll, userId) {
    // 1. Проверяем лимиты ДО загрузки полных данных плейлиста
    const user = await getUser(userId);
    const isAdmin = Number(userId) === Number(ADMIN_ID);
    const remainingLimit = isAdmin ? 99999 : user.premium_limit - (user.downloads_today || 0);

    if (remainingLimit <= 0) {
        const bonusAvailable = Boolean(CHANNEL_USERNAME && !user.subscribed_bonus_used);
        const cleanUsername = CHANNEL_USERNAME?.replace('@', '');
        const bonusText = bonusAvailable
            ? `\n\n🎁 Доступен бонус! Подпишись на <a href="https://t.me/${cleanUsername}">@${cleanUsername}</a> и получи <b>7 дней тарифа Plus</b>.`
            : '';
        const extra = { parse_mode: 'HTML', disable_web_page_preview: true };
        if (bonusAvailable) {
            extra.reply_markup = {
                inline_keyboard: [[ { text: '✅ Я подписался, забрать бонус', callback_data: 'check_subscription' } ]]
            };
        }
        await ctx.editMessageText(`${T('limitReached')}${bonusText}`, extra);
        playlistSessions.delete(userId);
        return;
    }

    if (!session.fullTracks) {
        await ctx.editMessageText('⏳ Получаю полные данные плейлиста... Это может занять несколько минут.');
        try {
            const youtubeDl = getYoutubeDl();
            const fullData = await youtubeDl(session.originalUrl, { dumpSingleJson: true, ignoreErrors: true });
            const originalTracks = session.tracks || [];
            const resolvedIds = new Set(fullData.entries.filter(t => t && t.id).map(t => String(t.id)));
            session.skippedTracks = originalTracks.filter(t => t && !resolvedIds.has(String(t.id)));
            session.tracks = fullData.entries.filter(track => track && track.url);
            session.fullTracks = true;
        } catch (e) {
            console.error('[Playlist] Ошибка фоновой загрузки:', e);
            await ctx.editMessageText('❌ Не удалось получить полную информацию о плейлисте. Попробуйте еще раз.');
            playlistSessions.delete(userId);
            return;
        }
    }

    const playlistLimit = await getPlaylistLimitForUser(userId);
    const tracksToTake = isAll ? Math.min(session.tracks.length, playlistLimit) : playlistLimit;
    
    let limitMessage = '';
    if (session.tracks.length > playlistLimit) {
        limitMessage = `⚠️ Внимание: согласно лимитам вашего тарифа, вы можете загрузить максимум <b>${playlistLimit}</b> трек(ов) из одного плейлиста.\n\n`;
    }

    await ctx.editMessageText('✅ Отлично! Добавляю треки в очередь...');

    const numberOfTracksToQueue = Math.min(tracksToTake, remainingLimit);
    const tracksToProcess = session.tracks.slice(0, numberOfTracksToQueue);

    for (const track of tracksToProcess) {
        addTaskToQueue({
            userId,
            source: 'soundcloud',
            url: track.webpage_url || track.url,
            originalUrl: track.webpage_url || track.url,
            metadata: track,
        });
    }

    let reportMessage = `${limitMessage}⏳ ${tracksToProcess.length} трек(ов) добавлено в очередь.`;
    if (numberOfTracksToQueue < tracksToTake) {
        reportMessage += '\n\nℹ️ Ваш дневной лимит будет исчерпан. Остальные треки из плейлиста не были добавлены.';
    }
    if (session.skippedTracks && session.skippedTracks.length > 0) {
        reportMessage += '\n\n⚠️ <b>Пропущены из-за DRM (SoundCloud Go+):</b>\n';
        session.skippedTracks.slice(0, 10).forEach((t, i) => {
            const trackName = t.title || (t.url && !t.url.includes('api-v2.soundcloud.com') ? t.url.split('/').slice(-2).join('/') : null) || `Трек ID: ${t.id}`;
            reportMessage += `${i + 1}. <i>${trackName}</i>\n`;
        });
        if (session.skippedTracks.length > 10) {
            reportMessage += `...и ещё ${session.skippedTracks.length - 10} трек(ов).`;
        }
    }
    await bot.telegram.sendMessage(userId, reportMessage, { parse_mode: 'HTML' });
    playlistSessions.delete(userId);
}

bot.action(/pl_download_all:|pl_download_limit:/, async (ctx) => {
    const isAll = ctx.callbackQuery.data.includes('pl_download_all');
    const playlistId = ctx.callbackQuery.data.split(':')[1];
    const userId = ctx.from.id;
    const session = playlistSessions.get(userId);
    
    if (!session) {
        return await ctx.answerCbQuery('❗️ Сессия выбора истекла.', { show_alert: true });
    }

    // Если данные ещё не загружены — отвечаем на callback и запускаем фоновую обработку.
    // Handler завершается сразу, тяжёлая работа идёт вне Telegraf handlerTimeout.
    await ctx.answerCbQuery('⏳ Обрабатываю...');

    processPlaylistDownload(ctx, session, isAll, userId).catch(e => {
        console.error(`[Playlist] Ошибка фоновой обработки для ${userId}:`, e.message);
        bot.telegram.sendMessage(userId, '❌ Ошибка при обработке плейлиста. Попробуйте ещё раз.').catch(() => {});
    });
});

bot.action(/pl_select_manual:(.+)/, async (ctx) => {
    const userId = ctx.from.id;
    const playlistId = ctx.match[1];
    const session = playlistSessions.get(userId);
    
    if (!session || session.playlistId !== playlistId) {
        return await ctx.answerCbQuery('❗️ Сессия выбора истекла.', { show_alert: true });
    }
    
    // 1. Проверяем лимиты ДО загрузки названий!
    const user = await getUser(userId);
    const isAdmin = Number(userId) === Number(ADMIN_ID);
    const remainingLimit = isAdmin ? 99999 : user.premium_limit - (user.downloads_today || 0);
    if (remainingLimit <= 0) {
        const bonusAvailable = Boolean(CHANNEL_USERNAME && !user.subscribed_bonus_used);
        const cleanUsername = CHANNEL_USERNAME?.replace('@', '');
        const bonusText = bonusAvailable
            ? `\n\n🎁 Доступен бонус! Подпишись на <a href="https://t.me/${cleanUsername}">@${cleanUsername}</a> и получи <b>7 дней тарифа Plus</b>.`
            : '';
        const extra = { parse_mode: 'HTML', disable_web_page_preview: true };
        if (bonusAvailable) {
            extra.reply_markup = { inline_keyboard: [[ { text: '✅ Я подписался, забрать бонус', callback_data: 'check_subscription' } ]] };
        }
        await ctx.editMessageText(`${T('limitReached')}${bonusText}`, extra);
        playlistSessions.delete(userId);
        return await ctx.answerCbQuery('Лимит исчерпан');
    }

    let queryAnswered = false;
    // Проверяем, есть ли у нас уже полные данные с названиями
    if (!session.fullTracks) {
        await ctx.answerCbQuery('⏳ Загружаю названия треков...');
        queryAnswered = true;
        await ctx.editMessageText('⏳ Получаю полные данные плейлиста... Это может занять несколько секунд.');
        
        try {
            const youtubeDl = getYoutubeDl();
            const fullData = await youtubeDl(session.originalUrl, { dumpSingleJson: true, ignoreErrors: true });
            const originalTracks = session.tracks || [];
            const resolvedIds = new Set(fullData.entries.filter(t => t && t.id).map(t => String(t.id)));
            session.skippedTracks = originalTracks.filter(t => t && !resolvedIds.has(String(t.id)));
            session.tracks = fullData.entries.filter(track => track && track.url);
            session.fullTracks = true; // Ставим флаг, что данные загружены
        } catch (e) {
            console.error('[Playlist] Ошибка при дозагрузке названий:', e);
            await ctx.editMessageText('❌ Не удалось получить детали плейлиста. Попробуйте снова или выберите другой вариант.');
            return;
        }
    }

    if (!queryAnswered) {
        await ctx.answerCbQuery();
    }
    
    // 4. Когда все готово, показываем меню выбора с названиями
    session.currentPage = 0;
    session.selected = new Set();
    const menu = generateSelectionMenu(userId);
    if (menu) {
        try {
            await ctx.editMessageText(menu.text, menu.options);
        } catch (e) { /* Игнорируем */ }
    }
});
bot.action(/pl_page:(.+):(\d+)/, async (ctx) => {
    const [playlistId, pageStr] = ctx.match.slice(1);
    const userId = ctx.from.id;
    const session = playlistSessions.get(userId);
    if (!session || session.playlistId !== playlistId) return await ctx.answerCbQuery('Сессия истекла.');
    session.currentPage = parseInt(pageStr, 10);
    const menu = generateSelectionMenu(userId);
    if (menu) try { await ctx.editMessageText(menu.text, menu.options); } catch (e) {}
    await ctx.answerCbQuery();
});

bot.action(/pl_toggle:(.+):(\d+)/, async (ctx) => {
    const [playlistId, indexStr] = ctx.match.slice(1);
    const userId = ctx.from.id;
    const session = playlistSessions.get(userId);
    if (!session || session.playlistId !== playlistId) return await ctx.answerCbQuery('Сессия истекла.');
    const trackIndex = parseInt(indexStr, 10);
    if (session.selected.has(trackIndex)) session.selected.delete(trackIndex);
    else session.selected.add(trackIndex);
    const menu = generateSelectionMenu(userId);
    if (menu) try { await ctx.editMessageText(menu.text, menu.options); } catch (e) {}
    await ctx.answerCbQuery();
});

// bot.js

// bot.js (ФИНАЛЬНАЯ ВЕРСИЯ ОБРАБОТЧИКА КНОПКИ "ГОТОВО")

bot.action(/pl_finish:(.+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const playlistId = ctx.match[1];
    const userId = ctx.from.id;
    const session = playlistSessions.get(userId);
    
    if (!session) {
        return await ctx.reply('❗️ Сессия выбора истекла.');
    }
    if (session.selected.size === 0) {
        return await ctx.reply('Вы не выбрали ни одного трека.');
    }
    
    // --- 0. Проверка лимитов на плейлист для тарифа ---
    const isAdmin = Number(userId) === Number(ADMIN_ID);
    if (!isAdmin) {
        const playlistLimit = await getPlaylistLimitForUser(userId);
        if (session.selected.size > playlistLimit) {
            return await ctx.reply(`❌ Вы не можете выбрать более ${playlistLimit} треков за раз (лимит вашего тарифа на импорт плейлистов).`);
        }
    }
    
    // Так как названия важны, оставляем проверку, что они были загружены
    if (!session.fullTracks) {
        return await ctx.answerCbQuery('❌ Произошла ошибка: данные плейлиста не были загружены. Попробуйте заново.', { show_alert: true });
    }
    
    // --- 1. Проверка лимитов пользователя ---
    const user = await getUser(userId);
    const remainingLimit = isAdmin ? 99999 : user.premium_limit - (user.downloads_today || 0);
    
    if (remainingLimit <= 0) {
  const bonusAvailable = Boolean(CHANNEL_USERNAME && !user.subscribed_bonus_used);
  const cleanUsername = CHANNEL_USERNAME?.replace('@', '');
  const bonusText = bonusAvailable
    ? `\n\n🎁 Доступен бонус! Подпишись на <a href="https://t.me/${cleanUsername}">@${cleanUsername}</a> и получи <b>7 дней тарифа Plus</b>.`
    : '';
  const extra = {
    parse_mode: 'HTML',
    disable_web_page_preview: true
  };
  if (bonusAvailable) {
    extra.reply_markup = {
      inline_keyboard: [[ { text: '✅ Я подписался, забрать бонус', callback_data: 'check_subscription' } ]]
    };
  }
  await ctx.editMessageText(`${T('limitReached')}${bonusText}`, extra);
  playlistSessions.delete(userId);
  return;
}
    
    await ctx.editMessageText(`✅ Готово! Добавляю ${session.selected.size} выбранных треков в очередь...`);
    
    // --- 2. Формирование очереди С УЧЕТОМ ЛИМИТА ---
    const selectedIndexes = Array.from(session.selected);
    const numberOfTracksToQueue = Math.min(selectedIndexes.length, remainingLimit);
    
    const tracksToProcess = selectedIndexes.slice(0, numberOfTracksToQueue).map(index => session.tracks[index]);
    
    // --- 3. Простая постановка задач в очередь (БЕЗ ПРОВЕРКИ КЭША) ---
    for (const track of tracksToProcess) {
        addTaskToQueue({
            userId,
            source: 'soundcloud',
            url: track.webpage_url || track.url,
            originalUrl: track.webpage_url || track.url,
            metadata: track,
            
        });
    }
    
    // --- 4. Корректный отчет пользователю ---
    let reportMessage = `⏳ ${tracksToProcess.length} трек(ов) добавлено в очередь.`;
    if (numberOfTracksToQueue < selectedIndexes.length) {
        reportMessage += `\n\nℹ️ Ваш дневной лимит будет исчерпан. Остальные выбранные треки не были добавлены.`;
    }
    if (session.skippedTracks && session.skippedTracks.length > 0) {
        reportMessage += '\n\n⚠️ <b>Пропущены из-за DRM (SoundCloud Go+):</b>\n';
        session.skippedTracks.slice(0, 10).forEach((t, i) => {
            const trackName = t.title || (t.url && !t.url.includes('api-v2.soundcloud.com') ? t.url.split('/').slice(-2).join('/') : null) || `Трек ID: ${t.id}`;
            reportMessage += `${i + 1}. <i>${trackName}</i>\n`;
        });
        if (session.skippedTracks.length > 10) {
            reportMessage += `...и ещё ${session.skippedTracks.length - 10} трек(ов).`;
        }
    }
    
    await ctx.reply(reportMessage, { parse_mode: 'HTML' });
    playlistSessions.delete(userId);
});
bot.action(/pl_cancel:(.+)/, async (ctx) => {
    const userId = ctx.from.id;
    const session = playlistSessions.get(userId);
    
    // Если по какой-то причине сессии уже нет, просто удаляем сообщение
    if (!session) {
        await ctx.deleteMessage().catch(() => {});
        return await ctx.answerCbQuery();
    }
    
    // Восстанавливаем текст и кнопки первоначального меню
    const playlistLimit = await getPlaylistLimitForUser(userId);
    const message = `🎶 В плейлисте <b>"${session.title}"</b> найдено <b>${session.tracks.length}</b> треков.\n\nЧто делаем?`;
    const initialMenu = generateInitialPlaylistMenu(session.playlistId, session.tracks.length, playlistLimit);
    
    // Редактируем текущее сообщение, возвращая его к исходному виду
    try {
        await ctx.editMessageText(message, {
            parse_mode: 'HTML',
            ...initialMenu
        });
        await ctx.answerCbQuery('Возвращаю...');
    } catch (e) {
        // Если сообщение не изменилось, просто игнорируем ошибку
        await ctx.answerCbQuery();
    }
});

// === ФУНКЦИЯ ДЛЯ РАСШИФРОВКИ КОРОТКИХ ССЫЛОК (on.soundcloud.com) ===
async function resolveSoundCloudLink(url) {
    // Если это не короткая ссылка, возвращаем как есть
    if (!url || !url.includes('on.soundcloud.com')) return url;

    try {
        console.log(`[LinkResolve] Расшифровываю короткую ссылку: ${url}`);
        // Делаем запрос, axios автоматически пройдет по редиректам
        const response = await axios.get(url, {
            maxRedirects: 5,
            // Притворяемся браузером, чтобы SoundCloud не кинул на страницу скачивания приложения
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36' 
            }
        });
        
        // В Node.js axios возвращает итоговый URL в request.res.responseUrl
        const finalUrl = response.request.res.responseUrl || url;
        console.log(`[LinkResolve] Успех: ${finalUrl}`);
        return finalUrl;
    } catch (e) {
        console.error(`[LinkResolve] Не удалось расшифровать ссылку: ${e.message}`);
        return url; // Если ошибка, пробуем вернуть оригинал, вдруг сработает
    }
}

// ЭТО НОВАЯ ФУНКЦИЯ-"ПОМОЩНИК", КОТОРАЯ БУДЕТ РАБОТАТЬ В ФОНЕ
async function processUrlInBackground(ctx, url) {
    let loadingMessage;
    try {
        loadingMessage = await ctx.reply('🔍 Анализирую ссылку...');
        
        const resolvedUrl = await resolveSoundCloudLink(url);
        const cleanUrl = resolvedUrl.split('?')[0]; // Очищаем
        
        const youtubeDl = getYoutubeDl();
        let data;
        try {
            data = await youtubeDl(cleanUrl, { dumpSingleJson: true, flatPlaylist: true, ignoreErrors: true });
        } catch (ytdlError) {
            const errText = ytdlError.stderr || ytdlError.message || '';
            console.error(`[youtube-dl] Ошибка для ${cleanUrl}:`, errText);
            if (errText.includes('DRM protected')) {
                throw new Error('DRM_PROTECTED');
            }
            throw new Error('Ошибка.');
        }

        if (!data) throw new Error('Пустой ответ.');

        if (data.entries && data.entries.length > 0) {
            await ctx.deleteMessage(loadingMessage.message_id).catch(() => {});
            const playlistId = `pl_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
            playlistSessions.set(ctx.from.id, {
                playlistId,
                title: data.title,
                tracks: data.entries.filter(track => track && track.url),
                originalUrl: cleanUrl,
                selected: new Set(),
                currentPage: 0,
                fullTracks: false
            });
            const playlistLimit = await getPlaylistLimitForUser(ctx.from.id);
            const message = `🎶 В плейлисте <b>"${escapeHtml(data.title)}"</b> найдено <b>${data.entries.length}</b> треков.\n\nЧто делаем?`;
            await ctx.reply(message, { parse_mode: 'HTML', ...generateInitialPlaylistMenu(playlistId, data.entries.length, playlistLimit) });
            
        } else {
            // Лимиты пропускаю для краткости, они у тебя правильные
            await ctx.telegram.editMessageText(ctx.chat.id, loadingMessage.message_id, undefined, '✅ Распознал трек, ставлю в очередь...');
            setTimeout(() => ctx.deleteMessage(loadingMessage.message_id).catch(() => {}), 3000);
            
            addTaskToQueue({
                userId: ctx.from.id,
                source: 'soundcloud',
                url: data.webpage_url || cleanUrl,
                originalUrl: data.webpage_url || cleanUrl,
                metadata: { id: data.id, title: data.title, uploader: data.uploader, duration: data.duration, thumbnail: data.thumbnail },
                ctx: null
            });
        }
    } catch (error) {
        let userMessage = '❌ Не удалось обработать ссылку.';
        if (error.message === 'DRM_PROTECTED') {
            userMessage = '❌ Этот трек защищен DRM-защитой (SoundCloud Go+). Скачивание платных премиум-треков невозможно.';
        }
        if (loadingMessage) await ctx.telegram.editMessageText(ctx.chat.id, loadingMessage.message_id, undefined, userMessage).catch(() => {});
    }
}
async function handleSoundCloudUrl(ctx, url) {
    let loadingMessage;
    try {
        // Ранняя проверка лимитов (для всех, кроме админа)
        const isAdmin = Number(ctx.from.id) === Number(ADMIN_ID);
        if (!isAdmin) {
            const user = await getUser(ctx.from.id);
            if ((user.downloads_today || 0) >= (user.premium_limit || 0)) {
                const bonusAvailable = Boolean(CHANNEL_USERNAME && !user.subscribed_bonus_used);
                const cleanUsername = CHANNEL_USERNAME?.replace('@', '');
                const bonusText = bonusAvailable
                  ? `\n\n🎁 Доступен бонус! Подпишись на <a href="https://t.me/${cleanUsername}">@${cleanUsername}</a> и получи <b>7 дней тарифа Plus</b>.`
                  : '';
                const extra = { parse_mode: 'HTML', disable_web_page_preview: true };
                if (bonusAvailable) {
                  extra.reply_markup = { inline_keyboard: [[ { text: '✅ Я подписался, забрать бонус', callback_data: 'check_subscription' } ]] };
                }
                await ctx.reply(`${T('limitReached')}${bonusText}`, extra);
                return;
            }
        }

        loadingMessage = await ctx.reply('🔍 Анализирую ссылку...');
        
        // 1. Расшифровываем и очищаем от рекламных меток
        const resolvedUrl = await resolveSoundCloudLink(url);
        const cleanUrl = resolvedUrl.split('?')[0]; 
        
        // 🔥 ДВОЙНАЯ ПРОВЕРКА КЭША: ищем и чистую, и старую "грязную" ссылку
        let cachedTrack = await findCachedTrack(cleanUrl, { source: 'soundcloud' });
        if (!cachedTrack) {
            cachedTrack = await findCachedTrack(resolvedUrl, { source: 'soundcloud' });
        }
        
        const hasBadCachedTitle = !cachedTrack || 
                                  !cachedTrack.title || 
                                  cachedTrack.title === 'null' || 
                                  cachedTrack.title === 'undefined' || 
                                  cachedTrack.title === 'track' || 
                                  cachedTrack.title.startsWith('scdl_') || 
                                  cachedTrack.title.startsWith('dl_');
                                  
        if (cachedTrack && cachedTrack.fileId && !hasBadCachedTitle) {
            console.log(`[Fast-Track] Трек найден в SQL, обход yt-dlp: ${cleanUrl}`);
            await ctx.deleteMessage(loadingMessage.message_id).catch(() => {});
            
            await ctx.replyWithAudio(cachedTrack.fileId, { 
                title: cachedTrack.title, 
                performer: cachedTrack.artist || 'Unknown' 
            });
            
            await incrementDownloadsAndSaveTrack(ctx.from.id, cachedTrack.title, cachedTrack.fileId, cleanUrl, 'soundcloud');
            return;
        }

        // Если в кэше нет — лезем в интернет
        const youtubeDl = getYoutubeDl();
        let data;
        try {
            data = await youtubeDl(cleanUrl, { dumpSingleJson: true, flatPlaylist: true, ignoreErrors: true });
        } catch (ytdlError) {
            const errText = ytdlError.stderr || ytdlError.message || '';
            console.error(`[youtube-dl] ДЕТАЛИ ОШИБКИ для ${cleanUrl}:`, errText);
            if (errText.includes('DRM protected')) {
                throw new Error('DRM_PROTECTED');
            }
            throw new Error('Ошибка при запросе к SoundCloud (см. логи)');
        }
        
        if (!data) {
            console.error('[yt-dlp] data пустой:', cleanUrl);
            throw new Error('Пустой ответ от yt-dlp.');
        }
        
        if (data.entries && data.entries.length > 1) {
            // Плейлист
            await ctx.deleteMessage(loadingMessage.message_id).catch(() => {});
            
            const playlistId = `pl_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
            playlistSessions.set(ctx.from.id, {
                playlistId,
                title: data.title,
                tracks: data.entries.filter(track => track && track.url),
                originalUrl: cleanUrl, 
                selected: new Set(),
                currentPage: 0,
                fullTracks: false
            });
            
            const playlistLimit = await getPlaylistLimitForUser(ctx.from.id);
            const message = `🎶 В плейлисте <b>"${escapeHtml(data.title)}"</b> найдено <b>${data.entries.length}</b> треков.\n\nЧто делаем?`;
            await ctx.reply(message, { parse_mode: 'HTML', ...generateInitialPlaylistMenu(playlistId, data.entries.length, playlistLimit) });
            
        } else {
            // Одиночный трек
            await ctx.deleteMessage(loadingMessage.message_id).catch(() => {});
            enqueue(ctx, ctx.from.id, cleanUrl, { isSingleTrack: true, metadata: data });
        }
        
    } catch (error) {
        console.error('Ошибка handleSoundCloudUrl:', error.message);
        let userMessage = '❌ Не удалось обработать ссылку. Возможно, трек удален или заблокирован.';
        if (error.message === 'DRM_PROTECTED') {
            userMessage = '❌ Этот трек защищен DRM-защитой (SoundCloud Go+). Скачивание платных премиум-треков невозможно.';
        }
        if (loadingMessage) {
            await ctx.telegram.editMessageText(ctx.chat.id, loadingMessage.message_id, undefined, userMessage).catch(() => {});
        } else {
            await ctx.reply(userMessage);
        }
    }
}
const handleMediaForShazam = async (ctx) => {
    const message = ctx.message;

    // 🛑 ФИКС: Если сообщение отправлено через этого же бота (результат поиска), игнорируем его
    if (message.via_bot && message.via_bot.id === ctx.botInfo.id) {
        return;
    }

    let fileId = null;

    if (message.voice) fileId = message.voice.file_id;
    else if (message.video_note) fileId = message.video_note.file_id;
    else if (message.audio) fileId = message.audio.file_id;
    else if (message.video) fileId = message.video.file_id;
    
    if (!fileId) return;
    
    const isVoiceOrNote = !!(message.voice || message.video_note);
    // Можно раскомментировать, если хотите, чтобы аудио файлы распознавались только по команде
    // if (!isVoiceOrNote && !message.caption?.toLowerCase().includes('shazam')) return;

    let statusMsg;
    try {
        statusMsg = await ctx.reply('👂 Слушаю...');
        const fileLink = await ctx.telegram.getFileLink(fileId);
        
        const result = await identifyTrack(fileLink.href);
        
        await ctx.deleteMessage(statusMsg.message_id).catch(() => {});

        if (result) {
            const query = `${result.artist} - ${result.title}`;
            
            // Ищем в кэше
            const searchResults = await performInlineSearch(query, ctx.from.id);
            const cachedCount = searchResults.filter(r => r.audio_file_id).length;

            let text = `🎵 <b>Shazam:</b>\n\n🎤 <b>${result.artist}</b>\n🎼 <b>${result.title}</b>`;
            
            // Кнопки
            const buttons = [];

            if (cachedCount > 0) {
                text += `\n\n📂 Нашел вариантов: <b>${cachedCount}</b>.`;
                text += `\n👇 Нажми кнопку, чтобы выбрать нужную версию:`;
                
                // Кнопка открывает встроенный поиск с результатами из кэша
                buttons.push([Markup.button.switchToCurrentChat(`📂 Показать варианты (${cachedCount})`, query)]);
            } else {
                text += `\n\n🤷‍♂️ В кэше пока нет.`;
                text += `\n👇 Нажми, чтобы найти в SoundCloud:`;
                
                // Кнопка открывает встроенный поиск по глобальной базе (SoundCloud)
                buttons.push([Markup.button.switchToCurrentChat(`🔎 Искать в SoundCloud`, query)]);
            }

            // Отправляем красивый ответ
            if (result.image) {
                await ctx.replyWithPhoto(result.image, { 
                    caption: text, 
                    parse_mode: 'HTML',
                    ...Markup.inlineKeyboard(buttons)
                });
            } else {
                await ctx.reply(text, { 
                    parse_mode: 'HTML',
                    ...Markup.inlineKeyboard(buttons)
                });
            }

        } else {
            await ctx.reply('🤷‍♂️ Не удалось распознать.');
        }

    } catch (e) {
        console.error('[Shazam] Error:', e);
        if (statusMsg) await ctx.deleteMessage(statusMsg.message_id).catch(() => {});
        await ctx.reply('⚠️ Произошла ошибка при обработке файла.');
    }
};

// Подключаем обработчик ко всем медиа-типам
bot.on(['voice', 'video_note', 'audio', 'video'], handleMediaForShazam);

bot.on('photo', async (ctx) => {
    if (isShuttingDown()) return;
    if (ctx.chat.type !== 'private') return;

    const user = ctx.state.user;
    if (user && user.support_mode) {
        try {
            const photo = ctx.message.photo[ctx.message.photo.length - 1];
            const fileId = photo.file_id;
            const caption = ctx.message.caption || '';

            await createSupportMessage(ctx.from.id, caption, 'user', 'photo', fileId);

            const safeName = ctx.from.first_name ? ctx.from.first_name.replace(/</g, '&lt;').replace(/>/g, '&gt;') : 'Без имени';
            const adminMessage = `📷 <b>Новое фото в поддержку!</b>\n` +
                `<b>От:</b> ${safeName} (ID: <code>${ctx.from.id}</code>, @${ctx.from.username || ''})\n` +
                (caption ? `<b>Подпись:</b> <i>"${caption}"</i>` : '');

            await bot.telegram.sendPhoto(ADMIN_ID, fileId, {
                caption: adminMessage,
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('✍️ Ответить', `reply_user:${ctx.from.id}`)]
                ])
            });

            await ctx.reply('✅ Ваше фото отправлено в поддержку. Ожидайте ответа.', Markup.inlineKeyboard([
                [Markup.button.callback('❌ Выйти из поддержки', 'support_exit')]
            ]));
        } catch (e) {
            console.error('Ошибка при обработке фото в поддержке:', e.message);
            await ctx.reply('❌ Не удалось отправить фото. Попробуйте еще раз.').catch(() => {});
        }
        return;
    }
});

bot.on('text', async (ctx) => {
    if (isShuttingDown()) return;
    
    if (ctx.chat.type !== 'private') return;
    
    const text = ctx.message.text;

    // --- Обработка сессии ответа админа ---
    const adminId = ctx.from.id;
    if (Number(adminId) === Number(ADMIN_ID) && adminReplySessions.has(adminId)) {
        const targetUserId = adminReplySessions.get(adminId);
        const replyText = ctx.message.text;
        
        if (replyText === '/cancel') {
            adminReplySessions.delete(adminId);
            return await ctx.reply('❌ Отправка ответа отменена.', getMainKeyboard());
        }
        
        try {
            await bot.telegram.sendMessage(targetUserId, `✉️ <b>Ответ от поддержки:</b>\n\n${replyText}`, { parse_mode: 'HTML' });
            await createSupportMessage(targetUserId, replyText, 'admin');
            adminReplySessions.delete(adminId);
            await ctx.reply('✅ Ответ успешно отправлен пользователю!', getMainKeyboard());
        } catch (e) {
            console.error(`Ошибка при отправке ответа пользователю ${targetUserId}:`, e.message);
            await ctx.reply(`❌ Не удалось отправить ответ: ${e.message}`, getMainKeyboard());
        }
        return;
    }

    // --- Обработка режима поддержки для пользователя ---
    const user = ctx.state.user;
    if (user && user.support_mode) {
        if (text === '/exit') {
            await updateUserField(ctx.from.id, 'support_mode', false);
            return await ctx.reply('❌ Вы вышли из чата поддержки.', getMainKeyboard());
        }

        try {
            await createSupportMessage(ctx.from.id, text, 'user');
            
            const safeName = ctx.from.first_name ? ctx.from.first_name.replace(/</g, '&lt;').replace(/>/g, '&gt;') : 'Без имени';
            const adminMessage = `✉️ <b>Новое обращение в поддержку!</b>\n` +
                `<b>От:</b> ${safeName} (ID: <code>${ctx.from.id}</code>, @${ctx.from.username || ''})\n\n` +
                `<i>"${text}"</i>`;

            await bot.telegram.sendMessage(ADMIN_ID, adminMessage, {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('✍️ Ответить', `reply_user:${ctx.from.id}`)]
                ])
            });
            
            await ctx.reply('✅ Ваше сообщение отправлено в поддержку. Ожидайте ответа.', Markup.inlineKeyboard([
                [Markup.button.callback('❌ Выйти из поддержки', 'support_exit')]
            ]));
        } catch (e) {
            console.error('Ошибка при обработке сообщения поддержки:', e.message);
            await ctx.reply('❌ Не удалось отправить сообщение. Попробуйте еще раз.').catch(() => {});
        }
        return;
    }
    
    if (text.startsWith('/')) return;
    if (Object.values(allTextsSync()).includes(text)) return;
    
    const urlMatch = text.match(/(https?:\/\/[^\s]+)/g);
    if (!urlMatch) return await ctx.reply('Пожалуйста, отправьте мне ссылку.');
    
    // ПАКЕТНЫЙ РЕЖИМ ДЛЯ АДМИНА: обрабатываем все ссылки из сообщения
    const isAdmin = ctx.from.id === ADMIN_ID;
    const soundcloudUrls = urlMatch.filter(u => u.includes('soundcloud.com'));
    
    if (isAdmin && soundcloudUrls.length > 1) {
        // Админ прислал несколько ссылок — обрабатываем все
        await ctx.reply(`📦 Пакетный режим: найдено ${soundcloudUrls.length} ссылок. Добавляю в очередь...`);
        let added = 0;
        for (const scUrl of soundcloudUrls) {
            try {
                handleSoundCloudUrl(ctx, scUrl);
                added++;
            } catch (e) {
                console.error(`[Admin/Batch] Ошибка для ${scUrl}:`, e.message);
            }
        }
        console.log(`[Admin/Batch] Добавлено ${added}/${soundcloudUrls.length} ссылок в очередь`);
        return;
    }
    
    const url = urlMatch[0];

    // Проверка лимитов (для всех, кроме админа)
    if (!isAdmin) {
        const user = await getUser(ctx.from.id);
        if ((user.downloads_today || 0) >= (user.premium_limit || 0)) {
            const bonusAvailable = Boolean(CHANNEL_USERNAME && !user.subscribed_bonus_used);
            const cleanUsername = CHANNEL_USERNAME?.replace('@', '');
            const bonusText = bonusAvailable
              ? `\n\n🎁 Доступен бонус! Подпишись на <a href="https://t.me/${cleanUsername}">@${cleanUsername}</a> и получи <b>7 дней тарифа Plus</b>.`
              : '';
            const extra = { parse_mode: 'HTML', disable_web_page_preview: true };
            if (bonusAvailable) {
              extra.reply_markup = { inline_keyboard: [[ { text: '✅ Я подписался, забрать бонус', callback_data: 'check_subscription' } ]] };
            }
            await ctx.reply(`${T('limitReached')}${bonusText}`, extra);
            return;
        }
    }

    // Определяем источник и обрабатываем
    
    if (url.includes('soundcloud.com')) {
        // SoundCloud
        if (getSetting('use_soundcloud') !== 'true') {
            await ctx.reply('⚠️ Сервис SoundCloud временно отключен администратором. Попробуйте позже или используйте другой сервис.');
            return;
        }
        handleSoundCloudUrl(ctx, url);
    } else if (url.includes('open.spotify.com') || url.includes('spotify.com')) {
        // Spotify - показываем меню выбора качества
        if (getSetting('use_spotify') !== 'true') {
            await ctx.reply('⚠️ Сервис Spotify временно отключен администратором. Попробуйте позже или используйте другой сервис.');
            return;
        }
        handleSpotifyUrl(ctx, url);
    } else if (url.includes('youtube.com') || url.includes('youtu.be') || url.includes('music.youtube.com')) {
        // YouTube / YouTube Music - показываем меню выбора качества
        if (getSetting('use_youtube') !== 'true') {
            await ctx.reply('⚠️ Сервис YouTube временно отключен администратором. Попробуйте позже или используйте другой сервис.');
            return;
        }
        handleYouTubeUrl(ctx, url);
    } else {
        await ctx.reply(
            '🎵 Я умею скачивать музыку из:\n\n' +
            '• SoundCloud (soundcloud.com)\n' +
            '• Spotify (open.spotify.com)\n' +
            '• YouTube Music (music.youtube.com)\n' +
            '• YouTube (youtube.com)\n\n' +
            'Просто отправь ссылку!'
        );
    }
});
