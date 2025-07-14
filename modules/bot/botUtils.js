import { Markup } from 'telegraf';
import { BOT_TOKEN } from '../config/env.js';
import { getUser, updateUserField } from '../db/userRepository.js';
import { logEvent } from '../db/logRepository.js';
import { safeTelegramCall } from '../utils/telegramUtils.js';
import { sanitizeFilename } from '../utils/fileUtils.js';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cacheDir = path.join(__dirname, '../../cache');

export const texts = {
  start: '👋 Пришли ссылку на трек с SoundCloud.',
  menu: '📋 Меню',
  upgrade: '🔓 Расширить лимит',
  mytracks: '🎵 Мои треки',
  help: 'ℹ️ Помощь',
  downloading: '🎧 Загружаю...',
  error: '❌ Ошибка',
  noTracks: 'Сегодня нет треков.',
  limitReached: `🚫 Лимит достигнут ❌\n\n💡 Чтобы качать больше треков, переходи на тариф Plus или выше.\n\n📣 Подпишись на канал с новостями: @SCM_BLOG`,
  upgradeInfo: `🚀 Хочешь больше треков?\n\n🆓 Free — 5 🟢  \nPlus — 20 🎯 (59₽)  \nPro — 50 💪 (119₽)  \nUnlimited — 💎 (199₽)\n\n👉 Донат: https://boosty.to/anatoly_bone/donate  \n✉️ После оплаты напиши: @anatolybone\n\n📣 Новости и фишки: @SCM_BLOG`,
  helpInfo: `ℹ️ Просто пришли ссылку и получишь mp3.  \n🔓 Расширить — оплати и подтверди.  \n🎵 Мои треки — список за сегодня.  \n📋 Меню — тариф, лимиты, рефералы.  \n📣 Канал: @SCM_BLOG`,
  queuePosition: pos => `⏳ Трек добавлен в очередь (#${pos})`,
  adminCommands: '\n\n📋 Команды админа:\n/admin — статистика'
};

export const kb = () =>
  Markup.keyboard([
    [texts.menu, texts.upgrade],
    [texts.mytracks, texts.help]
  ]).resize();

export const isSubscribed = async (botInstance, userId) => {
  try {
    const res = await botInstance.telegram.getChatMember('@BAZAproject', userId);
    return ['member', 'creator', 'administrator'].includes(res.status);
  } catch {
    return false;
  }
};

export async function sendAudioSafe(ctx, userId, filePath, title) {
  try {
    const message = await ctx.telegram.sendAudio(userId, {
      source: fs.createReadStream(filePath),
      filename: `${title}.mp3`
    }, {
      title,
      performer: 'SoundCloud'
    });
    return message.audio.file_id;
  } catch (e) {
    console.error(`Ошибка отправки аудио пользователю ${userId}:`, e);
    await ctx.telegram.sendMessage(userId, 'Произошла ошибка при отправке трека.');
    return null;
  }
}

export function getPersonalMessage(user) {
  const tariffName = getTariffName(user.premium_limit);
          
  return `Привет, ${user.first_name}!\n\n😎 Этот бот — не стартап и не команда разработчиков.  \nЯ делаю его сам, просто потому что хочется удобный и честный инструмент.  \nБез рекламы, без сбора данных — всё по-простому.\n\nЕсли пользуешься — круто. Рад, что зашло.  \nСпасибо, что ты тут 🙌\n\n💼 Текущий тариф: ${tariffName}\n\n⚠️ Скоро немного снизим лимиты, чтобы бот продолжал работать стабильно.  \nПроект держится на моих ресурсах, и иногда приходится идти на такие меры.\n\nНадеюсь на понимание. 🙏`;
}

export function getTariffName(limit) {
  if (limit >= 1000) return 'Unlim (∞/день)';
  if (limit >= 100) return 'Pro (100/день)';
  if (limit >= 50) return 'Plus (50/день)';
  return 'Free (10/день)';
}

export function getReferralLink(userId) {
  return `https://t.me/SCloudMusicBot?start=${userId}`;
}

export function getDaysLeft(premiumUntil) {
  if (!premiumUntil) return 0;
  const now = new Date();
  const until = new Date(premiumUntil);
  const diff = until - now;
  return Math.max(Math.ceil(diff / (1000 * 60 * 60 * 24)), 0);
}

export function formatMenuMessage(user) {
  const tariffLabel = getTariffName(user.premium_limit);
  const downloadsToday = user.downloads_today || 0;
  const invited = user.invited_count || 0;
  const bonusDays = user.bonus_days || 0;
  const refLink = getReferralLink(user.id);
  const daysLeft = getDaysLeft(user.premium_until);

  return `\n👋 Привет, ${user.first_name}!\n\n📥 Бот качает треки и плейлисты с SoundCloud в MP3.  \nПросто пришли ссылку — и всё 🧙‍♂️\n\n📣 Хочешь быть в курсе новостей, фишек и бонусов?  \nПодпишись на наш канал 👉 @SCM_BLOG\n\n🔄 При отправке ссылки ты увидишь свою позицию в очереди.  \n🎯 Платные тарифы идут с приоритетом — их треки загружаются первыми.  \n📥 Бесплатные пользователи тоже получают треки — просто чуть позже.\n\n💼 Тариф: ${tariffLabel}  \n⏳ Осталось дней: ${daysLeft}\n
🎧 Сегодня скачано: ${downloadsToday} из ${user.premium_limit}\n
👫 Приглашено: ${invited}  \n🎁 Получено дней Plus по рефералам: ${bonusDays}\n
🔗 Твоя реферальная ссылка:  \n${refLink}\n  `.trim();
}

export function extractUrl(text) {
  const regex = /(https?:\/\/[^\s]+)/g;
  const matches = text.match(regex);
  if (!matches) return null;
  return matches.find(url => url.includes('soundcloud.com')) || matches[0];
}
