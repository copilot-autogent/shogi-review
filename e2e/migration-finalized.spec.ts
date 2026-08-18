import { expect, test, type Page } from "@playwright/test";

const userId = "00000000-0000-0000-0000-000000000001";
const authStorageKey = "sb-yuymtghhqszcfbhhhhyq-auth-token";

async function mockFinalizedAccount(page: Page): Promise<void> {
  await page.addInitScript(({ key, id }) => {
    localStorage.setItem(key, JSON.stringify({
      access_token: "test-access-token",
      refresh_token: "test-refresh-token",
      token_type: "bearer",
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: { id, aud: "authenticated", role: "authenticated", email: "finalized@example.test", user_metadata: {} },
    }));
  }, { key: authStorageKey, id: userId });
  await page.route("**/auth/v1/user", async (route) => {
    await route.fulfill({ json: { id: userId, aud: "authenticated", role: "authenticated", email: "finalized@example.test", user_metadata: {} } });
  });
  await page.route("**/rest/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/user_migrations")) {
      await route.fulfill({ json: { status: "finalized", source_hash: "source-hash", target_hash: "target-hash", counts: { games: 0, points: 0, recommendations: 0 } } });
      return;
    }
    await route.fulfill({ json: [] });
  });
}

test("finalized status survives navigation and hard reload on phone and desktop", async ({ page }) => {
  await mockFinalizedAccount(page);
  for (const viewport of [{ width: 360, height: 800 }, { width: 1280, height: 900 }]) {
    await page.setViewportSize(viewport);
    await page.goto("#/migration");
    await expect(page.locator("[data-migration-finalized]")).toBeVisible();
    await expect(page.locator("[data-migration-finalized]")).toContainText("status=finalized");
    await expect(page.locator("[data-migration-finalized]")).toContainText("source-hash");
    await expect(page.locator("[data-migration-finalized]")).toContainText("target-hash");
    await expect(page.locator("[data-migration-finalized]")).toContainText("0 / 0 / 0");
    await expect(page.locator("#migration-audit, #migration-run, #migration-finalize")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    await page.goto("#/settings");
    await expect(page.locator("[data-sync-status]")).toContainText("正規化雲端資料為權威來源");
    await page.goto("#/migration");
    await expect(page.locator("[data-migration-finalized]")).toBeVisible();
    await page.reload();
    await expect(page.locator("[data-migration-finalized]")).toBeVisible();
    await expect(page.locator("#migration-audit, #migration-run, #migration-finalize")).toHaveCount(0);
  }
});
