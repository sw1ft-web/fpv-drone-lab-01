# Lab 06 — TypeScript: типи для протоколу, симуляції і обох боків дроту

Увесь код (`shared`, `server`, `client`, `scripts`, тести) переведено на TypeScript під `strict`. **Поведінка в рантаймі не змінилась**: golden-hash детермінізму з Lab 05 той самий, усі тести з Lab 05 проходять (після адаптації фікстур під брендовані типи).

## Що змінилось

| Було (Lab 05)                                 | Стало (Lab 06)                                                                                    |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `.js` + JSDoc                                 | `.ts`, `strict` + `noUncheckedIndexedAccess` + `verbatimModuleSyntax` + `erasableSyntaxOnly`      |
| рукописний `validate()` у `server/protocol`   | zod-схеми в `shared/src/protocol/messages.ts`; типи виводяться з них (`z.output`)                 |
| `EventTarget` + `CustomEvent` (`detail: any`) | типізований `Bus<E>`; `Room`/`RoomManager` — `EventEmitter<Events>`                               |
| `process.env` читався вручну                  | `ServerConfigSchema` (zod) з дефолтами і зрозумілими повідомленнями                               |
| `fetch().json()` → `any`                      | `unknown` + схема на кожній межі (manifest, `/api/rooms`, тіло POST, події матч-логу, JSON-кадри) |
| `catch (e)`                                   | `unknown` + `instanceof Error` / `errorMessage()`                                                 |

Запуск без збірки: Node 22 знімає типи сам (`node server/src/index.ts`, `node scripts/dev.ts`), тому весь синтаксис «стираний»: без `enum` і parameter properties (це перевіряє `erasableSyntaxOnly`). Імпорти пишуться з розширенням `.ts`. Vite транспілює `.ts` через esbuild і **не перевіряє типи** — перевірка окремо: `npm run typecheck`.

## Команди

```bash
npm run typecheck   # tsc --noEmit у shared, client, server + scripts
npm run lint        # ESLint + typescript-eslint strictTypeChecked (no-floating-promises, no-explicit-any …)
npm test            # shared 36 · client 27 · server 44 · netcode/e2e 9
npm run build       # vite build
```

CI (`.github/workflows/ci.yml`) запускає: `npm ci` → typecheck → lint → format:check → test → build.

> **Версія TypeScript.** Спершу стояв TypeScript 7 (нативний компілятор): `tsc` працює, але в нього немає JS API, а `typescript-eslint` його вимагає. Через це проєкт зафіксований на **TypeScript 6.0.3** — type-checked lint важливіший за швидкість `tsc`. Коли `typescript-eslint` підтримає 7.x, версію можна піднімати.

## Що знайшов TypeScript (і лінтер)

Це реальні знахідки під час міграції, а не перелік можливостей.

