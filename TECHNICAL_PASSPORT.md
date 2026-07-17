# Технический паспорт проекта SCloudMusicBot

> Состояние зафиксировано по исходному коду и доступной схеме на 17.07.2026 (Europe/Moscow). Документ описывает фактическую реализацию, а не целевую архитектуру.

| Атрибут | Значение |
|---|---|
| Дата анализа | 17.07.2026 |
| Git-ветка | `main` |
| Git commit | `79a597ca89650ded7ab2e728965411e721bc06bc` |
| Версия приложения | `1.0.0` (`package.json`) |
| Основная точка входа | `index.js` |
| Проанализировано | Корневой Node.js-код, `services/`, `lib/`, `config/`, EJS и статические ресурсы, SQL-миграции 001–012, схема PostgreSQL, Redis и очереди, Docker/Render/Hugging Face worker, Python-скрипты, тесты и release-скрипты |
| Не удалось независимо подтвердить | Реальное качество скачивания у SoundCloud/Spotify/YouTube; действующие лимиты внешних API; текущее содержимое Telegram storage channel; фактическое развертывание Hugging Face worker; резервное копирование/восстановление Supabase; production self-test из текущей локальной среды |

Секреты, реальные строки подключения, cookie, Telegram file IDs и персональные данные в документ не включены. Файл `.env` не читался. До создания этого документа рабочее дерево уже содержало пользовательские изменения в `views/user-journey.ejs`, `views/user-profile.ejs` и непрослеживаемый Git-файл `scratch_inspect_karaoke_triggers.js`; они не изменялись.

Статусы в документе:

- **работает** — реализация включена в активный граф импортов и покрыта тестом либо доступной интеграционной проверкой;
- **частично** — активная реализация есть, но имеет подтвержденные ограничения или не все ветви проверены;
- **не используется** — файл существует, но активная точка входа его не импортирует;
- **устарело** — альтернативная/старая реализация расходится с действующей;
- **не подтверждено** — по текущему коду или доступной среде достоверный вывод невозможен.

---

# 1. Общая информация

## Назначение

SCloudMusicBot — Telegram-бот для поиска, распознавания и скачивания музыкальных треков. Основные источники — SoundCloud, Spotify и YouTube/YouTube Music; готовый MP3 отправляется пользователю через Telegram. Вокруг бота реализованы тарифы, Telegram Stars и ручные платежи, рефералы, поддержка, промо, массовые рассылки и административная аналитика. Основание: `bot.js`, `services/downloadManager.js`, `services/spotifyManager.js`, `services/youtubeManager.js`, `services/shazamService.js`, `index.js`, `db.js`.

Это **не караоке-редактор**. Файлы `services/karaokeService.js` и `services/lyricsService.js` физически присутствуют, но не импортируются активными модулями. Реальная связь с отдельным караоке-проектом ограничена выдачей тестерского доступа, переходом во внешний интерфейс и сбором feedback (`bot.js`: обработчики `karaoke_test`, `karaoke_feedback`; `db.js`: `grantKaraokeTesterAccess`, `getKaraokeTester`, `addKaraokeFeedback`). Утверждения о создании минусовок в `ARCHITECTURE.md` и `PROJECT_STRUCTURE.md` устарели.

## Проблема и пользователи

Проект сокращает путь от ссылки/поискового запроса/фрагмента аудио до Telegram-аудиофайла и повторно использует уже загруженные треки через Telegram file ID. Категории пользователей:

1. обычные пользователи Free;
2. пользователи Plus, Pro и Unlimited;
3. администратор веб-панели и Telegram-команд;
4. получатели промо, уведомлений и рассылок;
5. тестировщики внешнего караоке-сервиса.

## Текущий этап готовности

Проект эксплуатируется как production-сервис: код содержит webhook, Render-конфигурацию, миграции, строгий schema preflight, health/self-test, фоновые задачи и административные страницы (`index.js`, `render.yaml`, `services/systemSelfTest.js`). Предоставленные владельцем production-логи показывали запуск schema version 12, Redis, webhook и workers, но это не заменяет независимую эксплуатационную проверку.

Локально в рамках аудита:

- `npm test`: **38/38 passed**;
- `npm run check:schema`: **успешно**, version 12, 13 обязательных таблиц, 141 обязательная колонка, отсутствующих обязательных колонок/таблиц и рекомендованных индексов нет;
- `npm run smoke:analytics`: **18/19 passed**; единственный сбой — `excel_generation` с `spawn EPERM` в ограниченной Windows-среде аудита. Остальные SQL-проверки, включая timeline, retention, acquisition и revenue, прошли;
- write-интеграции рассылок/платежей и реальные внешние API в этой задаче не запускались, поскольку задача — аудит, а не изменение production-состояния.

## Основные сценарии

- запуск бота, выбор языка, меню и справка;
- отправка ссылки SoundCloud/Spotify/YouTube и выбор качества/треков;
- inline-поиск SoundCloud;
- распознавание присланного аудио/видео через Shazam;
- повторная выдача трека из PostgreSQL/Telegram cache;
- покупка тарифа через Telegram Stars или ручная регистрация альтернативной оплаты администратором;
- поддержка, рефералы, бонус за подписку на канал и промо;
- администрирование пользователей, тарифов, текстов, очередей и проблемных треков;
- безопасно подтверждаемая массовая рассылка;
- аналитика, путь пользователя, retention, источники и XLSX-отчет.

---

# 2. Технологический стек

Версии ниже взяты из фактического `package-lock.json`, если библиотека установлена, а не только из диапазона `package.json`.

| Область | Технология / версия | Фактическое использование |
|---|---|---|
| Язык | JavaScript ES modules | Основной backend, бот, workers и клиентский JS (`package.json`, `index.js`, `bot.js`) |
| Runtime | Node.js `>=18`; Docker — Node 20 | Основное приложение; локально тесты выполнялись на Node 24.12.0 (`package.json`, `Dockerfile`) |
| Python | Python 3; Render декларирует 3.11 | `yt-dlp`, `spotdl`, Shazam и генератор XLSX (`requirements.txt`, `scripts/*.py`, `render.yaml`) |
| Telegram | Telegraf 4.16.3 | webhook/polling, команды, callback, inline query, Stars, отправка аудио (`bot.js`) |
| HTTP backend | Express 4.22.2 | webhook, admin UI, JSON API, redirect tracking (`index.js`) |
| Шаблоны | EJS 3.1.10, express-ejs-layouts 2.5.1 | server-side admin UI (`views/`, `index.js`) |
| Сессии | express-session 1.19.0, connect-pg-simple 8.0.0 | единственная админская роль, хранение в PostgreSQL (`index.js`, таблица `session`) |
| База | PostgreSQL через `pg` 8.21.0 | вся бизнес-модель и аналитика (`db.js`) |
| ORM | отсутствует | SQL написан вручную и параметризуется через `pg`; Prisma-схемы нет |
| Supabase | `@supabase/supabase-js` 2.108.2 | дополнительный RPC/поиск и Storage для feedback; основная БД доступна через `pg` (`db.js`, `bot.js`) |
| Redis cache | `redis` 4.7.1 | поиск, analytics session/daily markers, notifier gate (`services/redisClient.js`) |
| Redis broker | `ioredis` 5.11.1 | очередь master ↔ HF worker и Pub/Sub результатов (`services/taskBroker.js`, `hf-worker/worker.js`) |
| Локальная очередь | собственный `TaskQueue` | приоритет, concurrency и timeout скачиваний (`lib/TaskQueue.js`) |
| Планировщик | node-cron 3.0.3 + `setInterval` | рассылки, нотификаторы, reset тарифов, analytics aggregation (`services/workerManager.js`, `index.js`) |
| SoundCloud | soundcloud-downloader 1.0.0 + yt-dlp | быстрый поток и fallback (`services/downloadManager.js`) |
| Spotify | Spotify Web API + spotDL/yt-dlp | Spotify дает метаданные; аудио ищется на YouTube (`services/spotifyManager.js`, `services/spotifyDownloader.js`) |
| YouTube | youtube-dl-exec 3.1.8 и Python `yt-dlp` | метаданные, поиск и скачивание (`bot.js`, `services/downloadManager.js`, `hf-worker/worker.js`) |
| Media | ffmpeg-static 5.3.0 и системные FFmpeg/ffprobe | извлечение/перекодирование MP3, bitrate и probing (`services/downloadManager.js`, Dockerfiles) |
| Распознавание | shazamio >=0.4 | Python-скрипт получает сигнатуру/метаданные (`services/shazamService.js`, `scripts/shazam_recognize.py`) |
| XLSX | XlsxWriter >=3.2 | Python-генератор аналитического отчета (`scripts/generate_excel_report.py`, `services/excelReportService.js`) |
| HTTP clients | axios 1.18.0; встроенный Node `fetch` | Telegram file/thumbnails и Spotify Web API (`bot.js`, `services/downloadManager.js`, `services/spotifyManager.js`) |
| Прокси | https-proxy-agent 7.0.6 | Telegraf/yt-dlp/SoundCloud при включенной настройке (`bot.js`, `services/downloadManager.js`) |
| Массовая отправка | p-map 7.0.4, p-timeout 6.1.4 | concurrency и timeout рассылок/уведомлений (`services/broadcastManager.js`, `services/notifier.js`) |
| Тесты | встроенный `node:test` | unit/static contract tests в `test/`; интеграции в `integration/` |
| Хостинг | Render + опциональный Hugging Face Docker worker | web process и вынесенное скачивание (`render.yaml`, `Dockerfile`, `hf-worker/`) |
| Хранилище файлов | Telegram storage channel; опционально Supabase Storage | долговечное хранение аудио через file ID и вложений karaoke feedback (`services/downloadManager.js`, `bot.js`) |

