// services/taskBroker.js
// Использует ОТДЕЛЬНЫЙ Redis для связи с воркером

import Redis from 'ioredis';
import { EventEmitter } from 'events';

const QUEUE_KEY = 'music:download:queue';
const RESULTS_KEY = 'music:download:results';
const HEARTBEAT_KEY = 'music:worker:heartbeat';

class TaskBroker extends EventEmitter {
  constructor() {
    super();
    this.redis = null;
    this.subscriber = null;
    this.isConnected = false;
    this.pendingTasks = new Map(); // taskId → { resolve, reject, timeout }
  }

  async connect() {
    // ✅ Используем ОТДЕЛЬНУЮ переменную для TaskBroker
    const redisUrl = process.env.TASK_BROKER_REDIS_URL;
    
    if (!redisUrl) {
      console.log('[TaskBroker] TASK_BROKER_REDIS_URL не задан — гибридная архитектура отключена');
      return false;
    }

    console.log('[TaskBroker] Подключение к Upstash Redis...');

    try {
      const options = {
        maxRetriesPerRequest: 3,
        retryDelayOnFailover: 1000,
        connectTimeout: 10000,
        lazyConnect: true
      };

      this.redis = new Redis(redisUrl, options);
      this.subscriber = new Redis(redisUrl, options);

      await this.redis.connect();
      await this.subscriber.connect();

      // Проверка подключения
      const pong = await this.redis.ping();
      console.log(`[TaskBroker] Redis PING: ${pong}`);

      // Подписываемся на результаты
      await this.subscriber.subscribe(RESULTS_KEY);
      
      this.subscriber.on('message', (channel, message) => {
        if (channel === RESULTS_KEY) {
          try {
            const result = JSON.parse(message);
            console.log(`[TaskBroker] 📥 Результат от воркера: ${result.taskId}`);
            this.handleResult(result);
          } catch (e) {
            console.error('[TaskBroker] Parse error:', e);
          }
        }
      });

      this.isConnected = true;
      console.log('[TaskBroker] ✅ Подключён к Upstash Redis');
      return true;
      
    } catch (err) {
      console.error('[TaskBroker] ❌ Ошибка подключения:', err.message);
      this.isConnected = false;
      return false;
    }
  }

  handleResult(result) {
    console.log(`[TaskBroker] 📥 Result received: ${result.taskId}`);
    this.emit('result', result);
    
    // Резолвим промис если кто-то ждёт
    const pending = this.pendingTasks.get(result.taskId);
    if (pending) {
      clearTimeout(pending.timeout);
      pending.resolve(result);
      this.pendingTasks.delete(result.taskId);
    }
  }

  /**
   * Добавляет задачу в очередь
   */
  async addTask(task) {
    if (!this.isConnected) {
      return null;
    }

    const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const taskData = { 
      ...task, 
      taskId, 
      createdAt: Date.now() 
    };
    
    await this.redis.lpush(QUEUE_KEY, JSON.stringify(taskData));
    console.log(`[TaskBroker] 📤 Задача добавлена: ${taskId}`);
    
    return taskId;
  }

  /**
   * Добавляет задачу и ждёт результат
   */
  async addTaskAndWait(task, timeoutMs = 180000) {
    const taskId = await this.addTask(task);
    if (!taskId) return null;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingTasks.delete(taskId);
        reject(new Error('TASK_TIMEOUT'));
      }, timeoutMs);

      this.pendingTasks.set(taskId, { resolve, reject, timeout });
    });
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
      const lastHeartbeat = await this.redis.get(HEARTBEAT_KEY);
      if (!lastHeartbeat) {
        console.log('[TaskBroker] Воркер не найден (нет heartbeat)');
        return false;
      }

      const age = Date.now() - parseInt(lastHeartbeat);
      const isActive = age < 120000; // 2 минуты
      
      if (!isActive) {
        console.log(`[TaskBroker] Воркер неактивен (последний heartbeat ${Math.round(age/1000)}с назад)`);
      }
      
      return isActive;
    } catch (e) {
      console.error('[TaskBroker] Ошибка проверки воркера:', e.message);
      return false;
    }
  }

  /**
   * Получает статистику очереди
   */
  async getQueueStats() {
    if (!this.isConnected) return { pending: 0, hasWorker: false };

    try {
      const pending = await this.redis.llen(QUEUE_KEY);
      const hasWorker = await this.hasActiveWorker();
      return { pending, hasWorker };
    } catch (e) {
      return { pending: 0, hasWorker: false };
    }
  }

  /**
   * Отправляет heartbeat (вызывается на Worker)
   */
  async sendHeartbeat() {
    if (!this.isConnected) return;
    await this.redis.set(HEARTBEAT_KEY, Date.now().toString(), 'EX', 120);
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

