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
  const smallTargets = await page.locator("button:not(.moves button), a.button-link, header a, summary, input[type=file] + *").evaluateAll((elements) => elements.map((element) => {
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

test("route shells remain contained at every required width", async ({ page }) => {
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await page.goto("#/");
    await expect(page.locator("h1")).toBeVisible();
    await assertContained(page);
    await assertTargets(page);
    await page.goto("#/settings");
    await assertContained(page);
    await page.goto("#/review/missing/long-invalid-id");
    await expect(page.locator('[role="alert"]')).toBeVisible();
    await assertContained(page);
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
  const nav = page.locator(".review-navigation");
  await nav.scrollIntoViewIfNeeded();
  const overlap = await page.evaluate(() => {
    const nav = document.querySelector<HTMLElement>(".review-navigation")!.getBoundingClientRect();
    return Array.from(document.querySelectorAll<HTMLElement>("#review-answer, .continuation button, .continuation a")).some((element) => {
      const box = element.getBoundingClientRect();
      return box.bottom > nav.top && box.top < nav.bottom && box.right > nav.left && box.left < nav.right;
    });
  });
  expect(overlap).toBe(false);
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
  expect(await dialog.evaluate((element) => element.scrollHeight >= element.clientHeight)).toBe(true);
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(page.locator("[data-dialog]")).toContainText("取消");
  await page.locator("[data-dialog-cancel]").click();
  await expect(rename).toBeFocused();
});
