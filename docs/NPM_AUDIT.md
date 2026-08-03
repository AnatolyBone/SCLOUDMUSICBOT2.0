# npm audit — 2026-08-03

Проверка выполнена после `npm ci`, без `--force`. npm сообщает 8 уязвимых пакетов: 1 low, 3 moderate, 4 high, 0 critical.

| Пакет | Уровень | Production-риск | Безопасное действие |
|---|---:|---|---|
| `body-parser` 1.20.5 | low | DoS при некорректном лимите; приложение задаёт обычные числовые лимиты, поэтому риск снижен | lock-only до 1.20.6 |
| `brace-expansion` 2.1.1 | high | CPU/OOM DoS при управляемом атакующим glob; публичного ввода в пакет не найдено | lock-only до 2.1.4 |
| `js-yaml` 4.2.0 | high | CPU DoS на вредоносном YAML; публичной загрузки YAML нет | lock-only до 4.3.1 |
| `file-type` 19.x | moderate | бесконечный цикл ASF-парсера; медиа администратора проходит распознавание, риск реальный, но требует авторизации | на Node 20 обновить минимум до 21.3.1 и повторить media-тесты |
| `uuid` <11.1.1 | moderate | bounds-check v3/v5/v6 с buffer; напрямую не используется | обновить через `node-cron` после теста совместимости |
| `node-cron` 3.0.3 | moderate | наследует уязвимый `uuid`; используется worker-менеджером | отдельное обновление до 4.6.0 на Node 20 |
| `axios` ≤0.32 | high | SSRF, credential leak, prototype pollution и DoS; вложен в production-загрузчик SoundCloud | исправления нет: заменить зависимость или проверить безопасный fork |
| `soundcloud-downloader` | high | наследует уязвимый Axios и не предлагает исправления | заменить; до этого не передавать credentials, ограничить исходящие адреса и таймауты |

## Безопасная последовательность

1. Обычный `npm audit fix`: dry-run предлагает только `body-parser 1.20.6`, `brace-expansion 2.1.4`, `js-yaml 4.3.1`.
2. Закрепить Node.js 20 в `package.json` и Render; Docker уже использует Node 20.
3. Обновить `file-type` до 21.3.1 и проверить JPG/PNG/WEBP/GIF/MP4, SVG/HTML и malformed input.
4. Обновить `node-cron` до 4.6.0 и проверить worker lifecycle.
5. Удалить или заменить `soundcloud-downloader`; проверить SoundCloud URL, плейлисты, proxy и сетевые ошибки.
6. После каждого этапа запускать `npm ci`, `npm test`, `npm audit --omit=dev` и ручной smoke test.

`npm audit fix --force` не запускался и не рекомендуется без отдельного разрешения и анализа breaking changes.
