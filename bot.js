// ======================= ФИНАЛЬНАЯ ВЕРСИЯ BOT.JS =======================

import { Telegraf, Markup, TelegramError } from 'telegraf';
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { ADMIN_ID, BOT_TOKEN, WEBHOOK_URL, CHANNEL_USERNAME, STORAGE_CHANNEL_ID, PROXY_URL } from './config.js';
import { getSetting } from './services/settingsManager.js';
import { pool, supabase, updateUserField, getUser, createUser, setPremium, setTariffAdmin, getAllUsers, resetDailyLimitIfNeeded, getCachedTracksCount, logUserAction, getTopFailedSearches, getTopRecentSearches, getNewUsersCount,findCachedTrack,
    incrementDownloadsAndSaveTrack, getReferrerInfo, getReferredUsers, resetExpiredPremiumIfNeeded, getReferralStats, getUserUniqueDownloadedUrls, findCachedTrackByFileId, cleanUpDatabase, updateFileId, createSupportMessage,
    grantKaraokeTesterAccess, getKaraokeTester, addKaraokeFeedback, getKaraokeTestersStats, logKaraokeInvitation} from './db.js';
import { T, allTextsSync } from './config/texts.js';
import { performInlineSearch } from './services/searchManager.js';
import { handleSpotifyUrl, handleQualitySelection as handleSpotifyQuality, registerSpotifyCallbacks } from './services/spotifyManager.js';
import { handleYouTubeUrl, handleYouTubeQualitySelection } from './services/youtubeManager.js';
import { checkAndSendPromos, downloadQueue, enqueue } from './services/downloadManager.js';
import execYoutubeDl from 'youtube-dl-exec';
import { identifyTrack } from './services/shazamService.js';
import { handleReferralCommand, processNewUserReferral } from './services/referralManager.js';
import { isShuttingDown, isMaintenanceMode, setMaintenanceMode } from './services/appState.js';
import { t as i18n, getUserLanguage, normalizeLanguageCode, getUserLanguageSegment } from './services/i18nService.js';
import { SUPPORTED_LANGUAGES, LANGUAGE_LABELS } from './config/languages.js';
import { redactSecretsInText } from './services/logSanitizer.js';
import { activateSubscription } from './services/subscriptionService.js';
import redisService from './services/redisClient.js';
import { isSubscribedStatus } from './services/channelSubscriptionService.js';
import { createHash } from 'crypto';
import { storeTelegramSupportImage, SUPPORT_IMAGE_MIME_TYPES } from './services/supportMediaService.js';
import {
    getActiveTariffCode,
    getConfiguredFreeDownloadLimit,
    getDownloadQueuePriority,
    getEffectiveDownloadLimit,
    getRemainingDownloads,
    isDownloadLimitReachedForUser,
    isUserUnlimited as checkUserUnlimited
} from './services/downloadLimitService.js';
import { claimDownloadRequest, getDownloadCorrelationId, logDownloadFlow } from './services/downloadFlowService.js';
import { buildLimitUpsell, buildUpgradeOffer } from './services/limitUpsellService.js';
import { acquireInvoiceRequest, releaseInvoiceRequest } from './services/paymentInvoiceGuard.js';
import { notifyAdminAboutConfirmedStarsPayment } from './services/starsPaymentNotificationService.js';

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
                console.warn(`[youtube-dl] Ошибка proxy #${_botProxyFailCount}: ${redactSecretsInText(errText).slice(0, 200)}`);

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
        const priority = getDownloadQueuePriority(user);
        
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
        return isSubscribedStatus(member);
    } catch (e) {
        console.error(`Ошибка проверки подписки для ${userId} на ${CHANNEL_USERNAME}:`, e.message);
        return false;
    }
}

export function isUserUnlimited(user) {
    return checkUserUnlimited(user);
}

export function getUserLimit(user) {
    return getEffectiveDownloadLimit(user, getConfiguredFreeDownloadLimit());
}

async function isDownloadLimitReached(ctx, userId, correlationId = null) {
    const isAdmin = Number(userId) === Number(ADMIN_ID);
    if (isAdmin) return false;

    const user = await getUser(userId);
    if (!user) return false;

    const downloadsToday = Number(user.downloads_today || 0);
    const limitFreeSetting = getConfiguredFreeDownloadLimit();
    const userLimit = getEffectiveDownloadLimit(user, limitFreeSetting);
    const isPremium = user.premium_until && new Date(user.premium_until) > new Date();
    
    const activeTariff = getActiveTariffCode(user);
    const hasOverride = user.daily_limit_override !== null && user.daily_limit_override !== undefined;
    const limitSource = hasOverride
        ? 'daily_limit_override'
        : `daily_limit_${activeTariff}_setting`;

    console.log(`[DEBUG] [Tariffs & Limits] User check:`, {
        telegram_id: userId,
        username: ctx.from?.username || 'unknown',
        is_premium: isPremium,
        active_tariff: activeTariff,
        premium_until: user.premium_until,
        daily_limit: Number.isFinite(userLimit) ? userLimit : 'unlimited',
        downloaded_today: downloadsToday,
        remaining_downloads: Number.isFinite(userLimit) ? getRemainingDownloads(user, limitFreeSetting) : 'unlimited',
        limit_source: limitSource,
        correlation_id: correlationId
    });

    if (isDownloadLimitReachedForUser(user, limitFreeSetting)) {
        // Логируем попытку скачивания сверх лимита (только если НЕ только что достигли — то есть уже превышен)
        if (downloadsToday > userLimit) {
            try {
                const { analyticsService } = await import('./services/analyticsService.js');
                await analyticsService.trackEventSafe(userId, 'download_attempt_over_limit', 'limits', {
                    downloads_today: downloadsToday,
                    user_limit: userLimit
                }, ctx);
            } catch (_ae) {}
        }
        return true;
    }
    return false;
}

function getTariffName(limit) {
    const limitFree = parseInt(getSetting('daily_limit_free') || '3', 10);
    const limitPlus = parseInt(getSetting('daily_limit_plus') || '30', 10);
    const limitPro = parseInt(getSetting('daily_limit_pro') || '100', 10);

    if (limit === null || limit === undefined || limit >= 10000) return 'Unlimited — 💎';
    if (limit >= limitPro) return `Pro — ${limitPro} 💪`;
    if (limit >= limitPlus) return `Plus — ${limitPlus} 🎯`;
    return `🆓 Free — ${limitFree} 🟢`;
}

function getDaysLeft(premiumUntil) {
    if (!premiumUntil) return 0;
    const diff = new Date(premiumUntil) - new Date();
    return Math.max(Math.ceil(diff / 86400000), 0);
}

// bot.js

// bot.js

export function formatMenuMessage(user, botUsername, lang = 'ru') {
    // 1. Динамические данные
    const userLimit = getUserLimit(user);
    const tariffLabel = getTariffName(userLimit);
    const downloadsToday = user.downloads_today || 0;
    const daysLeft = getDaysLeft(user.premium_until);
    const referralCount = Number(user.referral_count ?? 0);
    const referralLink = `https://t.me/${botUsername}?start=ref_${user.id}`;

    // 2. Блок статистики (данные, не переводятся)
    const limitText = Number.isFinite(userLimit) ? userLimit : '∞';
    const statsBlock = [
        `💼 <b>${lang === 'en' ? 'Plan' : 'Тариф'}:</b> <i>${tariffLabel}</i>`,
        `⏳ <b>${lang === 'en' ? 'Subscription days left' : 'Осталось дней подписки'}:</b> <i>${daysLeft}</i>`,
        `🎧 <b>${lang === 'en' ? 'Downloaded today' : 'Сегодня скачано'}:</b> <i>${downloadsToday}</i> / <i>${limitText}</i>`
    ].join('\n');

    // 3. Переведённые шаблоны через i18n с подстановкой переменных
    const header = i18n(lang, 'menu_header', { first_name: escapeHtml(user.first_name) || (lang === 'en' ? 'user' : 'пользователь') });

    const referralBlock = i18n(lang, 'menu_referral_block', {
        referral_count: referralCount,
        referral_link: referralLink
    });

    let bonusBlock = '';
    if (!user.subscribed_bonus_used && CHANNEL_USERNAME) {
        const cleanUsername = CHANNEL_USERNAME.replace('@', '');
        const channelLabel = lang === 'en' ? 'our channel' : 'наш канал';
        const channelLink = `<a href="https://t.me/${cleanUsername}">${channelLabel}</a>`;
        bonusBlock = i18n(lang, 'menu_bonus_block', { channel_link: channelLink });
    }

    const footer = i18n(lang, 'menu_footer');

    // 4. Сборка
    return [header, statsBlock, '\n- - - - - - - - - - - - - - -', referralBlock, bonusBlock, footer]
        .filter(Boolean).join('\n\n');
}

// --- Инициализация Telegraf ---
const telegrafOptions = { handlerTimeout: 300_000 };
if (process.env.TELEGRAM_TEST_ENV === 'true') {
    telegrafOptions.telegram = telegrafOptions.telegram || {};
    telegrafOptions.telegram.testEnv = true;
    console.log('🧪 [App] Запуск Telegraf в тестовом окружении Telegram (testEnv: true).');
}
export const bot = new Telegraf(BOT_TOKEN, telegrafOptions);

// --- Telegram API Rate Limiting (предотвращает 429 ошибки при массовой отправке) ---
const lastSentTimes = new Map();
const userQueues = new Map();

