# 🗺️ Архитектура проекта SCloudMusicBot

## 📁 Структура проекта и связи между компонентами

---

## 🎯 **ЯДРО ПРИЛОЖЕНИЯ**

### `index.js` 
**Точка входа приложения**
- Инициализирует Express сервер
- Настраивает вебхуки для Telegram
- Запускает фоновые задачи (notifier, broadcast)
- Подключает все сервисы
- **Связан с:** `bot.js`, `services/downloadManager.js`, `services/workerManager.js`, `db.js`, `config.js`

### `bot.js`
**Основной файл бота (Telegraf)**
- Регистрирует все команды и обработчики
- Обрабатывает сообщения пользователей
- Интегрирует все менеджеры (Spotify, YouTube, SoundCloud)
- **Связан с:** 
  - `services/spotifyManager.js` (регистрация callbacks)
  - `services/youtubeManager.js`
  - `services/searchManager.js`
  - `services/downloadManager.js`
  - `services/shazamService.js`
  - `services/referralManager.js`
  - `db.js`

### `config.js`
**Конфигурация приложения**
- Переменные окружения
- Настройки API ключей
- **Используется:** везде через импорты

### `db.js`
**Работа с базой данных (Supabase)**
- Все SQL запросы к PostgreSQL
- Кэширование треков
- Управление пользователями
- Статистика и аналитика
- Управление рекламными кампаниями (`promo_campaigns`, `user_promo_progress`) и сброс статистики РК
- Операции с битыми треками (включая очистку всей таблицы `deleteAllBrokenTracks`)
- **Используется:** во всех сервисах

---


## 🎵 **СЕРВИСЫ СКАЧИВАНИЯ МУЗЫКИ**

### `services/downloadManager.js` ⭐ **ЦЕНТРАЛЬНЫЙ МЕНЕДЖЕР**
**Оркестратор всех загрузок**
- Управляет очередью задач (`TaskQueue`)
- Делегирует задачи воркеру через `taskBroker`
- Обрабатывает локально (SoundCloud, fallback)
- Отправляет треки в Telegram
- Кэширует результаты
- Отправляет рекламные промо-сообщения (системные РК и кастомные динамические) с задержкой и атомарным контролем от race conditions
- **Связан с:**
  - `services/taskBroker.js` (гибридная архитектура)
  - `services/spotifyDownloader.js` (локальная обработка)
  - `lib/TaskQueue.js` (очередь задач)
  - `db.js` (кэш, статистика, реклама)

### `services/spotifyManager.js`
**Обработка Spotify ссылок**
- Парсинг URL (треки, альбомы, плейлисты)
- Получение метаданных через Spotify API
- Меню выбора качества
- Сессии пользователей
- **Связан с:**
  - `services/downloadManager.js` (добавление задач в очередь)
  - `bot.js` (регистрация callbacks)

### `services/spotifyDownloader.js`
**Скачивание Spotify треков**
- Pipe-стриминг (быстрый метод)
- Файловый fallback
- Поиск через YouTube (`ytsearch1`)
- Конвертация в MP3 через ffmpeg
- **Используется:** `services/downloadManager.js` (локальная обработка)

### `services/youtubeManager.js`
**Обработка YouTube ссылок**
- Парсинг YouTube/YouTube Music URL
- Меню выбора качества
- **Связан с:** `services/downloadManager.js`

### `services/taskBroker.js` 🔗 **БРОКЕР ЗАДАЧ**
**Связь Master ↔ Worker через Redis**
- Добавление задач в очередь Redis
- Подписка на результаты от воркера
- Проверка активности воркера (heartbeat)
- Статистика очереди
- **Связан с:**
  - `services/downloadManager.js` (делегирование задач)
  - `hf-worker/worker.js` (обработка задач)
  - Redis (очередь, pub/sub)

---

## 🤖 **ВОРКЕРЫ (ГИБРИДНАЯ АРХИТЕКТУРА)**

### `worker.js` (корень)
**Локальный воркер для домашнего ПК**
- Использует `taskBroker` для получения задач
- Использует `spotifyDownloader` для скачивания
- **Связан с:** `services/taskBroker.js`, `services/spotifyDownloader.js`

### `hf-worker/worker.js` 🚀 **HUGGINGFACE WORKER**
**Standalone воркер для HuggingFace Spaces**
- Получает задачи из Redis (`brpop`)
- Скачивает через `yt-dlp` напрямую
- Загружает в Telegram Storage
- Отправляет результаты через Redis pub/sub
- **Связан с:** `services/taskBroker.js` (через Redis)
- **Независим:** не требует основного проекта

