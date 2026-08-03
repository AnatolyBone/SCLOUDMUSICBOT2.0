# Технический паспорт SCloudMusicBot

## Назначение

Монолитное Node.js-приложение объединяет Telegram-бота и административный HTTP-интерфейс. Основные данные хранятся в PostgreSQL/Supabase; Telegram и Storage обслуживают файлы; Redis координирует настройки, сессии и опциональный удалённый worker.

## Компоненты

- `bot.js`: команды, загрузки, меню, поддержка, тарифы, Stars и рекламные callback;
- `index.js`: bootstrap, webhook/HTTP, админка, Dashboard, настройки и lifecycle рекламы;
- `services/downloadLimitService.js` и `downloadLimitCore.js`: единый лимит;
- `services/subscriptionService.js`: идемпотентная активация и сброс кэша;
- `services/analyticsService.js`: события, сессии и дедупликация;
- `services/promoCampaignService.js`, `promoSessionService.js`, `adCampaignMediaService.js`: реклама;
- `services/taskBroker.js`: очередь Render ↔ внешний worker;
- `migrations/`: контракт production-схемы.

## Тарифы и лимиты

Активный тариф определяется по действующему `tariff_code`. Для старых строк без него допускается классификация по legacy-признакам (`premium_until` и `premium_limit`), но число `premium_limit` не становится эффективным лимитом. Приоритет расчёта: override → тариф → актуальный `app_settings` → fallback.

Активация подписки продолжает заполнять `premium_limit` для совместимости старого кода и отчётов. Это поле нельзя массово переносить в `daily_limit_override`: старые значения обычно являются снимком глобальной настройки, а не индивидуальным исключением.

## Платежи и аналитика

Telegram Stars проходят этапы показа платежной опции, выбора тарифа, invoice, pre-checkout и authoritative payment RPC. `payments` остаётся источником истины по оплате; `analytics_events` описывает воронку. События активации/продления создаются внутри SQL-операции платежа.

Рекламные события записываются RPC вместе с обновлением состояния. Полная модель приведена в [AD_CAMPAIGNS.md](AD_CAMPAIGNS.md).

## Redis

- `settings:version` — версия настроек;
- канал `settings:invalidate` — немедленная инвалидация между экземплярами; дополнительно настройки обновляются polling каждые 15 секунд;
- `session:<userId>` — аналитическая сессия, TTL 1800 секунд;
- `promo-session-shown:<userId>:<sessionId>` — одна реклама на сессию, TTL 1800 секунд;
- `user:<telegram_id>:subscription` — legacy-ключ кэша, который удаляется после активации;
- `music:download:queue`, канал `music:download:results`, `music:worker:heartbeat` — отдельный task broker через `TASK_BROKER_REDIS_URL`.

Без Redis приложение сохраняет базовую работоспособность, но теряет мгновенную межэкземплярную инвалидацию и строгую общую блокировку рекламы в сессии.

## База и Storage

Схема, связи, индексы, миграции и backup описаны в [DATABASE.md](DATABASE.md). Рекламное медиа хранится только по приватному storage path. Service-role доступ остаётся на сервере.

## Администрирование и эксплуатация

Все рабочие страницы и API закрываются `requireAuth`. Подробности: [ADMIN_PANEL.md](ADMIN_PANEL.md), [DEPLOYMENT.md](DEPLOYMENT.md), [TESTING.md](TESTING.md).

## Известные ограничения и риски

- precheck 014 нельзя считать проверкой production, пока его фактический вывод из Supabase не просмотрен оператором;
- `manual` зарезервирован схемой, но отключён в интерфейсе и отклоняется сервером до реализации API ручной отправки;
- fallback без Redis локален экземпляру;
- PostgreSQL и Supabase Storage не имеют общей транзакции, используется компенсационная очистка;
- часть автоматических тестов проверяет статические контракты, поэтому необходимы тестовая БД и ручные production-сценарии;
- legacy-счётчики рекламы не имеют полной детализации по пользователям и показываются отдельно от новых событий.
