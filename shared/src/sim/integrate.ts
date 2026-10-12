import { BULLET, SHIP, TAU } from "../constants.ts";
import type { Command, MutableVec2, Vec2 } from "../types.ts";

/** The state `integrateShip` reads and writes: everything else about a ship is irrelevant to movement. */
export interface Kinematic {
  readonly pos: MutableVec2;
  readonly vel: MutableVec2;
  angle: number;
}

export interface ShipKinematic extends Kinematic {
  thrust: number;
}

/** The signature of a ship integrator; tests inject broken ones to watch prediction fall apart. */
export type IntegrateShip = (
  ship: ShipKinematic,
  command: Partial<Command>,
  dt: number,
  width: number,
  height: number,
) => void;

/**
 * Advances one ship's kinematics by `dt` seconds under `command`.
 *
 * This is THE function the client calls to predict its own ship and the server
 * calls to simulate it. It is pure with respect to (state, command, dt, size):
 * no DOM, no clock, no Math.random(). Anything non-deterministic added here
 * makes prediction diverge from the server (see docs/lab-05.md).
 */
export const integrateShip: IntegrateShip = (
  ship,
  command,
  dt,
  width,
  height,
) => {
  if (command.left) ship.angle -= SHIP.rotationSpeed * dt;
  if (command.right) ship.angle += SHIP.rotationSpeed * dt;
  ship.thrust = command.thrust ? 1 : 0;

  if (command.thrust) {
    ship.vel.x += Math.cos(ship.angle) * SHIP.thrust * dt;
    ship.vel.y += Math.sin(ship.angle) * SHIP.thrust * dt;
  }

  const drag = command.brake ? SHIP.brakeDrag : Math.pow(SHIP.drag, dt * 60);
  ship.vel.x *= drag;
  ship.vel.y *= drag;

  const speed = Math.hypot(ship.vel.x, ship.vel.y);
  if (speed > SHIP.maxSpeed) {
    const scale = SHIP.maxSpeed / speed;
    ship.vel.x *= scale;
    ship.vel.y *= scale;
  }

  ship.pos.x += ship.vel.x * dt;
  ship.pos.y += ship.vel.y * dt;

  ship.pos.x = ((ship.pos.x % width) + width) % width;
  ship.pos.y = ((ship.pos.y % height) + height) % height;
  ship.angle = ((ship.angle % TAU) + TAU) % TAU;
};

/** Straight-line bullet motion, shared by the server and the client's predicted bullets. */
export function integrateBullet(
  bullet: { readonly pos: MutableVec2; readonly vel: Vec2 },
  dt: number,
  width: number,
  height: number,
): void {
  bullet.pos.x = (((bullet.pos.x + bullet.vel.x * dt) % width) + width) % width;
  bullet.pos.y =
    (((bullet.pos.y + bullet.vel.y * dt) % height) + height) % height;
}

/** Where a bullet fired by `ship` starts and how fast it moves. */
export function bulletLaunch(ship: Kinematic): { pos: Vec2; vel: Vec2 } {
  const dx = Math.cos(ship.angle);
  const dy = Math.sin(ship.angle);
  const nose = SHIP.radius + 8;
  return {
    pos: { x: ship.pos.x + dx * nose, y: ship.pos.y + dy * nose },
    vel: {
      x: ship.vel.x + dx * BULLET.speed,
      y: ship.vel.y + dy * BULLET.speed,
    },
  };
}
