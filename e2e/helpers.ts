import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

/** The slice of `window.lab05` the tests read. */
interface Lab05 {
  game: {
    view(): {
      own: { x: number; y: number; active: boolean } | null;
      ships: { id: number; x: number; y: number; active: boolean }[];
    };
  } | null;
}

declare global {
  interface Window {
    lab05?: Lab05;
  }
}

export interface Pilot {
  readonly page: Page;
  ownPosition(): Promise<{ x: number; y: number }>;
  shipCount(): Promise<number>;
}

/** Opens the game, loads assets, joins a room under `name` and waits for the first snapshot. */
export async function join(
  page: Page,
  name: string,
  roomId: string,
): Promise<Pilot> {
  await page.goto("/");
  await page.locator("#startLoading").click();
  await expect(page.locator("#lobby")).toBeVisible();
  await page.locator("#playerName").fill(name);
  await page.locator(`input[name="room"][value="${roomId}"]`).check();
  await page.getByRole("button", { name: "Join & play" }).click();
  await expect(page.locator("#hud")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.lab05?.game?.view().own != null))
    .toBe(true);

  return {
    page,
    ownPosition: () =>
      page.evaluate(() => {
        const own = window.lab05?.game?.view().own;
        if (!own) throw new Error("no own ship");
        return { x: own.x, y: own.y };
      }),
    shipCount: () =>
      page.evaluate(() => window.lab05?.game?.view().ships.length ?? 0),
  };
}

/** Where `page` sees the ship named by `index` among the ships it knows (0-based, stable order by id). */
export const remoteShips = (page: Page) =>
  page.evaluate(() => {
    const view = window.lab05?.game?.view();
    return (view?.ships ?? []).map((ship) => ({
      id: ship.id,
      x: ship.x,
      y: ship.y,
    }));
  });
