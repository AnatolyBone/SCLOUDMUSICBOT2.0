import { createClient } from 'redis';

class RedisService {
  constructor() {
    this.client = null;
  }

  // Метод для подключения к Redis
  async connect() {
    if (!this.client) {
      try {
        this.client = createClient({ url: process.env.REDIS_URL });
        await this.client.connect();
        console.log('✅ Redis подключен');
      } catch (error) {
        console.error('❌ Ошибка подключения к Redis:', error.message);
        throw new Error('Не удалось подключиться к Redis');
      }
    }
    return this.client;
  }

  // Метод для получения клиента Redis
  getClient() {
    if (!this.client) {
      throw new Error('Redis client is not initialized');
    }
    return this.client;
  }
}

export default RedisService;