1. **`SnapshotBuffer.#blend`: `a.kind === "ship" && (b.flags …)`** — перевірка звужувала лише `a`, а `b.flags` читався без перевірки. Код мовчки припускав, що той самий `id` завжди має той самий `kind`. Тепер перевіряються обидва (`b.kind === "ship"`).
2. **`GameClient.#emitEvents`: `previous.kind === "ship" && current`** — та сама історія: `current.flags` читався з сутності невідомого виду. Тепер `current?.kind === "ship"`.
3. **`FATAL_CLOSE_CODES.has(event.code)`** — `new Set([CLOSE.TOO_BIG, …])` мав тип `Set<1009 | 4000 | …>`, і `.has(number)` не компілювалось. Це чесне попередження: множина «знає» лише свої літерали. Тип змінено на `ReadonlySet<number>`.
4. **Непотрібне покриття `undefined` у парсингу/індексації** (`noUncheckedIndexedAccess`): `list[0]`/`list.at(-1)` у `SnapshotBuffer.sample`, `EXTRA_SIZE[kindCode]` у бінарному кодеку, `lines[0]` у тестах, `sockets[i]`, `Map.get(id)` у тестах і стенді. У `sample` тепер явна гілка «буфер порожній», у кодеку — `?? 0`, у тестах — `assert.ok(x)`.
5. **`PORT=not-a-number`** давав у zod-конфігу «expected number, received NaN» — не те, що обіцяв тест («PORT must be an integer»). Повідомлення виправлено в схемі.
6. **`for await (const chunk of req)` у `readJsonBody`** — `chunk` був `any`: `received += chunk.length` і `chunks.push(chunk)` не перевірялись. Тепер `Buffer.isBuffer(chunk)`, інакше 400.
7. **Лог матчу приймав будь-який JSON-об'єкт як подію** (`{"ok":1}` проходив у `replayEvents`). Тепер подія зобов'язана мати рядкове `type`; тестову фікстуру виправлено.
8. **`WebSocket.send` проти `Uint8Array`** — з TS ≥ 5.7 `Uint8Array` за замовчуванням може бути поверх `SharedArrayBuffer`, а DOM-`send` приймає лише `ArrayBuffer`-подібні. Кодек тепер повертає `Uint8Array<ArrayBuffer>`.
9. **`benchmarkLoadAll` викликав `loadAudio(undefined, …)`**, якщо `AudioContext` ще не створений, — це був би `TypeError` у рантаймі. Аудіо-завдання тепер додаються лише коли контекст є.
10. **`blocking-demo` слав `v: 0`**, хоча сервер вимагає `v: 1`. Скрипт будував повідомлення вручну; тепер він відправляє той самий формат, що описує схема.
11. **Prefixed `webkitAudioContext`** — типів для нього немає, а `AudioContext` без префікса підтримується з Safari 14.1. Застарілий fallback видалено.
12. **Async-обробники подій** (`addEventListener("click", async …)`, `process.on("SIGTERM", () => shutdown())`) — `no-misused-promises`/`no-floating-promises`: відхилений проміс там нічого не зловив би. Тепер явний `void`, а помилки обробляються всередині.

## Бюджет `as` і `any`

- `any`: **0** (`@typescript-eslint/no-explicit-any` — error, плюс уся родина `no-unsafe-*`).
- Приведення типів `as T`: **1** — `mint()` у `shared/src/types.ts`, єдине місце, де `number` стає `EntityId`/`Tick`/`Seq` (бренд не має представлення в рантаймі). Коментар там же.
- `as const` (не приведення, а «заморозка» літералів): використовується для списків кодеків, тестових фікстур тощо.
- `@ts-expect-error`: 1, у тесті, який навмисно передає рядок у бінарний декодер, щоб перевірити відмову в рантаймі.
- `eslint-disable`: 3 рядки з поясненням (`no-control-regex` для схеми імені; `no-unnecessary-type-parameters` для `mint`; `no-unsafe-assignment` для `workerData`).

## Три цікаві типи

### 1. Брендований `EntityId` / `Tick` / `Seq` (`shared/src/types.ts`)

```ts
declare const brand: unique symbol;
export type Brand<Base, Name extends string> = Base & {
  readonly [brand]: Name;
};
export type EntityId = Brand<number, "EntityId">;
export type Seq = Brand<number, "Seq">;
```

У рантаймі це просто `number`. У компіляції `EntityId` і `Seq` несумісні: `world.get(seq)` — помилка. Це важливо, бо в проєкті п'ять різних «цілих чисел» (id сутності, тік, seq інпуту, байти, кадри), і саме `ack` (це `Seq`) легко сплутати з `tick`. Єдиний спосіб отримати бренд — `asEntityId(n)`, які всі йдуть через одну функцію `mint`; цінність у тому, що перед нею завжди стоїть перевірка (zod-схема, діапазон у бінарному декодері або лічильник у тому ж модулі).

### 2. Дискримінований union + `assertNever` (`EntityView`)

