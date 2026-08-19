import { expect, test, type Page } from "@playwright/test";
import { SUPABASE_URL } from "../src/sync.js";

const userId = "00000000-0000-0000-0000-000000000002";
const authStorageKey = `sb-${new URL(SUPABASE_URL).hostname.split(".")[0]}-auth-token`;

async function mockFinalizedAccount(page: Page): Promise<void> {
  await page.addInitScript(({ key, id }) => {
    localStorage.setItem(key, JSON.stringify({
      access_token: "offline-shell-access-token",
      refresh_token: "offline-shell-refresh-token",
      token_type: "bearer",
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: { id, aud: "authenticated", role: "authenticated", email: "offline-shell@example.test", user_metadata: {} },
    }));
  }, { key: authStorageKey, id: userId });
  await page.route("**/auth/v1/user", async (route) => {
    await route.fulfill({ json: { id: userId, aud: "authenticated", role: "authenticated", email: "offline-shell@example.test", user_metadata: {} } });
  });
  await page.route("**/rest/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/user_migrations")) {
      await route.fulfill({ json: { status: "finalized", source_hash: "offline-source", target_hash: "offline-target", counts: { games: 0, points: 0, recommendations: 0 } } });
      return;
    }
    await route.fulfill({ json: [] });
  });
}

test("production app shell reloads offline without serving API data from Cache Storage", async ({ page, context }) => {
  await mockFinalizedAccount(page);
  await page.goto("#/settings");
  await expect(page.locator("main [data-sync-status]")).toContainText("正規化雲端資料為權威來源");
  await page.evaluate(() => window.navigator.serviceWorker.ready);
  await page.reload();
  await expect.poll(() => page.evaluate(() => Boolean(window.navigator.serviceWorker.controller))).toBe(true);
  await context.setOffline(true);
  await page.reload({ waitUntil: "commit" }).catch(() => undefined);
  await expect(page.locator("main")).toBeVisible();
  await expect(page.locator("main [data-sync-status]")).toContainText("正規化雲端資料為權威來源");
  await expect(page.locator("[data-authority-warning]")).toContainText("目前離線；已停用雲端資料修改，重新連線後再試。");
  await expect(page.locator("#import, [data-rename], [data-game-delete], [data-delete], [data-add-recommendation]")).toHaveCount(0);
  await expect(page.evaluate(async (url) => {
    try {
      await window.fetch(url);
      return "served";
    } catch {
      return "blocked";
    }
  }, `${SUPABASE_URL}/rest/v1/games`)).resolves.toBe("blocked");
  const cacheUrls = await page.evaluate(async () => {
    const keys = await window.caches.keys();
    return (await Promise.all(keys.map(async (key) => (await window.caches.open(key)).keys()))).flat().map((request) => request.url);
  });
  expect(cacheUrls.every((url) => !/\/(?:auth|rest\/v1|rpc|functions\/v1|storage\/v1)\b/.test(url))).toBe(true);
  await context.setOffline(false);
});
