import { expect, test, type Page } from "@playwright/test";

const viewports = [
  { width: 320, height: 720 },
  { width: 360, height: 800 },
  { width: 390, height: 844 },
  { width: 768, height: 900 },
  { width: 1280, height: 900 },
];

const kif = `手合割：平手
先手：A
後手：B

   1 ７六歩(77)
   2 ３四歩(33)
   3 ２六歩(27)
`;

async function assertContained(page: Page): Promise<void> {
  const metrics = await page.evaluate(() => {
    const viewport = document.documentElement.clientWidth;
    const overflow = document.documentElement.scrollWidth - viewport;
    const selectors = [".header-inner", ".account", ".panel", ".board", ".dialog", ".moves", ".actions"];
    const boxes = selectors.flatMap((selector) => Array.from(document.querySelectorAll<HTMLElement>(selector)).map((element) => {
      const box = element.getBoundingClientRect();
      return { selector, left: box.left, right: box.right, width: box.width, height: box.height };
    }));
    return { overflow, boxes };
  });
  expect(metrics.overflow, "only .hand may scroll horizontally").toBeLessThanOrEqual(1);
  for (const box of metrics.boxes) {
    expect(box.width, `${box.selector} has zero width`).toBeGreaterThan(0);
    expect(box.left, `${box.selector} starts offscreen`).toBeGreaterThanOrEqual(-1);
    expect(box.right, `${box.selector} ends offscreen`).toBeLessThanOrEqual((await page.evaluate(() => document.documentElement.clientWidth)) + 1);
  }
}

async function assertTargets(page: Page): Promise<void> {
  const smallTargets = await page.locator("button:not(.moves button), a.button-link, a.nav-link, summary, input[type=file] + *").evaluateAll((elements) => elements.map((element) => {
    const box = element.getBoundingClientRect();
    return { width: box.width, height: box.height };
  }));
  for (const target of smallTargets) {
    if (target.width > 0 && target.height > 0) {
      expect(target.width).toBeGreaterThanOrEqual(44);
      expect(target.height).toBeGreaterThanOrEqual(44);
    }
  }
}

async function assertNavLink(page: Page, name: string, selector = "a.nav-link"): Promise<void> {
  const link = page.locator(selector).filter({ hasText: name }).first();
  await expect(link, `${name} nav link should exist`).toBeVisible();
  const box = await link.boundingBox();
  expect(box, `${name} nav link should have a box`).not.toBeNull();
  expect(box!.width, `${name} nav link width`).toBeGreaterThanOrEqual(44);
  expect(box!.height, `${name} nav link height`).toBeGreaterThanOrEqual(44);
}

test("route shells remain contained at every required width", async ({ page }) => {
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await page.goto("#/");
    await expect(page.locator("h1")).toBeVisible();
    await assertContained(page);
    await assertTargets(page);
    await assertNavLink(page, "查看全部");
    await assertNavLink(page, "設定", "header a.nav-link");
    await page.goto("#/games");
    await assertContained(page);
    await assertNavLink(page, "← 首頁", "main .nav-link");
    await page.goto("#/settings");
    await assertContained(page);
    await assertNavLink(page, "← 首頁", "main > a.nav-link");
    await page.goto("#/review/missing/long-invalid-id");
    await expect(page.locator('[role="alert"]')).toBeVisible();
    await assertContained(page);
    await assertNavLink(page, "返回棋局", '[role="alert"] .nav-link');
  }
});

test("import, game, review reveal and continuation stay usable on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("#/import");
  await page.locator("#import-panel summary").click();
  await page.locator("#title").fill("這是一個非常長的棋局標題，用來確認它不會把操作推到畫面之外");
  await page.locator("#source").fill(kif);
  await page.locator("#import").click();
  await expect(page.locator("h1")).toContainText("非常長");
  await page.locator("#reason").selectOption({ label: "計算錯誤" });
  await page.locator("#point-form button[type=submit]").click();
  await expect(page.locator(".saved-review-list a")).toBeVisible();
  await page.locator(".saved-review-list a").click();
  await page.locator("[data-review-reveal]").click();
  await expect(page.locator("#review-answer")).toBeVisible();
  await page.locator("[data-review-continuation]").click();
  await expect(page.locator(".continuation")).toBeVisible();
  await assertContained(page);
  for (const target of await page.locator(".continuation button, .continuation a").all()) {
    await target.evaluate((element) => element.scrollIntoView({ block: "center", inline: "nearest" }));
    const overlap = await target.evaluate((element) => {
      const nav = document.querySelector<HTMLElement>(".review-navigation")!.getBoundingClientRect();
      const box = element.getBoundingClientRect();
      return box.bottom > nav.top && box.top < nav.bottom && box.right > nav.left && box.left < nav.right;
    });
    expect(overlap).toBe(false);
  }
});

test("rename dialog follows kind focus policy, traps focus, and survives 200% zoom", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto("#/import");
  await page.locator("#import-panel summary").click();
  await page.locator("#title").fill("可供對話框測試的棋局");
  await page.locator("#source").fill(kif);
  await page.locator("#import").click();
  const rename = page.locator("[data-rename]");
  await rename.click();
  await expect(page.locator("[data-dialog]")).toBeVisible();
  await expect(page.locator("#dialog-input")).toBeFocused();
  await page.evaluate(() => { document.documentElement.style.zoom = "2"; });
  const dialog = page.locator("[data-dialog] .dialog");
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  const focusSequence: boolean[] = [];
  let cancelFocused = false;
  for (let index = 0; index < 6; index += 1) {
    await page.keyboard.press("Tab");
    focusSequence.push(await page.evaluate(() => Boolean(document.activeElement?.closest("[data-dialog]"))));
    if (await page.locator("[data-dialog-cancel]").evaluate((element) => element === document.activeElement)) {
      cancelFocused = true;
      break;
    }
  }
  expect(focusSequence.every(Boolean)).toBe(true);
  expect(cancelFocused).toBe(true);
  await page.locator("[data-dialog-cancel]").click();
  await expect(rename).toBeFocused();
});
