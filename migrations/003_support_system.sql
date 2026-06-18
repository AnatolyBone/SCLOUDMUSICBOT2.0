-- 1. Добавление колонки режима поддержки для пользователей
ALTER TABLE users 
ADD COLUMN IF NOT EXISTS support_mode boolean DEFAULT false;

-- 2. Создание таблицы сообщений поддержки
CREATE TABLE IF NOT EXISTS support_messages (
  id SERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_text TEXT NOT NULL,
  sender VARCHAR(50) NOT NULL CHECK (sender IN ('user', 'admin')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  is_read BOOLEAN DEFAULT FALSE
);

-- Индекс для быстрого поиска сообщений конкретного пользователя
CREATE INDEX IF NOT EXISTS idx_support_messages_user ON support_messages(user_id);
