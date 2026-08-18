import { describe, expect, it } from "vitest";
import { createBackup, parseBackup } from "./backup.js";
import { NORMALIZED_STORAGE, canonicalNormalizedData, normalizedStorageEnabled, semanticSourceHash } from "./normalized.js";
import { parseGame } from "./parser.js";

const source = `手合割：平手
先手：A
後手：B

   1 ７六歩(77)
   2 ３四歩(33)
`;

describe("Phase A normalized foundation", () => {
  it("is dormant and preserves the JS semantic hash authority", async () => {
    const game = parseGame(source, "KIF", "Unicode 測試");
    const data = { games: [{ ...game, perspective: undefined }] };
    const backup = createBackup(data, new Date("2026-01-01T00:00:00.000Z"));
    const input = JSON.stringify(backup);
    expect(NORMALIZED_STORAGE).toBe(false);
    expect(normalizedStorageEnabled()).toBe(false);
    expect(await semanticSourceHash(input)).toBe(await semanticSourceHash(JSON.stringify({ ...backup, exportedAt: "different" })));
    expect(canonicalNormalizedData(parseBackup(input))).toBe(canonicalNormalizedData(data));
  });
});
