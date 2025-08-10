import { T, loadTexts } from './config/texts.js'; // Убедитесь, что этот импорт правильный

async function setupTelegramBot() {
  bot.start(async (ctx) => {
    try {
      const user = ctx.state.user || await getUser(ctx.from.id, ctx.from.first_name, ctx.from.username);
      const messageText = formatMenuMessage(user, ctx);
      await ctx.reply(messageText, { reply_markup: getBonusKeyboard(user) }); // parse_mode убран
      await ctx.reply('Выберите действие:', kb());
    } catch (e) {
      await handleSendMessageError(e, ctx.from.id);
    }
  });

  bot.hears(T('menu'), async (ctx) => {
    try {
      const user = ctx.state.user || await getUser(ctx.from.id);
      const messageText = formatMenuMessage(user, ctx);
      await ctx.reply(messageText, { reply_markup: getBonusKeyboard(user) }); // parse_mode убран
    } catch (e) {
      await handleSendMessageError(e, ctx.from.id);
    }
  });

  bot.hears(T('mytracks'), async (ctx) => {
    try {
      const user = ctx.state.user || await getUser(ctx.from.id);
      let tracks = [];
      if (Array.isArray(user.tracks_today)) {
        tracks = user.tracks_today;
      } else if (typeof user.tracks_today === 'string') {
        try { tracks = JSON.parse(user.tracks_today); } catch { tracks = []; }
      }
      const validTracks = tracks.filter(t => t && t.fileId);
      if (!validTracks.length) {
        return await ctx.reply(T('noTracks') || 'У вас пока нет треков за сегодня.');
      }
      for (let i = 0; i < validTracks.length; i += 5) {
        const chunk = validTracks.slice(i, i + 5);
        await ctx.replyWithMediaGroup(chunk.map(track => ({ type: 'audio', media: track.fileId, title: track.title })));
      }
    } catch (err) {
      console.error('Ошибка в /mytracks:', err);
      await ctx.reply('Произошла ошибка при получении треков.');
    }
  });

  bot.hears(T('help'), async (ctx) => {
    try { 
      await ctx.reply(T('helpInfo'), kb());
    } catch (e) {
      await handleSendMessageError(e, ctx.from.id);
    }
  });

  bot.hears(T('upgrade'), async (ctx) => {
    try {
      // Убираем форматирование
      await ctx.reply(T('upgradeInfo').replace(/\*/g, ''));
    } catch (e) {
      await handleSendMessageError(e, ctx.from.id);
    }
  });

  bot.command('admin', async (ctx) => {
    if (ctx.from.id !== Number(process.env.ADMIN_ID)) return;
    try {
      const users = await getAllUsers(true);
      const totalUsers = users.length;
      const activeUsers = users.filter(u => u.active).length;
      const totalDownloads = users.reduce((sum, u) => sum + (u.total_downloads || 0), 0);
      const now = new Date();
      const activeToday = users.filter(u => u.last_active && new Date(u.last_active).toDateString() === now.toDateString()).length;

      const dashboardUrl = `${WEBHOOK_URL.replace(/\/$/, '')}/dashboard`;

      const message = `
        📊 <b>Статистика Бота</b>
        👤 <b>Пользователи:</b>
           - Всего: <i>${totalUsers}</i>
           - Активных всего: <i>${activeUsers}</i>
           - Активных сегодня: <i>${activeToday}</i>
        📥 <b>Загрузки:</b>
           - Всего за все время: <i>${totalDownloads}</i>
        ⚙️ <b>Очередь сейчас:</b>
           - В работе: <i>${downloadQueue.active}</i>
           - В ожидании: <i>${downloadQueue.size}</i>
        🔗 <a href="${dashboardUrl}">Открыть админ-панель</a>
      `;
      
      await ctx.replyWithHTML(message.trim());
    } catch (e) {
      console.error('❌ Ошибка в команде /admin:', e);
      try {
        await ctx.reply('⚠️ Произошла ошибка при получении статистики.');
      } catch {}
    }
  });

  bot.on('text', async (ctx) => {
    try {
      const url = extractUrl(ctx.message.text);
      if (url) {
        await enqueue(ctx, ctx.from.id, url);
      } else if (![T('menu'), T('upgrade'), T('mytracks'), T('help')].includes(ctx.message.text)) {
        await ctx.reply('Пожалуйста, пришлите ссылку на трек или плейлист SoundCloud.');
      }
    } catch (e) {
      await handleSendMessageError(e, ctx.from.id);
    }
  });
}

export { setupTelegramBot };