// services/workerManager.js (улучшенная версия)

import cron from 'node-cron';
import { Mutex } from 'async-mutex';
import { ADMIN_ID } from '../config.js'; 
import {
  pool,
  getAndStartPendingBroadcastTask,
  updateBroadcastStatus,
  getUsersForBroadcastBatch,
  findAndInterruptActiveBroadcast,
  resetExpiredPremiumsBulk,
  getBroadcastProgress
} from '../db.js';
import {
  checkAndSendExpirationNotifications,
  notifyExpiringTodayHourly
} from './notifier.js';
import redisService from './redisClient.js';
import { downloadQueue } from './downloadManager.js';
import { 
  isShuttingDown, 
  setShuttingDown, 
  isBroadcasting, 
  setBroadcasting 
} from './appState.js';
import { runBroadcastBatch, sendAdminReport } from './broadcastManager.js';

// ========================= CONFIGURATION =========================

const SHUTDOWN_TIMEOUT = 25000; // 25 секунд
const BROADCAST_BATCH_SIZE = 100;
const BROADCAST_BATCH_DELAY = 1000; // 1 секунда между батчами
const BROADCAST_MAX_DURATION = 30 * 60 * 1000; // 30 минут

let botInstance;
const shutdownMutex = new Mutex();

// ========================= HELPER FUNCTIONS =========================

/**
 * Создаёт cron задачу с защитой от одновременного запуска
 */
function createCronTask(schedule, taskName, taskFn, options = {}) {
  let isRunning = false;
  
  // Watchdog для застрявших задач (по умолчанию 5 минут)
  const watchdogInterval = options.watchdogMs || 5 * 60 * 1000;
  
  setInterval(() => {
    if (isRunning) {
      console.warn(`[${taskName}] Задача застряла более ${watchdogInterval / 1000}с, принудительно сбрасываю флаг`);
      isRunning = false;
    }
  }, watchdogInterval);
  
  cron.schedule(schedule, async () => {
    // Проверка: уже запущена или идёт shutdown
    if (isRunning || isShuttingDown()) return;
    
    isRunning = true;
    console.log(`[${taskName}] Запуск задачи...`);
    
    try {
      await taskFn();
    } catch (e) {
      console.error(`[${taskName}] Ошибка выполнения:`, e.message);
    } finally {
      isRunning = false;
    }
  }, options.cronOptions);
  
  console.log(`[${taskName}] Планировщик запущен (${schedule})`);
}

// ========================= WORKERS =========================

/**
 * Нотификатор истечения подписок
 */
function startNotifierWorker() {
  // Дневной: каждую минуту (внутри функции свой гейт на 10:00 UTC)
  createCronTask(
    '* * * * *',
    'Notifier/Daily',
    async () => {
      await checkAndSendExpirationNotifications(botInstance);
    }
  );
  
  // Почасовой: в начале каждого часа
  createCronTask(
    '0 * * * *',
    'Notifier/Hourly',
    async () => {
      await notifyExpiringTodayHourly(botInstance);
    }
  );
}

/**
 * Автоматический сброс истёкших подписок до Free
 */
function startPremiumAutoResetWorker() {
  createCronTask(
    '10 0 * * *',
    'Premium/BulkReset',
    async () => {
      const count = await resetExpiredPremiumsBulk();
      if (count > 0) {
        console.log(`[Premium/BulkReset] Сброшено ${count} пользователей на тариф Free`);
      }
    },
    { cronOptions: { timezone: 'UTC' } }
  );
}

/**
 * Воркер массовых рассылок
 */