function rateLimitRequest(chatId, taskFn) {
    const id = Number(chatId);
    if (isNaN(id) || id < 0) {
        return taskFn();
    }
    
    if (!userQueues.has(id)) {
        userQueues.set(id, Promise.resolve());
    }
    
    const currentChain = userQueues.get(id);
    
    const nextChain = currentChain.then(async () => {
        const lastSent = lastSentTimes.get(id) || 0;
        const now = Date.now();
        const delay = 1200 - (now - lastSent); // Гарантируем задержку 1.2 сек между отправками одному юзеру
        if (delay > 0) {
            await new Promise(resolve => setTimeout(resolve, delay));
        }
        const result = await taskFn();
        lastSentTimes.set(id, Date.now());
        return result;
    });
    
    userQueues.set(id, nextChain.catch(() => {}));
    return nextChain;
}

const originalSendAudio = bot.telegram.sendAudio.bind(bot.telegram);
bot.telegram.sendAudio = async function(chatId, ...args) {
    return rateLimitRequest(chatId, () => originalSendAudio(chatId, ...args));
};

const originalSendMessage = bot.telegram.sendMessage.bind(bot.telegram);
bot.telegram.sendMessage = async function(chatId, ...args) {
    return rateLimitRequest(chatId, () => originalSendMessage(chatId, ...args));
};

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
        const text = ctx.message?.text || '';
        
        // Разрешаем команды (начинаются с /)
        if (text.startsWith('/')) {
            return await next();
        }
        
        // Разрешаем кнопки основного меню и навигацию
        const vpnText = getSetting('vpn_button_text') || '🔐 VPN (YouTube 4K)';
        // Собираем разрешённые тексты кнопок для всех поддерживаемых языков
        const allowedTexts = new Set(['🆔 Распознать', vpnText]);
        for (const lng of SUPPORTED_LANGUAGES) {
            allowedTexts.add(i18n(lng, 'btn_menu'));
            allowedTexts.add(i18n(lng, 'btn_upgrade'));
            allowedTexts.add(i18n(lng, 'btn_mytracks'));
            allowedTexts.add(i18n(lng, 'btn_help'));
            allowedTexts.add(i18n(lng, 'btn_language'));
        }
        if (allowedTexts.has(text)) {
            return await next();
        }
        
        // Разрешаем callback-запросы, относящиеся к караоке и админке
        if (ctx.callbackQuery) {
            const data = ctx.callbackQuery.data || '';
            if (data.startsWith('karaoke_') || data.startsWith('admin_karaoke_')) {
                return await next();
            }
            return await ctx.answerCbQuery('⏳ Бот на плановом обслуживании (скачивание временно недоступно).', { show_alert: true });
        }
        
        // Блокируем ссылки и обычный текст (поиск), так как они запускают скачивание
        const isDownloadAttempt = text.includes('soundcloud.com') || text.includes('spotify.com') || text.includes('youtu') || !text;
        if (isDownloadAttempt) {
            return await ctx.reply('⏳ Скачивание музыки временно недоступно: бот на плановом обслуживании.');
        }
        
        return await ctx.reply('⏳ Поиск и скачивание музыки временно недоступны: бот на плановом обслуживании.');
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

    // Пытаемся достать payload из deep link
    const payload =
        (typeof ctx.startPayload === 'string' && ctx.startPayload) ||
        (ctx.message?.text?.startsWith('/start ') ? ctx.message.text.split(' ')[1] : null) ||
        null;

    const tgLangCode = ctx.from.language_code || null;

    // Получаем/создаём пользователя, передаём язык Telegram
    const user = await getUser(ctx.from.id, ctx.from.first_name, ctx.from.username, payload, tgLangCode);
    ctx.state.user = user;

    // === ОПРЕДЕЛЕНИЕ ЯЗЫКА ===
    // Для существующих legacy-пользователей без language_source — бэкфилл
    if (user && !user.language_source && tgLangCode) {
        try {
            const normalizedLang = normalizeLanguageCode(tgLangCode);
            await updateUserField(ctx.from.id, {
                telegram_language_code: tgLangCode,
                language_code: normalizedLang,
                language_source: 'telegram_auto',
                language_updated_at: new Date()
            });
            user.language_code = normalizedLang;
            user.language_source = 'telegram_auto';
            user.telegram_language_code = tgLangCode;
            // Аналитика первого определения языка
            const isSupported = ['ru', 'en'].includes(normalizedLang) &&
                ['ru', 'uk', 'be', 'kk', 'en'].includes(tgLangCode.toLowerCase().split('-')[0]);
            const reason = isSupported ? 'supported_language' : 'unsupported_language';
            try {
                const { analyticsService } = await import('./services/analyticsService.js');
                await analyticsService.trackEventSafe(ctx.from.id, 'language_detected', 'i18n', {
                    telegram_language: tgLangCode,
                    selected_language: normalizedLang,
                    source: 'telegram_auto',
                    reason
                }, ctx);
            } catch (_ae) {}
        } catch (e) {
            console.error('[i18n] Backfill language error:', e.message);
        }
    }

    // Устанавливаем текущий язык пользователя в ctx.state для хендлеров
    ctx.state.lang = getUserLanguage(user);

    if (user && user.active === false) return;

    // Восстанавливаем флаг рассылок
    if (user && user.can_receive_broadcasts === false) {
        try { await updateUserField(user.id, { can_receive_broadcasts: true }); } catch (e) {
            console.error('[Broadcast flag] update error:', e.message);
        }
    }

    await resetDailyLimitIfNeeded(ctx.from.id);
    await resetExpiredPremiumIfNeeded(ctx.from.id);

    try {
        const { analyticsService } = await import('./services/analyticsService.js');
        await analyticsService.handleSessionAndActivity(ctx.from.id, user, ctx);
    } catch (e) {
        console.error('[Analytics] Middleware error:', e.message);
    }

    return next();
});

// =====================================================================================
//                       KARAOKE LRC MAKER INTEGRATION (MVP)
// =====================================================================================