В `package.json` также объявлены `cheerio`, `file-type`, `json-2-csv`, `node-fetch`, `p-limit`, `p-queue` и `puppeteer`. Их активное использование корневым production-контуром не подтверждено поиском импортов; это кандидаты на устаревшие зависимости, но удаление в рамках аудита не выполнялось.

---

# 3. Архитектура проекта

## Активные компоненты

1. **`index.js`** — bootstrap, Express/admin routes, production webhook, migrations/preflight, cron/interval orchestration.
2. **`bot.js`** — Telegraf middleware и все пользовательские Telegram-сценарии.
3. **`db.js`** — единый большой data-access модуль, SQL, migrations wrappers, schema contract, analytics.
4. **`services/downloadManager.js`** — локальный download pipeline, cache и очередь.
5. **`services/spotifyManager.js`, `youtubeManager.js`, `searchManager.js`, `shazamService.js`** — входные сценарии источников.
6. **`lib/TaskQueue.js`** — неперсистентная очередь скачиваний.
7. **`services/taskBroker.js` + `hf-worker/worker.js`** — опциональный распределенный путь.
8. **`services/broadcastWorker.js`, `broadcastManager.js`, `broadcastSafety.js`** — рассылка, snapshot и защиты launch/preview.
9. **`services/analyticsService.js`, `userInsightsService.js`, `excelReportService.js`** — события, admin insights, экспорт.
10. **PostgreSQL, Redis, Telegram API и storage channel** — постоянное состояние, короткоживущий cache и доставка.

`src/app.js`, `src/bot.js`, файлы `routes/` и `routes_admin_users.js` не импортируются `index.js` и являются альтернативным/устаревшим контуром. Запускать их как эквивалент production нельзя.

## Точки входа

- `npm start` → `node index.js` (`package.json`);
- production Telegram updates → `POST ${WEBHOOK_PATH}`; development → Telegraf long polling (`index.js:startApp`);
- admin HTTP → `/admin`, далее сессионные routes (`index.js:setupExpress`);
- HF worker → `hf-worker/worker.js` (`hf-worker/Dockerfile`);
- CLI проверки → `scripts/schema-preflight.js`, `smoke-analytics.js`, migration/integration/release scripts.

## Поток одиночного скачивания

```text
Пользователь Telegram
→ Telegraf middleware и обработчик URL/inline/media (`bot.js`)
→ определение источника и проверка настройки/пользователя
→ cache lookup (`db.js:findCachedTrack`)
→ локальная `TaskQueue` либо Redis broker
→ SoundCloud stream / Spotify metadata + YouTube search / yt-dlp
→ FFmpeg/MP3 и проверка размера
→ Telegram storage channel
→ `track_cache` + счетчики/`downloads_log`/analytics
→ Telegram file_id пользователю
```

При cache hit внешний источник и перекодирование пропускаются: Telegram повторно отправляет сохраненный `file_id`.

## Поток массовой рассылки

```text
Администратор → форма EJS
→ preview: ровно одно сообщение администратору, без task/log
или launch-token → подтвержденный POST /broadcast/launch
→ `broadcast_tasks` со статусом pending и launch_confirmed_at
→ cron worker раз в минуту
→ проверка broadcasts_enabled и claim
→ snapshot получателей в `broadcast_log`
→ батчи по 100, Telegram API, статус каждой строки
→ completed/cancelled/error и отчет администратору
```

Основание: `index.js` routes `/broadcast/*`, `services/broadcastSafety.js`, `services/broadcastWorker.js`, `services/broadcastManager.js`, `db.js:createBroadcastSnapshot`.

## Startup и фоновые процессы

`index.js:startApp` сначала регистрирует Express, выполняет обертки миграций 003/006/007/008, затем строгий `checkSchemaPreflight`. Только после загрузки текстов, Redis/settings и download manager открывается HTTP-порт. Backfill последних семи дней запускается асинхронно. В production webhook устанавливается до трех раз с паузой 5 секунд.

Фоновые процессы:

- broadcast cron: каждую минуту;
- notifier daily gate: cron каждую минуту, реально один раз в сутки после 10:00 UTC;
- notifier expiring-today: каждый час;
- premium bulk reset: 00:10 UTC;
- analytics aggregation: проверка каждую минуту, запуск 00:05 Europe/Moscow;
- analytics backfill: при startup за 7 дней;
- webhook watchdog: 10 минут и отдельная проверка отсутствия updates каждые 5 минут;
- queue monitor: 1 минута;
- cleanup Spotify sessions/temp и HF temp: отдельные intervals.

При этом `index.js` дополнительно запускает notifier через `setInterval`, хотя `initializeWorkers()` уже регистрирует те же daily/hourly задачи. Mutex, Redis gate и DB-флаги уменьшают дублирование отправок, но orchestration фактически задублирован (`index.js:startApp`, `services/workerManager.js`).

## Retry, ошибки и cleanup

- webhook: 3 попытки; watchdog повторно устанавливает webhook;
- yt-dlp: retries 3 и socket timeout 120 секунд; proxy failure повторяется без proxy (`services/downloadManager.js:ytdlSafe`);
- HF yt-dlp: по 5 retries/extractor/fragment, socket timeout 30 секунд, общий timer 180 секунд;
- локальная задача: `Promise.race` с 10 минутами (`lib/TaskQueue.js`), но underlying процесс не отменяется самим timeout;
- broadcast: Telegram 429/ошибки обрабатываются в `broadcastManager.js`, worker проверяет cancel/kill switch между батчами;
- временные файлы удаляются в `finally`; XLSX — callback `res.download`; HF cleanup удаляет файлы старше 10 минут каждые 5 минут;
- `unhandledRejection` только логируется и процесс продолжает работу; `uncaughtException` завершает процесс (`services/workerManager.js`).

---

# 4. Структура проекта

```text
.
├── index.js                    # активный HTTP/bootstrap/admin entrypoint
├── bot.js                      # активный Telegram bot
├── db.js                       # SQL/data access/schema contract
├── config.js                   # ENV validation и безопасный config log
├── config/
│   ├── tariffs.js              # Plus/Pro/Unlimited
│   └── texts.js                # локализуемые тексты из bot_texts
├── services/
│   ├── downloadManager.js      # download/cache pipeline
│   ├── spotifyManager.js       # Spotify metadata/UI sessions
│   ├── spotifyDownloader.js    # yt-dlp/FFmpeg для Spotify
│   ├── youtubeManager.js       # YouTube quality/session UI
│   ├── searchManager.js        # inline SoundCloud search + Redis cache
│   ├── shazamService.js        # Python Shazam bridge
│   ├── broadcast*.js           # safety, delivery, worker, audience/form mapping
│   ├── analytics*.js           # event collection и smoke
│   ├── userInsightsService.js  # timeline/retention/acquisition SQL
│   ├── excelReportService.js   # temporary JSON → Python → XLSX
│   ├── workerManager.js        # cron и graceful shutdown
│   ├── taskBroker.js           # Redis distributed broker
│   ├── redisClient.js          # обычный Redis cache
│   ├── notifier.js             # expiration notifications
│   ├── settingsManager.js      # app_settings in-memory cache/defaults
│   ├── referralManager.js      # referral bonuses
│   ├── systemSelfTest.js       # DB/analytics/broadcast/workers/excel
│   ├── karaokeService.js       # не импортируется
│   └── lyricsService.js        # не импортируется
├── lib/TaskQueue.js            # in-memory priority queue
├── migrations/001..012.sql     # исторические миграции
├── scripts/                    # checks, migrations, XLSX/Shazam, release
├── test/                       # node:test unit/static contracts
├── integration/                # PostgreSQL integration fixtures
├── views/                      # EJS admin UI
├── public/static/              # CSS/JS/assets
├── hf-worker/                  # отдельный Docker Redis worker
├── src/, routes/               # устаревший альтернативный контур
├── Dockerfile
├── render.yaml
├── package.json / package-lock.json
└── requirements.txt
```

## Ключевые модули и контракты

