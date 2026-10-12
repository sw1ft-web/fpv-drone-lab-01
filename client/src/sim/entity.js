export class Entity {
  static #nextId = 1;
  #id = Entity.#nextId++;

  constructor({
    pos = { x: 0, y: 0 },
    vel = { x: 0, y: 0 },
    angle = 0,
    radius = 10,
    kind = "entity",
  } = {}) {
    this.pos = { x: pos.x, y: pos.y };
    this.vel = { x: vel.x, y: vel.y };
    this.angle = angle;
    this.radius = radius;
    this.alive = true;
    this.kind = kind;
  }

  get id() {
    return this.#id;
  }

  update() {}

  markDead() {
    this.alive = false;
  }
}
