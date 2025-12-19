// services/taskBroker.js
// Брокер задач через Redis (Master ↔ Worker)

import Redis from 'ioredis';
import { EventEmitter } from 'events';

const QUEUE_KEY = 'music:download:queue';
const RESULTS_KEY = 'music:download:results';
const WORKER_HEARTBEAT = 'music:worker:heartbeat';

class TaskBroker extends EventEmitter {
  constructor() {
    super();
    this.redis = null;
    this.subscriber = null;
    this.isConnected = false;
  }

  async connect(redisUrl) {
    if (!redisUrl) {
      console.log('[TaskBroker] Redis URL не задан, работаем локально');
      return false;
    }

    try {
      this.redis = new Redis(redisUrl);
      this.subscriber = new Redis(redisUrl);
      
      // Подписываемся на результаты
      await this.subscriber.subscribe(RESULTS_KEY);
      this.subscriber.on('message', (channel, message) => {
        if (channel === RESULTS_KEY) {
          try {
            const result = JSON.parse(message);
            this.emit('result', result);
          } catch (err) {
            console.error('[TaskBroker] Ошибка парсинга результата:', err.message);
          }
        }
      });

      this.isConnected = true;
      console.log('[TaskBroker] ✅ Подключён к Redis');
      return true;
    } catch (err) {
      console.error('[TaskBroker] ❌ Ошибка подключения:', err.message);
      return false;
    }
  }

  /**
   * Добавляет задачу в очередь (вызывается на Master)
   */
  async addTask(task) {
    if (!this.isConnected) {
      return null; // Обрабатываем локально
    }

    const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const taskData = { ...task, taskId, createdAt: Date.now() };
    
    await this.redis.lpush(QUEUE_KEY, JSON.stringify(taskData));
    console.log(`[TaskBroker] 📤 Задача добавлена: ${taskId}`);
    
    return taskId;
  }

  /**
   * Получает задачу из очереди (вызывается на Worker)
   */
  async getTask(timeout = 30) {
    if (!this.isConnected) return null;

    const result = await this.redis.brpop(QUEUE_KEY, timeout);
    if (!result) return null;

    try {
      return JSON.parse(result[1]);
    } catch (err) {
      console.error('[TaskBroker] Ошибка парсинга задачи:', err.message);
      return null;
    }
  }

  /**
   * Отправляет результат (вызывается на Worker)
   */
  async sendResult(taskId, result) {
    if (!this.isConnected) return;

    const data = { taskId, ...result, completedAt: Date.now() };
    await this.redis.publish(RESULTS_KEY, JSON.stringify(data));
    console.log(`[TaskBroker] 📥 Результат отправлен: ${taskId}`);
  }

  /**
   * Проверяет, есть ли активный воркер
   */
  async hasActiveWorker() {
    if (!this.isConnected) return false;

    try {
      const lastHeartbeat = await this.redis.get(WORKER_HEARTBEAT);
      if (!lastHeartbeat) return false;

      // Воркер активен, если heartbeat был в последние 60 секунд
      return (Date.now() - parseInt(lastHeartbeat)) < 60000;
    } catch (err) {
      console.error('[TaskBroker] Ошибка проверки воркера:', err.message);
      return false;
    }
  }

  /**
   * Отправляет heartbeat (вызывается на Worker)
   */
  async sendHeartbeat() {
    if (!this.isConnected) return;
    await this.redis.set(WORKER_HEARTBEAT, Date.now().toString(), 'EX', 120);
  }

  /**
   * Закрывает соединения
   */
  async disconnect() {
    if (this.redis) {
      await this.redis.quit();
    }
    if (this.subscriber) {
      await this.subscriber.quit();
    }
    this.isConnected = false;
    console.log('[TaskBroker] Отключён от Redis');
  }
}

export const taskBroker = new TaskBroker();