| Модуль | Экспорты/роль | Кто вызывает | Вход → выход |
|---|---|---|---|
| `index.js` | `startApp`, route closures | `npm start` | ENV/HTTP/Telegram updates → HTML/JSON/webhook side effects |
| `bot.js` | `bot`, `isUserUnlimited`, `getUserLimit` | `index.js`, services | Telegraf context → messages/callbacks/tasks |
| `db.js` | десятки CRUD/analytics/broadcast/payment функций | почти все services и `index.js` | параметры → rows/domain objects; side effects PostgreSQL |
| `downloadManager.js` | `enqueue`, `trackDownloadProcessor`, `downloadQueue`, `initializeDownloadManager` | `bot.js`, `index.js` | URL/metadata/user → Telegram audio/cache/logs |
| `TaskQueue` | `add`, `pause`, `start`, clear/stats | download manager/admin | task object → Promise result |
| `broadcastSafety.js` | token, validation, preview | broadcast routes | authenticated form/session → one preview or validated launch |
| `broadcastWorker.js` | `processNextBroadcastTask` | worker manager/tests | confirmed pending task → status/progress |
| `analyticsService.js` | `trackEvent`, `trackEventSafe`, session/activity | `bot.js` и services | event context → `analytics_events` |
| `userInsightsService.js` | `getUserTimeline`, `getRetentionExplorer`, `getAcquisitionSourceExplorer` | admin API/smoke/tests | validated filters → paginated/aggregate JSON |
| `excelReportService.js` | `generateExcelReport`, cleanup | analytics export/smoke | JSON analytics → temporary XLSX artifact |
| `systemSelfTest.js` | `runSystemSelfTest` | `POST /admin/system/self-test` | internal checks → five-component JSON |
| `settingsManager.js` | `loadSettings`, `getSetting` | startup/bot/services/UI | `app_settings` + defaults → process-memory map |

`db.js` (~4049 строк), `bot.js` (~2760), `index.js` (~2406) и `downloadManager.js` (~1688) объединяют слишком много ответственностей. Это факт структуры, а не автоматически доказанная ошибка.

---

# 5. Пользовательские сценарии

## 5.1 Регистрация и язык

Точка входа — `/start` или любой update. Middleware `bot.js` получает/создает `users`, сбрасывает дневной лимит при необходимости, определяет RU/EN по сохраненному и Telegram language code, обновляет `last_active`, пишет analytics. Referral payload `ref_<id>` передается в `db.js:createUser`; затем `processNewUserReferral` начисляет бонусы.

Ошибки analytics в `trackEventSafe` не прерывают пользовательский сценарий. Ошибка основной БД, наоборот, затрагивает middleware и может сорвать update.

## 5.2 Одиночная ссылка

1. `bot.js` извлекает URL и определяет источник по подстроке.
2. Проверяет `use_soundcloud`/`use_spotify`/`use_youtube`.
3. Менеджер проверяет пользователя/лимит и `track_cache`.
4. При cache hit отправляется Telegram `file_id`, затем фиксируется скачивание.
5. При miss извлекаются metadata, создается задача с приоритетом.
6. `trackDownloadProcessor` скачивает/конвертирует, ограничивает результат примерно 48 MB, отправляет в storage channel, кеширует, отдает пользователю и пишет счетчики/логи.
7. Ошибки классифицируются (DRM, 403, 404, auth, empty, too large), трек попадает в `failed_tracks`, пользователь получает локализованное сообщение.

Подтвержденные расхождения limit logic описаны в разделах 15, 16 и 19.

## 5.3 Плейлист/альбом

SoundCloud playlist и Spotify album/playlist сначала создают in-memory session, показывают выбор треков/всех и учитывают отдельные playlist limits (`bot.js:processPlaylistDownload`, `spotifyManager.js`). Элементы ставятся в ту же локальную очередь. Это массовая операция без единой транзакции: каждый трек имеет собственный результат. Перезапуск процесса теряет session и ожидающие задачи.

## 5.4 Inline-поиск

Inline query длиной от 3 символов передается `searchManager.js`. Сначала читается Redis `search:<normalized query>` с TTL 3600, затем выполняется yt-dlp/SoundCloud search с логическим timeout 8 секунд. Результаты превращаются в Telegram inline choices. Timeout через `Promise.race` не гарантирует остановку внешнего процесса.

## 5.5 Spotify

Spotify URL разбирается regex на track/album/playlist. `spotifyManager.js` получает client-credentials token, вызывает Spotify Web API, хранит UI session 15 минут и передает title/artist/duration. Аудио Spotify напрямую не извлекается: `spotifyDownloader.js`/spotDL ищет соответствие на YouTube и кодирует MP3. Выбирается первый search result; строгая проверка версии/длительности перед скачиванием не подтверждена.

## 5.6 YouTube

Для URL/выбора качества используется `youtubeManager.js` и download manager. yt-dlp извлекает bestaudio и конвертирует в 128/192/320 kbps MP3. При включенном hybrid worker текущий HF worker использует `ytsearch1` по metadata даже для задачи, полученной как YouTube source, поэтому идентичность исходному URL не гарантирована.

## 5.7 Распознавание фрагмента

Пользователь присылает voice/audio/video/video note. `bot.js` получает Telegram file URL и загружает содержимое; `shazamService.js` сохраняет временный файл и запускает `scripts/shazam_recognize.py`. Результат title/artist возвращается как поисковая подсказка. Явный лимит размера и HTTP timeout на первичную загрузку Telegram-файла в этой ветке не подтвержден.

## 5.8 Оплата

- Stars: выбор тарифа → `payment_orders` → Telegram invoice → pre-checkout сверяет order/status/expiry/amount/currency → successful payment → PostgreSQL RPC `process_stars_payment` → `payments`, `users`, `subscription_operations`, analytics.
- Альтернативная оплата: ссылки ЮMoney/другие тексты; подтверждение выполняет администратор через `/register-manual-payment` и RPC `process_manual_payment`.
- `/paysupport` локализован RU/EN, объясняет Stars/альтернативы и запрос charge ID/скриншота (`bot.js`, locales/text config).

## 5.9 Поддержка

`/support` включает support mode. Сообщения/Telegram file IDs пишутся в `support_messages`; админ видит tickets, может проксировать файл, ответить и закрыть диалог (`bot.js`, routes `/support*`, `db.js`).

## 5.10 Рассылка

Preview RU/EN выполняется отдельным `POST /broadcast/preview`, получатель определяется сессией/`ADMIN_ID`, и не создает `broadcast_tasks`/`broadcast_log`. Launch требует `action=launch`, confirm modal, одноразовый session token и отдельный `POST /broadcast/launch`. Worker берет только подтвержденные pending tasks и проверяет `broadcasts_enabled` перед claim и каждым batch. Cancel переводит task и оставшиеся pending logs в cancelled. Основание: `services/broadcastSafety.js`, `index.js`, `services/broadcastWorker.js`, migrations 010.

## 5.11 Администратор

После login доступны dashboard, пользователи/профили, тарифы и платежи, queue control, broken tracks, settings/maintenance, тексты, promos, broadcasts, support, analytics, user journey, XLSX, schema/smoke/self-test. Все активные admin routes защищены `requireAuth`; публичными остаются `/health`, `/r`, login и Telegram webhook.

---

# 6. Внешние интеграции

| Сервис | Назначение и вызов | Авторизация/ENV | Timeout/retry/fallback | Данные |
|---|---|---|---|---|
| Telegram Bot API | updates, messages, inline, invoices, files, storage | `BOT_TOKEN`; Telegraf | webhook 3×/5 s; Telegram errors обрабатываются по месту | Telegram ID, username/name/lang, сообщения, file IDs, Stars charge IDs |
| Telegram storage channel | постоянный reusable media cache | `STORAGE_CHANNEL_ID`, bot membership | при отсутствии storage часть веток падает или отправляет напрямую | MP3 bytes → Telegram `file_id` |
| Telegram broadcast storage | загрузка вложений рассылки | `BROADCAST_STORAGE_ID` | ошибки возвращаются форме; temp cleanup | image/video/audio/document |
| SoundCloud | metadata/download/search | публичный доступ; proxy optional | scdl fast path; yt-dlp fallback; retries 3, socket 120 s | URL/search → title/artist/duration/audio |
| Spotify Accounts/API | metadata track/album/playlist | `SPOTIPY_CLIENT_ID/SECRET`, client credentials | token cached до expiry; API errors → user error | Spotify IDs/metadata, не аудиобайты |
| YouTube/yt-dlp | audio source и metadata | cookie file optional, proxy optional | retries/fallback без proxy; external process timeouts | URL или search query → media/metadata |
| Shazamio | распознавание | библиотека Python; отдельный API key кодом не требуется | child process; ошибки → recognition failure | user media → title/artist |
| PostgreSQL/Supabase | durable data и RPC | `DATABASE_URL`; optional Supabase URL/key | pool; query errors logged/rethrown | все domain records |
| Supabase Storage | karaoke feedback attachment | karaoke client или main Supabase fallback | не подтвержден общий retry/timeout | вложение → public/storage URL |
| Redis | cache/gates | `REDIS_URL` | reconnect до 10 попыток, до 3 s | search/session/day/notifier keys |
| Upstash-compatible Redis | broker master/HF worker | `TASK_BROKER_REDIS_URL` master; `REDIS_URL` worker | ioredis retry config; local fallback только для некоторых worker errors | task metadata и result JSON, не MP3 |
| Hugging Face worker | удаленное скачивание | Redis + Telegram bot/channel | BRPOP 30 s, job 180 s, local fallback по network error | metadata → Telegram file ID |
| ЮMoney/TBank/Boosty/VPN/внешнее караоке | пользовательские переходы | URL в коде или `app_settings` | доступность не контролируется приложением | click/referral context; платеж подтверждает админ |

