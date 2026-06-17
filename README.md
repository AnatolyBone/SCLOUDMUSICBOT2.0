# SCloudMusicBot

Telegram-бот на **Node.js** + **Telegraf** для скачивания музыки (SoundCloud, Spotify, YouTube и др.), с **PostgreSQL** (Supabase), **Redis**, веб-админкой и очередью загрузок.

![Node.js](https://img.shields.io/badge/Node.js-20+-339933?logo=nodedotjs)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-Supabase-3ECF8E?logo=supabase)

---

## Возможности

- **Источники:** SoundCloud (в т.ч. короткие ссылки), Spotify, YouTube; гибрид **scdl** + **yt-dlp** + **ffmpeg**.
- **Плейлисты:** выбор «все / первые 10 / вручную», тяжёлая обработка вынесена из таймаута Telegram.
- **Кэш:** `file_id` в канале-хранилище + таблица `track_cache`, быстрые повторные выдачи.
- **Тарифы:** дневные лимиты (Free / Plus / Pro / Unlimited), бонус за подписку на канал.
- **Inline-поиск**, распознавание **Shazam** (медиа в чате).
- **Монетизация:** партнёрская кнопка VPN; промо Яндекс после **3-го скачивания в рамках акции** (счётчик `yandex_promo_progress`).
- **Админ-панель (Express + EJS):** дашборд, пользователи, рассылки, проблемные треки, настройки, **редактор текстов** (в т.ч. `yandex_promo_message`, кнопка и URL).
- **Гибрид воркеров:** опционально Redis (Upstash) для задач между инстансами.

---

## Структура проекта (кратко)

| Путь | Назначение |
|------|------------|
| `index.js` | Точка входа: Express, вебхук, админ-роуты |
| `bot.js` | Telegraf: команды, кнопки, плейлисты, обработка ссылок |
| `db.js` | PostgreSQL (pool), кэш, пользователи, логи |
| `config.js` | Переменные окружения, валидация при старте |
| `config/texts.js` | Тексты бота + загрузка из таблицы `bot_texts` |
| `services/downloadManager.js` | Очередь скачиваний, промо, интеграция с БД |
| `migrations/` | SQL-миграции для ручного применения в Supabase |
| `Dockerfile` | Сборка для Render: Node + Python + ffmpeg + yt-dlp |

---

## Требования

- **Node.js** ≥ 18 (рекомендуется 20)
- **PostgreSQL** (строка подключения `DATABASE_URL`)
- Для продакшена: **Redis** (очереди/сессии — по конфигу), аккаунт **Supabase** (клиент для `bot_texts` и части API)

В Docker дополнительно ставятся **Python 3**, **yt-dlp**, **spotdl**, **shazamio** и системный **ffmpeg** (в т.ч. **ffprobe** для проверок длительности).

---

## Переменные окружения

### Обязательные (всегда)

| Переменная | Описание |
|------------|----------|
| `BOT_TOKEN` | Токен бота от @BotFather |
| `ADMIN_ID` | Числовой Telegram ID администратора |
| `DATABASE_URL` | `postgres://` или `postgresql://` |

### Обязательные в production (`NODE_ENV=production`)

| Переменная | Описание |
|------------|----------|
| `WEBHOOK_URL` | Базовый URL сервиса, например `https://your-app.onrender.com` |
| `WEBHOOK_PATH` | Путь вебхука (по умолчанию `/telegram`) |
| `SESSION_SECRET` | Минимум 32 символа |
| `ADMIN_LOGIN` / `ADMIN_PASSWORD` | Вход в веб-админку (пароль ≥ 8 символов) |

### Часто используемые опциональные

| Переменная | Описание |
|------------|----------|
| `PORT` | Порт HTTP (на Render задаётся платформой, часто `10000`) |
| `REDIS_URL` | Redis / Upstash для кэша и брокера задач |
| `SUPABASE_URL` / `SUPABASE_KEY` | Supabase API (тексты, часть операций) |
| `STORAGE_CHANNEL_ID` | Канал для хранения `file_id` аудио |
| `CHANNEL_URL` | Канал для бонуса за подписку |
| `BROADCAST_STORAGE_ID` | Канал для файлов рассылок |
| `SPOTIPY_CLIENT_ID` / `SPOTIPY_CLIENT_SECRET` | Spotify |
| `FORCE_POLLING=1` | Локально: long polling вместо вебхука |

Создай файл `.env` в корне и заполни значения (шаблон можно взять из своих секретов на хостинге).

---

## Миграции базы данных

SQL лежит в каталоге **`migrations/`**. Выполняй скрипты **вручную** в Supabase → SQL Editor (или через `psql`), когда указано в описании файла.

Пример: акция Яндекс и счётчик прогресса — см. **`migrations/001_yandex_promo_progress.sql`** (колонка `yandex_promo_progress` в `users`).

Убедись, что в таблице `users` есть поля, которые ожидает код: `downloads_count`, `yandex_promo_shown`, `yandex_promo_progress` и т.д.

---

## Установка и локальный запуск

```bash
git clone <repo-url>
cd SCLOUDMUSICBOT2.0-main
npm install
```

Настрой `.env` (см. выше). Для разработки без публичного URL:

```env
NODE_ENV=development
FORCE_POLLING=1
```

```bash
npm start
```

Приложение поднимает Express и бота (polling или webhook в зависимости от `NODE_ENV` и `FORCE_POLLING`).

---

## Деплой (Docker / Render)

1. Подключи репозиторий к **Render** (или другой платформе с Docker).
2. Укажи **все** обязательные переменные окружения.
3. При необходимости смонтируй **Secret File** с cookies для yt-dlp (путь в коде: `/etc/secrets/cookies.txt`).
4. После первого деплоя примени **миграции** из `migrations/` к своей БД.

Сборка образа описана в **`Dockerfile`** (Node 20 slim, Python, ffmpeg, npm + pip-зависимости).

---

## Админка

- URL: корень сервиса → редирект на `/dashboard` после входа.
- Раздел **«Тексты»** — правка копирайта без правок кода (HTML для сообщений, ключи `yandex_promo_*` для промо Яндекса).
- Дашборд: в том числе блок **«Монетизация (промо)»** (показы акции vs lifetime-метрики).

---

## Полезные команды

```bash
npm start          # запуск
npm audit          # проверка уязвимостей зависимостей
```

---

## Автор

**AnatolyBone** и контрибьюторы.

Лицензия и ссылки на донаты/каналы — по желанию владельца репозитория (при публикации на GitHub обнови clone URL в разделе установки).