```ts
export type EntityView = ShipView | BulletView | AsteroidView | PickupView; // поле `kind`
switch (entity.kind) {
  case "ship": …
  case "bullet": …
  case "asteroid": …
  case "pickup": …
  default: return assertNever(entity, "unknown entity kind");
}
```

`entity.kind` звужує тип: у гілці `"bullet"` існує `ownerId`, а `hp` — ні. Якщо додати п'ятий вид (наприклад, `"mine"`), у `default` `entity` перестане бути `never`, і **кожен** `switch` (бінарний кодек, клієнтський `view()`, малювання) перестане компілюватись. `assertNever` ще й кидає помилку в рантаймі, якщо дані прийшли «зі світу», де типи вже не діють.

### 3. Типізований `Bus<E>` і мапа повідомлень з перейменуванням ключів (`shared/src/bus.ts`, `client/src/net/connection.ts`)

```ts
class Bus<E extends { [name: string]: unknown }> {
  on<K extends keyof E>(name: K, handler: (payload: E[K]) => void): () => void;
  emit<K extends keyof E>(name: K, payload: E[K]): void;
}
type MessageEvents = {
  [M in ServerMessage as M["type"]]: M & { readonly size: number };
};
connection.on("welcome", (m) => m.shipId); // m — саме WelcomeMessage
```

`K extends keyof E` зв'язує **ім'я події** з **типом корисного навантаження** `E[K]`: `bus.emit("hit", { dmg: 1 })` — помилка, а в `on("scoreChanged", ({ score }) => …)` `score` має тип `number`. Друга частина — mapped type з `as M["type"]`: з union `ServerMessage` автоматично виходить `{ welcome: Welcome & {size}, roster: …, chat: …, snapshot: … }`, тож додати новий тип повідомлення на сервері означає отримати його в `connection.on(...)` без жодного додаткового коду. Усередині `Bus` зберігаються обробники для різних подій в одній `Map`; щоб не вдаватись до `any` чи `as`, використано метод-стильну bivariance (`{ bivarianceHack(p: P): void }["bivarianceHack"]`).

## Рішення щодо UI-фреймворку

**Svelte/Vue/React не додавав.** Причини:

- Лобі й чат — це ~200 рядків DOM-коду з одним `query()`-хелпером, який дає типізовані елементи без приведень (`query(root, "#lobbyForm", HTMLFormElement)` перевіряє `instanceof` і кидає помилку при хибному селекторі).
- Дані вже течуть через типізований `Bus`/`Connection.on`, тобто головна вигода (реактивний стан) для двох форм невелика, а ціна — нова залежність, інший збирач і ризик регресу в UI.
- У середовищі, де виконувалась робота, **немає браузера**, тож переписаний UI неможливо було б перевірити очима; переписувати інтерфейс «наосліп» — гірше, ніж лишити перевірений.

Що фреймворк дав би: декларативний рендер списку кімнат і ростера замість `replaceChildren`. Що коштував би: збільшення бандла (зараз `index.js` ≈ 141 kB / 44 kB gzip, переважно zod) і додатковий крок збірки.

## Що перевірено, а що ні

- ✅ `tsc --noEmit` (strict) у всіх пакетах і `scripts/`; ESLint `strictTypeChecked`; Prettier; 116 тестів; `vite build`.
- ✅ Детермінізм: golden-hash і тест «нічого не змінилось у рантаймі» проходять; headless-стенд (`npm run test:netcode`) і e2e через справжній WebSocket (JSON і бінарний) — теж.
- ❌ **Браузер не запускався.** Клієнт зібраний і типізований, але ні лобі, ні чат, ні canvas, ні звук тут візуально не перевірялись. Перед тегом варто відкрити `npm run dev` і пройти: Start loading → кімната → Join → політ, чат, `N` (netgraph).
- ❌ CI-workflow написаний, але не запускався на GitHub у момент коміту (перший прогін — у PR).
