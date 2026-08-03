# Структура проекта

```text
SCLOUDMUSICBOT2.0-main/
├── bot.js, index.js, config.js, db.js
├── services/          доменные сервисы
├── routes/            модульные административные маршруты
├── views/             EJS-интерфейс
├── public/            CSS и клиентский JavaScript
├── config/            тарифы, языки и тексты
├── locales/           локализация
├── migrations/        SQL 001–014
├── test/              автоматический набор
├── integration/       интеграционные сценарии
├── scripts/           проверки и эксплуатационные утилиты
├── hf-worker/         опциональный удалённый worker
└── docs/              актуальная техническая документация
```

Главные рекламные модули: `services/promoCampaignService.js`, `promoSessionService.js`, `adCampaignMediaService.js`, `views/promo-campaigns.ejs`, миграция `014_yandex_partner_campaigns.sql`.

Главные модули лимитов и подписок: `services/downloadLimitCore.js`, `downloadLimitService.js`, `subscriptionService.js`.

Навигация по документации начинается с [README.md](README.md) и [docs/TECHNICAL_PASSPORT.md](docs/TECHNICAL_PASSPORT.md).
