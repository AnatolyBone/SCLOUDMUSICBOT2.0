import { Telegraf, Markup } from 'telegraf';
import { BOT_TOKEN, ADMIN_ID, WEBHOOK_URL } from '../config/env.js';
import { createUser, getUser, getAllUsers, updateUserField, getUserById, setPremium, addOrUpdateUserInSupabase } from '../db/userRepository.js';
import { logEvent } from '../db/logRepository.js';
import { enqueue } from './trackProcessor.js';
import { texts, kb, isSubscribed, getPersonalMessage, formatMenuMessage, sendAudioSafe, extractUrl } from './botUtils.js';
import { saveTrackForUser } from '../db/trackRepository.js';
import { broadcastMessage } from './broadcastHandler.js';
import { sanitizeFilename } from '../utils/fileUtils.js';
import { handleReferralBonus } from './referralHandler.js';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cacheDir = path.join(__dirname, '../../cache');

const bot = new Telegraf(BOT_TOKEN);

// Команды бота
bot.start(async ctx => {
  const user = ctx.from;
  const referrerId = ctx.startPayload;

  // Создание и обновление пользователя
  await createUser(user.id, user.first_name, user.username);
  await addOrUpdateUserInSupabase(user.id, user.first_name, user.username, referrerId);

  // Логируем событие "регистрация"
  await logEvent(user.id, 'registered');

  // Обработка реферального бонуса
  if (referrerId) {
    await handleReferralBonus(user.id, referrerId);
  }

  const fullUser = await getUser(user.id);

  await ctx.reply(getPersonalMessage(fullUser));

  // ⏳ Добавляем задержку ~1.5 секунды
  await ctx.replyWithChatAction('typing');
  await new Promise(resolve => setTimeout(resolve, 2000));

  await ctx.reply(formatMenuMessage(fullUser), kb());
});

bot.hears(texts.menu, async ctx => {
  const user = await getUser(ctx.from.id);
  await ctx.reply(formatMenuMessage(user), kb());

  // Добавляем inline-кнопку, если бонус ещё не использован
  if (!user.subscribed_bonus_used) {
    await ctx.reply(
      'Нажми кнопку ниже, чтобы получить бонус после подписки:',
      Markup.inlineKeyboard([
        Markup.button.callback('✅ Я подписался', 'check_subscription')
      ])
    );
  }
});

bot.hears(texts.help, async ctx => {
  await ctx.reply(texts.helpInfo, kb());
});

bot.hears(texts.upgrade, async ctx => {
  await ctx.reply(texts.upgradeInfo, kb());
});

