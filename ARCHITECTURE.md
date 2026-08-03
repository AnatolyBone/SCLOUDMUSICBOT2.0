# Архитектура

SCloudMusicBot — Node.js-монолит: Telegram-бот и Express/EJS-админка работают с общей доменной логикой в `services/`. PostgreSQL/Supabase хранит авторитетные данные, Redis обеспечивает координацию экземпляров, Telegram и приватный Supabase Storage обслуживают файлы.

```text
Telegram ──> bot.js ──> services ──> PostgreSQL/Supabase
                    ├──────────────> Redis
Admin HTTP ─> index.js ─> services ─> private Storage
                              └────> optional HF worker
```

Ключевые правила:

- эффективный дневной лимит считается централизованно из override, тарифа и текущей настройки;
- платежи подтверждаются SQL/RPC, а аналитика не заменяет таблицу `payments`;
- рекламное событие показа создаётся только после успешной отправки Telegram;
- статистика кампаний строится из `analytics_events`, состояние используется для eligibility;
- все административные маршруты медиа и поддержки закрыты `requireAuth`.

Полное описание находится в [docs/TECHNICAL_PASSPORT.md](docs/TECHNICAL_PASSPORT.md), схема данных — в [docs/DATABASE.md](docs/DATABASE.md), реклама — в [docs/AD_CAMPAIGNS.md](docs/AD_CAMPAIGNS.md).
