// services/redisClient.js (улучшенная версия)

import { createClient } from 'redis';

class RedisService {
  constructor() {
    this.client = null;
    this.connectionPromise = null;
    this.reconnectAttempts = 0;
    console.log('[Redis] Сервис создан.');
  }

  /**
   * Устанавливает соединение с Redis
   * Гарантирует только одну попытку подключения за раз
   */
  async connect() {
    // Если уже подключены, возвращаем клиента
    if (this.client?.isReady) {
      return this.client;
    }

    // Если идет процесс подключения, возвращаем его
    if (this.connectionPromise) {
      return this.connectionPromise;
    }

    this.connectionPromise = (async () => {
      const redisUrl = process.env.REDIS_URL;
      
      if (!redisUrl) {
        console.warn('[Redis] Переменная REDIS_URL не найдена. Redis не будет использоваться.');
        this.connectionPromise = null;
        return null;
      }

      console.log('[Redis] Подключаюсь...');
      
      const client = createClient({
        url: redisUrl,
        socket: {
          reconnectStrategy: (retries) => {
            this.reconnectAttempts = retries;
            
            // После 10 попыток прекращаем
            if (retries > 10) {
              console.error('[Redis] Превышен лимит попыток переподключения (10).');
              this.client = null;
              return false; // Прекращаем автореконнект
            }
            
            const delay = Math.min(retries * 100, 3000);
            console.log(`[Redis] Попытка переподключения ${retries}/10 через ${delay}мс...`);
            return delay;
          }
        }
      });

      client.on('error', (err) => {
        console.error('🔴 [Redis] Ошибка:', err.message);
      });

      client.on('reconnecting', () => {
        console.log('[Redis] Переподключение...');
      });

      client.on('ready', () => {
        console.log('✅ [Redis] Соединение восстановлено.');
        this.reconnectAttempts = 0;
      });

      try {
        await client.connect();
        console.log('✅ [Redis] Клиент успешно подключен.');
        this.client = client;
        this.connectionPromise = null;
        return client;
      } catch (err) {
        console.error('🔴 [Redis] Критическая ошибка при подключении:', err.message);
        this.connectionPromise = null;
        throw err;
      }
    })();

    return this.connectionPromise;
  }

  /**
   * Проверяет и возвращает активное соединение
   */
  async ensureConnection() {
    if (this.client?.isReady) return this.client;
    return await this.connect();
  }

  /**
   * Получает значение по ключу
   */
  async get(key) {
    if (!key || typeof key !== 'string') {
      console.error('[Redis GET] Некорректный ключ:', key);
      return null;
    }

    try {
      const client = await this.ensureConnection();
      if (!client) return null;
      return await client.get(key);
    } catch (e) {
      console.error(`[Redis GET] Ошибка при получении ключа ${key}:`, e.message);
      return null;
    }
  }

  /**
   * Устанавливает значение с TTL
   */
  async set(key, value, ttlSeconds) {
    if (!key || typeof key !== 'string') {
      console.error('[Redis SET] Некорректный ключ:', key);
      return;
    }

    if (value === undefined || value === null) {
      console.error('[Redis SET] Некорректное значение для ключа', key);
      return;
    }

    // Автоматическая сериализация объектов
    const valueToStore = typeof value === 'object' ? JSON.stringify(value) : String(value);

    try {
      const client = await this.ensureConnection();
      if (!client) return;
      await client.set(key, valueToStore, { EX: ttlSeconds });
    } catch (e) {
      console.error(`[Redis SET] Ошибка при установке ключа ${key}:`, e.message);
    }
  }

  /**
   * Устанавливает значение с TTL (совместимость с notifier.js)
   */
  async setEx(key, ttlSeconds, value) {
    return await this.set(key, value, ttlSeconds);
  }

  /**
   * Удаляет ключ
   */
  async del(key) {
    if (!key || typeof key !== 'string') {
      console.error('[Redis DEL] Некорректный ключ:', key);
      return 0;
    }

    try {
      const client = await this.ensureConnection();
      if (!client) return 0;
      return await client.del(key);
    } catch (e) {
      console.error(`[Redis DEL] Ошибка при удалении ключа ${key}:`, e.message);
      return 0;
    }
  }

  /**
   * Получает JSON объект
   */
  async getJson(key) {
    const value = await this.get(key);
    if (!value) return null;
    
    try {
      return JSON.parse(value);
    } catch (e) {
      console.error(`[Redis] Ошибка парсинга JSON для ключа ${key}:`, e.message);
      return null;
    }
  }

  /**
   * Сохраняет JSON объект
   */
  async setJson(key, obj, ttlSeconds) {
    if (typeof obj !== 'object' || obj === null) {
      console.error('[Redis] setJson ожидает объект, получено:', typeof obj);
      return;
    }

    const value = JSON.stringify(obj);
    await this.set(key, value, ttlSeconds);
  }

  /**
   * Проверяет доступность Redis (для healthcheck)
   */
  async isAvailable() {
    try {
      const client = await this.ensureConnection();
      if (!client) return false;
      await client.ping();
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Инкрементирует значение (для счётчиков)
   */
  async incr(key) {
    try {
      const client = await this.ensureConnection();
      if (!client) return null;
      return await client.incr(key);
    } catch (e) {
      console.error(`[Redis INCR] Ошибка инкремента ${key}:`, e.message);
      return null;
    }
  }

  async publish(channel, message) {
    try { const client = await this.ensureConnection(); return client ? await client.publish(channel, String(message)) : 0; }
    catch (e) { console.error(`[Redis PUBLISH] ${channel}:`, e.message); return 0; }
  }

  async subscribe(channel, handler) {
    try {
      const client = await this.ensureConnection();
      if (!client) return null;
      const subscriber = client.duplicate();
      await subscriber.connect();
      await subscriber.subscribe(channel, handler);
      return subscriber;
    } catch (e) { console.error(`[Redis SUBSCRIBE] ${channel}:`, e.message); return null; }
  }

  /**
   * Устанавливает TTL для существующего ключа
   */
  async expire(key, ttlSeconds) {
    try {
      const client = await this.ensureConnection();
      if (!client) return false;
      return await client.expire(key, ttlSeconds);
    } catch (e) {
      console.error(`[Redis EXPIRE] Ошибка установки TTL для ${key}:`, e.message);
      return false;
    }
  }

  /**
   * Закрывает соединение
   */
  async disconnect() {
    if (this.client?.isOpen) {
      console.log('[Redis] Закрываю соединение...');
      await this.client.quit();
      this.client = null;
    }
  }
}

// Создаём singleton инстанс
const redisService = new RedisService();

// Graceful shutdown
process.on('SIGTERM', async () => {
  await redisService.disconnect();
});

process.on('SIGINT', async () => {
  await redisService.disconnect();
});

export default redisService;

// ========================= EXPORTS SUMMARY =========================
// Основные методы:
// - get(key): получить значение
// - set(key, value, ttl): установить значение с TTL
// - setEx(key, ttl, value): алиас для совместимости
// - del(key): удалить ключ
// - getJson(key): получить JSON объект
// - setJson(key, obj, ttl): сохранить JSON объект
// - isAvailable(): проверка доступности (для healthcheck)
// - incr(key): инкремент счётчика
// - expire(key, ttl): установить TTL для существующего ключа