Точные SLA, квоты и rate limits внешних сервисов: **не удалось подтвердить по текущему коду**. Telegram broadcast использует ограниченную concurrency и обработку 429 (`services/broadcastManager.js`), но глобального централизованного rate limiter для всех Telegram-вызовов нет.

---

# 7. База данных

## Общая модель

Используется PostgreSQL без ORM (`db.js:query`, `Pool`). На доступной схеме обнаружены следующие public-таблицы.

| Таблица | Роль, ключи и связи |
|---|---|
| `users` | Главная модель Telegram-пользователя; PK `id bigint`; профиль, язык, source/referrer, тариф/лимит, counters, flags, karaoke tester feedback fields |
| `track_cache` | Cache media; PK `url text`; Telegram `file_id`, title/artist/duration/source/quality/Spotify ID, aliases/search fields |
| `track_url_aliases` | Альтернативные URL/keys для cache; связь с canonical track |
| `track_metadata` | Дополнительные metadata; роль в активном pipeline ограничена |
| `downloads_log` | Факт выдачи трека; bigint id, user, title/url/source/time; явный FK в introspection не подтвержден |
| `search_queries` | История поисков и cache/result признаки |
| `failed_searches` | Агрегированные неудачные запросы; unique `(query, search_type)` |
| `failed_tracks` | Проблемные URL, причины, retry/resolution state; unique index на URL |
| `events` | Legacy события; основная новая аналитика использует `analytics_events` |
| `user_actions_log` | Административные/продуктовые действия с JSON details |
| `user_activity` | Дневная активность; `id int4`, `user_id bigint` FK → users; именно user_id исправлен migration 011 |
| `user_activity_logs` | Отдельный legacy activity log; потенциально пересекается с `user_activity`/analytics |
| `analytics_events` | Сырые события; bigint PK, nullable user, event/category/data/session/source/campaign/language/dedup/time |
| `analytics_daily` | Дневные агрегаты; PK date, DAU/WAU/MAU/funnel/revenue/version |
| `analytics_user_daily` | PK `(day,user_id)`, пользовательские дневные counts/source для retention |
| `payment_orders` | UUID order для invoice, plan/amount/currency/status/expiry/period |
| `payments` | Финансовый факт; bigint PK, nullable FK user `ON DELETE SET NULL`, status/method/currency/charge IDs/metadata |
| `subscription_operations` | Audit изменения тарифа до/после; FK user set null; `payment_id` без подтвержденного FK |
| `unprocessed_payments_log` | Ошибки Stars processing; уникальный charge ID |
| `broadcast_tasks` | Кампания, scheduling/status/content/audience/language/confirmation fields |
| `broadcast_log` | Snapshot и delivery state; FK task/user cascade; unique `(broadcast_id,user_id)` |
| `broadcast_clicks` | UUID PK, FK task/user cascade, button/time/user-agent/lang |
| `language_history` | UUID PK, история языка/source; явные FK не подтверждены |
| `support_messages` | Диалог support; FK user cascade, sender check `user/admin`, media/file ID/read state |
| `bot_texts` | PK `(key,language)`, редактируемые RU/EN тексты |
| `app_settings` | PK `key`, string value, timestamps; feature flags, limits, proxy and URLs |
| `promo_campaigns` | Триггер, текст, кнопка, URL, active flag |
| `user_promo_progress` | PK `(user_id,campaign_id)`, campaign FK cascade, показ/прогресс |
| `reviews` | Отзывы пользователя |
| `karaoke_cache` | Karaoke-related cache; активным music download pipeline не используется |
| `SCDBBACKUP` | Историческая backup-подобная таблица; автоматическая стратегия backup из нее не подтверждена |
| `session` | Сессии `connect-pg-simple`, expiry и serialized session |

## Ключевые ограничения и статусы

- `broadcast_log` предотвращает повтор одного пользователя в одной кампании unique constraint.
- `analytics_events` имеет partial unique для non-null `deduplication_key`.
- `payments.telegram_payment_charge_id` защищен unique; фактически обнаружены два эквивалентных объекта (`payments_telegram_payment_charge_id_key` и `uq_telegram_payment_charge_id`).
- `broadcast_tasks` имеет check `ck_broadcast_tasks_pending_confirmed`: pending требует `launch_confirmed_at/by`. Constraint создан `NOT VALID`, поэтому защищает новые/изменяемые rows, но исторические строки не были полностью validated.
- `premium_limit IS NULL` означает Unlimited только при активном `premium_until`; Free limit берется из `app_settings` и по умолчанию равен 3 (`bot.js:getUserLimit`, `services/settingsManager.js`).
- Status values в основном строки, PostgreSQL ENUM types не обнаружены. Допустимые значения задаются CHECK/RPC/кодом: payment `pending/completed/...`, broadcast `draft/pending/processing/completed/cancelled/error` и т. п.

## Индексы

Schema contract version 12 отдельно проверяет следующие рекомендованные индексы:

| Индекс | Ускоряет |
|---|---|
| `idx_analytics_events_user_created` | timeline по user/time |
| `idx_payments_user_created` | платежи пользователя |
| `idx_payments_user_paid_completed` | completed revenue/payer analytics |
| `idx_broadcast_log_user_sent` | timeline/рассылка по user/status/time |
| `idx_broadcast_clicks_user_clicked` | клики пользователя |
| `idx_downloads_log_user_downloaded` | downloads timeline |
| `idx_language_history_user_created` | история языка |
| `idx_user_actions_log_user_created` | user actions timeline |
| `idx_analytics_user_daily_user_day` | retention return checks |
| `idx_users_created_at_id` | cohorts/source pagination |

`track_cache` дополнительно использует B-tree и GIN/trigram/search-vector индексы для URL, source, metadata и fuzzy search (`migrations/`, фактическая introspection). Полный набор не является частью strict start contract; отсутствие рекомендованных индексов выдается как warning, а не блокирует startup (`db.js:RECOMMENDED_SCHEMA_INDEXES`, `checkSchemaPreflight`).

## Миграции

`migrations/` содержит 001–012. Единой ledger-таблицы миграций нет; версия хранится строкой `app_settings.schema_version`.

- 003/006/007/008 запускаются через wrappers при каждом startup и написаны идемпотентно;
- 009 — reconciliation схемы;
- 010 — подтверждение/kill switch рассылок;
- 011 — транзакционно переводит `user_activity.user_id` в bigint с сохранением фактического определения FK;
- 012 — только `CREATE INDEX CONCURRENTLY IF NOT EXISTS`; выполняется вне transaction отдельным script и дважды для идемпотентности;
- 005 предназначена отдельной karaoke database (`profiles`, `karaoke_testers`) и не должна применяться к main DB.

`npm run migrate:schema` вызывает только `runPreflightFixesMigration()` (008), хотя имя предполагает полный migration set. `npm run migrate:insights:twice` применяет 012 и ставит version 12. Поэтому fresh/stale database нельзя надежно довести до текущей версии одной общей командой.

## Жизненный цикл и риски данных

Автоматическая retention policy для downloads/events/payments/broadcast logs не найдена. PostgreSQL records сохраняются бессрочно, если администратор или внешняя DB policy их не удаляет. Session expiry управляет `connect-pg-simple`. Backup/restore procedure в репозитории отсутствует; Supabase managed backups **не удалось подтвердить по текущему коду**.

Гонки: доставка media может произойти до атомарного подтверждения increment quota; несколько параллельных tasks способны выдать файлы сверх лимита. Broadcast snapshot и unique constraint существенно лучше защищены от дублей. Подробности — разделы 16/19.

---

# 8. Кэш, очереди и фоновые задачи

## Кэш