function drawProgressBar(current, total) {
  const size = 10;
  const progress = total > 0 ? Math.round((current / total) * size) : 0;
  const empty = size - progress;
  return `<code>[${'■'.repeat(progress)}${'□'.repeat(empty)}]</code>`;
}
function startBroadcastWorker() {
  createCronTask(
    '* * * * *',
    'Broadcast',
    async () => {
      if (isBroadcasting()) return;
      
      const task = await getAndStartPendingBroadcastTask();
      if (!task) return;
      
      console.log(`[Broadcast] Начинаю рассылку #${task.id}.`);
      setBroadcasting(true);
      downloadQueue.pause();
      
      const startTime = Date.now();
      let isDone = false;
      let reportMsgId = null; // ID сообщения для обновления прогресса

      try {
        // 1. Отправляем начальное сообщение админу
        const initialReport = await botInstance.telegram.sendMessage(
          ADMIN_ID, 
          `⏳ <b>Подготовка рассылки #${task.id}...</b>`, 
          { parse_mode: 'HTML' }
        );
        reportMsgId = initialReport.message_id;

        while (!isDone && !isShuttingDown()) {
          if (Date.now() - startTime > BROADCAST_MAX_DURATION) {
            await updateBroadcastStatus(task.id, 'pending');
            break;
          }
          
          const users = await getUsersForBroadcastBatch(
            task.id,
            task.target_audience,
            BROADCAST_BATCH_SIZE
          );
          
          if (users.length === 0) {
            isDone = true;
            continue;
          }
          
          // 2. Отправляем пачку
          await runBroadcastBatch(botInstance, task, users);

          // 3. ОБНОВЛЯЕМ ПРОГРЕСС-БАР
          const { total, sent } = await getBroadcastProgress(task.id, task.target_audience);
          const percent = total > 0 ? ((sent / total) * 100).toFixed(1) : '0';
          const bar = drawProgressBar(sent, total);

          try {
            await botInstance.telegram.editMessageText(
              ADMIN_ID,
              reportMsgId,
              null,
              `⏳ <b>Выполнение рассылки #${task.id}</b>\n\n` +
              `${bar} <b>${percent}%</b>\n\n` +
              `📦 Отправлено: <b>${sent} / ${total}</b>\n` +
              `👤 Аудитория: <code>${task.target_audience}</code>`,
              { parse_mode: 'HTML' }
            );
          } catch (editErr) {
            // Игнорируем ошибки редактирования (например, если текст не изменился)
          }
          
          await new Promise(resolve => setTimeout(resolve, BROADCAST_BATCH_DELAY));
        }
        
        if (!isShuttingDown() && isDone) {
          await updateBroadcastStatus(task.id, 'completed');
          
          // 4. Финальный отчет (редактируем то же сообщение)
          const { total, sent } = await getBroadcastProgress(task.id, task.target_audience);
          await botInstance.telegram.editMessageText(
            ADMIN_ID,
            reportMsgId,
            null,
            `✅ <b>Рассылка #${task.id} завершена!</b>\n\n` +
            `${drawProgressBar(sent, total)} <b>100%</b>\n\n` +
            `📦 Всего отправлено: <b>${sent}</b>\n` +
            `⏱ Время выполнения: <b>${Math.round((Date.now() - startTime) / 1000)} сек.</b>`,
            { parse_mode: 'HTML' }
          );
        }
      } catch (error) {
        console.error(`[Broadcast] Ошибка:`, error);
        await updateBroadcastStatus(task.id, 'failed', error.message);
        if (reportMsgId) {
          await botInstance.telegram.sendMessage(ADMIN_ID, `❌ Ошибка рассылки #${task.id}: ${error.message}`);
        }
      } finally {
        setBroadcasting(false);
        downloadQueue.start();
      }
    },
    { watchdogMs: 35 * 60 * 1000 }
  );
}

// ========================= GRACEFUL SHUTDOWN =========================

/**
 * Настройка изящного завершения работы
 */
