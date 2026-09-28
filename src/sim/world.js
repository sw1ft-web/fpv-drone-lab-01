import { resolveCollisions } from "./collision.js";

export class World {
  #entities = new Map();

  constructor(width, height, classes) {
    this.width = width;
    this.height = height;
    this.classes = classes;
    this.score = 0;
  }

  spawn(entity) {
    this.#entities.set(entity.id, entity);
    return entity;
  }

  despawn(id) {
    const entity = this.#entities.get(id);
    if (entity) entity.markDead();
  }

  get(id) {
    return this.#entities.get(id);
  }

  *[Symbol.iterator]() {
    yield* this.#entities.values();
  }

  *ofKind(kind) {
    for (const entity of this) {
      if (entity.kind === kind) yield entity;
    }
  }

  step(dt, input) {
    const entitiesAtStart = [...this];

    for (const entity of entitiesAtStart) {
      if (!entity.alive) continue;
      entity.update(dt, this, input);
    }

    resolveCollisions(this);
    this.#sweep();
  }

  #sweep() {
    for (const [id, entity] of this.#entities) {
      if (!entity.alive) this.#entities.delete(id);
    }
  }
}