| Слой | Ключ/идентификатор | TTL / invalidation |
|---|---|---|
| Redis search | `search:<lowercase query>` | 3600 s; естественный expiry (`searchManager.js`) |
| Analytics session | `session:<userId>` | sliding 1800 s (`analyticsService.getSessionId`) |
| Daily active marker | `daily_active:<userId>:<YYYY-MM-DD>` | до полуночи Europe/Moscow |
| Notifier gate | `notifier:last_run` | 86400 s |
| Spotify token | process memory | до API expiry |
| Spotify UI session | process Map | 15 минут, cleanup раз в 5 минут |
| YouTube UI session | process Map | 10 минут; cleanup привязан к обработчикам, отдельный interval не подтвержден |
| SoundCloud playlist session | process Map | явный TTL/periodic cleanup не найден |
| Settings/texts | process memory | reload при startup/админском обновлении; multi-instance coherence не подтверждена |
| Track media | PostgreSQL key + Telegram file ID | TTL отсутствует; manual fix/delete |

В `db.js:findCachedTrack` сначала используется exact PostgreSQL, затем опциональный Supabase fuzzy path. В `searchTracksInCache` Supabase RPC вызывается до SQL fallback; если Supabase client отсутствует/бросает ошибку, общий catch возвращает пустой список и SQL fallback может не выполниться.

## Локальная очередь

`TaskQueue` хранится в памяти, max concurrency — `MAX_CONCURRENT_DOWNLOADS` или 4. Более высокий numeric priority идет раньше. Код часто ставит priority равным `premium_limit || 5`, поэтому Unlimited (`null`) получает 5, а не высший приоритет. Timeout 10 минут реализован `Promise.race`; abort/kill underlying task отсутствует. Dead-letter queue и durable recovery отсутствуют. После restart ожидающие задачи теряются.

Защиты от двух одинаковых задач для одного URL/user нет. Admin может удалить только ожидающие задачи; активные не отменяются.

## Distributed broker

- queue: `music:download:queue`, `LPUSH` master + `BRPOP` worker;
- results: `music:download:results`, Redis Pub/Sub;
- heartbeat: `music:worker:heartbeat`, TTL 120 s, обновление 30 s;
- master считает worker активным при age <120 s.

Нет ACK/inflight list, retry counter и DLQ. После `BRPOP` падение worker теряет task. Pub/Sub result теряется, если master не подписан. Это at-most-once окно. Рабочая реализация — `hf-worker/worker.js`; корневой `worker.js` вызывает отсутствующие в `TaskBroker` методы `sendHeartbeat/getTask/sendResult/disconnect` и неработоспособен без изменения API.

## Периодические задачи и restart

Broadcast state и recipient snapshot в PostgreSQL позволяют продолжить pending campaign после restart. Download queue — нет. Notifier использует Redis/DB flags, premium reset и analytics aggregation идемпотентны на уровне SQL/upsert. In-process `lastAggregationDate` сбрасывается при restart, но daily upsert ограничивает последствия.

---

# 9. Работа с файлами и медиа

## Поддерживаемые входы/выходы

- ссылки: SoundCloud track/playlist, Spotify track/album/playlist, YouTube/YouTube Music URL;
- Telegram media для Shazam: voice, audio, video, video note;
- broadcast upload: image/video/audio/document до 49 MB;
- основной download output: MP3 128/192/320 kbps;
- analytics output: XLSX;
- user export: CSV и TXT links.

Строгое ограничение длительности трека не найдено. Ограничение готового audio — около 48 MB в worker, upload middleware — 49 MB. Telegram API остается внешним фактическим ограничителем.

## Временные каталоги

- download: `os.tmpdir()/sc-cache`;
- thumbnails: `os.tmpdir()/sc-thumbs`;
- Spotify: `os.tmpdir()/spotify-dl`;
- Shazam: `os.tmpdir()/shazam_tmp`;
- admin uploads: `os.tmpdir()/uploads`;
- XLSX: `os.tmpdir()/scloud-analytics-*`;
- HF: `TEMP_DIR` или `/tmp/music-worker`.

Cookie берется из `/etc/secrets/cookies.txt`, fallback — `cookies.txt` в проекте, затем копируется во временную writable path (`downloadManager.js`). Содержимое cookie не логируется, но сам путь логируется.

## Pipeline

SoundCloud fast path открывает stream через `soundcloud-downloader`, передает в FFmpeg `libmp3lame`, 320 kbps/44.1 kHz, проверяет duration/preview через Telegram metadata и ffprobe; при ошибке идет yt-dlp fallback. Spotify metadata преобразуется в YouTube search, затем yt-dlp/FFmpeg. В ряде веток MP3 целиком буферизуется до 48 MB, что при concurrency 4 существенно повышает RAM peak.

Metadata: title, uploader/artist, duration, thumbnail, source, quality, original/canonical URL. Thumbnail загружается axios с timeout 10 s и удаляется в `finally`. Внешний thumbnail URL приходит из metadata и отдельно не ограничен allowlist.

Готовый MP3 сохраняется не на локальном persistent disk, а в Telegram storage channel; PostgreSQL хранит `file_id`. Локальные файлы удаляются в `finally`. HF имеет аварийный cleanup файлов старше 10 минут. Для SoundCloud playlist sessions и части ошибочных дочерних процессов полное освобождение process-memory подтвердить нельзя.

---

# 10. Авторизация и безопасность

## Авторизация и роли

- Telegram user идентифицируется `ctx.from.id`; Telegram сам подписывает updates на уровне Bot API/webhook transport.
- Web admin имеет одну роль: ID должен совпасть с `ADMIN_ID`. Login сравнивает `ADMIN_LOGIN`/`ADMIN_PASSWORD`, затем сохраняет `authenticated` и `userId` в PostgreSQL session (`index.js`).
- Session cookie: 30 дней, `httpOnly`, `sameSite=lax`, `secure` в production.
- Попытки login ограничены in-memory map: 5 за 15 минут на IP. После restart/между instances счетчик не разделяется.
- Active admin routes используют `requireAuth`. `/health`, `/r`, login и webhook публичны.

## Секреты

`config.js` валидирует обязательные ENV и выводит `getSafeConfig`. `services/logSanitizer.js` маскирует password-bearing URLs и sensitive keys; `settingsManager.loadSettings` использует sanitizer. Реальные значения в Git не должны попадать; `.env` игнорируется.

Остаточные места:

- `/r` логирует полный invalid/expired signed token `t` (`index.js`), который содержит tracking payload/signature;
- DB error/slow logs выводят SQL text, но параметры обычно не выводятся (`db.js:query`);
- некоторые логи содержат Telegram user IDs, URL треков и titles;
- HF worker маскирует proxy credentials через regex, основной код использует centralized redaction.

## Валидация и API protection

User insights валидирует `user_id`, ISO dates, source, cohort day/segment, page/limit и использует фиксированный ORDER BY/параметризованный SQL (`services/userInsightsService.js`). Broadcast launch имеет отдельный intent/token/confirmation. Payment HTTP и RPC запрещают manual `XTR`/`telegram_stars`.

Общей CSRF-защиты в активном `index.js` нет. `sameSite=lax` снижает часть риска, но state-changing POST routes не имеют CSRF token. В неиспользуемом `src/app.js` есть следы другой middleware-архитектуры, но она production не защищает.

URL source определяется через `includes('soundcloud.com')`, `includes('spotify.com')`, `includes('youtu')`, а затем URL передается yt-dlp/axios. Полноценная проверка hostname/protocol/redirect chain не найдена; это потенциальный SSRF/нежелательный fetch risk. Эксплуатация не выполнялась.

Multer генерирует server-side имя и берет только extension original filename, что ограничивает traversal. Однако MIME/extension и media content строго не проверяются до отправки Telegram.

`app_settings` содержит proxy/URL и меняется authenticated admin route. Route принимает произвольный key, поэтому опечатка создает новый setting; allowlist отсутствует.

RLS создается для аналитических/payment объектов migration 006, RPC privileges отозваны у public/authenticated и выданы `service_role`. Основное приложение подключается напрямую через PostgreSQL credentials, поэтому реальная изоляция определяется ролью этой строки подключения. Ее права: **не удалось подтвердить по текущему коду**.

---

# 11. Тарифы, ограничения и монетизация

## Фактические тарифы

| Тариф | Дневной лимит | Stars | RUB reference | Срок |
|---|---:|---:|---:|---:|
| Free | 3 по default `daily_limit_free` | — | — | бессрочно |
| Plus | 30 | 79 XTR | 119 RUB | 30 дней |
| Pro | 100 | 129 XTR | 199 RUB | 30 дней |
| Unlimited | `NULL` | 199 XTR | 299 RUB | 30 дней |

Основание: `config/tariffs.js`, `services/settingsManager.js`, `bot.js:getUserLimit`. Тарифы non-recurring (`isRecurring:false`). Playlist limits конфигурируются отдельно: default 5/30/100/10000.

## Активация и истечение

`process_stars_payment` выполняет row locking, проверяет order/charge, создает `payments`, обновляет пользователя и audit operation. Повторный charge защищен unique/idempotent response. Manual RPC запрещает выдавать Stars как ручной платеж, но принимает админские альтернативные methods.

