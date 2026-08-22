import { describe, expect, it } from "vitest";
import { importSourceOrder, IMPORT_ORDER_BASE, MAX_SOURCE_ORDER } from "./normalized-order.js";

describe("normalized import ordering", () => {
  it("uses a bounded minute order instead of a millisecond timestamp", () => {
    const order = importSourceOrder("2026-08-22T13:27:09.151Z");
    expect(order).toBeGreaterThan(0);
    expect(order).toBeLessThan(MAX_SOURCE_ORDER);
    expect(Number.isSafeInteger(order)).toBe(true);
  });

  it("keeps migrated compact rows in a disjoint lower namespace", () => {
    expect(importSourceOrder("2020-01-01T00:00:00Z")).toBe(IMPORT_ORDER_BASE);
    expect(importSourceOrder("2020-01-01T00:01:00Z")).toBe(IMPORT_ORDER_BASE + 1);
    expect(importSourceOrder("2026-08-22T13:27:09.151Z")).toBeGreaterThan(IMPORT_ORDER_BASE);
  });

  it("rejects invalid and out-of-range dates before insertion", () => {
    expect(() => importSourceOrder("not-a-date")).toThrow("無法建立安全的棋局排序值。");
    expect(() => importSourceOrder("2019-12-31T23:59:00Z")).toThrow("無法建立安全的棋局排序值。");
    expect(() => importSourceOrder("99999-01-01T00:00:00Z")).toThrow("無法建立安全的棋局排序值。");
  });

  it("intentionally permits same-minute ties for stable id ordering", () => {
    expect(importSourceOrder("2026-08-22T13:27:01Z")).toBe(importSourceOrder("2026-08-22T13:27:59Z"));
  });
});
