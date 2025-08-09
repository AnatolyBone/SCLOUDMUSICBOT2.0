
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { Telegraf } from 'telegraf';
import { createClient } from 'redis';
import { initNotifier } from './services/notifier.js';
import RedisService from './services/redisService.js';
import BotService from './services/botService.js';
import { setupAdmin } from './routes/admin.js';
import { loadTexts, T } from './config/texts.js';

// Security Headers for Express
const app = express();
app.use(helmet()); // Adding security headers
app.use(cors()); // Enabling Cross-Origin Requests

// Set up rate limiting for bot API to prevent abuse
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per window
});
app.use(limiter);

// Initialize Redis for session management
const redis = createClient({
  url: 'redis://localhost:6379', // Ensure this is the correct URL
});
redis.connect();

// Initialize Telegraf Bot
const bot = new Telegraf(process.env.BOT_TOKEN);

// Set up bot service
const botService = new BotService(bot);
botService.start();

// Set up admin routes
setupAdmin({ app, redis, bot });

// Initialize notifications
initNotifier();

// Load translations and text resources
loadTexts();

// Start Express server
app.listen(process.env.PORT || 3000, () => {
  console.log('Server is running...');
});
