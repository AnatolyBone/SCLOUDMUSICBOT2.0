import { getAllUsers } from "../db/userRepository.js";
import { logEvent } from "../db/logRepository.js";
import bot from "./bot.js"; // Импортируем экземпляр бота

export async function broadcastMessage(message, audioFile = null) {
  const users = await getAllUsers(true); // Получаем всех пользователей, включая неактивных
  let successCount = 0;
  let errorCount = 0;

  for (const user of users) {
    try {
      if (audioFile) {
        await bot.telegram.sendAudio(user.id, { source: audioFile.buffer, filename: audioFile.originalname });
      }
      if (message) {
        await bot.telegram.sendMessage(user.id, message);
      }
      successCount++;
      await logEvent(user.id, "broadcast_sent");
    } catch (e) {
      console.error(`Ошибка отправки сообщения пользователю ${user.id}:`, e);
      errorCount++;
      await logEvent(user.id, "broadcast_failed", { error: e.message });
    }
  }
  return { successCount, errorCount };
}
