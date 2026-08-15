import { describe, expect, it } from "vitest";
import { createBackup, parseBackup } from "./backup.js";
import { applyConflictChoice } from "./conflict-resolution.js";
import { mergeAppData } from "./merge.js";
import { normalizeRecommendedMoves } from "./recommendations.js";
import { canonicalData, payloadHash } from "./sync.js";
import { parseGame } from "./parser.js";
import type { AppData, Game } from "./model.js";

const initialSfen = parseGame("手合割：平手\n先手：A\n後手：B\n\n   1 ７六歩(77)\n", "KIF", "g").initialSfen;
const game = (points: Game["reviewPoints"] = []): Game => ({
  ...parseGame("手合割：平手\n先手：A\n後手：B\n\n   1 ７六歩(77)\n", "KIF", "g"),
  id: "g", createdAt: "2026-01-01", reviewPoints: points,
});
const point = (recommendations?: Game["reviewPoints"][number]["recommendedMoves"]) => ({
  id: "p", ply: 0, sfen: initialSfen, reason: "其他" as const, issueTags: [], createdAt: "2026-01-01", ...(recommendations ? { recommendedMoves: recommendations } : {}),
});

describe("optional recommendations", () => {
  it("keeps an old v3 absent field byte-for-byte canonical and hash compatible", async () => {
    const data: AppData = { games: [game([point()])] };
    const loaded = parseBackup(JSON.stringify(createBackup(data, new Date("2026-01-01T00:00:00.000Z"))));
    expect(canonicalData(loaded)).toBe(canonicalData(data));
    expect(await payloadHash(loaded)).toBe(await payloadHash(data));
    expect("recommendedMoves" in loaded.games[0]!.reviewPoints[0]!).toBe(false);
  });
  it("normalizes and rejects malformed or duplicate rows", () => {
    expect(normalizeRecommendedMoves([{ id: " a ", move: " ７六歩 ", comment: "  memo " }])).toEqual([{ id: "a", move: "７六歩", comment: "memo" }]);
    expect(() => normalizeRecommendedMoves([{ id: "a", move: "x" }, { id: "a", move: "y" }])).toThrow();
    expect(() => normalizeRecommendedMoves([{ id: "a", move: " " }])).toThrow();
  });
  it("merges independent additions and granular edits with deterministic order", () => {
    const basePoint = point([{ id: "base", move: "A", comment: "old" }, { id: "keep", move: "K" }]);
    const base = { games: [game([basePoint])] };
    const local = { games: [game([point([{ id: "base", move: "A+", comment: "old" }, { id: "keep", move: "K" }, { id: "z", move: "Z" }])])] };
    const cloud = { games: [game([point([{ id: "base", move: "A", comment: "new" }, { id: "keep", move: "K" }, { id: "a", move: "A" }])])] };
    const merged = mergeAppData(base, local, cloud);
    expect(merged.conflicts).toHaveLength(0);
    expect(merged.data.games[0]!.reviewPoints[0]!.recommendedMoves?.map((item) => item.id)).toEqual(["base", "keep", "a", "z"]);
    expect(merged.data.games[0]!.reviewPoints[0]!.recommendedMoves?.[0]).toMatchObject({ move: "A+", comment: "new" });
    const deleted = mergeAppData(base, { games: [game([point([{ id: "keep", move: "K" }])])] }, base);
    expect(deleted.data.games[0]!.reviewPoints[0]!.recommendedMoves).toEqual([{ id: "keep", move: "K" }]);
  });
  it("applies nested recommendation conflict choices to the selected entry", () => {
    const base = { games: [game([point([{ id: "r", move: "A", comment: "base" }])])] };
    const local = { games: [game([point([{ id: "r", move: "L", comment: "base" }])])] };
    const cloud = { games: [game([point([{ id: "r", move: "C", comment: "base" }])])] };
    const result = mergeAppData(base, local, cloud);
    const target = globalThis.structuredClone(result.data);
    const conflict = result.conflicts.find((item) => item.field.endsWith(".move"))!;
    applyConflictChoice(target, local, cloud, conflict, "cloud");
    expect(target.games[0]!.reviewPoints[0]!.recommendedMoves).toEqual([{ id: "r", move: "C", comment: "base" }]);
  });
});
