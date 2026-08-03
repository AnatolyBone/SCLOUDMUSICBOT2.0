# База данных и миграции

## Основные сущности

- `users` — Telegram-профиль, `tariff_code`, срок подписки, legacy-поле `premium_limit`, индивидуальный `daily_limit_override`;
- `app_settings` — глобальные лимиты и прочие runtime-настройки;
- `payments`, `subscription_activation_log` — оплаты и результат активации;
- `analytics_events` — первичная история продуктовых, платежных и рекламных событий;
- `analytics_daily_metrics` — дневные агрегаты аналитики;
- `ad_campaigns`, `ad_campaign_user_state`, `ad_user_category_state`, `ad_campaign_audit_log` — реклама;
- таблицы support, broadcasts, bot texts, broken tracks и пользовательской активности обслуживают соответствующие модули админки.

Связи рекламного состояния: составной первичный ключ `(campaign_id, user_id)`, внешний ключ кампании на `ad_campaigns.id`, пользователя — на `users.id`. События сохраняются после архивирования и мягкого удаления кампании.

## Порядок миграций

Применять вручную в указанном порядке:

1. `001_yandex_promo_progress.sql`
2. `002_yandex_music_promo.sql`
3. `003_support_system.sql`
4. `004_music_bot_karaoke_feedback_mode.sql`
5. `005_karaoke_testers_in_karaoke_db.sql`
6. `006_analytics_system.sql`
7. `007_multilang_system.sql`
8. `008_analytics_preflight_fixes.sql`
9. `009_schema_contract_reconciliation.sql`
10. `010_broadcast_launch_safety.sql`
11. `011_user_activity_bigint.sql`
12. `012_user_insights_indexes.sql`
13. `013_admin_audit_fixes_precheck.sql`, затем `013_admin_audit_fixes.sql`, затем `013_admin_audit_fixes_verify.sql`
14. `014_yandex_partner_campaigns_precheck.sql`, затем `014_yandex_partner_campaigns.sql`, затем `014_yandex_partner_campaigns_verify.sql`

Для отката предусмотрены `013_admin_audit_fixes_rollback.sql` и `014_yandex_partner_campaigns_rollback.sql`. Откат 014 возвращает совместимое имя таблицы и намеренно сохраняет события, состояния, audit log и Storage-объекты.

## Реклама и индексы

Миграция 014 создаёт/расширяет конфигурацию кампаний, пользовательское и категорийное состояние, audit log, RPC записи и статистики. Индексы покрывают `analytics_events.event_name`, `user_id`, `created_at`, а также JSON-поля `campaign_id` и `promo_key`.

Bucket `ad-campaign-media` приватный, имеет лимит 20 МБ и allowlist MIME. Доступ выполняется сервером с ключом Supabase; service-role ключ запрещено передавать браузеру.

## Настройки лимитов

Авторитетные ключи: `daily_limit_free`, `daily_limit_plus`, `daily_limit_pro`, `daily_limit_unlimited`. Для старой схемы читается алиас `daily_limit_unlim`. Изменение настройки не требует переписывать пользователей: эффективный лимит берётся при каждом расчёте. Число в `premium_limit` — legacy-совместимость, не индивидуальное исключение.

## Backup и проверка

Перед изменением production создайте проверяемый backup средствами Supabase/PostgreSQL. Сначала выполните read-only precheck, сохраните вывод, примените миграцию, затем verify. Не запускайте rollback без анализа: он меняет схему и должен соответствовать фактически применённым изменениям.
