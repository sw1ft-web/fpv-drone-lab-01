# FPV Drone — multiplayer JavaScript game

Навчальний проєкт курсу «JavaScript — Build a Multiplayer Game»: космічний (FPV) дог-файт, який росте від локального game loop (Lab 01) до гри з авторитетним сервером, TypeScript, тестами і деплоєм.

## Структура репозиторію

```text
client/    Vite-застосунок (canvas, asset loader, lobby, чат)      — Lab 01–03, 04
server/    Node.js: HTTP, WebSocket, rooms, match logs             — Lab 04
docs/      звіти по лабораторних, графіки, логи експериментів
scripts/   dev-скрипт і генератор SVG-графіків для вимірювань
```

(`shared/` з'являється в Lab 05, див. відповідні звіти.)

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
npm run lint
npm run format:check
npm test
npm run build
```

## Звіти по лабораторних

| Lab | Тема                                         | Звіт                                           |
| --- | -------------------------------------------- | ---------------------------------------------- |
| 03  | Promises, async/await, loading screen, lobby | [docs/lab-03/README.md](docs/lab-03/README.md) |
| 04  | Node.js, streams, WebSockets, rooms          | [docs/lab-04.md](docs/lab-04.md)               |
