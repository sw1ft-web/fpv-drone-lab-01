/** Base entity. Ids are assigned by the World on spawn so they are deterministic per match. */
export class Entity {
  constructor({
    pos = { x: 0, y: 0 },
    vel = { x: 0, y: 0 },
    angle = 0,
    radius = 10,
    kind = "entity",
  } = {}) {
    this.id = 0;
    this.pos = { x: pos.x, y: pos.y };
    this.vel = { x: vel.x, y: vel.y };
    this.angle = angle;
    this.radius = radius;
    this.alive = true;
    this.kind = kind;
  }

  update() {}

  markDead() {
    this.alive = false;
  }
}