async function handleKaraokeFeedbackMessage(ctx) {
    const text = ctx.message.text;
    
    if (text === '/cancel') {
        await updateUserField(ctx.from.id, {
            karaoke_feedback_mode: false,
            karaoke_feedback_started_at: null
        });
        return await ctx.reply('❌ Отправка отзыва отменена.', getMainKeyboard());
    }

    let fileId = null;
    let attachmentType = null;
    let mimeType = 'image/jpeg';
    let fileExtension = 'jpg';

    if (ctx.message.photo) {
        const photo = ctx.message.photo[ctx.message.photo.length - 1];
        fileId = photo.file_id;
        attachmentType = 'photo';
        mimeType = 'image/jpeg';
        fileExtension = 'jpg';
    } else if (ctx.message.video) {
        fileId = ctx.message.video.file_id;
        attachmentType = 'video';
        mimeType = ctx.message.video.mime_type || 'video/mp4';
        fileExtension = 'mp4';
    } else if (ctx.message.document) {
        fileId = ctx.message.document.file_id;
        attachmentType = 'document';
        mimeType = ctx.message.document.mime_type || 'application/octet-stream';
        const origName = ctx.message.document.file_name || '';
        const extMatch = origName.match(/\.([a-zA-Z0-9]+)$/);
        fileExtension = extMatch ? extMatch[1] : 'bin';
    } else if (ctx.message.voice) {
        fileId = ctx.message.voice.file_id;
        attachmentType = 'voice';
        mimeType = ctx.message.voice.mime_type || 'audio/ogg';
        fileExtension = 'ogg';
    } else if (ctx.message.video_note) {
        fileId = ctx.message.video_note.file_id;
        attachmentType = 'video_note';
        mimeType = 'video/mp4';
        fileExtension = 'mp4';
    } else if (ctx.message.audio) {
        fileId = ctx.message.audio.file_id;
        attachmentType = 'audio';
        mimeType = ctx.message.audio.mime_type || 'audio/mpeg';
        fileExtension = 'mp3';
    }

    const messageText = ctx.message.text || ctx.message.caption || '';
    if (!messageText && !fileId) {
        return await ctx.reply('💬 Пожалуйста, напишите ваш отзыв текстом или пришлите скриншот/видео.');
    }

    let attachmentUrl = null;

    if (fileId) {
        try {
            await ctx.reply('⏳ Загружаю файл в Supabase Storage...');
            
            const fileInfo = await ctx.telegram.getFile(fileId);
            const downloadUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.file_path}`;
            
            const response = await axios.get(downloadUrl, { responseType: 'arraybuffer' });
            const buffer = Buffer.from(response.data);
            
            const filename = `feedback_${Date.now()}_${fileId}.${fileExtension}`;
            
            const { karaokeSupabase, supabase } = await import('./db.js');
            const client = karaokeSupabase || supabase;
            const { data, error } = await client.storage
                .from('karaoke-feedback')
                .upload(filename, buffer, {
                    contentType: mimeType,
                    upsert: true
                });
                
            if (error) throw error;
            
            const { data: publicData } = client.storage
                .from('karaoke-feedback')
                .getPublicUrl(filename);
                
            attachmentUrl = publicData.publicUrl;
            console.log(`[Storage] Файл загружен: ${attachmentUrl}`);
        } catch (err) {
            console.error('🔴 [Feedback Storage] Ошибка загрузки файла:', err.message);
            await ctx.reply('⚠️ Не удалось сохранить файл в облако, отзыв будет сохранен без вложения...').catch(() => {});
        }
    }

    const contact = ctx.from.username ? `@${ctx.from.username}` : (ctx.from.first_name || 'Пользователь');
    
    await addKaraokeFeedback({
        telegramId: ctx.from.id,
        messageText,
        attachmentUrl,
        attachmentType,
        contact
    });

    try {
        const safeName = ctx.from.first_name ? ctx.from.first_name.replace(/</g, '&lt;').replace(/>/g, '&gt;') : 'Без имени';
        const adminMessage = `🎤 <b>Новый отзыв о караоке-сервисе!</b>\n` +
            `<b>От:</b> ${safeName} (ID: <code>${ctx.from.id}</code>, ${contact})\n\n` +
            `<i>"${messageText || '(без текста)'}"</i>`;

        if (attachmentType === 'photo') {
            await bot.telegram.sendPhoto(ADMIN_ID, fileId, { caption: adminMessage, parse_mode: 'HTML' });
        } else if (attachmentType === 'video') {
            await bot.telegram.sendVideo(ADMIN_ID, fileId, { caption: adminMessage, parse_mode: 'HTML' });
        } else if (attachmentType === 'document') {
            await bot.telegram.sendDocument(ADMIN_ID, fileId, { caption: adminMessage, parse_mode: 'HTML' });
        } else {
            await bot.telegram.sendMessage(ADMIN_ID, adminMessage, { parse_mode: 'HTML' });
        }
    } catch (adminErr) {
        console.error('🔴 Не удалось уведомить админа об отзыве:', adminErr.message);
    }

    await updateUserField(ctx.from.id, {
        karaoke_feedback_mode: false,
        karaoke_feedback_started_at: null
    });

    return await ctx.reply('✅ Спасибо за ваш отзыв! Он поможет сделать сервис лучше.', getMainKeyboard());
}

bot.use(async (ctx, next) => {
    if (isShuttingDown()) return next();
    if (!ctx.from || ctx.chat?.type !== 'private') return next();
    if (ctx.callbackQuery) return next();

    const user = ctx.state.user;
    if (user && user.karaoke_feedback_mode) {
        const startedAt = user.karaoke_feedback_started_at ? new Date(user.karaoke_feedback_started_at).getTime() : 0;
        const now = Date.now();
        
        if (startedAt > 0 && (now - startedAt) > 20 * 60 * 1000) {
            await updateUserField(ctx.from.id, {
                karaoke_feedback_mode: false,
                karaoke_feedback_started_at: null
            });
            await ctx.reply('⏳ Время ожидания отзыва истекло. Если хотите оставить отзыв, пожалуйста, начните заново через /karaoke_test.');
            return next();
        }

        return await handleKaraokeFeedbackMessage(ctx);
    }

    return next();
});
const getMainKeyboard = (lang = 'ru') => {
    const buttons = [
        [i18n(lang, 'btn_menu'), '🆔 Распознать', i18n(lang, 'btn_upgrade')],
        [i18n(lang, 'btn_mytracks'), i18n(lang, 'btn_help'), i18n(lang, 'btn_language')]
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

    const tgLang = ctx.from.language_code || null;
    const user = await getUser(ctx.from.id, ctx.from.first_name, ctx.from.username, ctx.startPayload || null, tgLang);
    const lang = getUserLanguage(user);

    const isNewRegistration = (Date.now() - new Date(user.created_at).getTime()) < 5000;

    if (isNewRegistration) {
        await logUserAction(ctx.from.id, 'registration');
        await processNewUserReferral(user, ctx);
        // Аналитика первого определения языка для нового пользователя
        try {
            const normalizedLang = normalizeLanguageCode(tgLang);
            const cleanTg = (tgLang || '').toLowerCase().split('-')[0];
            const isSupported = ['ru', 'uk', 'be', 'kk', 'en'].includes(cleanTg);
            const { analyticsService } = await import('./services/analyticsService.js');
            await analyticsService.trackEventSafe(ctx.from.id, 'language_detected', 'i18n', {
                telegram_language: tgLang || 'unknown',
                selected_language: normalizedLang,
                source: 'telegram_auto',
                reason: isSupported ? 'supported_language' : 'unsupported_language'
            }, ctx);
        } catch (_ae) {}
    }

    if (ctx.startPayload === 'karaoke_test') {
        await logKaraokeInvitation(ctx.from.id, ctx.from.username || null, ctx.from.first_name || null);
        const msg = `🎤 <b>Хочешь протестировать новый сервис для создания караоке-видео?</b>\n\n` +
            `Можно загрузить песню, найти текст, расставить тайминги, экспортировать видео и опубликовать караоке в каталог.\n\n` +
            `Я даю <b>Plus-доступ на 30 дней бесплатно</b>.\n` +
            `Взамен попрошу честно потестировать сервис и прислать пару отзывов или багов прямо сюда, если что-то пойдёт не так.\n\n` +
            `Мест пока немного.`;

        return await ctx.reply(msg, {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('🚀 Стать тестировщиком', 'karaoke_join')],
                [Markup.button.url('🌐 Открыть Karaoke LRC Maker', 'https://karaoke-lrc.vercel.app/')],
                [Markup.button.callback('Позже', 'karaoke_later')]
            ])
        });
    }

    const startKey = isNewRegistration ? 'start_new_user' : 'start_returning';
    await ctx.reply(i18n(lang, startKey), {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...getMainKeyboard(lang)
    });
  } catch (err) {
    console.error(`[bot.start] Ошибка для userId=${ctx.from?.id}:`, err.message);
    await ctx.reply('Произошла ошибка при запуске. Попробуйте ещё раз: /start').catch(() => {});
  }
});

// =====================================================================================
//                       КОМАНДА /language — СМЕНА ЯЗЫКА
// =====================================================================================

const sendLanguageMenu = async (ctx) => {
    const user = ctx.state.user || await getUser(ctx.from.id);
    const lang = getUserLanguage(user);
    const buttons = SUPPORTED_LANGUAGES.map(code => [
        Markup.button.callback(
            (lang === code ? '✅ ' : '') + (LANGUAGE_LABELS[code] || code),
            `set_lang_${code}`
        )
    ]);
    await ctx.reply(i18n(lang, 'select_language_msg'), {
        ...Markup.inlineKeyboard(buttons)
    });
};

bot.command('language', sendLanguageMenu);

// Callback-обработчик выбора языка
bot.action(/^set_lang_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const selectedLang = ctx.match[1];
    if (!SUPPORTED_LANGUAGES.includes(selectedLang)) return;

    const prevUser = ctx.state.user || await getUser(ctx.from.id);
    const prevLang = getUserLanguage(prevUser);

    if (prevLang === selectedLang) {
        // Уже выбран — ничего не делаем
        return ctx.editMessageText(
            (LANGUAGE_LABELS[selectedLang] || selectedLang) + ' ' + i18n(selectedLang, 'language_changed'),
            { parse_mode: 'HTML' }
        ).catch(() => {});
    }

    try {
        await updateUserField(ctx.from.id, {
            language_code: selectedLang,
            language_source: 'user_selected',
            language_updated_at: new Date()
        });

        // Логируем смену в language_history
        const { logLanguageChange } = await import('./db.js');
        await logLanguageChange(ctx.from.id, prevLang, selectedLang, 'user_selected').catch(() => {});

        // Аналитика
        try {
            const { analyticsService } = await import('./services/analyticsService.js');
            await analyticsService.trackEventSafe(ctx.from.id, 'language_changed', 'i18n', {
                from_lang: prevLang,
                to_lang: selectedLang,
                source: 'user_selected'
            }, ctx);
        } catch (_ae) {}

        // Подтверждение на новом языке
        await ctx.editMessageText(i18n(selectedLang, 'language_changed'), { parse_mode: 'HTML' }).catch(() => {});
        await ctx.reply(i18n(selectedLang, 'select_language_msg') + '\n' + i18n(selectedLang, 'language_changed'),
            { ...getMainKeyboard(selectedLang) }
        ).catch(() => {});
    } catch (e) {
        console.error('[language] Ошибка смены языка:', e.message);
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

// Альтернативные способы оплаты
bot.action(['payment_help', 'other_payment_methods'], async (ctx) => {
    try {
        await ctx.answerCbQuery();
        const userId = ctx.from?.id;

        // Трекаем открытие меню альтернативных способов
        if (userId) {
            const { analyticsService } = await import('./services/analyticsService.js');
            const eventName = ctx.callbackQuery.data === 'payment_help' ? 'alternative_payment_methods_opened' : 'other_payment_methods_opened';
            await analyticsService.trackEventSafe(userId, eventName, 'monetization', {
                placement: 'upgrade_menu'
            }, ctx);
        }

        const ADMIN_USERNAME = getSetting('admin_username') || '';

        const text = `<b>💳 Другие способы оплаты (оплата в рублях)</b>\n\n` +
            `Если вы предпочитаете оплатить картой (ЮMoney, Т-Банк/СБП) или через Boosty, выберите нужный вариант ниже:\n\n` +
            `🎯 <b>Plus</b> — 119 ₽ / месяц (ЮMoney)\n` +
            `💪 <b>Pro</b> — 199 ₽ / месяц (ЮMoney)\n` +
            `💎 <b>Unlimited</b> — 299 ₽ / месяц (ЮMoney)\n` +
            `🏦 <b>Т-Банк / СБП</b> — ручной перевод на карту по реквизитам\n` +
            `❤️ <b>Boosty</b> — поддержка и подписки через платформу Boosty\n` +
            `👤 <b>Написать администратору</b> — ручное зачисление/любые вопросы`;

        const buttons = [
            [
                Markup.button.callback('🎯 Plus — ЮMoney (119 ₽)', 'yoomoney_plus'),
                Markup.button.callback('💪 Pro — ЮMoney (199 ₽)', 'yoomoney_pro')
            ],
            [
                Markup.button.callback('💎 Unlimited — ЮMoney (299 ₽)', 'yoomoney_unlim')
            ],
            [
                Markup.button.callback('🏦 Т-Банк / СБП', 'tbank_help'),
                Markup.button.callback('❤️ Boosty', 'boosty_help')
            ]
        ];

        if (ADMIN_USERNAME) {
            buttons.push([Markup.button.url('👤 Написать администратору', `https://t.me/${ADMIN_USERNAME.replace('@', '')}`)]);
        } else {
            buttons.push([Markup.button.callback('👤 Написать в поддержку бота', 'support_enter')]);
        }
        buttons.push([Markup.button.callback('⬅️ Назад', 'back_to_upgrade')]);

        await ctx.reply(text, {
            parse_mode: 'HTML',
            disable_web_page_preview: true,
            ...Markup.inlineKeyboard(buttons)
        });
    } catch (e) {
        console.error('[other_payment_methods] Error:', e.message);
    }
});

