import { expect, test } from "@playwright/test";
import { join, remoteShips } from "./helpers.ts";

test("the lobby lists the seeded rooms from /api/rooms", async ({ page }) => {
  await page.goto("/");
  await page.locator("#startLoading").click();
  await expect(page.locator("#lobby")).toBeVisible();
  await expect(page.locator(".room-card")).toHaveCount(3);
  await expect(page.locator("#roomList")).toContainText("Kyiv Alpha");
});

test("two players share a room: roster, movement and chat travel between browsers", async ({
  browser,
}) => {
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  const alice = await join(await aliceContext.newPage(), "Alice", "night-run");
  const bob = await join(await bobContext.newPage(), "Bob", "night-run");

  await test.step("both see each other in the roster", async () => {
    for (const { page } of [alice, bob]) {
      await expect(page.locator("#roster")).toContainText("Alice");
      await expect(page.locator("#roster")).toContainText("Bob");
    }
  });

  await test.step("Alice's ship moves in Bob's browser", async () => {
    const before = await remoteShips(bob.page);
    // Hold thrust until the ship has really moved: a ship that was just
    // respawned (or is waiting to) ignores input for a moment.
    const aliceStart = await alice.ownPosition();
    await alice.page.keyboard.down("ArrowUp");
    await alice.page.keyboard.down("ArrowRight");
    await expect
      .poll(async () => {
        const now = await alice.ownPosition();
        return Math.hypot(now.x - aliceStart.x, now.y - aliceStart.y);
      })
      .toBeGreaterThan(20);

    // Bob must see one of the ships at a new place (Alice keeps flying meanwhile).
    await expect
      .poll(async () => {
        const now = await remoteShips(bob.page);
        return now.some((ship) => {
          const old = before.find((b) => b.id === ship.id);
          return old && Math.hypot(ship.x - old.x, ship.y - old.y) > 20;
        });
      })
      .toBe(true);
    await alice.page.keyboard.up("ArrowUp");
    await alice.page.keyboard.up("ArrowRight");
  });

  await test.step("a chat message reaches the other player", async () => {
    await alice.page.locator("#chatInput").fill("hello from alice");
    await alice.page.locator("#chatInput").press("Enter");
    await expect(bob.page.locator("#chatLog")).toContainText(
      "Alice: hello from alice",
    );
  });

  await test.step("leaving the page removes the player from the roster", async () => {
    await aliceContext.close();
    await expect(bob.page.locator("#roster")).not.toContainText("Alice");
  });

  await bobContext.close();
});

test("the server reports health and stats", async ({ request }) => {
  const health = await request.get("/health");
  expect(health.ok()).toBe(true);
  const stats = await request.get("/api/stats");
  expect(await stats.json()).toMatchObject({ rooms: expect.any(Number) });
});
