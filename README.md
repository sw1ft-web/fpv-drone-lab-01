# Lab 03 — Asynchronous JavaScript: Promises, async/await and Loading Screen

Це **продовження того самого FPV Drone проєкту з Lab 01–02**. Синхронний fixed-step game loop, `World`, `Ship`, `Bullet`, `Asteroid`, `Pickup`, collision system і respawn з Lab 02 збережені. У Lab 03 поверх них додані асинхронне завантаження ресурсів, Web Audio, event bus і HTTP lobby.

## Що реалізовано

- `manifest.json` для sprites / audio / arena JSON;
- `fetchJson()` з обов'язковою перевіркою `response.ok`;
- `loadImage`, `loadAudio`, `loadJson`, кожен підтримує `AbortSignal`;
- `withRetry()` з exponential backoff + jitter;
- **4xx не повторюються**, network/5xx/decode errors можуть повторюватися;
- `loadAll()` запускає всі ресурси через `Promise.all` паралельно;
- canvas loading screen показує реальний progress по завершених файлах;
- гра не запускається до завершення `await loadAll(...)`;
- корабель, кулі та астероїди малюються зі sprite sheets;
- аудіо працює через Web Audio API, `AudioContext` створюється після кліку користувача, а WAV буфери декодуються ще під час loading screen;
- `World extends EventTarget` і відправляє `CustomEvent`: `fired`, `hit`, `exploded`, `scoreChanged`;
- simulation **не імпортує** `audio.js` або `hud.js`;
- `Lobby extends EventTarget`, а DOM rendering винесений в окремий `src/lobby/view.js`;
- lobby робить `GET /api/rooms`, оновлює список по interval, має timeout на кожен request і abort при виході;
- є failure gallery: 404 sprite, timeout, manual abort, broken JSON;
- є browser benchmark helper для sequential vs concurrent loading.

## Запуск

Потрібен Node.js 22.

```bash
npm install
npm run dev
```

Потім відкрити URL, який покаже Vite, зазвичай:

```text
http://localhost:5173
```

Перевірка перед здачею:

```bash
npm run lint
npm run format:check
npm run build
```

## Демонстрація на захисті

1. Відкрити сторінку.
2. Натиснути **Start loading** — цей gesture створює / resume-ить `AudioContext`.
3. Показати canvas progress bar і паралельне завантаження assets.
4. Після loading screen відкриється Lobby.
5. Обрати ім'я, кімнату і натиснути **Join & start local game**.
6. Натиснути `F`: у грі з'являється bullet, `World` dispatch-ить `fired`, а audio module відтворює звук.
7. Влучити в asteroid: `hit` + `exploded`, HUD і audio реагують через events.
8. До Join можна відкрити **Failure gallery / test recovery** і показати 4 failure cases.

## Керування

- `W` / `ArrowUp` — thrust
- `A` / `ArrowLeft` — rotate left
- `D` / `ArrowRight` — rotate right
- `F` — fire
- `Space` — brake / fire action з попередньої лабораторної

---

# Структура Lab 03

```text
public/
  api/
    rooms
    rooms.json
    bad-json
  assets/
    manifest.json
    sprites/
      ship-sheet.png
      bullet-sheet.png
      asteroid-sheet.png
    audio/
      shoot.wav
      hit.wav
      explosion.wav
    data/
      arena-neon.json
      arena-training.json

src/
  assets/
    http.js
    loader.js
  audio/
    audio.js
  lobby/
    lobby.js
    view.js
  debug/
    failures.js
  render/
    canvas.js
    draw.js
    loading.js
  sim/
    ...Lab 02 entities...
  hud.js
  input.js
  loop.js
  main.js
  style.css

vite.config.js
```

---

# M1 — Asset pipeline

## Manifest

`public/assets/manifest.json` описує всі ресурси, які треба завантажити до старту гри.

Кожний sprite має frame metadata, наприклад:

