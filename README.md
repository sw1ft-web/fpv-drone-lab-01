# Lab 02 — Objects, Prototypes, and `this`: Entity Model

Продовження **Lab 01 — FPV Drone: Event Loop and Game Loop** у тому самому репозиторії.

Тема проєкту: FPV Drone на Canvas 2D. У Lab 02 plain-object корабель із Lab 01 перетворено на `class Ship extends Entity`, а світ гри тепер зберігає всі сутності через `Map`.

## Запуск

Потрібен Node.js 22.

```bash
npm install
npm run dev
```

Перевірка:

```bash
npm run lint
npm run format:check
npm run build
```

## Керування

- `W` / `ArrowUp` — тяга
- `A` / `ArrowLeft` — поворот ліворуч
- `D` / `ArrowRight` — поворот праворуч
- `F` — постріл
- `0` — normal mode
- `1` — Experiment 1
- `2` — Experiment 2
- `3` — Experiment 3

У грі є корабель, кулі з TTL, астероїди, homing-астероїд, pickup-и, колізії, вибухи, HP, score та respawn.

## Структура

```text
src/
  main.js
  loop.js
  input.js
  sim/
    vector.js
    entity.js
    world.js
    ship.js
    bullet.js
    asteroid.js
    pickup.js
    explosion.js
    homing.js
    collision.js
  render/
    canvas.js
    draw.js
```

## M1 — Vector2, Entity, Ship

`Vector2` має чисті методи:

- `add`
- `sub`
- `scale`
- `length`
- `normalize`
- `rotate`
- `dot`
- `Vector2.fromAngle`

Методи створюють новий `Vector2`, тому `a.add(b)` не змінює `a`.

`Entity` містить:

- приватний статичний лічильник `#nextId`;
- `id`;
- `pos`;
- `vel`;
- `angle`;
- `radius`;
- `alive`;
- `kind`;
- `update(dt)`.

Єдиний рівень наслідування:

```text
Entity
  └── Ship
```

Інші сутності також успадковують безпосередньо від `Entity`, без глибокого дерева класів.

## M2 — World і Map

`World` використовує:

```js
#entities = new Map();
```

Він має:

- `spawn(entity)`
- `despawn(id)` — лише позначає entity мертвою;
- `get(id)`
- `[Symbol.iterator]`
- `*ofKind(kind)`
- `step(dt, input)`

На початку кроку формується snapshot `[...]`, після оновлення виконується collision pass, а потім dead entities видаляються методом sweep.

Це не змінює `Map` під час основної ітерації симуляції.

## TTL і сутності

`Bullet` має `ttl = 2` секунди. Після завершення TTL він викликає `markDead()`.

`Asteroid` рухається по арені та обгортається через межі.

`Explosion` містить набір короткоживучих particle objects.

`Pickup` стоїть на місці, має власний lifetime та може дати кораблю:

- `shield`;
- `rapid-fire`.

## `this`: проблема та фікс

`this` визначається способом виклику функції.

Чотири правила у потрібному порядку:

1. `new` binding — `new F()` встановлює `this` у новостворений об'єкт.
2. Explicit binding — `call`, `apply`, `bind`.
3. Implicit binding — `obj.method()` дає `this === obj`.
4. Default binding — для strict mode `this === undefined`.

Проблемний варіант:

```js
window.addEventListener("keydown", ship.fire);
```

Тут передається сама функція `fire`, а не виклик `ship.fire()`. Event system викликає callback зі своїм receiver, тому метод не отримує очікуваний `ship` як `this`.

Обраний фікс:

```js
window.addEventListener("keydown", () => ship.fire(world));
```

Стрілка не має власного `this`, а wrapper явно викликає метод через `ship`.

Інші можливі фікси:

```js
window.addEventListener("keydown", ship.fire.bind(ship));
```

Плюс: коротко і зберігає receiver. Мінус: `bind` створює нову bound function, що потрібно враховувати при подальшому `removeEventListener`.

Другий варіант — class field:

```js
fire = () => {
  // ...
};
```

Плюс: метод завжди прив'язаний до instance. Мінус: arrow-function field створюється окремо для кожного екземпляра, тому для тисяч сутностей це менш економно, ніж спільний prototype method.

## Prototype experiment

У DevTools Console:

```js
const proto = {
  hello() {
    return "hello";
  },
};

const a = Object.create(proto);
const b = Object.create(proto);

a.hello = () => "A";
console.log(a.hello()); // A
console.log(b.hello()); // hello
console.log(a.__proto__ === b.__proto__); // true
```

