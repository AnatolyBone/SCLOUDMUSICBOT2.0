// src/bot.js
import { Telegraf } from 'telegraf';
import { StartCommand, AdminCommand } from '../services/botCommand.js';  // Импортируем команды

const bot = new Telegraf(process.env.BOT_TOKEN);

// Создаем экземпляры команд
const startCommand = new StartCommand();
const adminCommand = new AdminCommand();

// Настройка бота
bot.start((ctx) => startCommand.execute(ctx));  // Запуск команды /start
bot.command('admin', (ctx) => adminCommand.execute(ctx));  // Запуск команды /admin

// Здесь добавьте другие команды и обработчики, например:
bot.hears('📋 Меню', async (ctx) => {
  const message = 'Здесь будет ваше меню';
  await ctx.reply(message);
});

// Можно добавить другие команды с помощью классов
// bot.hears('...')

export { bot };