Expired premium сбрасывается при user access, startup, daily interval и cron 00:10 UTC (`db.js:resetExpiredPremiumIfNeeded/resetExpiredPremiumsBulk`, `workerManager.js`, `index.js`). Такое дублирование в основном идемпотентно.

## Бесплатные механики

- referral: новый пользователь и referrer получают по 3 дня Plus (`services/referralManager.js`);
- channel subscription bonus: 7 дней Plus один раз (`bot.js`, `subscribed_bonus_used`);
- promo campaigns после заданного числа downloads (`promo_campaigns`, `user_promo_progress`, `downloadManager.js`);
- рекламные переходы VPN/Yandex/другие кампании;
- admin может set/extend/reset tariff и зарегистрировать ручной платеж (`index.js`, `db.js:setTariffAdmin/processManualPayment`).

## Подтвержденные расхождения

1. В `downloadManager.enqueue` проверка `(downloads_today >= premium_limit)` при `premium_limit=null` фактически сравнивает с 0 и блокирует Unlimited.
2. Некоторые Spotify/YouTube ветки используют `(premium_limit || 5)`, поэтому Free setting 3 и Unlimited semantics теряются.
3. Отправка файла местами выполняется до `incrementDownloadsAndSaveTrack`; параллельные задачи могут обойти лимит.
4. В referral code условие `referrer.premium_limit > 30` не распознает Unlimited (`null`), поэтому referrer Unlimited попадает в ветку выдачи Plus 30 и рискует потерять тарифное преимущество.
5. Manual RPC/route защищает тип платежа, но строгая проверка положительного amount/period/currency allowlist по текущему коду не подтверждена.

---

# 12. Аналитика и логирование

## События и хранение

`analyticsService.trackEvent` пишет user/session, event name/category/data, origin, acquisition/source/placement/campaign/language и optional dedup key в `analytics_events`. События включают session start, daily return, inactivity return, регистрацию, поиск, скачивание/cache, limit/tariff funnel, invoices/payments, promo/referral/support/broadcast interactions. Полный словарь распределен по `bot.js`, `services/*`; централизованного enum нет.

`trackEventSafe` намеренно проглатывает analytics error, чтобы не ломать бот. Это повышает доступность, но создает незаметные пробелы в event chain.

Дополнительные источники: `downloads_log`, `payments`, `broadcast_log`, `broadcast_clicks`, `language_history`, `user_actions_log`. Event Timeline объединяет их UNION, сортирует стабильно по `occurred_at DESC, event_uid DESC`, использует cursor pagination default 50/max 200 и date range. Downloads с `download_log_id` исключаются из analytics branch для уменьшения двойного учета (`services/userInsightsService.js:getUserTimeline`).

## Агрегаты и отчеты

- `aggregateDailyStats` транзакционно агрегирует день Europe/Moscow в `analytics_daily` и `analytics_user_daily`;
- startup backfill проверяет последние 7 дней;
- dashboard: DAU/WAU/MAU, регистрации, funnel, downloads, revenue, language/source;
- retention: D1/D7/D30/D90 с eligible denominator; молодые cohorts получают `null`; lists returned/«не вернулись к контрольному дню» загружаются отдельным paginated endpoint;
- acquisition: raw и canonical normalized source, unknown отдельно, completed revenue, unique payers, ARPPU и observed LTV; RUB делится на 100, XTR переводится через `xtr_rub_rate` (`userInsightsService.js`);
- XLSX: Executive Summary, Dashboard и тематические sheets через `generate_excel_report.py`.

## Логи и monitoring

Логи — `console.log/warn/error` с текстовыми tags. Уровни не управляются ENV; structured JSON logger, trace ID, Sentry, Prometheus и central retention в коде отсутствуют. Render/container log aggregation находится вне репозитория и **не подтверждена**.

`/health` проверяет Redis/DB/queue, но всегда возвращает top-level `status:'ok'` и HTTP 200 даже при database `❌`; это может скрыть отказ БД от platform healthcheck. Более глубокий authenticated `POST /admin/system/self-test` возвращает database/analytics/broadcasts/workers/excel и 503 при любом error. Broadcast smoke выполняется в transaction с rollback.

Data cleanup для analytics/log tables не найден. Восстановление цепочки доступно через timeline только для успешно записанных событий; проглоченные analytics errors восстановить нельзя.

---

# 13. Развертывание и эксплуатация

## Требования

- Node.js 18+; production Docker использует 20;
- npm;
- Python 3 и pip;
- FFmpeg/ffprobe;
- PostgreSQL schema version 12;
- Telegram bot и storage channel;
- optional Redis и optional hybrid worker.

## Установка и запуск

Подтвержденные команды:

```text
npm install
pip install -r requirements.txt
npm start
```

Development запускает long polling, production требует webhook config. До запуска приложение требует `BOT_TOKEN`, numeric `ADMIN_ID`, `DATABASE_URL`; production также `WEBHOOK_URL`, `SESSION_SECRET` >=32, `ADMIN_LOGIN`, `ADMIN_PASSWORD` >=8 (`config.js`).

## Миграции и проверки

Подтвержденные scripts:

```text
npm run migrate:schema
npm run migrate:insights:twice
npm run check:schema
npm run smoke:analytics
npm test
npm run test:broadcast:integration
npm run test:payments:integration
npm run test:insights:integration
npm run release:check
```

Но `migrate:schema` применяет только migration 008, а не весь набор. Перед fresh deployment migrations 009–012 должны быть применены отдельным подтвержденным процессом. `release:check` запускает unit, schema, analytics smoke и broadcast integration, но не включает payment и user-insights integration (`scripts/release-check.js`).

## Docker и Render

`Dockerfile` устанавливает Python, FFmpeg, nightly yt-dlp, npm production dependencies и связывает системный yt-dlp с youtube-dl-exec. `render.yaml` при этом декларирует `env: node`, build `npm install && pip install -r requirements.txt`, а не Docker build. В native Render recipe системный FFmpeg и nightly yt-dlp не устанавливаются самим manifest; доступность зависит от platform image. Также manifest содержит placeholder/старый `WEBHOOK_URL`, отличающийся от предоставленного production URL.

HF worker имеет отдельный Dockerfile, Node 20, Python/FFmpeg/yt-dlp и health на 7860. В main `render.yaml` он не развертывается.

Vercel-конфигурации в репозитории нет. Внешний karaoke UI может быть размещен отдельно, но это не deployment данного проекта.

## Health, данные, update и rollback

- shallow health: `GET /health`;
- deep health: authenticated `POST /admin/system/self-test`;
- persistent: PostgreSQL и Telegram storage; Redis — cache/queue; local `/tmp` ephemeral;
- update: Git/Render autodeploy предполагается по фактической эксплуатации, но pipeline YAML/Actions в репозитории не найден;
- rollback: документированной команды/автоматической DB rollback нет. SQL migrations в основном forward-only;
- backup/restore: репозиторий не содержит проверенной процедуры. Использование Supabase backup **не удалось подтвердить по текущему коду**.

---

# 14. Переменные окружения

Безопасный пример означает placeholder, а не текущее значение.

