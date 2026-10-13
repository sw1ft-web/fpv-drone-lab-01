# FPV Drone — multiplayer JavaScript game

[![CI](https://github.com/sw1ft-web/fpv-drone-lab-01/actions/workflows/ci.yml/badge.svg)](https://github.com/sw1ft-web/fpv-drone-lab-01/actions/workflows/ci.yml)

Навчальний проєкт курсу «JavaScript — Build a Multiplayer Game»: космічний (FPV) дог-файт, який росте від локального game loop (Lab 01) до гри з авторитетним сервером, TypeScript, тестами і деплоєм.

## Структура репозиторію

```text
client/    Vite-застосунок (canvas, asset loader, lobby, чат)      — Lab 01–03, 04
server/    Node.js: HTTP, WebSocket, rooms, match logs             — Lab 04
shared/    симуляція, протокол (zod), кодеки — код обох сторін      — Lab 05–06
docs/      звіти по лабораторних, графіки, логи експериментів
e2e/       Playwright: два браузери проти реального сервера
scripts/   dev-скрипт, headless-стенд мережі, SVG-графіки
```

Весь код — TypeScript під `strict` (Lab 06). Node 22 запускає `.ts` без збірки; Vite збирає клієнт; типи перевіряє `npm run typecheck`.

## Запуск

Потрібен Node.js 22 (`.nvmrc`).

```bash
npm install
cp server/.env.example server/.env   # необов'язково
npm run dev                          # server :3000 + Vite :5173 (proxy /api і /ws)
```

Відкрити `http://localhost:5173`, натиснути **Start loading**, обрати кімнату (або створити свою) і **Join**.

Production-режим (сервер сам віддає зібраний клієнт):

```bash
npm run build && npm start           # http://localhost:3000
```

Перевірки перед здачею:

```bash
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
```

Те саме виконує CI (`.github/workflows/ci.yml`).

## Звіти по лабораторних

| Lab | Тема                                                                   | Звіт                                           |
| --- | ---------------------------------------------------------------------- | ---------------------------------------------- |
| 03  | Promises, async/await, loading screen, lobby                           | [docs/lab-03/README.md](docs/lab-03/README.md) |
| 04  | Node.js, streams, WebSockets, rooms                                    | [docs/lab-04.md](docs/lab-04.md)               |
| 05  | Authoritative server, prediction, interpolation, binary protocol       | [docs/lab-05.md](docs/lab-05.md)               |
| 06  | TypeScript: strict, zod-протокол, типізовані події, branded types      | [docs/lab-06.md](docs/lab-06.md)               |
| 07  | Тести, V8/GC, профілювання, боти, навантаження (ємність ≈ 768 гравців) | [docs/lab-07.md](docs/lab-07.md)               |
| 08  | Production: логи, метрики, health/ready, захист WS, Docker, PWA, chaos | [docs/lab-08.md](docs/lab-08.md)               |

## Production

```bash
docker compose up --build            # http://localhost:3000 (образ не збирався в середовищі авторства — див. docs/lab-08.md)
```

- `GET /health` — liveness (версія, sha, uptime); `GET /ready` — readiness (503 під час shutdown); `GET /metrics` — Prometheus (опційно `METRICS_TOKEN`).
- Змінні середовища — `server/.env.example`.
- Деплой: тег `v*` запускає `.github/workflows/deploy.yml` (GHCR + опційно Fly.io, **не перевірено**).

## Обмеження (чесно)

- Ємність виміряна на 2 спільних CPU: ≈ 768 гравців у межах бюджету тіку 33 мс; без реальної мережі.
- Немає публічного URL, моніторингу аптайму, відео-демо, перевірки PWA на телефоні та Docker-збірки — див. `docs/lab-08.md`.
