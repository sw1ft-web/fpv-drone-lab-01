# Lab 08 — Production: спостережуваність, безпека, пакування, PWA

## Що зроблено

| Область           | Реалізація                                                                                                                                                                                                                         | Перевірка                                      |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Логи              | `server/src/logger.ts` на **pino**: JSON, рівні (`LOG_LEVEL`), редакція секретів, `service`, ISO-час. Події `ws.rejected`, `player.joined`, `room.created`                                                                         | `server/test`                                  |
| Метрики           | `server/src/metrics.ts` (prom-client), `GET /metrics`: гравці/кімнати/матчі, p50/p99 тіку, затримка тіку, event-loop utilization, трафік, `fpv_rejected_total{reason}`, `fpv_build_info`; опційний `METRICS_TOKEN` (Bearer)        | `server/test/ops.test.ts`                      |
| Health            | `/health` (liveness + версія + sha), `/ready` (200 / 503 `shutting_down`)                                                                                                                                                          | `ops.test.ts`                                  |
| Захист WS         | перевірка `Origin` (403), ліміт з'єднань на IP (429, `MAX_CONNECTIONS_PER_IP`), `TRUST_PROXY` для `X-Forwarded-For`; без Origin дозволено (не-браузерні клієнти); порожній `ALLOWED_ORIGINS` = лише same-origin                    | `ops.test.ts`                                  |
| Graceful shutdown | повідомлення `shutdown` клієнтам → close 1001 → `/ready` = 503; клієнт показує рядок у чаті й перепідключається                                                                                                                    | `shutdown.test.ts`                             |
| Chaos             | `scripts/test/chaos.test.ts`: (1) жорстко обірвані клієнти не шкодять сусідній кімнаті; (2) рестарт сервера → клієнт сам перепідключається; (3) флуд сміттєвими кадрами з 12 атакуючих відсікається, жертва в іншій кімнаті працює | `npx vitest run --project netcode chaos` — 3/3 |
| Пакування         | `Dockerfile` (multi-stage, користувач `node`, exec-form CMD, HEALTHCHECK, `GIT_SHA`), `.dockerignore`, `docker-compose.yml`                                                                                                        | див. нижче                                     |
| Деплой            | `.github/workflows/deploy.yml` (тег `v*` → GHCR → опційно Fly), `fly.toml`                                                                                                                                                         | **не запускалось**                             |
| PWA               | `manifest.webmanifest`, іконки 192/512/maskable, `sw.js` (network-first для статики; `/api`, `/ws`, `/health`, `/ready`, `/metrics` не кешуються), реєстрація лише в production-збірці                                             | лише збірка й роздача файлів                   |

Версія проєкту піднята до `1.0.0` (тег `v1.0.0` ставить власник після merge).

## Що перевірено фактично

- Усі unit/integration-тести сервера (70), chaos-тести (3), typecheck, lint, prettier.
- «Імітація Docker»: окрема тека з `npm ci --omit=dev`, запуск `node server/src/index.ts` з `NODE_ENV=production`: `/health` віддає `sha`, `/ready` = `ready`, `/metrics` містить `fpv_build_info{version="1.0.0",sha="abc123"}`, `manifest.webmanifest` і `sw.js` віддаються. Це підтверджує склад production-залежностей, але **не** сам образ.
- Chaos 3: під флудом жертва не мала розриву снапшотів понад 8 номінальних інтервалів (сервер і атакуючі в тесті ділять один event loop, тому межа м'якша, ніж у реальній мережі).

## Чого зробити не вдалося (чесно)

Середовище — хмарний контейнер без GUI-браузера, Docker-демона, облікових даних та зовнішніх гравців.

- Docker-образ **не збирався** і не запускався (демон недоступний): розмір образу, HEALTHCHECK у контейнері, `docker compose up` не перевірені.
- Публічний URL, деплой на Fly/GHCR, `deploy.yml` — не виконувались.
- Гра двох віддалених гравців через інтернет, моніторинг аптайму, відео-демо, публікація на itch.io — не робились.
- Встановлення PWA на телефон і офлайн-режим у реальному браузері не перевірялись (Lighthouse не запускався).
- Метрики не підключені до Prometheus/Grafana — перевірено лише формат виводу.

## Відомі обмеження

- Ємність ≈ 768 гравців виміряна на 2 спільних CPU у локальному loopback (див. Lab 07).
- Per-IP ліміт за NAT може відсікати легітимних гравців; налаштовується `MAX_CONNECTIONS_PER_IP`.
- `sw.js` кешує за стратегією network-first: офлайн відкривається лише оболонка, гра без сервера не працює.