Метод `hello` не копіюється в `b`: lookup проходить через prototype.

Ще один experiment:

```js
class A {
  m() {
    return this;
  }
}

const a = new A();
const m = a.m;

console.log(m()); // undefined у module/strict mode
console.log(m.call(a) === a); // true
```

Це показує, що `this` залежить від call site.

## Map experiment

```js
const objectStore = { "1": "x" };
const mapStore = new Map([[1, "x"]]);

console.log(objectStore[1]); // "x"
console.log(mapStore.get("1")); // undefined
console.log(mapStore.get(1)); // "x"
```

Object перетворює numeric property key у string. `Map` зберігає тип ключа, має `.size`, insertion order та не має проблеми з успадкованими ключами звичайного object dictionary.

## M3 — collisions, HP, explosion, respawn, score

Колізії винесені в окремий `collision.js`.

Поточна перевірка — naive O(n²):

```text
кожна сутність × кожна наступна сутність
```

Цього достатньо для Lab 02. Пізніше систему можна замінити на spatial hash без зміни решти `World`.

Корабель має приватне поле:

```js
#hp
```

і публічний accessor:

```js
get hp()
```

Куля пошкоджує корабель або астероїд. При знищенні створюється `Explosion`. Корабель відновлюється через 2 секунди у випадковій позиції та на короткий час отримує invulnerability.

Score відображається в HUD.

## M4 — композиція замість глибокого inheritance tree

Наївний варіант ієрархії міг би виглядати так:

```text
Entity
├── MovingEntity
│   ├── Ship
│   ├── Bullet
│   └── Asteroid
└── Pickup

MovingEntity
└── HomingMovingEntity
    ├── HomingBullet
    └── HomingAsteroid
```

Проблема: homing — це окрема здатність, а не тип сутності. Якщо завтра потрібен stationary homing turret або інша сутність із тим самим behavior, дерево швидко ускладниться.

У цьому проєкті homing реалізований композицією:

```js
entity.homing = createHomingBehavior("ship", 1.1);
```

І `Bullet`, і `Asteroid` можуть мати це поле незалежно від їхнього класу.

Pickup також не робиться `Ship` або його нащадком. Це окрема `Entity` з:

```js
kind = "pickup"
pickupType = "shield" | "rapid-fire"
```

Системи працюють із потрібними властивостями сутності, а не з глибоким inheritance tree.

Такий підхід зручніший для гри, де здібності можуть комбінуватися незалежно.

## Reflection

### 1. Що буде у `setTimeout(ship.fire, 100)`?

Функція передається як callback і втрачає implicit receiver `ship`. У strict mode класів `this` не стає `ship`. Виправлення:

```js
setTimeout(() => ship.fire(world), 100);
setTimeout(ship.fire.bind(ship, world), 100);
```

Або class-field arrow method.

### 2. Чому arrow functions не реагують на `bind`?

Arrow function не має власного `this`. Вона захоплює `this` з lexical environment, тому `call`, `apply` і `bind` не можуть його змінити.

Arrow methods зручні для callback-ів, але для великої кількості однакових об'єктів prototype method економніший, бо функція спільна для всіх instances.

### 3. Чому Map замість plain object?

1. `Map` зберігає ключ `1` як number, а не перетворює його на `"1"`.
2. Є реальний `.size`.
3. Немає inherited keys типу `constructor`.
4. Є зручні `set`, `get`, `delete`, `values`.
5. `Map` природно підходить для `id -> Entity`.

### 4. Чому composition?

Homing — це capability. Його можуть отримати різні сутності. Якщо робити тільки inheritance, довелося б створювати `HomingBullet`, `HomingAsteroid` та інші спеціальні класи. Композиція дозволяє просто додати behavior до потрібної entity.

## Prototype chain

Для:

```js
const ship = new Ship();
```

ланцюг instance methods виглядає приблизно так:

```text
ship
 ↓
Ship.prototype
 ↓
Entity.prototype
 ↓
Object.prototype
 ↓
null
```

Наприклад, `ship.update` спочатку шукається на самому `ship`. Якщо там немає `update`, lookup переходить до `Ship.prototype`, де знаходить метод.

## Git deliverable

Після локальної перевірки:

```bash
npm run lint
npm run format:check
npm run build
```

Потім:

```bash
git status
git add .
git commit -m "Lab 02: entity model, collisions and composition"
git tag lab-02
git push origin main
git push origin lab-02
```

Перевірка тегу:

```bash
git tag
```

У списку має бути:

```text
lab-01
lab-02
```
