export async function safeTelegramCall(ctx, method, ...args) {
  try {
    return await ctx.telegram[method](...args);
  } catch (e) {
    console.error(`Ошибка вызова Telegram API метода ${method}:`, e);
    // Можно добавить логирование в БД или отправку уведомления админу
    return null;
  }
}