### `hf-worker/Dockerfile`
**Docker образ для HuggingFace**
- Node.js 20
- Python 3 + yt-dlp
- FFmpeg
- **Используется:** HuggingFace Spaces для деплоя

---

## 🔍 **ПОИСК И РАСПОЗНАВАНИЕ**

### `services/searchManager.js`
**Умный поиск по SoundCloud**
- Локальный кэш + живой поиск
- Fuzzy search (исправление опечаток)
- PostgreSQL `pg_trgm` для нечеткого сравнения
- **Связан с:** `db.js`, `bot.js`

### `services/shazamService.js`
**Распознавание музыки (Shazam)**
- Обработка голосовых сообщений
- Обработка аудио/видео файлов
- Python bridge через `shazamio`
- **Связан с:** `bot.js`, `scripts/recognize.py`

### `scripts/recognize.py`
**Python скрипт для Shazam**
- Использует `shazamio` библиотеку
- Вызывается из Node.js через `child_process`
- **Используется:** `services/shazamService.js`

---

## 🎤 **ДОПОЛНИТЕЛЬНЫЕ СЕРВИСЫ**

### `services/karaokeService.js`
**Создание минусовок (караоке)**
- Удаление вокала из треков
- **Связан с:** `bot.js`

### `services/lyricsService.js`
**Получение текстов песен**
- Интеграция с Genius API
- **Связан с:** `bot.js`

### `services/referralManager.js`
**Реферальная система**
- Генерация реферальных ссылок
- Отслеживание приглашений
- **Связан с:** `bot.js`, `db.js`

### `services/broadcastManager.js`
**Система рассылок**
- Массовые рассылки пользователям
- Поддержка медиа
- **Связан с:** `db.js`, `index.js`

### `services/notifier.js`
**Уведомления пользователям**
- Напоминания об истечении Premium
- Ежедневные уведомления
- **Связан с:** `db.js`, `index.js`

### `services/settingsManager.js`
**Управление настройками приложения**
- Сохранение настроек в БД
- **Связан с:** `db.js`

### `services/appState.js`
**Состояние приложения**
- Maintenance mode
- Shutdown handling
- **Используется:** `index.js`, `bot.js`

### `services/workerManager.js`
**Управление воркерами**
- Graceful shutdown
- Health checks
- **Связан с:** `index.js`

### `services/redisClient.js`
**Redis клиент**
- Подключение к Redis
- Кэширование сессий
- **Используется:** везде где нужен Redis

---

## 📊 **АДМИН-ПАНЕЛЬ**

### `routes/admin.js`, `routes/admin-users.js`, `routes/texts-admin.js` (Legacy)
**Прежние файлы роутинга админки**
- В текущей версии все административные роуты для надежности и простоты развертывания объединены непосредственно в точке входа `index.js`.

### `views/*.ejs`
**Шаблоны админ-панели**
- `dashboard.ejs` - главная страница (статистика, метрики очередей, график монетизации промо-кампаний)
- `users.ejs` - список пользователей с интерактивным поиском и фильтрами
- `user-profile.ejs` - детальный профиль пользователя с историей его скачиваний и рефералов
- `broadcasts.ejs` - создание и ведение рассылок (с исправленным аудиторным прогресс-баром)
- `promo-campaigns.ejs` - управление системными и динамическими рекламными кампаниями
- `broken-tracks.ejs` - просмотр проблемных треков с кнопкой «Удалить все»
- `settings.ejs` - настройки бота и лимитов тарифов
- `texts.ejs` - редактор текстов с функцией добавления новых ключей

### `public/static/admin.js` & `admin.css`
**Фронтенд админки**
- JavaScript для интерактивности (асинхронное переключение вкладок, живые тугглы рекламных кампаний без перезагрузки, асинхронные AJAX запросы к API)
- Стили с поддержкой темной и светлой темы для дашборда и таблиц данных

---

## 🛠 **ВСПОМОГАТЕЛЬНЫЕ ФАЙЛЫ**

### `lib/TaskQueue.js`
**Очередь задач**
- Управление параллельными загрузками
- Приоритеты для Premium
- **Используется:** `services/downloadManager.js`

### `config/texts.js`
**Тексты бота**
- Все сообщения пользователям
- Мультиязычность
- **Используется:** `bot.js`, `services/*`

