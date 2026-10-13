import type { Command } from "../types.ts";

/**
 * A command is what a player's keyboard means for ONE simulation step.
 * On the wire it is a single byte (bit set).
 */
export const COMMAND_BITS = Object.freeze({
  left: 1,
  right: 2,
  thrust: 4,
  brake: 8,
  fire: 16,
});
export const COMMAND_MASK = 31;

export const EMPTY_COMMAND: Command = Object.freeze({
  left: false,
  right: false,
  thrust: false,
  brake: false,
  fire: false,
});

export function commandToBits(command: Partial<Command>): number {
  return (
    (command.left ? COMMAND_BITS.left : 0) |
    (command.right ? COMMAND_BITS.right : 0) |
    (command.thrust ? COMMAND_BITS.thrust : 0) |
    (command.brake ? COMMAND_BITS.brake : 0) |
    (command.fire ? COMMAND_BITS.fire : 0)
  );
}

const decode = (bits: number): Command =>
  Object.freeze({
    left: (bits & COMMAND_BITS.left) !== 0,
    right: (bits & COMMAND_BITS.right) !== 0,
    thrust: (bits & COMMAND_BITS.thrust) !== 0,
    brake: (bits & COMMAND_BITS.brake) !== 0,
    fire: (bits & COMMAND_BITS.fire) !== 0,
  });

/** All 32 possible commands, built once: decoding an input is a table lookup, not an allocation. */
const COMMANDS: readonly Command[] = Array.from(
  { length: COMMAND_MASK + 1 },
  (_, bits) => decode(bits),
);

/** The (frozen, shared) command for `bits`; bits outside the mask are ignored. */
export function commandFromBits(bits: number): Command {
  return COMMANDS[bits & COMMAND_MASK] ?? EMPTY_COMMAND;
}