// Клик по Т-Банку
bot.action('tbank_help', async (ctx) => {
    try {
        await ctx.answerCbQuery();
        const userId = ctx.from?.id;
        if (userId) {
            const { analyticsService } = await import('./services/analyticsService.js');
            await analyticsService.trackEventSafe(userId, 'tbank_payment_link_opened', 'monetization', {
                placement: 'other_payment_methods_menu'
            }, ctx);
        }
        const TBANK_URL = getSetting('tbank_payment_url') || 'https://www.tinkoff.ru/rm/r_BZqnOJWzGA.WgnBFlqjec/02q0l97815';
        await ctx.reply(
            `🏦 <b>Оплата через Т-Банк / СБП</b>\n\n` +
            `Для перевода на карту вручную используйте кнопку ниже:\n\n` +
            `<i>После оплаты обязательно отправьте чек администратору!</i>`,
            {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([
                    [Markup.button.url('🔗 Перейти к оплате Т-Банк', TBANK_URL)],
                    [Markup.button.callback('⬅ Назад', 'other_payment_methods')]
                ])
            }
        );
    } catch (e) {
        console.error('[tbank_help] Error:', e.message);
    }
});

// Клик по Boosty
bot.action('boosty_help', async (ctx) => {
    try {
        await ctx.answerCbQuery();
        const userId = ctx.from?.id;
        if (userId) {
            const { analyticsService } = await import('./services/analyticsService.js');
            await analyticsService.trackEventSafe(userId, 'boosty_payment_link_opened', 'monetization', {
                placement: 'other_payment_methods_menu'
            }, ctx);
        }
        const BOOSTY_URL = getSetting('boosty_url') || 'https://boosty.to';
        await ctx.reply(
            `☕ <b>Поддержать на Boosty</b>\n\n` +
            `Для оплаты через платформу Boosty используйте кнопку ниже:\n\n` +
            `<i>После оплаты обязательно напишите администратору для начисления тарифа!</i>`,
            {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([
                    [Markup.button.url('🔗 Перейти на Boosty', BOOSTY_URL)],
                    [Markup.button.callback('⬅ Назад', 'other_payment_methods')]
                ])
            }
        );
    } catch (e) {
        console.error('[boosty_help] Error:', e.message);
    }
});

// ЮMoney Plus
bot.action('yoomoney_plus', async (ctx) => {
    try {
        await ctx.answerCbQuery();
        const userId = ctx.from?.id;
        if (userId) {
            const { analyticsService } = await import('./services/analyticsService.js');
            await analyticsService.trackEventSafe(userId, 'yoomoney_plus_link_opened', 'monetization', {
                placement: 'other_payment_methods_menu'
            }, ctx);
        }
        await ctx.reply(
            `🎯 <b>Тариф Plus — 119 ₽</b>\n\n` +
            `Для оплаты через ЮMoney (банковские карты, кошелек) используйте кнопку ниже:\n\n` +
            `<i>После оплаты обязательно отправьте чек администратору для активации!</i>`,
            {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([
                    [Markup.button.url('🔗 Перейти к оплате (119 ₽)', 'https://yoomoney.ru/bill/pay/1CI4F93M69C.250903')],
                    [Markup.button.callback('⬅ Назад', 'other_payment_methods')]
                ])
            }
        );
    } catch (e) {
        console.error('[yoomoney_plus] Error:', e.message);
    }
});

// ЮMoney Pro
bot.action('yoomoney_pro', async (ctx) => {
    try {
        await ctx.answerCbQuery();
        const userId = ctx.from?.id;
        if (userId) {
            const { analyticsService } = await import('./services/analyticsService.js');
            await analyticsService.trackEventSafe(userId, 'yoomoney_pro_link_opened', 'monetization', {
                placement: 'other_payment_methods_menu'
            }, ctx);
        }
        await ctx.reply(
            `💪 <b>Тариф Pro — 199 ₽</b>\n\n` +
            `Для оплаты через ЮMoney (банковские карты, кошелек) используйте кнопку ниже:\n\n` +
            `<i>После оплаты обязательно отправьте чек администратору для активации!</i>`,
            {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([
                    [Markup.button.url('🔗 Перейти к оплате (199 ₽)', 'https://yoomoney.ru/bill/pay/1CI4JNMILG7.250903')],
                    [Markup.button.callback('⬅ Назад', 'other_payment_methods')]
                ])
            }
        );
    } catch (e) {
        console.error('[yoomoney_pro] Error:', e.message);
    }
});

// ЮMoney Unlimited
bot.action('yoomoney_unlim', async (ctx) => {
    try {
        await ctx.answerCbQuery();
        const userId = ctx.from?.id;
        if (userId) {
            const { analyticsService } = await import('./services/analyticsService.js');
            await analyticsService.trackEventSafe(userId, 'yoomoney_unlimited_link_opened', 'monetization', {
                placement: 'other_payment_methods_menu'
            }, ctx);
        }
        await ctx.reply(
            `💎 <b>Тариф Unlimited — 299 ₽</b>\n\n` +
            `Для оплаты через ЮMoney (банковские карты, кошелек) используйте кнопку ниже:\n\n` +
            `<i>После оплаты обязательно отправьте чек администратору для активации!</i>`,
            {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([
                    [Markup.button.url('🔗 Перейти к оплате (299 ₽)', 'https://yoomoney.ru/bill/pay/1CI4K5962NE.250903')],
                    [Markup.button.callback('⬅ Назад', 'other_payment_methods')]
                ])
            }
        );
    } catch (e) {
        console.error('[yoomoney_unlim] Error:', e.message);
    }
});

