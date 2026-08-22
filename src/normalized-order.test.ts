import { describe, expect, it } from "vitest";
import { importSourceOrder, MAX_SOURCE_ORDER } from "./normalized-order.js";

describe("normalized import ordering", () => {
  it("uses a bounded minute order instead of a millisecond timestamp", () => {
    const order = importSourceOrder("2026-08-22T13:27:09.151Z");
    expect(order).toBeGreaterThan(0);
    expect(order).toBeLessThan(MAX_SOURCE_ORDER);
    expect(Number.isSafeInteger(order)).toBe(true);
  });

  it("keeps migrated compact rows first and clamps invalid/out-of-range dates", () => {
    expect(importSourceOrder("not-a-date")).toBe(0);
    expect(importSourceOrder("2019-12-31T23:59:00Z")).toBe(0);
    expect(importSourceOrder("99999-01-01T00:00:00Z")).toBe(0);
    expect(importSourceOrder("2020-01-01T00:00:00Z")).toBe(0);
    expect(importSourceOrder("2020-01-01T00:01:00Z")).toBe(1);
  });

  it("intentionally permits same-minute ties for stable id ordering", () => {
    expect(importSourceOrder("2026-08-22T13:27:01Z")).toBe(importSourceOrder("2026-08-22T13:27:59Z"));
  });
});
