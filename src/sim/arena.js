export function wrapEntity(entity, width, height) {
  entity.x = ((entity.x % width) + width) % width;
  entity.y = ((entity.y % height) + height) % height;
}