// Возврат к меню тарифов
bot.action(['back_to_upgrade', 'open_tariffs_limit'], async (ctx) => {
    try {
        await ctx.answerCbQuery();
        const reason = ctx.callbackQuery?.data === 'open_tariffs_limit' ? 'limit_message' : 'menu_button';
        await upgradeHandler(ctx, reason);
    } catch (_e) {}
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
// bot.js
// ==========================================================
//    ДОБАВЬ ЭТОТ БЛОК ДЛЯ ОБРАБОТКИ КНОПКИ "ПОЛУЧИТЬ БОНУС"
// ==========================================================

bot.action(/^yandex_promo_click:([a-z0-9_]+)$/, async (ctx) => {
    const promoKey = ctx.match[1];
    const { getPromoCampaignByKey, recordPromoClick } = await import('./db.js');
    const campaign = await getPromoCampaignByKey(promoKey);
    if (!campaign) return ctx.answerCbQuery('Предложение больше недоступно.', { show_alert:true });
    const legacyUrl = promoKey === 'balance300' ? T('yandex_promo_url') : promoKey === 'music' ? T('yandex_music_promo_url') : '';
    const promoUrl = String(legacyUrl || campaign?.url || '').trim();
    if (!/^https:\/\//i.test(promoUrl)) return ctx.answerCbQuery('Ссылка временно недоступна.', { show_alert: true });
    const messageId = ctx.callbackQuery?.message?.message_id || null;
    try {
        const urlHash = createHash('sha256').update(promoUrl).digest('hex');
        const click = await recordPromoClick({ campaignId:campaign.id, userId:ctx.from.id, promoKey, messageId, placement:'post_download', urlHash });
        if (!click) return ctx.answerCbQuery('Предложение больше недоступно.', { show_alert:true });
        await ctx.answerCbQuery('Нажмите кнопку ещё раз, чтобы перейти.');
        const label = campaign.category === 'yandex' ? 'Открыть предложение Яндекса' : `Открыть: ${campaign.name}`;
        await ctx.editMessageReplyMarkup(Markup.inlineKeyboard([[Markup.button.url(label, promoUrl)]]).reply_markup);
    } catch (error) {
        console.error('[YandexPromo] Click tracking error:', error.message);
        await ctx.answerCbQuery('Не удалось открыть ссылку. Попробуйте ещё раз.', { show_alert: true }).catch(() => {});
    }
});

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
            await activateSubscription(pool, {
                userId: ctx.from.id,
                tariff: 'plus',
                durationDays: 7,
                source: 'channel_subscription',
                transactionId: `channel-subscription:${ctx.from.id}`
            }, { cache: redisService });
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
    const user = ctx.state.user || await getUser(ctx.from.id);
    const lang = ctx.state.lang || getUserLanguage(user);
    const message = formatMenuMessage(user, ctx.botInfo.username, lang);
    const extraOptions = {
        parse_mode: 'HTML',
        disable_web_page_preview: true
    };
    if (!user.subscribed_bonus_used && CHANNEL_USERNAME) {
        extraOptions.reply_markup = {
            inline_keyboard: [[ Markup.button.callback('✅ Я подписался и хочу бонус!', 'check_subscription') ]]
        };
    } else {
        Object.assign(extraOptions, getMainKeyboard(lang));
    }
    await ctx.reply(message, extraOptions);
    void checkAndSendPromos(ctx.from.id,user,'main_menu');
};

const recognizeHandler = (ctx) => {
    const lang = ctx.state.lang || 'ru';
    const text = lang === 'en'
        ? 'Just send or forward me:\n🎤 Voice message\n📹 Video note\n🎧 Audio file\n\n...and I will identify the track!'
        : 'Просто отправьте или перешлите мне:\n🎤 Голосовое сообщение\n📹 Видео-кружок\n🎧 Аудиофайл\n\n...и я скажу, что это за трек!';
    return ctx.reply(text, getMainKeyboard(lang));
};

const mytracksHandler = async (ctx) => {
    try {
        const user = ctx.state.user || await getUser(ctx.from.id);
        const lang = ctx.state.lang || getUserLanguage(user);
        if (!user.tracks_today || user.tracks_today.length === 0) {
            return await ctx.reply(i18n(lang, 'no_tracks_today'), getMainKeyboard(lang));
        }
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

const paySupportHandler = async (ctx) => {
    try {
        const user = ctx.state.user || await getUser(ctx.from.id);
        const lang = ctx.state.lang || getUserLanguage(user);
        const configuredAdmin = String(getSetting('admin_username') || '')
            .trim()
            .replace(/^@/, '');
        const adminUsername = /^[A-Za-z0-9_]{5,32}$/.test(configuredAdmin)
            ? configuredAdmin
            : null;
        const adminContact = adminUsername
            ? `@${adminUsername}`
            : i18n(lang, 'pay_support_chat_contact');
        const buttons = [
            [Markup.button.callback(i18n(lang, 'pay_support_alt_button'), 'other_payment_methods')]
        ];

        if (adminUsername) {
            buttons.push([
                Markup.button.url(
                    i18n(lang, 'pay_support_admin_button'),
                    `https://t.me/${adminUsername}`
                )
            ]);
        } else {
            buttons.push([
                Markup.button.callback(i18n(lang, 'pay_support_admin_button'), 'support_enter')
            ]);
        }

        await ctx.reply(i18n(lang, 'pay_support_info', { admin_contact: adminContact }), {
            parse_mode: 'HTML',
            disable_web_page_preview: true,
            ...Markup.inlineKeyboard(buttons)
        });
    } catch (e) {
        console.error('[Bot] Error in paySupportHandler:', e.message);
        await ctx.reply(i18n(ctx.state.lang || 'ru', 'pay_support_error')).catch(() => {});
    }
};

const helpHandler = async (ctx) => {
    const lang = ctx.state.lang || 'ru';
    return ctx.reply(i18n(lang, 'help_info'), {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...getMainKeyboard(lang),
        ...Markup.inlineKeyboard([
            [Markup.button.callback('✉️ Написать в поддержку', 'support_enter')]
        ])
    });
};
const upgradeHandler = async (ctx, explicitReason = null) => {
    try {
        const lang = ctx.state.lang || 'ru';
        const offer = buildUpgradeOffer({ lang });

        await ctx.reply(offer.text, offer.extra);

        const userId = ctx.from?.id;
        if (userId) {
            const { analyticsService } = await import('./services/analyticsService.js');
            const pricingOpenReason = await analyticsService.inferPricingOpenReason(
                userId,
                typeof explicitReason === 'string' ? explicitReason : null
            );
            await analyticsService.trackEventSafe(userId, 'star_payment_option_shown', 'monetization', {
                placement: 'upgrade_menu',
                pricing_open_reason: pricingOpenReason,
                lang
            }, ctx);
        }
    } catch (e) {
        console.error('[Bot] Error in upgradeHandler:', e.message);
    }
};


// Кнопки меню — слушаем все поддерживаемые языки
for (const lang of SUPPORTED_LANGUAGES) {
    bot.hears(i18n(lang, 'btn_menu'), menuHandler);
    bot.hears(i18n(lang, 'btn_mytracks'), mytracksHandler);
    bot.hears(i18n(lang, 'btn_help'), helpHandler);
    bot.hears(i18n(lang, 'btn_upgrade'), (ctx) => upgradeHandler(ctx, 'menu_button'));
    bot.hears(i18n(lang, 'btn_language'), sendLanguageMenu);
}
bot.hears('🆔 Распознать', recognizeHandler);

bot.command('menu', menuHandler);
bot.command('subs', menuHandler);
bot.command('mytracks', mytracksHandler);
bot.command('help', helpHandler);
bot.command('support', supportCommandHandler);
bot.command('paysupport', paySupportHandler);
bot.command('upgrade', (ctx) => upgradeHandler(ctx, 'manual_command'));
bot.command('tariffs', (ctx) => upgradeHandler(ctx, 'manual_command'));
bot.command('premium', (ctx) => upgradeHandler(ctx, 'manual_command'));
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
    return text === vpnText;
}, vpnHandler);

bot.command('vpn', vpnHandler);

// =====================================================================================
//                       KARAOKE LRC MAKER COMMANDS & ACTIONS
// =====================================================================================

bot.command('karaoke_test', async (ctx) => {
    if (isShuttingDown()) return;
    if (ctx.chat.type !== 'private') return;

    const tester = await getKaraokeTester(ctx.from.id);
    if (tester && tester.status === 'tester_active' && tester.plus_until && new Date(tester.plus_until) > new Date()) {
        const plusUntilDate = tester.plus_until ? new Date(tester.plus_until).toLocaleDateString('ru-RU') : 'не задан';
        return await ctx.reply(
            `🎤 Вы уже зарегистрированы как тестировщик!\n` +
            `Plus-доступ активен до: <b>${plusUntilDate}</b>\n\n` +
            `🔗 Сервис: https://karaoke-lrc.vercel.app/`,
            {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([
                    [Markup.button.url('🌐 Открыть сервис', 'https://karaoke-lrc.vercel.app/')],
                    [Markup.button.callback('✍️ Оставить отзыв', 'karaoke_feedback')]
                ])
            }
        );
    }

    await logKaraokeInvitation(ctx.from.id, ctx.from.username || null, ctx.from.first_name || null);

    const msg = `🎤 <b>Хочешь протестировать новый сервис для создания караоке-видео?</b>\n\n` +
        `Можно загрузить песню, найти текст, расставить тайминги, экспортировать видео и опубликовать караоке в каталог.\n\n` +
        `Я даю <b>Plus-доступ на 30 дней бесплатно</b>.\n` +
        `Взамен попрошу честно потестировать сервис и прислать пару отзывов или багов прямо сюда, если что-то пойдёт не так.\n\n` +
        `Мест пока немного.`;

    return await ctx.reply(msg, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
            [Markup.button.callback('🚀 Стать тестировщиком', 'karaoke_join')],
            [Markup.button.url('🌐 Открыть Karaoke LRC Maker', 'https://karaoke-lrc.vercel.app/')],
            [Markup.button.callback('Позже', 'karaoke_later')]
        ])
    });
});

bot.action('karaoke_join', async (ctx) => {
    await ctx.answerCbQuery();
    
    const limit = 50; // Лимит тестировщиков
    const result = await grantKaraokeTesterAccess(ctx.from.id, ctx.from.username || null, ctx.from.first_name || null, limit);

    if (result.success) {
        const plusUntilDate = result.plus_until ? new Date(result.plus_until).toLocaleDateString('ru-RU') : 'не задан';
        try { await ctx.editMessageReplyMarkup(null); } catch {}

        // Выдаем/продлеваем Plus-доступ в локальной базе музыкального бота (кроме администраторов)
        const isBotAdmin = Number(ctx.from.id) === Number(ADMIN_ID);
        if (!isBotAdmin) {
            await setTariffAdmin(ctx.from.id, 30, 30, { mode: 'extend' });
            console.log(`[Karaoke/Tester] Granted/extended Plus in Bot DB for user ${ctx.from.id} (30 days)`);
        }
        
        // Логируем действие в системный лог
        await logUserAction(ctx.from.id, 'karaoke_tester_activated', {
            limit: 30,
            days: 30,
            status: 'tester_active',
            source: 'karaoke_test'
        });
        
        let successMessage = `✅ <b>Готово! Я выдал тебе Plus-доступ на 30 дней (до ${plusUntilDate}).</b>\n\n`;
        if (result.existed_active && result.old_plus_until) {
            const oldDate = new Date(result.old_plus_until).toLocaleDateString('ru-RU');
            successMessage = `✅ <b>У тебя уже был активный тариф до ${oldDate}. Мы добавили 30 дней тестового Plus. Новый срок: ${plusUntilDate}.</b>\n\n`;
        }
        
        successMessage += `Попробуй создать караоке-видео и пришли фидбэк, если что-то будет неудобно или сломается.\n\n` +
                          `🔗 <b>Открыть сервис:</b> https://karaoke-lrc.vercel.app/`;

        return await ctx.reply(
            successMessage,
            {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([
                    [Markup.button.url('🌐 Открыть сервис', 'https://karaoke-lrc.vercel.app/')],
                    [Markup.button.callback('✍️ Отправить фидбэк', 'karaoke_feedback')]
                ])
            }
        );
    } else if (result.status === 'waitlist') {
        try { await ctx.editMessageReplyMarkup(null); } catch {}
        
        return await ctx.reply(
            `😔 <b>Места в первой группе тестировщиков уже закончились.</b>\n\n` +
            `Я добавил тебя в список ожидания и напишу, когда открою следующую волну тестирования.`
        );
    } else {
        return await ctx.reply('⚠️ Произошла ошибка при регистрации. Пожалуйста, попробуйте позже.');
    }
});

