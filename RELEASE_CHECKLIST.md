# Release checklist

## До изменения базы

- [ ] Проверен diff и отсутствуют `.env`, секреты, логи и артефакты.
- [ ] Создан и проверен backup Supabase.
- [ ] Выполнен `013_admin_audit_fixes_precheck.sql`.
- [ ] Результат precheck изучен до применения схемы.

## Миграции

- [ ] Применён `013_admin_audit_fixes.sql`.
- [ ] Успешен `013_admin_audit_fixes_verify.sql`.
- [ ] Выполнен precheck 014, просмотрен результат, применён основной SQL и успешен verify 014.
- [ ] Подтверждены RPC рекламы, индексы и приватный bucket `ad-campaign-media`.

## Проверки приложения

- [ ] `npm ci`
- [ ] `npm test`
- [ ] `node --check index.js`
- [ ] `node --check bot.js`
- [ ] `npm run check:schema`
- [ ] Проверены лимиты, Stars, реклама, медиа, callback, Dashboard, поддержка и Pub/Sub на двух экземплярах.

## Выпуск

- [ ] Переменные Render сверены без вывода значений в логи.
- [ ] Deploy выполнен только после успешных проверок.
- [ ] Пройдены ручные сценарии из [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).
- [ ] Подготовлен откат приложения и проверен сценарий `014_yandex_partner_campaigns_rollback.sql`.
