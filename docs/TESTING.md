# Тестирование

## Основной набор

```bash
npm ci
npm test
```

Runner `scripts/run-tests.js` выполняет файлы из `test/`. Набор покрывает дневные лимиты и подписки, платежи Stars, аналитику потерь, Dashboard, кампании, временные триггеры, медиа, lifecycle, поддержку административных контрактов, рассылки, отчёты и безопасность логов.

## Дополнительные проверки

```bash
node --check index.js
node --check bot.js
npm run check:schema
npm run smoke:analytics
npm run test:broadcast:integration
npm run test:payments:integration
npm run test:insights:integration
npm run release:check
```

Интеграционные команды требуют соответствующих переменных окружения и тестовой инфраструктуры. Не запускайте их против production без отдельного разрешения.

## Границы автоматизации

Часть тестов статически проверяет контракты исходного кода и SQL, а не выполняет реальные запросы к Telegram, Supabase Storage или production Redis. Поэтому перед выпуском обязательны schema preflight/verify и ручные сценарии из [DEPLOYMENT.md](DEPLOYMENT.md). Особое внимание: атомарность RPC рекламы, ошибки Storage, реальная MIME-проверка, межэкземплярный Pub/Sub и Telegram callback.

Последний полный локальный запуск 2026-08-03: **131 тест, 131 успешно, 0 ошибок**. Это снимок текущей версии; после изменения кода результат нужно подтверждать заново.