function setupGracefulShutdown(server) {
  const gracefulShutdown = async (signal) => {
    // Защита от повторных вызовов через mutex
    const release = await shutdownMutex.acquire();
    
    try {
      if (isShuttingDown()) {
        console.log(`[Shutdown] Уже выполняется, игнорирую повторный сигнал ${signal}`);
        return;
      }
      
      setShuttingDown(true);
      console.log(`[Shutdown] Получен сигнал ${signal}. Начинаю изящное завершение...`);
      
      // Закрываем HTTP сервер
      server.close(() => console.log('[Shutdown] HTTP сервер закрыт'));
      
      // Если идёт рассылка — помечаем как прерванную
      if (isBroadcasting()) {
        // services/workerManager.js (улучшенная версия) - ЧАСТЬ 2 (ФИНАЛ)

        console.log('[Shutdown] Обнаружена активная рассылка, помечаю как прерванную...');
        await findAndInterruptActiveBroadcast();
      }
      
      // Останавливаем новые задачи в очереди
      downloadQueue.pause();
      console.log('[Shutdown] Очередь скачивания приостановлена');
      
      // Ждём завершения активных задач (с таймаутом и периодической проверкой)
      const maxWaitTime = 30000; // 30 секунд
      const startTime = Date.now();
      
      while (Date.now() - startTime < maxWaitTime) {
        const stats = downloadQueue.getStats();
        
        if (stats.activeTasks === 0 && stats.queueSize === 0) {
          console.log('[Shutdown] Все активные задачи завершены');
          break;
        }
        
        const remainingSeconds = Math.round((maxWaitTime - (Date.now() - startTime)) / 1000);
        console.log(
          `[Shutdown] Ожидаю завершения задач... ` +
          `(активных: ${stats.activeTasks}, в ожидании: ${stats.queueSize}). ` +
          `Осталось: ${remainingSeconds}с`
        );
        
        await new Promise(r => setTimeout(r, 2000)); // Проверяем каждые 2 секунды
      }
      
      // Очищаем очередь ожидания после таймаута
      const finalStats = downloadQueue.getStats();
      if (finalStats.queueSize > 0) {
        console.warn(`[Shutdown] Не все задачи завершились, очищаю очередь (${finalStats.queueSize} задач)`);
        downloadQueue.clear();
      }
      
      // Закрываем соединения с БД и Redis
      console.log('[Shutdown] Закрываю соединения с БД и Redis...');
      await Promise.allSettled([
        pool.end(),
        redisService.disconnect()
      ]);
      
      console.log('[Shutdown] ✅ Завершение работы успешно завершено');
      process.exit(0);
    } catch (e) {
      console.error('[Shutdown] Ошибка при завершении:', e);
      process.exit(1);
    } finally {
      release();
    }
  };
  
  // Регистрируем обработчики сигналов
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  
  // Обработка необработанных ошибок (для диагностики)
  process.on('unhandledRejection', (reason, promise) => {
    console.error('[UnhandledRejection]', reason);
    console.error('Promise:', promise);
    // Не завершаем процесс для unhandledRejection, так как это может быть обработано
  });
  
  // Для uncaughtException НЕ делаем graceful shutdown - сразу выходим
  process.on('uncaughtException', (error) => {
    console.error('[UncaughtException]', error);
    console.error('[Shutdown] Критическая ошибка, немедленный выход');
    process.exit(1); // Немедленный выход без graceful shutdown;
    gracefulShutdown('UNCAUGHT_EXCEPTION');
  });
}

// ========================= INITIALIZATION =========================

/**
 * Инициализация всех воркеров
 */
export function initializeWorkers(server, bot) {
  botInstance = bot;
  
  console.log('[Workers] Инициализация воркеров...');
  
  // Запускаем воркеры
  startBroadcastWorker();
  startNotifierWorker();
  startPremiumAutoResetWorker();
  
  // Настраиваем graceful shutdown
  setupGracefulShutdown(server);
  
  console.log('[Workers] ✅ Все воркеры успешно запущены');
}

// ========================= EXPORTS SUMMARY =========================
// Основной экспорт: initializeWorkers(server, bot)
// Запускает все фоновые задачи:
// - Broadcast Worker: обработка массовых рассылок
// - Notifier Worker: уведомления об истечении подписок (daily + hourly)
// - Premium Auto-Reset Worker: ночной сброс истёкших подписок
// - Graceful Shutdown: корректное завершение работы при SIGTERM/SIGINT

// ========================= CONFIGURATION TIPS =========================
// 
// Константы для настройки (можно вынести в ENV):
// - SHUTDOWN_TIMEOUT=25000 (таймаут graceful shutdown)
// - BROADCAST_BATCH_SIZE=100 (размер батча рассылки)
// - BROADCAST_BATCH_DELAY=1000 (задержка между батчами, мс)
// - BROADCAST_MAX_DURATION=1800000 (макс. длительность рассылки, 30 мин)
// 
// ========================= END OF FILE =========================
