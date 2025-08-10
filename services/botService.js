// services/botService.js
class BotService {
  constructor(bot) {
    this.bot = bot;
  }

  // Метод для настройки бота
  setupTelegramBot() {
    // Пример обработки текстовых сообщений
    this.bot.on('text', async (ctx) => {
      try {
        // Логика для обработки текстов
        ctx.reply('Hello, world!');
      } catch (e) {
        console.error('Ошибка при обработке текста:', e);
      }
    });

    // Добавьте другие обработчики, например:
    // this.bot.on('sticker', ctx => ctx.reply('Sticker received!'));
  }

  // Метод для старта бота
  async start() {
    try {
      await this.bot.launch(); // Запуск бота
      console.log('✅ Бот запущен!');
    } catch (error) {
      console.error('Ошибка при запуске бота:', error);
    }
  }
}

export default BotService;