```json
{
  "id": "ship",
  "url": "/assets/sprites/ship-sheet.png?labDelay=110",
  "frameWidth": 64,
  "frameHeight": 64,
  "frames": 4
}
```

`labDelay` використовується Vite middleware лише для лабораторної демонстрації, щоб progress bar і різницю між sequential/concurrent було видно. На звичайному static hosting query не блокує завантаження файлу.

## fetchJson перевіряє ok

У `src/assets/http.js`:

```js
export async function fetchJson(url, { signal } = {}) {
  const response = throwIfNotOk(await fetch(url, { signal }));
  return response.json();
}
```

Це важливо, тому що `fetch()` **не reject-иться на 404**. HTTP 404 — це fulfilled Promise з `response.ok === false`, тому перевірку треба робити вручну.

## AbortSignal

`loadImage`, `loadAudio`, `loadJson` отримують `signal`. Для image спочатку виконується cancellable `fetch(...).blob()`, потім blob декодується через `Image`. Abort також скасовує незавершене image decode.

## Retry: exponential backoff + jitter

`withRetry()`:

```text
attempt 1 -> base delay + jitter
attempt 2 -> base * 2 + jitter
attempt 3 -> final attempt
```

Якщо error — `HttpError` зі status `400..499`, retry **не виконується**.

Причина: 404/403/400 — це зазвичай постійна помилка request, а не тимчасова проблема мережі.

## Promise.all і progress

`loadAll()` створює Promise для кожного asset одразу, а потім:

```js
await Promise.all(tasks);
```

Кожен task після успішного завершення збільшує `completed` і викликає `onProgress(...)`, тому canvas отримує реальний прогрес по файлах.

---

# Sequential await vs concurrent Promise.all

Для контрольованого експерименту ресурси мають різні dev-delay. Ті самі 8 HTTP assets були завантажені двома способами.

| Варіант | Час контрольного HTTP-заміру |
|---|---:|
| sequential `for (...) await load()` | ~1944 ms |
| concurrent `await Promise.all(...)` | ~347 ms |
| прискорення | ~5.6× |

Причина: sequential version чекає завершення A перед стартом B. Concurrent version запускає всі незалежні requests одразу, тому загальний час ближчий до найдовшого окремого request, а не до суми всіх затримок.

У браузері після завантаження гри можна повторити benchmark зі справжніми browser loaders:

```js
await window.lab03.benchmark();
```

Результат виводиться через `console.table`. Числа можуть трохи відрізнятися через cache, CPU та browser decoding.

---

# M2 — Sprite sheets, Web Audio і EventTarget

## Sprite sheets

Замість primitive-only rendering:

- `ship-sheet.png` — 4 frames;
- `bullet-sheet.png` — 2 frames;
- `asteroid-sheet.png` — 4 frames.

`drawImage` використовує source rectangle:

```js
ctx.drawImage(
  sprite.image,
  sx,
  0,
  frameWidth,
  frameHeight,
  -size / 2,
  -size / 2,
  size,
  size,
);
```

## Web Audio

`src/audio/audio.js` володіє `AudioContext`.

Контекст не створюється до user gesture. Кнопка **Start loading** викликає:

```js
await audio.unlock();
```

Після цього `loadAudio()` робить:

```text
fetch -> arrayBuffer -> decodeAudioData
```

Тобто expensive decode відбувається під час loading screen, а не під час першого пострілу.

## EventTarget bus

`World extends EventTarget`.

При пострілі:

```js
world.emit("fired", { shipId, bulletId });
```

При collision:

```js
world.emit("hit", ...);
world.emit("exploded", ...);
```

`audio.js` і `hud.js` підписуються на ці events зовні.

Таким чином:

```text
simulation -> CustomEvent -> audio/HUD
```

а не:

```text
simulation -> import audio.js
```

Це decoupling: simulation не знає, хто слухає її events.

---

# M3 — Lobby over HTTP

`class Lobby extends EventTarget` знаходиться у `src/lobby/lobby.js`.

Методи:

- `show()`;
- `refresh()`;
- `join(roomId, playerName)`;
- `leave()`.