bot.hears(texts.mytracks, async ctx => {
  const user = await getUser(ctx.from.id);
  if (!user) return ctx.reply('Ошибка получения данных пользователя.');

  let tracks = [];
  try {
    tracks = user.tracks_today ? JSON.parse(user.tracks_today) : [];
  } catch (e) {
    console.warn('Ошибка парсинга tracks_today:', e);
    return ctx.reply('❌ Ошибка чтения треков. Попробуй позже.');
  }

  if (!tracks.length) return ctx.reply('Сегодня ты ещё ничего не скачивал.');

  await ctx.reply(`Скачано сегодня ${tracks.length} из ${user.premium_limit || 10}`);

  for (let i = 0; i < tracks.length; i += 5) {
    const chunk = tracks.slice(i, i + 5);

    // Фильтруем треки с валидным fileId
    const mediaGroup = chunk
      .filter(t => t.fileId && typeof t.fileId === 'string' && t.fileId.trim().length > 0)
      .map(t => ({
        type: 'audio',
        media: t.fileId
      }));

    if (mediaGroup.length > 0) {
      try {
        await ctx.replyWithMediaGroup(mediaGroup);
      } catch (e) {
        console.error('Ошибка отправки аудио-пачки:', e);

        // Если не получилось, отправляем по одному треку без caption
        for (let t of chunk) {
          try {
            await ctx.replyWithAudio(t.fileId);
          } catch {
            // Если fileId не работает — отправляем локальный файл
            const filePath = path.join(cacheDir, `${sanitizeFilename(t.title)}.mp3`);
            if (fs.existsSync(filePath)) {
              const msg = await ctx.replyWithAudio({ source: fs.createReadStream(filePath) });
              const newFileId = msg.audio.file_id;

              // Обновляем fileId в базе
              await saveTrackForUser(ctx.from.id, t.title, newFileId);

              console.log(`Обновлен fileId для трека "${t.title}" у пользователя ${ctx.from.id}`);
            } else {
              console.warn(`Файл для трека "${t.title}" не найден на диске.`);
              await ctx.reply(`⚠️ Не удалось отправить трек "${t.title}". Файл не найден.`);
            }
          }
        }
      }
    } else {
      // Если ни одного валидного fileId нет — отправляем по одному локальным файлом
      for (let t of chunk) {
        const filePath = path.join(cacheDir, `${sanitizeFilename(t.title)}.mp3`);
        if (fs.existsSync(filePath)) {
          const msg = await ctx.replyWithAudio({ source: fs.createReadStream(filePath) });
          const newFileId = msg.audio.file_id;

          await saveTrackForUser(ctx.from.id, t.title, newFileId);

          console.log(`Обновлен fileId для трека "${t.title}" у пользователя ${ctx.from.id}`);
        } else {
          console.warn(`Файл для трека "${t.title}" не найден на диске.`);
          await ctx.reply(`⚠️ Не удалось отправить трек "${t.title}". Файл не найден.`);
        }
      }
    }
  }
});

bot.command('admin', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply('❌ У вас нет доступа к этой команде.');
  }

  try {
    const users = await getAllUsers();
    const totalUsers = users.length;
    const totalDownloads = users.reduce((sum, u) => sum + (u.total_downloads || 0), 0);

    const activeToday = users.filter(u => {
      if (!u.last_active) return false;
      const last = new Date(u.last_active);
      const now = new Date();
      return last.toDateString() === now.toDateString();
    }).length;

    await ctx.reply(
`📊 Статистика бота:\n\n👤 Пользователей: ${totalUsers}\n📥 Всего загрузок: ${totalDownloads}\n🟢 Активных сегодня: ${activeToday}\n\n🤖 Бот работает.\n🧭 Панель: ${WEBHOOK_URL}/dashboard`
    );
  } catch (e) {
    console.error('Ошибка в /admin:', e);
    await ctx.reply('⚠️ Ошибка получения статистики');
  }
});
bot.action('check_subscription', async ctx => {
  const subscribed = await isSubscribed(bot, ctx.from.id);
  if (subscribed) {
    const user = await getUser(ctx.from.id);
    if (user.subscribed_bonus_used) {
      await ctx.reply('Ты уже использовал бонус подписки.');
    } else {
      const until = Date.now() + 7 * 24 * 3600 * 1000;
      await setPremium(ctx.from.id, 50, 7);
      await updateUserField(ctx.from.id, 'subscribed_bonus_used', true);
      await ctx.reply('Поздравляю! Тебе начислен бонус: 7 дней Plus.');
    }
  } else {
    await ctx.reply('Пожалуйста, подпишись на канал @BAZAproject и нажми кнопку ещё раз.');
  }
  await ctx.answerCbQuery();
});
bot.on('text', async ctx => {
  const url = extractUrl(ctx.message.text);
  if (!url) {
    await ctx.reply('Пожалуйста, отправь ссылку на трек или плейлист SoundCloud.');
    return;
  }

  try {
    await ctx.reply('🔄 Загружаю трек... Это может занять пару минут.');
  } catch (e) {
    console.error('Ошибка при отправке сообщения:', e);
  }

  enqueue(ctx, ctx.from.id, url).catch(async e => {
    console.error('Ошибка в enqueue:', e);
    try {
      await bot.telegram.sendMessage(ctx.chat.id, '❌ Ошибка при обработке ссылки.');
    } catch {}
  });
});

export default bot;
