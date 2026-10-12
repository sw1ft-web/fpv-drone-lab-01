/** A DOM constructor such as `HTMLButtonElement`, usable with `instanceof`. */
type ElementClass<T extends Element> = new (...args: never[]) => T;

/**
 * `querySelector` that returns the element with its real type or throws.
 * The `instanceof` check is what turns `Element | null` into `HTMLFormElement`,
 * so there is no cast and a wrong selector fails loudly instead of at first use.
 */
export function query<T extends Element>(
  root: ParentNode,
  selector: string,
  type: ElementClass<T>,
): T {
  const element = root.querySelector(selector);
  if (element instanceof type) return element;
  throw new Error(
    `Expected ${type.name} for "${selector}", found ${element ? element.tagName : "nothing"}`,
  );
}

/** Describes anything that was thrown: only `Error` instances have a message. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
