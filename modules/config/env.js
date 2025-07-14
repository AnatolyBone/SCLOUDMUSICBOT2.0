import dotenv from 'dotenv';

dotenv.config();

export const BOT_TOKEN = process.env.BOT_TOKEN;
export const ADMIN_ID = parseInt(process.env.ADMIN_ID);
export const WEBHOOK_URL = process.env.WEBHOOK_URL;
export const WEBHOOK_PATH = process.env.WEBHOOK_PATH || '/bot-webhook';
export const PORT = process.env.PORT || 3000;
export const ADMIN_LOGIN = process.env.ADMIN_LOGIN;
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
export const DATABASE_URL = process.env.DATABASE_URL;
export const SUPABASE_URL = process.env.SUPABASE_URL;
export const SUPABASE_KEY = process.env.SUPABASE_KEY;
export const SESSION_SECRET = process.env.SESSION_SECRET || 'secret';