### `Dockerfile` (корень)
**Docker образ для Render.com**
- Node.js 20
- Python 3 + yt-dlp
- FFmpeg
- **Используется:** Render.com для деплоя

### `package.json`
**Зависимости проекта**
- Node.js пакеты
- Скрипты

### `requirements.txt`
**Python зависимости**
- yt-dlp
- spotdl (если используется)

---

## 🗄️ **СХЕМА ДАННЫХ И МОНЕТИЗАЦИЯ (РЕКЛАМА)**

Для поддержки гибкой монетизации и динамического управления рекламными кампаниями (РК) используются следующие сущности и таблицы в PostgreSQL:

### 1. Дополнения к таблице `users`
- `yandex_promo_progress` (integer, default 0) — прогресс скачиваний для системной РК №1 (Баланс телефона).
- `yandex_promo_shown` (boolean, default false) — флаг показа РК №1.
- `yandex_music_promo_shown` (boolean, default false) — флаг показа системной РК №2 (Яндекс Музыка / Яндекс Плюс).

### 2. Таблица `promo_campaigns`
Хранит настройки рекламных кампаний.
- `id` (serial, primary key) — уникальный идентификатор (id=1 и id=2 зарезервированы под системные РК).
- `name` (varchar) — название кампании.
- `trigger_downloads` (integer) — порог скачиваний для показа рекламы.
- `message_text` (text) — текст сообщения (для системных РК текст загружается из `bot_texts` по соответствующим ключам).
- `button_text` (varchar) — текст кнопки перехода.
- `url` (text) — ссылка перехода.
- `is_active` (boolean, default true) — туггл активности рекламной кампании.

### 3. Таблица `user_promo_progress`
Связующая таблица для отслеживания прогресса пользователей по кастомным РК (id > 2).
- `user_id` (bigint) — Telegram ID пользователя.
- `campaign_id` (integer) — ID кампании.
- `progress` (integer, default 0) — количество скачиваний пользователем в рамках данной РК.
- `shown` (boolean, default false) — флаг показа этой РК пользователю.

---

## 🔄 **СХЕМА ПОТОКА ДАННЫХ**

### Spotify трек:
```
Пользователь → bot.js 
  → spotifyManager.js (парсинг, меню качества)
    → downloadManager.js (проверка воркера)
      → taskBroker.js (делегирование)
        → Redis Queue
          → hf-worker/worker.js (скачивание)
            → Redis Pub/Sub (результат)
              → taskBroker.js (получение результата)
                → downloadManager.js (кэш, отправка)
                  → Пользователь
```

### SoundCloud трек (локально):
```
Пользователь → bot.js
  → downloadManager.js
    → scdl или yt-dlp (скачивание)
      → Telegram Storage
        → Кэш в БД
          → Пользователь
```

### Поиск:
```
Пользователь → bot.js
  → searchManager.js
    → db.js (локальный кэш)
      → SoundCloud API (если не найдено)
        → Результаты пользователю
```

---

## 📦 **ЗАВИСИМОСТИ МЕЖДУ МОДУЛЯМИ**

```
index.js
  ├── bot.js
  │   ├── services/spotifyManager.js
  │   ├── services/youtubeManager.js
  │   ├── services/searchManager.js
  │   ├── services/shazamService.js
  │   ├── services/referralManager.js
  │   └── services/downloadManager.js
  │       ├── services/taskBroker.js ←→ Redis ←→ hf-worker/worker.js
  │       ├── services/spotifyDownloader.js
  │       ├── lib/TaskQueue.js
  │       └── db.js
  ├── services/downloadManager.js
  ├── services/workerManager.js
  ├── services/broadcastManager.js
  ├── services/notifier.js
  └── db.js
```

---

## 🎯 **КЛЮЧЕВЫЕ СВЯЗИ**

1. **bot.js ↔ services/** - все обработчики команд
2. **downloadManager.js ↔ taskBroker.js** - делегирование задач
3. **taskBroker.js ↔ Redis ↔ hf-worker/worker.js** - гибридная архитектура
4. **Все сервисы ↔ db.js** - работа с базой данных
5. **index.js** - точка входа, инициализация всего

---

## 📝 **ПРИМЕЧАНИЯ**

- **hf-worker/** - полностью независимый модуль для HuggingFace
- **services/taskBroker.js** - единственная связь Master ↔ Worker
- **db.js** - централизованная работа с БД
- **config.js** - централизованная конфигурация
- Все сервисы в `services/` - модульные, слабо связанные