| Переменная | Обязательна | Назначение / использование | Безопасное значение по умолчанию |
|---|---:|---|---|
| `BOT_TOKEN` | да, кроме DB tools | Telegraf/main/HF/indexer/redirect fallback | отсутствует |
| `ADMIN_ID` | да, кроме DB tools | Telegram/admin role/preview/reports | отсутствует |
| `DATABASE_URL` | да | PostgreSQL pool, sessions, migrations/tests | отсутствует |
| `NODE_ENV` | production | webhook, secure cookie, prod validation | `development` |
| `CONFIG_SCOPE` | CLI only | разрешает DB tools без bot/admin secrets | unset; script ставит `database` |
| `WEBHOOK_URL` | production | base public URL | отсутствует |
| `WEBHOOK_PATH` | нет | Telegram route | `/telegram` |
| `PORT` | нет | HTTP | `3000`; HF `7860` |
| `SESSION_SECRET` | production | session signing и redirect fallback | dev DB-tool placeholder; в prod отсутствует |
| `ADMIN_LOGIN` | production | web login | `admin` только dev/DB tool |
| `ADMIN_PASSWORD` | production | web login | `admin` только dev/DB tool |
| `REDIS_URL` | нет | cache/notifier; HF использует как broker | disabled |
| `TASK_BROKER_REDIS_URL` | нет | master distributed queue | disabled |
| `SUPABASE_URL` | нет | optional client/storage/RPC | empty |
| `SUPABASE_KEY` | нет | Supabase credential | empty |
| `PROXY_URL` | нет | Telegraf/scdl/yt-dlp | disabled |
| `CHANNEL_URL` | нет | обязательный канал бонуса | empty |
| `STORAGE_CHANNEL_ID` | практически для cache/HF | Telegram audio storage | empty |
| `BROADCAST_STORAGE_ID` | для media broadcast | Telegram broadcast media storage | empty |
| `SPOTIPY_CLIENT_ID` | для Spotify metadata | Spotify OAuth client | empty |
| `SPOTIPY_CLIENT_SECRET` | для Spotify metadata | Spotify OAuth secret | empty |
| `FORCE_POLLING` | нет | polling даже вне обычного dev path | unset/`0` |
| `TELEGRAM_TEST_ENV` | нет | Telegraf test API flag | `false` |
| `MAX_CONCURRENT_DOWNLOADS` | нет | local queue | `4` |
| `SEARCH_TIMEOUT_MS` | нет | search logical timeout | `8000` |
| `BOT_USERNAME` | нет | search deep-link fallback | `YourBotUsername` (часть кода hardcode `SCloudMusicBot`) |
| `REDIRECT_SECRET` | нет | HMAC redirect | fallback SESSION_SECRET/BOT_TOKEN |
| `NOTIFICATION_CONCURRENCY` | нет | p-map notifier | `3` |
| `NOTIFICATION_THROTTLE_MS` | нет | объявлена, но фактически не используется p-map | `300` |
| `MVSEP_API_KEY` | нет | неиспользуемый karaoke service | empty |
| `KARAOKE_DATABASE_URL` | для tester integration | отдельная karaoke DB | empty |
| `KARAOKE_SUPABASE_URL/KEY` | для feedback storage | отдельный Supabase | empty |
| `GENIUS_ACCESS_TOKEN` | только dead service | `lyricsService.js`, не импортируется | empty |
| `TEMP_DIR` | HF only | worker temp | `/tmp/music-worker` |
| `BROADCAST_TEST_DATABASE_URL` | integration | isolated broadcast test DB | fallback `DATABASE_URL` с защитами script |
| `PAYMENT_TEST_DATABASE_URL` | integration | isolated payment RPC test | fallback `DATABASE_URL` с защитами script |

Расхождения `env.example`:

- пример содержит `ADMIN_IDS`, код требует одиночный `ADMIN_ID`;
- пример содержит `WEBHOOK_DOMAIN`, код требует `WEBHOOK_URL`;
- пример содержит `CHANNEL_USERNAME`, код читает `CHANNEL_URL`;
- пример не содержит production-required `SESSION_SECRET`, `ADMIN_LOGIN`, а также `WEBHOOK_PATH`, `BROADCAST_STORAGE_ID`, Redis broker, concurrency/timeouts, redirect, karaoke и integration vars;
- `GENIUS_ACCESS_TOKEN` используется только неактивным `lyricsService.js` и отсутствует в примере.

---

# 15. Известные ограничения

## Технические и производительность

- Один Node process содержит HTTP, bot, cron, admin и download queue; большие sync/CPU/media операции конкурируют за RAM/event-loop.
- Локальная очередь и UI sessions неперсистентны.
- `db.js`, `bot.js`, `index.js`, `downloadManager.js` очень велики и тесно связаны.
- MP3 местами буферизуется целиком; concurrency 4 умножает memory peak.
- Event Timeline ограничен 200 rows/page и date range; полная история не грузится одним запросом — это осознанное ограничение.
- XLSX зависит от возможности spawn Python и writable temp; в текущей sandbox среде smoke дал `EPERM`.

## Внешние и форматы

- DRM/Go+ и удаленные/геоограниченные источники не скачиваются надежно.
- Spotify audio — подбор YouTube-версии, не официальный Spotify stream; возможны remix/live/wrong version.
- HF worker также ищет `ytsearch1`, а не гарантирует исходный media URL.
- Финальный Telegram audio ограничен примерно 48 MB.
- Shazam зависит от качества/длины фрагмента и внешнего распознавания.
- Cookie/proxy/yt-dlp extractor регулярно зависят от изменений платформ.

## Продуктовые/UI

- Только RU/EN.
- Одна web-admin роль, нет granular RBAC/audit login.
- Admin UI server-rendered; часть страниц большая и использует inline client JS.
- `views/user-journey.ejs` и `views/user-profile.ejs` были изменены до аудита и не проверялись как clean commit state.
- Broadcast kill switch по default должен быть false; текущий production state в предоставленных логах был false, но из текущей среды значение независимо не запрашивалось.

---

# 16. Проблемные и спорные места

| Важность | Файл/участок | Фактическое последствие | Краткая рекомендация |
|---|---|---|---|
| критично | `services/downloadManager.js:enqueue/trackDownloadProcessor`, `spotifyManager.js`, `youtubeManager.js` | `NULL` Unlimited блокируется/превращается в 5; разные ветви расходятся с Free=3 | Использовать один `getUserLimit`/atomic entitlement contract во всех путях |
| критично | `services/downloadManager.js` hybrid/local success | Audio отправляется до atomic quota increment; параллельные tasks могут выдать сверх лимита | Резервировать quota транзакционно до доставки и компенсировать при failure |
| критично | `services/referralManager.js:processNewUserReferral` | Unlimited referrer (`null`) попадает в Plus branch и может быть понижен | Явно различать active Unlimited и сохранять текущий limit |
| критично | `index.js:startApp`, `scripts/migrate-schema.js`, migrations 009–012 | Strict schema v12 может остановить startup, а названная migration command не применяет весь путь | Ввести подтвержденный ordered runner/ledger до старта приложения |
| высокая | `bot.js`, `downloadManager.js`: URL checks через `includes` | Потенциальный SSRF/нежелательный protocol/hostname для yt-dlp/axios | Parse URL, allowlist exact host/scheme, revalidate redirects |
| высокая | `lib/TaskQueue.js:processNext` | Timeout завершает Promise, но не child process/stream; задача продолжает потреблять ресурсы | Передавать AbortSignal и kill/cleanup по timeout |
| высокая | `taskBroker.js`, `hf-worker/worker.js` | BRPOP/PubSub без ACK: task/result теряется при restart/disconnect | Inflight list + ACK/requeue/result persistence/DLQ |
| высокая | `index.js:/health` | DB может быть недоступна, а Render получает 200/status ok | Возвращать degraded/503 для обязательной DB или отдельный readiness route |
| высокая | `index.js` + `workerManager.js` | Daily/hourly notifier зарегистрирован дважды | Оставить один scheduler owner |
| высокая | `index.js` active admin POST routes | CSRF token отсутствует | Добавить CSRF protection и оставить sameSite как дополнительный слой |
| средняя | `spotifyDownloader.js`, `hf-worker/worker.js` | Первый YouTube search result может быть другой версией трека | Сопоставлять duration/artist/title, отклонять низкую уверенность |
| средняя | `db.js:searchTracksInCache` | Ошибка/отсутствие Supabase может пропустить PostgreSQL fallback | Разделить try/catch и гарантировать SQL fallback |
| средняя | `services/analyticsService.js:trackEventSafe` | Analytics gaps скрыты от monitoring | Считать/алертить dropped events без влияния на user flow |
| средняя | `index.js:/r` | Invalid signed tracking token попадает в log целиком | Логировать только hash/prefix/reason |
| средняя | `index.js:/settings/update` | Произвольные keys и string values создают schema drift настроек | Allowlist и type validators |
| средняя | `services/settingsManager.js` | In-memory settings не синхронизированы между instances | Versioned invalidation/reload |
| средняя | `services/notifier.js` | `NOTIFICATION_THROTTLE_MS` объявлена, но не применяется | Либо применить throttle, либо убрать ложную настройку |
| средняя | `worker.js` | Корневой worker использует несуществующие TaskBroker methods | Удалить/архивировать или привести к фактическому protocol |
| низкая | `src/`, `routes/`, karaoke/lyrics services | Нового разработчика вводят в заблуждение альтернативные entrypoints | Явно пометить legacy/dead и убрать после проверки истории |
| низкая | `render.yaml` vs `Dockerfile` | Native Render build не повторяет Docker system dependencies и содержит старый URL | Выбрать один deployment source of truth |

Бесконечных циклов без блокирующего ожидания в active main не найдено: HF `while(true)` блокируется `BRPOP 30`. Однако root `worker.js` потенциально зацикливает ошибки API, если его запустить, поскольку ожидаемые broker methods отсутствуют.

---

# 17. Фактический статус функций

