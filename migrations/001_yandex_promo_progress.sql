-- Счётчик скачиваний с момента запуска акции Яндекс (триггер промо на 3-м).
-- Выполнить один раз в Supabase SQL Editor.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS yandex_promo_progress INTEGER NOT NULL DEFAULT 0;

-- Все пользователи начинают воронку акции с нуля
UPDATE users SET yandex_promo_progress = 0;