bot.action('karaoke_later', async (ctx) => {
    await ctx.answerCbQuery();
    try { await ctx.editMessageReplyMarkup(null); } catch {}
    return await ctx.reply('Хорошо! Если передумаете, команда /karaoke_test всегда доступна.');
});

bot.command('feedback', async (ctx) => {
    if (isShuttingDown()) return;
    if (ctx.chat.type !== 'private') return;
    
    const tester = await getKaraokeTester(ctx.from.id);
    if (!tester) {
        return await ctx.reply('⚠️ Вы не зарегистрированы как тестировщик. Чтобы принять участие, используйте команду /karaoke_test.');
    }
    
    await updateUserField(ctx.from.id, {
        karaoke_feedback_mode: true,
        karaoke_feedback_started_at: new Date()
    });
    
    return await ctx.reply(
        '🎤 <b>Оставьте ваш отзыв о Karaoke LRC Maker!</b>\n\n' +
        'Напишите, что вы заметили:\n' +
        '- что не работает или сломалось;\n' +
        '- что показалось непонятным или неудобным;\n' +
        '- что понравилось;\n' +
        '- на каком устройстве вы тестировали.\n\n' +
        'Вы можете отправить текст, скриншот, видео или файл.\n' +
        'Для отмены введите /cancel.',
        { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } }
    );
});

bot.action('karaoke_feedback', async (ctx) => {
    await ctx.answerCbQuery();
    
    await updateUserField(ctx.from.id, {
        karaoke_feedback_mode: true,
        karaoke_feedback_started_at: new Date()
    });
    
    return await ctx.reply(
        '🎤 <b>Оставьте ваш отзыв о Karaoke LRC Maker!</b>\n\n' +
        'Напишите, что вы заметили:\n' +
        '- что не работает или сломалось;\n' +
        '- что показалось непонятным или неудобным;\n' +
        '- что понравилось;\n' +
        '- на каком устройстве вы тестировали.\n\n' +
        'Вы можете отправить текст, скриншот, видео или файл.\n' +
        'Для отмены введите /cancel.',
        { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } }
    );
});

bot.command('karaoke_testers', async (ctx) => {
    if (isShuttingDown()) return;
    if (Number(ctx.from.id) !== Number(ADMIN_ID)) return;

    const stats = await getKaraokeTestersStats();
    
    const msg = `🎤 <b>Тестировщики Karaoke LRC Maker</b>\n\n` +
        `👤 Всего приглашено: <b>${stats.totalInvited}</b>\n` +
        `✅ Активировали тест: <b>${stats.totalActive}</b>\n` +
        `⏳ В листе ожидания: <b>${stats.totalWaitlist}</b>\n` +
        `💬 Оставили фидбэк: <b>${stats.totalFeedback}</b>\n\n` +
        `📊 <b>Активность на сайте:</b>\n` +
        `🌐 Открывали сервис: <b>${stats.openedService}</b>\n` +
        `📹 Экспортировали видео: <b>${stats.exportedVideos}</b>\n` +
        `🎵 Опубликовали караоке: <b>${stats.publishedKaraoke}</b>`;

    return await ctx.reply(msg, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
            [Markup.button.callback('🔄 Обновить', 'admin_karaoke_refresh')]
        ])
    });
});

bot.action('admin_karaoke_refresh', async (ctx) => {
    if (Number(ctx.from.id) !== Number(ADMIN_ID)) return ctx.answerCbQuery('Доступ запрещен');
    
    const stats = await getKaraokeTestersStats();
    
    const msg = `🎤 <b>Тестировщики Karaoke LRC Maker</b>\n\n` +
        `👤 Всего приглашено: <b>${stats.totalInvited}</b>\n` +
        `✅ Активировали тест: <b>${stats.totalActive}</b>\n` +
        `⏳ В листе ожидания: <b>${stats.totalWaitlist}</b>\n` +
        `💬 Оставили фидбэк: <b>${stats.totalFeedback}</b>\n\n` +
        `📊 <b>Активность на сайте:</b>\n` +
        `🌐 Открывали сервис: <b>${stats.openedService}</b>\n` +
        `📹 Экспортировали видео: <b>${stats.exportedVideos}</b>\n` +
        `🎵 Опубликовали караоке: <b>${stats.publishedKaraoke}</b>`;

    try {
        await ctx.editMessageText(msg, {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('🔄 Обновить', 'admin_karaoke_refresh')]
            ])
        });
        await ctx.answerCbQuery('Статистика обновлена!');
    } catch (e) {
        await ctx.answerCbQuery();
    }
});

const inlineQueries = new Map(); // userId -> currentQueryId

