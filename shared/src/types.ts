/**
 * Core vocabulary shared by every package: branded numbers, vectors, commands
 * and the plain-object view of an entity that travels on the wire.
 */

declare const brand: unique symbol;

/**
 * A number that the compiler refuses to mix with other numbers. `EntityId`,
 * `Tick` and `Seq` are all `number` at runtime (zero cost); at compile time
 * passing a `Seq` where a `Tick` is expected is an error.
 */
export type Brand<Base, Name extends string> = Base & {
  readonly [brand]: Name;
};

export type EntityId = Brand<number, "EntityId">;
export type Tick = Brand<number, "Tick">;
export type Seq = Brand<number, "Seq">;

/**
 * The ONLY place a number becomes branded. Every brand constructor goes through
 * this function, so the codebase has a single unchecked assertion for all of
 * them. Callers are responsible for having validated the value (zod schema,
 * codec range check or a counter owned by the same module).
 */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- T appears only in the return type on purpose: that is what makes it a brand constructor
function mint<T extends number>(value: number): T {
  return value as T; // the single brand assertion: the brand has no runtime representation
}

export const asEntityId = (value: number): EntityId => mint<EntityId>(value);
export const asTick = (value: number): Tick => mint<Tick>(value);
export const asSeq = (value: number): Seq => mint<Seq>(value);

export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

/** A mutable point/velocity used inside entities (the only mutable vector). */
export interface MutableVec2 {
  x: number;
  y: number;
}

/** What a player's keyboard means for ONE simulation step. */
export interface Command {
  readonly left: boolean;
  readonly right: boolean;
  readonly thrust: boolean;
  readonly brake: boolean;
  readonly fire: boolean;
}

/** A command as the server applies it: with the sequence number of the input it came from. */
export interface SequencedCommand extends Command {
  readonly seq?: Seq;
}

export type EntityKind = "ship" | "bullet" | "asteroid" | "pickup";

interface ViewBase {
  readonly id: EntityId;
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
  readonly angle: number;
}

export interface ShipView extends ViewBase {
  readonly kind: "ship";
  readonly hp: number;
  readonly score: number;
  /** Bit set of SNAPSHOT_FLAGS. */
  readonly flags: number;
}

export interface BulletView extends ViewBase {
  readonly kind: "bullet";
  readonly ownerId: EntityId;
  readonly fireSeq: Seq;
}

export interface AsteroidView extends ViewBase {
  readonly kind: "asteroid";
  readonly radius: number;
  readonly homing: 0 | 1;
}

export interface PickupView extends ViewBase {
  readonly kind: "pickup";
  /** Index into PICKUP_TYPES. */
  readonly pickupType: 0 | 1;
}

/** Discriminated union: checking `kind` narrows to exactly one member. */
export type EntityView = ShipView | BulletView | AsteroidView | PickupView;

export interface Snapshot {
  readonly tick: Tick;
  readonly ack: Seq;
  readonly entities: readonly EntityView[];
}

export interface InputEntry {
  readonly seq: Seq;
  readonly bits: number;
}

export function assertNever(value: never, message = "unhandled case"): never {
  throw new Error(`${message}: ${JSON.stringify(value)}`);
}