| Функция | Статус | Основные файлы | Комментарий |
|---|---|---|---|
| Telegram webhook/polling | работает | `index.js`, `bot.js` | prod webhook, dev polling, watchdog |
| SoundCloud track | частично | `downloadManager.js`, `bot.js` | fast + fallback; внешняя доступность не проверена |
| SoundCloud playlist | частично | `bot.js`, `downloadManager.js` | in-memory session/queue, теряется при restart |
| Spotify track/album/playlist | частично | `spotifyManager.js`, `spotifyDownloader.js` | metadata Spotify, аудио YouTube matching |
| YouTube download | частично | `youtubeManager.js`, `downloadManager.js` | yt-dlp; hybrid может выбрать другую версию |
| Inline search | работает | `searchManager.js`, `bot.js` | Redis cache и timeout; external process не abortable |
| Shazam | частично | `shazamService.js`, Python script | pipeline есть, реальный API не тестировался |
| Telegram media cache | работает | `db.js`, `downloadManager.js` | PostgreSQL metadata + Telegram file ID |
| Local priority queue | работает | `lib/TaskQueue.js` | non-durable, timeout без cancellation |
| HF distributed worker | частично | `taskBroker.js`, `hf-worker/` | protocol работает по коду, at-most-once risk; deployment не подтвержден |
| Root `worker.js` | не используется/устарело | `worker.js` | несовместим с текущим TaskBroker API |
| Stars payments | работает | `bot.js`, `db.js`, migrations 006/009 | RPC/idempotency; integration script существует |
| Manual payments | работает | `index.js`, `db.js`, migration RPC | Stars запрещены на HTTP+RPC; input limits неполны |
| Тарифы | частично | `tariffs.js`, `bot.js`, `db.js` | core есть, download paths расходятся по Unlimited/Free |
| Referrals | частично | `referralManager.js` | бонусы есть; Unlimited downgrade risk |
| Support | работает | `bot.js`, `index.js`, `db.js` | text/media IDs, admin reply/close |
| Broadcast preview | работает | `broadcastSafety.js`, tests | ровно admin, без task/log по contract tests |
| Broadcast launch/worker/cancel | работает | broadcast services, migration 010 | multi-layer safety, kill switch, snapshot |
| Analytics dashboard | работает | `db.js`, `analyticsService.js`, views | SQL smoke passed |
| User Timeline | работает | `userInsightsService.js`, user journey API/view | paginated/deduplicated, smoke/tests passed |
| Retention Explorer | работает | `userInsightsService.js` | aggregate-first, paginated details, eligible logic |
| Source analytics | работает | `userInsightsService.js` | canonical/raw/unknown/revenue semantics |
| XLSX export | частично | `excelReportService.js`, Python generator | static tests pass; local spawn EPERM; production evidence was green |
| System self-test | работает | `systemSelfTest.js`, route | transaction rollback broadcast smoke; prod execution not done here |
| Karaoke creation/minus/lyrics | не используется | `karaokeService.js`, `lyricsService.js` | no imports; documentation stale |
| Karaoke tester bridge | частично | `bot.js`, `db.js` | access/feedback/external app; external DB not tested |
| Legacy `src/`/`routes/` app | устарело | `src/`, `routes/` | not mounted by active entrypoint |

---

# 18. Карта потока данных

## Персональные данные

Telegram передает ID, username, first name, language code, message/media metadata. Они сохраняются в `users`, `support_messages`, analytics, broadcast logs/clicks и audit logs. Admin pages читают их через authenticated routes. Acquisition/referrer и last activity формируют retention/source reports.

## Токены и секреты

Bot/database/Spotify/Supabase/Redis/proxy secrets входят только через ENV/config. Telegram Stars charge IDs и provider IDs сохраняются в `payments`/`unprocessed_payments_log`. Session secret подписывает cookie; redirect secret HMAC-подписывает payload. Логи должны видеть sanitized config, но invalid redirect token сейчас логируется полностью.

## Пользовательские ссылки и аудио

```text
URL пользователя
→ source classification
→ metadata extractor/API
→ canonical/cache key (`track_cache`, aliases)
→ external downloader
→ temporary media/FFmpeg
→ Telegram storage channel
→ file_id в PostgreSQL
→ Telegram user
→ downloads/analytics records
```

Внешним сервисам уходят URL, поисковая строка title/artist, proxy/cookies при настройке и технические headers. Spotify получает resource ID; YouTube search получает artist/title. Telegram получает audio bytes и metadata.

## Поддержка/рассылка

Support text и file IDs идут в PostgreSQL, админский ответ — обратно Telegram. Broadcast form content может временно записываться в `/tmp`, затем media отправляется в broadcast storage. Recipient snapshot содержит user IDs/language/status; clicks сохраняют user agent и language.

## Аналитика

Raw события и operational logs агрегируются по дню Europe/Moscow. User journey объединяет несколько таблиц, retention использует creation/activity dates, source analytics присоединяет completed payments и `xtr_rub_rate`. XLSX получает агрегированный JSON во временном файле; оба артефакта удаляются после download/error.

---

# 19. Технический долг

## P0 — может ломать работу или приводить к потере/неверной выдаче прав

1. **Единая атомарная проверка download entitlement.** Сейчас `downloadManager.js`, `spotifyManager.js`, `youtubeManager.js` по-разному трактуют Free и `NULL` Unlimited, а delivery может предшествовать increment. Это одновременно блокирует оплаченный Unlimited и допускает превышение лимита.
2. **Сохранение Unlimited в referral bonus.** `referralManager.js:processNewUserReferral` трактует `null` как не больше 30 и может понизить referrer до Plus.
3. **Полный migration runner до strict preflight.** `index.js` требует version 12, но startup/`migrate:schema` не умеют последовательно применить 009–012. Fresh/stale deployment может завершиться exit(1).

## P1 — существенно влияет на стабильность и поддержку

1. Durable broker protocol с ACK/inflight/retry/DLQ вместо BRPOP + transient Pub/Sub (`taskBroker.js`, `hf-worker/worker.js`).
2. Реальное cancellation child processes при timeout (`TaskQueue`, download/Spotify/Shazam scripts).
3. Точная URL allowlist до yt-dlp/axios и thumbnail fetch (`bot.js`, `downloadManager.js`).
4. Один owner для notifier schedules; сейчас `index.js` и `workerManager.js` дублируют их.
5. Readiness health должен падать при обязательной DB failure (`index.js:/health`).
6. CSRF protection для admin state-changing routes.
7. Официально выбрать Render native или Docker; синхронизировать FFmpeg/yt-dlp и webhook manifest.
8. Включить payment и user-insights integrations в `release:check`.

## P2 — мешает развитию

1. Разделить `db.js` по bounded contexts, `index.js` по routers, `bot.js` по handlers, download manager по source adapters.
2. Удалить или архивировать несовместимые `src/`, `routes/`, root `worker.js`, unused karaoke/lyrics services после проверки истории.
3. Централизовать event names/statuses/settings schema и тарифный contract.
4. Добавить observable counter/alert для `trackEventSafe` failures и structured logging с correlation IDs.
5. Гарантировать PostgreSQL cache fallback без Supabase.
6. Ввести retention/privacy policy и документированный backup/restore drill.
7. Проверять Spotify↔YouTube match по duration/title/artist.

## P3 — качество и косметика

1. Синхронизировать `env.example`, `ARCHITECTURE.md`, `PROJECT_STRUCTURE.md`, `RELEASE_CHECKLIST.md` с кодом.
2. Убрать неиспользуемые зависимости после import/test audit.
3. Удалить дублирующий unique index на Stars charge, если production constraints подтвердят эквивалентность.
4. Унифицировать hardcoded bot usernames, affiliate/payment URLs и тексты через settings.
5. Убрать объявленный, но неиспользуемый `NOTIFICATION_THROTTLE_MS` либо применить его.

---

# 20. Итоговая краткая сводка

Сейчас проект — production-oriented Telegram music download service с тремя основными источниками, MP3 pipeline, Telegram media cache, тарифами/Stars, поддержкой, безопасными рассылками и развитой admin analytics. Критические компоненты: Telegram Bot API, PostgreSQL schema/RPC, download manager + yt-dlp/FFmpeg, Telegram storage channel и startup preflight. Redis полезен для cache и hybrid worker, но основной bot способен частично работать без обычного Redis.

Хорошо реализованы:

1. многоуровневая безопасность broadcast preview/launch/cancel/kill switch и recipient snapshot;
2. schema contract version 12 и SQL smoke/self-test, включая transaction rollback;
3. аналитические timeline/retention/source semantics с валидацией, пагинацией и индексами;
4. idempotent Stars processing и отдельный manual-payment RPC guard;
5. повторное использование Telegram file IDs вместо постоянного локального диска.

Три главных риска:

1. расхождение и неатомарность тарифных/лимитных проверок, особенно Unlimited;
2. неполный migration/deployment path относительно strict schema version 12;
3. недолговечность local/Redis download queues и отсутствие настоящей cancellation/ACK.

Три логичных следующих шага:

1. исправить единый entitlement/atomic quota contract и referral Unlimited regression с интеграционными тестами;
2. сделать один детерминированный migration/release runner, включающий все PostgreSQL integrations и readiness;
3. укрепить download execution: точная URL validation, cancelable child processes и durable broker protocol.

Этот документ фиксирует состояние кода на указанном commit. Изменения в незакоммиченных EJS-файлах, production ENV/settings, внешних API и managed infrastructure после 17.07.2026 могут изменить выводы.