bot.on('inline_query', async (ctx) => {
    const query = ctx.inlineQuery.query;
    const userId = ctx.from?.id;
    const queryText = query ? query.trim() : '';

    if (queryText.length < 3) {
        return await ctx.answerInlineQuery([], { 
            switch_pm_text: 'Введите не менее 3 символов для поиска...', 
            switch_pm_parameter: 'start' 
        });
    }

    const currentQueryId = ctx.inlineQuery.id;
    if (userId) {
        inlineQueries.set(userId, currentQueryId);
    }

    // Дебаунс 350 мс
    await new Promise(r => setTimeout(r, 350));

    // Проверяем, не ввёл ли пользователь новый символ за это время
    if (userId && inlineQueries.get(userId) !== currentQueryId) {
        return;
    }

    try {
        // Трекаем начало поиска
        if (userId) {
            const { analyticsService } = await import('./services/analyticsService.js');
            await analyticsService.trackEventSafe(userId, 'track_search_started', 'search', {
                query: query.slice(0, 100),
                source: 'inline_query'
            }, ctx);
        }
        const results = await performInlineSearch(query, ctx.from.id);
        await ctx.answerInlineQuery(results, { cache_time: 60 });
        // Трекаем результат поиска
        if (userId) {
            const { analyticsService } = await import('./services/analyticsService.js');
            const eventName = results.length > 0 ? 'track_search_success' : 'track_search_failed';
            await analyticsService.trackEventSafe(userId, eventName, 'search', {
                query: query.slice(0, 100),
                results_count: results.length,
                source: 'inline_query'
            }, ctx);
        }
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
        
        const userLimit = getUserLimit(user);
        
        if (userLimit <= limitFree) {
            return parseInt(getSetting('playlist_limit_free') || '5', 10);
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

function getLimitUpsellPayload(user, lang = 'ru') {
    return buildLimitUpsell({
        lang,
        channelUsername: CHANNEL_USERNAME,
        bonusAvailable: Boolean(CHANNEL_USERNAME && !user?.subscribed_bonus_used),
        user,
        freeLimit: getConfiguredFreeDownloadLimit()
    });
}

async function trackPlaylistLimitReached(ctx, playlistLimit, requestedTracks) {
    const userId = ctx.from?.id;
    if (!userId) return;
    try {
        const { analyticsService } = await import('./services/analyticsService.js');
        await analyticsService.trackEventSafe(userId, 'playlist_limit_reached', 'limits', {
            playlist_limit: playlistLimit,
            requested_tracks: requestedTracks,
            deduplication_key: `playlist_limit:${userId}:${ctx.callbackQuery?.message?.message_id || Date.now()}`
        }, ctx);
    } catch (_error) {}
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
    const userLimit = getUserLimit(user);
    const remainingLimit = isAdmin ? 99999 : userLimit - (user.downloads_today || 0);

    if (remainingLimit <= 0) {
        const _lang1 = ctx.state?.lang || 'ru';
        const payload = getLimitUpsellPayload(user, _lang1);
        await ctx.editMessageText(payload.text, payload.extra);
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
        await trackPlaylistLimitReached(ctx, playlistLimit, session.tracks.length);
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
    const userLimit = getUserLimit(user);
    const remainingLimit = isAdmin ? 99999 : userLimit - (user.downloads_today || 0);
    if (remainingLimit <= 0) {
        const _lang2 = ctx.state?.lang || 'ru';
        const payload = getLimitUpsellPayload(user, _lang2);
        await ctx.editMessageText(payload.text, payload.extra);
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
            await trackPlaylistLimitReached(ctx, playlistLimit, session.selected.size);
            return await ctx.reply(`❌ Вы не можете выбрать более ${playlistLimit} треков за раз (лимит вашего тарифа на импорт плейлистов).`);
        }
    }
    
    // Так как названия важны, оставляем проверку, что они были загружены
    if (!session.fullTracks) {
        return await ctx.answerCbQuery('❌ Произошла ошибка: данные плейлиста не были загружены. Попробуйте заново.', { show_alert: true });
    }
    
    // --- 1. Проверка лимитов пользователя ---
    const user = await getUser(userId);
    const userLimit = getUserLimit(user);
    const remainingLimit = isAdmin ? 99999 : userLimit - (user.downloads_today || 0);
    
    if (remainingLimit <= 0) {
        const _langLR = ctx.state?.lang || 'ru';
        const payload = getLimitUpsellPayload(user, _langLR);
        await ctx.editMessageText(payload.text, payload.extra);
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
            console.error(`[youtube-dl] Ошибка для ${cleanUrl}:`, redactSecretsInText(errText));
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
    const userId = ctx.from?.id;
    const correlationId = getDownloadCorrelationId(ctx);
    logDownloadFlow(correlationId, 'limit-check', { userId, source: 'soundcloud' });
    try {
        if (await isDownloadLimitReached(ctx, ctx.from.id, correlationId)) {
            logDownloadFlow(correlationId, 'limit-rejected', { userId, source: 'soundcloud', queued: false });
            const user = await getUser(ctx.from.id);
            const _lang4 = ctx.state?.lang || 'ru';
            const payload = getLimitUpsellPayload(user, _lang4);
            await ctx.reply(payload.text, payload.extra);
            return;
        }

        logDownloadFlow(correlationId, 'limit-admitted', { userId, source: 'soundcloud' });
        if (userId) {
            try {
                const { analyticsService } = await import('./services/analyticsService.js');
                await analyticsService.trackEventSafe(userId, 'track_download_requested', 'downloads', {
                    url: url.slice(0, 200),
                    source: 'soundcloud',
                    correlation_id: correlationId
                }, ctx);
            } catch (_ae) {}
        }

        loadingMessage = await ctx.reply('🔍 Анализирую ссылку...');
        
        // 1. Расшифровываем и очищаем от рекламных меток
        const resolvedUrl = await resolveSoundCloudLink(url);
        const cleanUrl = resolvedUrl.split('?')[0]; 
        
        // 🔥 ДВОЙНАЯ ПРОВЕРКА КЭША: ищем и чистую, и старую "грязную" ссылку
        let cachedTrack = await findCachedTrack(cleanUrl, { source: 'soundcloud' });
        if (!cachedTrack && resolvedUrl !== cleanUrl) {
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
            
            await incrementDownloadsAndSaveTrack(ctx.from.id, cachedTrack.title, cachedTrack.fileId, cleanUrl, 'soundcloud', true, correlationId);
            logDownloadFlow(correlationId, 'delivery-complete', { userId, source: 'soundcloud' });
            return;
        }

        // Если в кэше нет — лезем в интернет
        const youtubeDl = getYoutubeDl();
        let data;
        try {
            data = await youtubeDl(cleanUrl, { dumpSingleJson: true, flatPlaylist: true, ignoreErrors: true });
        } catch (ytdlError) {
            const errText = ytdlError.stderr || ytdlError.message || '';
            console.error(`[youtube-dl] ДЕТАЛИ ОШИБКИ для ${cleanUrl}:`, redactSecretsInText(errText));
            if (errText.includes('DRM protected')) {
                throw new Error('DRM_PROTECTED');
            }
            const httpStatus = errText.match(/(?:HTTP(?: Error)?\s*)?(403|404|413)\b/i)?.[1];
            if (httpStatus) {
                const safeHttpError = new Error(`HTTP ${httpStatus}`);
                safeHttpError.status = Number(httpStatus);
                throw safeHttpError;
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
            await enqueue(ctx, ctx.from.id, cleanUrl, { isSingleTrack: true, metadata: data, correlationId });
        }
        
    } catch (error) {
        console.error('Ошибка handleSoundCloudUrl:', error.message);
        try {
            const { analyticsService } = await import('./services/analyticsService.js');
            await analyticsService.trackDownloadFailureSafe(userId, error, {
                source: 'soundcloud', path: 'direct_url', stage: 'metadata',
                correlation_id: correlationId, is_playlist: false
            }, ctx);
        } catch (_analyticsError) {}
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

bot.on('document', async (ctx, next) => {
    const user = ctx.state.user;
    if (!user?.support_mode) return next();
    const document = ctx.message.document;
    const mimeType = String(document.mime_type || '').toLowerCase();
    if (!SUPPORT_IMAGE_MIME_TYPES.has(mimeType)) return ctx.reply('Допустимы только PNG, JPG, JPEG и WEBP.');
    try {
        let attachment = {};
        try {
            attachment = await storeTelegramSupportImage({
                telegram: ctx.telegram,
                storage: supabase.storage.from('support-attachments'),
                fileId: document.file_id,
                mimeType,
                userId: ctx.from.id,
                fetchBuffer: async url => Buffer.from((await axios.get(url, { responseType: 'arraybuffer' })).data)
            });
        } catch (storageError) {
            console.error('[Support Storage] Document fallback to Telegram file_id:', storageError.message);
        }
        await createSupportMessage(ctx.from.id, ctx.message.caption || '', 'user', 'photo', document.file_id, attachment);
        await ctx.reply('✅ Ваше изображение отправлено в поддержку. Ожидайте ответа.');
    } catch (error) {
        console.error('[Support Document] Error:', error.message);
        await ctx.reply('❌ Не удалось отправить изображение. Попробуйте ещё раз.');
    }
});

bot.on('photo', async (ctx) => {
    if (isShuttingDown()) return;
    if (ctx.chat.type !== 'private') return;

    const user = ctx.state.user;
    if (user && user.support_mode) {
        try {
            const photo = ctx.message.photo[ctx.message.photo.length - 1];
            const fileId = photo.file_id;
            const caption = ctx.message.caption || '';

            let attachment = {};
            try {
                attachment = await storeTelegramSupportImage({
                    telegram: ctx.telegram,
                    storage: supabase.storage.from('support-attachments'),
                    fileId,
                    mimeType: 'image/jpeg',
                    userId: ctx.from.id,
                    fetchBuffer: async url => Buffer.from((await axios.get(url, { responseType: 'arraybuffer' })).data)
                });
            } catch (storageError) {
                console.error('[Support Storage] Falling back to Telegram file_id:', storageError.message);
            }
            await createSupportMessage(ctx.from.id, caption, 'user', 'photo', fileId, attachment);

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
                if (!claimDownloadRequest(ctx, scUrl)) {
                    logDownloadFlow(getDownloadCorrelationId(ctx), 'duplicate-update-url-skipped', { userId: ctx.from.id, source: 'soundcloud', queued: false });
                    continue;
                }
                await handleSoundCloudUrl(ctx, scUrl);
                added++;
            } catch (e) {
                console.error(`[Admin/Batch] Ошибка для ${scUrl}:`, e.message);
            }
        }
        console.log(`[Admin/Batch] Добавлено ${added}/${soundcloudUrls.length} ссылок в очередь`);
        return;
    }
    
    const url = urlMatch[0];

    if (!claimDownloadRequest(ctx, url)) {
        logDownloadFlow(getDownloadCorrelationId(ctx), 'duplicate-update-url-skipped', { userId: ctx.from.id, queued: false });
        return;
    }
    logDownloadFlow(getDownloadCorrelationId(ctx), 'update-accepted', { userId: ctx.from.id });

    // Определяем источник и обрабатываем
    
    if (url.includes('soundcloud.com')) {
        // SoundCloud
        if (getSetting('use_soundcloud') !== 'true') {
            await ctx.reply('⚠️ Сервис SoundCloud временно отключен администратором. Попробуйте позже или используйте другой сервис.');
            return;
        }
        await handleSoundCloudUrl(ctx, url);
    } else if (url.includes('open.spotify.com') || url.includes('spotify.com')) {
        // Spotify - показываем меню выбора качества
        if (getSetting('use_spotify') !== 'true') {
            await ctx.reply('⚠️ Сервис Spotify временно отключен администратором. Попробуйте позже или используйте другой сервис.');
            return;
        }
        await handleSpotifyUrl(ctx, url);
    } else if (url.includes('youtube.com') || url.includes('youtu.be') || url.includes('music.youtube.com')) {
        // YouTube / YouTube Music - показываем меню выбора качества
        if (getSetting('use_youtube') !== 'true') {
            await ctx.reply('⚠️ Сервис YouTube временно отключен администратором. Попробуйте позже или используйте другой сервис.');
            return;
        }
        await handleYouTubeUrl(ctx, url);
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

// === TELEGRAM STARS PAYMENTS FLOW ===

bot.action(/^buy_plan_(plus|pro|unlim)$/, async (ctx) => {
    const plan = ctx.match[1];
    const userId = ctx.from?.id;
    if (!userId) return;
    const lang = ctx.state.lang || 'ru';

    if (!acquireInvoiceRequest(userId, plan)) {
        return ctx.answerCbQuery(i18n(lang, 'invoice_request_in_progress')).catch(() => {});
    }

    try {
        await ctx.answerCbQuery().catch(() => {});

        // Импортируем тарифную сетку
        const { TARIFFS } = await import('./config/tariffs.js');
        const tariff = TARIFFS[plan];
        if (!tariff) return ctx.reply('Ошибка: неверный тарифный план.');

        // Создаем платежный предзаказ
        const { createPaymentOrder } = await import('./db.js');
        const order = await createPaymentOrder({
            userId,
            plan,
            amountMinor: tariff.priceXtr,
            currency: 'XTR',
            placement: 'bot_tariffs_menu',
            campaignId: null,
            periodDays: tariff.periodDays
        });

        const isEn = lang === 'en';

        const title = isEn ? `Plan ${tariff.name}` : `Тариф ${tariff.name}`;
        const limitLabel = tariff.dailyLimit === null
            ? (isEn ? 'unlimited' : 'безлимитно')
            : (isEn ? `${tariff.dailyLimit} downloads/day` : `${tariff.dailyLimit} скачиваний в день`);
        const description = isEn
            ? `Activate ${tariff.name} plan for ${tariff.periodDays} days. Limit: ${limitLabel}.`
            : `Активация тарифа ${tariff.name} на ${tariff.periodDays} дней. Лимит: ${limitLabel}.`;
        const payload = order.id.toString();
        const currency = 'XTR';

        const prices = [{
            label: tariff.name,
            amount: tariff.priceXtr
        }];

        // Выставляем счет
        try {
            await ctx.replyWithInvoice({
                title,
                description,
                payload,
                currency,
                prices
            });
        } catch (err) {
            releaseInvoiceRequest(userId, plan);
            console.error('[Payment] Error sending Stars invoice:', err.message);
            const errMsg = lang === 'en'
                ? '⚠️ Failed to issue invoice. Please try again or contact support.'
                : '⚠️ Не удалось выставить счет. Пожалуйста, попробуйте еще раз или обратитесь в поддержку.';
            await ctx.reply(errMsg);
            return;
        }

        // Отслеживаем выбор плана и способа оплаты
        const { analyticsService } = await import('./services/analyticsService.js');
        await analyticsService.trackEventSafe(userId, 'subscription_plan_clicked', 'monetization', {
            plan,
            price_xtr: tariff.priceXtr,
            placement: 'bot_tariffs_menu',
            order_id: order.id
        }, ctx);

        await analyticsService.trackEventSafe(userId, 'star_invoice_created', 'monetization', {
            plan,
            price_xtr: tariff.priceXtr,
            payment_method: 'telegram_stars',
            order_id: order.id
        }, ctx);

    } catch (e) {
        releaseInvoiceRequest(userId, plan);
        console.error('[PaymentAction] Error:', e.message);
    }
});

bot.on('pre_checkout_query', async (ctx) => {
    const orderId = ctx.preCheckoutQuery.invoice_payload;
    try {
        const { getPaymentOrder } = await import('./db.js');
        const order = await getPaymentOrder(orderId);

        if (!order) {
            return ctx.answerPreCheckoutQuery(false, 'Счет не найден в базе данных бота. Попробуйте еще раз.').catch(() => {});
        }

        if (order.status !== 'pending') {
            return ctx.answerPreCheckoutQuery(false, 'Этот счет уже обработан. Пожалуйста, выберите тариф заново.').catch(() => {});
        }

        const expiry = new Date(order.expires_at).getTime();
        if (expiry <= Date.now()) {
            return ctx.answerPreCheckoutQuery(false, 'Срок действия счета истек. Пожалуйста, выберите тариф заново.').catch(() => {});
        }

        if (Number(order.amount_minor) !== Number(ctx.preCheckoutQuery.total_amount)) {
            return ctx.answerPreCheckoutQuery(false, 'Ошибка: несовпадение суммы платежа.').catch(() => {});
        }

        if (ctx.preCheckoutQuery.currency !== 'XTR') {
            return ctx.answerPreCheckoutQuery(false, 'Ошибка: поддерживается только валюта Stars.').catch(() => {});
        }

        // Разрешаем оплату
        await ctx.answerPreCheckoutQuery(true).catch(() => {});

        // Логируем аналитику: пользователь прошёл pre-checkout
        try {
            const { analyticsService } = await import('./services/analyticsService.js');
            await analyticsService.trackEventSafe(ctx.from.id, 'star_pre_checkout_received', 'monetization', {
                order_id: orderId,
                amount: ctx.preCheckoutQuery.total_amount,
                currency: ctx.preCheckoutQuery.currency,
                plan: order.plan
            }, ctx);
        } catch (_ae) {}
    } catch (e) {
        console.error('[Payment] PreCheckoutQuery error:', e.message);
        await ctx.answerPreCheckoutQuery(false, 'Внутренняя ошибка сервера. Попробуйте позже.').catch(() => {});
    }
});

bot.on('successful_payment', async (ctx) => {
    const payment = ctx.message.successful_payment;
    const orderId = payment.invoice_payload;
    const userId = ctx.from?.id;
    if (!userId) return;

    try {
        const { processStarsPayment } = await import('./db.js');
        
        const result = await processStarsPayment({
            userId,
            orderId,
            telegramPaymentChargeId: payment.telegram_payment_charge_id,
            providerPaymentChargeId: payment.provider_payment_charge_id || null,
            amountMinor: payment.total_amount,
            currency: payment.currency,
            invoicePayload: orderId
        });

        if (result && result.status === 'success') {
            try {
                const { query } = await import('./db.js');
                await notifyAdminAboutConfirmedStarsPayment({
                    paymentResult: result,
                    paymentChargeId: payment.telegram_payment_charge_id,
                    adminId: ADMIN_ID,
                    queryFn: query,
                    sendMessage: (...args) => bot.telegram.sendMessage(...args)
                });
            } catch (notifyError) {
                console.error('[Payment/AdminNotify] Failed to notify administrator:', notifyError.message);
            }

            const { TARIFFS } = await import('./config/tariffs.js');
            const tariff = TARIFFS[result.plan];
            const name = tariff ? tariff.name : result.plan;
            const lang = ctx.state.lang || 'ru';
            const isEn = lang === 'en';

            const locale = isEn ? 'en-GB' : 'ru-RU';
            const tz = isEn ? 'UTC' : 'Europe/Moscow';
            const tzLabel = isEn ? 'UTC' : 'МСК';
            const expDate = new Date(result.new_premium_until).toLocaleDateString(locale, { timeZone: tz });

            let msgText;
            if (isEn) {
                msgText = `<b>🎉 Payment confirmed!</b>\n\nPlan <b>${name}</b> has been activated.\nValid until: <b>${expDate} (${tzLabel})</b>.\n\n`;
                if (result.op_type === 'renewal') {
                    msgText += `<i>Your previous subscription was active — the new plan was added on top and remaining days carried over!</i>`;
                } else {
                    msgText += `<i>Daily limits updated. Enjoy!</i>`;
                }
            } else {
                msgText = `<b>🎉 Оплата успешно подтверждена!</b>\n\nВам начислен тариф <b>${name}</b>.\nСрок действия продлен до: <b>${expDate} (${tzLabel})</b>.\n\n`;
                if (result.op_type === 'renewal') {
                    msgText += `<i>Поскольку у вас уже была активна подписка, новый тариф активирован сразу, а оставшиеся дни старого тарифа были сохранены и добавлены к общему сроку!</i>`;
                } else {
                    msgText += `<i>Дневные лимиты обновлены. Приятного пользования!</i>`;
                }
            }

            await ctx.reply(msgText, { parse_mode: 'HTML' });
        } else if (result && result.status === 'already_processed') {
            const alreadyMsg = (ctx.state.lang === 'en')
                ? 'This payment has already been processed.'
                : 'Этот платеж уже был успешно обработан ранее.';
            await ctx.reply(alreadyMsg);
        } else {
            const errorReason = result ? result.reason : 'unknown_error';
            console.error('[Payment] Stars payment process failed:', result);
            
            // Записываем ошибку в unprocessed_payments_log
            try {
                const { query } = await import('./db.js');
                await query(
                    `INSERT INTO public.unprocessed_payments_log 
                     (user_id, order_id, telegram_payment_charge_id, provider_payment_charge_id, amount_minor, currency, error_message, status)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, 'unprocessed')`,
                    [userId, orderId, payment.telegram_payment_charge_id, payment.provider_payment_charge_id || null, payment.total_amount, payment.currency, `status=${result ? result.status : 'error'} reason=${errorReason}`]
                );
            } catch (logErr) {
                console.error('[Payment] Error logging unprocessed payment:', logErr.message);
            }

            await ctx.reply('⚠️ Произошел технический сбой при автоматической активации тарифа. Не волнуйтесь, мы сохранили данные вашего платежа. Администратор активирует подписку вручную в ближайшее время.');
        }
    } catch (e) {
        console.error('[Payment] Error in successful_payment handler:', e.message);
        
        // Записываем критическую ошибку в базу
        try {
            const { query } = await import('./db.js');
            await query(
                `INSERT INTO public.unprocessed_payments_log 
                 (user_id, order_id, telegram_payment_charge_id, provider_payment_charge_id, amount_minor, currency, error_message, status)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, 'unprocessed')`,
                [userId, orderId, payment.telegram_payment_charge_id, payment.provider_payment_charge_id || null, payment.total_amount, payment.currency, e.message]
            );
        } catch (logErr) {
            console.error('[Payment] Error logging unprocessed payment:', logErr.message);
        }

        await ctx.reply('⚠️ Произошла непредвиденная ошибка при активации тарифа. Пожалуйста, напишите в техподдержку (кнопка в разделе Помощь) с указанием ID транзакции.');
    }
});
