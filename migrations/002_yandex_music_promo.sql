-- Миграция: Добавление колонки для рекламы Яндекс Музыки и создание таблиц рекламных кампаний
-- Выполнить один раз в Supabase SQL Editor (Dashboard → SQL Editor → New query)

-- 1. Добавляем колонку yandex_music_promo_shown в таблицу users
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS yandex_music_promo_shown BOOLEAN NOT NULL DEFAULT FALSE;

-- 2. Таблица для хранения рекламных кампаний (динамическая панель)
CREATE TABLE IF NOT EXISTS promo_campaigns (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  trigger_downloads INTEGER NOT NULL DEFAULT 3,
  message_text TEXT NOT NULL,
  button_text VARCHAR(255) NOT NULL DEFAULT '🔗 Перейти',
  url TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. Связующая таблица для прогресса кастомных промо по пользователям
CREATE TABLE IF NOT EXISTS user_promo_progress (
  user_id BIGINT NOT NULL,
  campaign_id INTEGER REFERENCES promo_campaigns(id) ON DELETE CASCADE,
  progress INTEGER NOT NULL DEFAULT 0,
  shown BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (user_id, campaign_id)
);

-- 4. Заполнение системных рекламных кампаний (id=1 и id=2)
-- Кампания 1: Баланс телефона (старая рекламная кампания)
INSERT INTO promo_campaigns (id, name, trigger_downloads, message_text, button_text, url, is_active)
VALUES (
  1,
  'Баланс телефона',
  3,
  '',
  '',
  '',
  true
)
ON CONFLICT (id) DO NOTHING;

-- Кампания 2: Яндекс Музыка / Яндекс Плюс
INSERT INTO promo_campaigns (id, name, trigger_downloads, message_text, button_text, url, is_active)
VALUES (
  2,
  'Яндекс Музыка / Яндекс Плюс',
  3,
  '🔥 Слушай любимую музыку на Яндекс Музыке!\n\nПолучи подписку Яндекс Плюс и наслаждайся миллионами треков в высоком качестве.',
  '🎵 Попробовать Яндекс Музыку',
  'https://music.yandex.ru',
  true
)
ON CONFLICT (id) DO NOTHING;

-- 5. Синхронизируем последовательность ID
SELECT setval('promo_campaigns_id_seq', COALESCE((SELECT MAX(id)+1 FROM promo_campaigns), 1), false);