DOM знаходиться окремо в `src/lobby/view.js`.

## GET /api/rooms

Vite віддає static JSON з:

```text
public/api/rooms
```

Room має `arenaId`, наприклад:

```json
{
  "id": "kyiv-alpha",
  "name": "Kyiv Alpha",
  "players": 2,
  "maxPlayers": 6,
  "arenaId": "arena-neon"
}
```

Після Join локальна гра стартує з arena config, який уже був async-loaded через manifest.

## Timeout на кожен request

Кожний refresh створює:

```js
const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
```

і об'єднує його з lobby session signal.

## Abort on leave

Коли гравець натискає Join:

```js
lobby.leave();
```

`leave()`:

- зупиняє `setInterval`;
- abort-ить lobby `AbortController`;
- незавершений fetch більше не залишається orphaned.

---

# M4 — Five microtask/task ordering puzzles

## Puzzle 1 — await continuation

```js
console.log("A");

(async () => {
  console.log("B");
  await 0;
  console.log("C");
})();

Promise.resolve().then(() => console.log("D"));
console.log("E");
```

Output:

```text
A
B
E
C
D
```

Пояснення: код до `await` синхронний; continuation після `await` стає microtask і була поставлена в queue раніше за `.then(...D)`.

## Puzzle 2 — setTimeout inside .then

```js
console.log(1);

Promise.resolve()
  .then(() => {
    console.log(2);
    setTimeout(() => console.log(4), 0);
  })
  .then(() => console.log(3));

setTimeout(() => console.log(5), 0);
```

Output:

```text
1
2
3
5
4
```

Пояснення: promise reactions `2` і `3` — microtasks. Timer `5` був зареєстрований ще у початковій task, а timer `4` — пізніше всередині microtask.

## Puzzle 3 — requestAnimationFrame

```js
requestAnimationFrame(() => {
  console.log("rAF");
  Promise.resolve().then(() => console.log("micro-in-rAF"));
});

Promise.resolve().then(() => console.log("micro"));
console.log("sync");
```

Output:

```text
sync
micro
rAF
micro-in-rAF
```

Пояснення: поточна task закінчується, потім очищається microtask queue, далі перед наступним repaint виконується `requestAnimationFrame`; microtask, створена всередині rAF, виконується після callback.

## Puzzle 4 — rejection propagation

```js
Promise.resolve()
  .then(() => {
    console.log("A");
    throw new Error("boom");
  })
  .then(() => console.log("B"))
  .catch(() => console.log("C"))
  .then(() => console.log("D"));

console.log("E");
```

Output:

```text
E
A
C
D
```

Пояснення: thrown error перетворюється на rejected Promise, `B` пропускається, `catch` обробляє rejection і повертає chain у fulfilled state.

## Puzzle 5 — queueMicrotask + await + timer

```js
setTimeout(() => console.log("T"), 0);
queueMicrotask(() => console.log("M1"));

(async () => {
  console.log("S");
  await Promise.resolve();
  console.log("A");
  queueMicrotask(() => console.log("M2"));
})();

Promise.resolve().then(() => console.log("P"));
console.log("E");
```

Output:

```text
S
E
M1
A
P
M2
T
```

Пояснення: sync спочатку; потім microtasks у FIFO-порядку; `M2` додається в кінець queue під час виконання await-continuation; timer task `T` іде після всіх microtasks.

---

# Failure gallery

У Lobby є інтерактивний `<details>` **Failure gallery / test recovery**.

## 1. 404 sprite

Test:

```text
/assets/sprites/does-not-exist.png
```

Expected log:

```text
404: HttpError: HTTP 404 Not Found
Recovered: app is still responsive; retry/start remains available.
```

4xx не retry-иться.

Лог: `docs/failure-gallery/404-sprite.txt`.

## 2. Network timeout

Test endpoint:

```text
/api/slow?delay=2500
```

але request має:

```js
AbortSignal.timeout(250)
```

Expected:

```text
TimeoutError
```

