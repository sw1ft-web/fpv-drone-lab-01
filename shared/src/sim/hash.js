const scratch = new DataView(new ArrayBuffer(8));

/**
 * FNV-1a over the exact IEEE-754 bits of every entity, in insertion order, plus
 * the PRNG state. Two worlds hash equal only if they are bit-identical.
 */
export function hashWorld(world) {
  let hash = 0x811c9dc5;
  const byte = (value) => {
    hash ^= value;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  };
  const number = (value) => {
    scratch.setFloat64(0, value, true);
    for (let i = 0; i < 8; i += 1) byte(scratch.getUint8(i));
  };

  for (const entity of world) {
    number(entity.id);
    number(entity.pos.x);
    number(entity.pos.y);
    number(entity.vel.x);
    number(entity.vel.y);
    number(entity.angle);
    if (entity.kind === "ship") {
      number(entity.hp);
      number(entity.score);
      number(entity.respawnTimer);
    }
  }
  number(world.rng.getState());
  number(world.stepCount);
  return hash >>> 0;
}
