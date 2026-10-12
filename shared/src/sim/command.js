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

export const EMPTY_COMMAND = Object.freeze({
  left: false,
  right: false,
  thrust: false,
  brake: false,
  fire: false,
});

export function commandToBits(command) {
  return (
    (command.left ? COMMAND_BITS.left : 0) |
    (command.right ? COMMAND_BITS.right : 0) |
    (command.thrust ? COMMAND_BITS.thrust : 0) |
    (command.brake ? COMMAND_BITS.brake : 0) |
    (command.fire ? COMMAND_BITS.fire : 0)
  );
}

export function commandFromBits(bits) {
  return {
    left: (bits & COMMAND_BITS.left) !== 0,
    right: (bits & COMMAND_BITS.right) !== 0,
    thrust: (bits & COMMAND_BITS.thrust) !== 0,
    brake: (bits & COMMAND_BITS.brake) !== 0,
    fire: (bits & COMMAND_BITS.fire) !== 0,
  };
}