Лог: `docs/failure-gallery/network-timeout.txt`.

## 3. Abort mid-request

Створюється `AbortController`, запускається slow request і через ~120 ms виконується manual `abort()`.

Expected:

```text
AbortError: Manual abort
```

Лог: `docs/failure-gallery/abort-mid-request.txt`.

## 4. Broken JSON

Endpoint:

```text
/api/bad-json
```

повертає навмисно invalid JSON. `response.ok` успішний, але `response.json()` reject-иться `SyntaxError`.

UI ловить error, показує повідомлення і не допускає unhandled rejection.

Лог: `docs/failure-gallery/broken-json.txt`.

---

# Promise combinators — де вони підходять у цій грі

- `Promise.all` — critical asset bundle: усі потрібні sprites/audio/arena до переходу в lobby.
- `Promise.allSettled` — optional decorative sounds/skins, де один missing asset не повинен блокувати гру.
- `Promise.race` — можна реалізувати legacy timeout, змагаючи fetch проти timeout promise; у Lab 03 використано більш правильний `AbortSignal.timeout`.
- `Promise.any` — перше успішне джерело asset з кількох mirror/CDN URL.

Якщо `Promise.all` reject-иться, інші Promises автоматично **не скасовуються**. Для cancellation потрібен окремий `AbortController`.

---

# Reflection — короткі відповіді для захисту

## 1. Які три стани Promise?

`pending -> fulfilled` або `pending -> rejected`. Перехід відбувається максимум один раз. `.then` навіть для вже fulfilled Promise виконується асинхронно як **microtask**.

## 2. Що насправді робить await?

`await` не блокує main thread. Async function повертає control event loop, а код після `await` продовжується як microtask після settlement Promise.

Приблизний еквівалент:

```js
async function f() {
  const a = await g();
  return a + 1;
}
```

це концептуально:

```js
function f() {
  return Promise.resolve(g()).then((a) => a + 1);
}
```

## 3. Чому fetch не reject на 404?

Бо HTTP error — це успішно отримана HTTP response. `fetch` reject-иться на network/cancellation errors. Тому треба перевіряти `response.ok` або `response.status`.

## 4. Promise чи Event?

Promise — значення/результат, який приходить один раз: завантаження asset.

Event — подія, яка може повторюватися багато разів: `fired`, `hit`, `exploded`, lobby updates.

## 5. Як AbortController скасовує роботу?

Promise сам не має `cancel()`. `AbortController` змінює `signal` у aborted state, а API, які отримали цей signal, повинні зупинити свою роботу і reject-нутися `AbortError`/`TimeoutError`.

---

# Debug helpers

Після успішного asset loading доступно:

```js
await window.lab03.benchmark();
```

Також можна вручну перевірити abort loading:

```js
window.lab03.abortLoading();
```

І оновити rooms:

```js
await window.lab03.refreshRooms();
```

---

# Git / здача Lab 03

Це має бути **той самий GitHub repository**, але Lab 03 краще робити в окремій branch і зливати через Pull Request.

Після merge потрібен tag:

```bash
git tag lab-03
git push origin lab-03
```

Definition of Done:

- [x] `loadImage` / `loadAudio` / `loadJson` + AbortSignal
- [x] shared `fetchJson` перевіряє `ok`
- [x] retry with exponential backoff + jitter; no retry for 4xx
- [x] `loadAll` через `Promise.all`
- [x] real canvas progress bar
- [x] sequential vs concurrent measurement
- [x] sprite sheets
- [x] Web Audio after user gesture; decoded during loading
- [x] EventTarget / CustomEvent bus
- [x] sim не import-ить audio/HUD
- [x] lobby over HTTP
- [x] periodic refresh
- [x] `AbortSignal.timeout`
- [x] abort-on-leave
- [x] separate lobby DOM module
- [x] five ordering puzzles
- [x] failure gallery: 404 / timeout / abort / corrupt JSON
- [ ] поставити Git tag `lab-03` після merge PR
