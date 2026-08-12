import { describe, expect, it } from "vitest";
import { createBackup, parseBackup } from "./backup.js";
import { decodeRecordBytes, fnv1a, parseGame } from "./parser.js";
import { MemoryRepository, parseStoredData } from "./repository.js";

const kif = `手合割：平手
先手：A
後手：B

   1 ７六歩(77)
   2 ３四歩(33)
   3 ２六歩(27)
`;
const expectedMoves = ["☗７六歩", "☖３四歩", "☗２六歩"];

describe("record parsing and canonical identity", () => {
  it.each(["KIF", "KI2", "CSA"] as const)("keeps the corrected %s ply invariant", (format) => {
    const source = format === "KIF" ? kif : format === "KI2" ? kif.replace(/ {3}\d /g, "▲") : "V2.2\nPI\n+\n+7776FU\n-3334FU\n+2726FU\n%TORYO\n";
    const game = parseGame(source, format, "測試");
    expect(game.moves).toEqual(expectedMoves);
    expect(game.sfens).toHaveLength(4);
    expect(game.sfens[0]).toBe(game.initialSfen);
  });
  it("decodes UTF-8 and Shift-JIS explicitly", () => {
    expect(decodeRecordBytes(new TextEncoder().encode("手合割：平手"))).toContain("平手");
    expect(decodeRecordBytes(Uint8Array.from([0x8e, 0x71]))).toBe("子");
  });
  it("hashes canonical values deterministically", () => { expect(fnv1a("a|b")).toBe(fnv1a("a|b")); expect(fnv1a("a|b")).not.toBe(fnv1a("a|c")); });
});

describe("schema v3 data", () => {
  it("round-trips reason-only data and rejects unknown versions", () => {
    const game = parseGame(kif, "KIF");
    game.reviewPoints.push({ id: "p", ply: 1, sfen: game.sfens[1]!, reason: "其他", issueTags: [], createdAt: "2026-08-12T00:00:00.000Z" });
    const data = parseBackup(JSON.stringify(createBackup({ games: [game] })));
    expect(data.games[0]?.reviewPoints[0]?.reason).toBe("其他");
    expect(() => parseBackup(JSON.stringify({ schemaVersion: 99, data }))).toThrow("不支援");
  });
  it("maps v1 legacy prose and unknown category without loss", () => {
    const game = parseGame(kif, "KIF");
    const legacy = { ...game, reviewPoints: [{ id: "p", ply: 1, sfen: game.sfens[1], thinking: "想法", nextConsideration: "下次", category: "新分類", tag: "自訂", candidates: "候選", opponentResponse: "應手", externalNotes: "外部", createdAt: "2026-08-12T00:00:00.000Z" }], cards: [{ id: "c", reviewPointId: "p", dueDate: "2026-08-12", interval: 1, createdAt: "2026-08-12" }] };
    const migrated = parseBackup(JSON.stringify({ schemaVersion: 1, data: { games: [legacy] } }));
    const point = migrated.games[0]!.reviewPoints[0]!;
    expect(point.reason).toBe("其他");
    expect(point.note).toBe("下次");
    expect(point.legacyNotes).toContain("舊分類：新分類");
    expect(point.legacyNotes).toContain("當時想法：想法");
    expect(migrated.games[0]!.reviewPoints).toHaveLength(1);
  });
  it("repository preserves a load failure without replacing data", async () => {
    const game = parseGame(kif, "KIF");
    const repository = new MemoryRepository({ games: [game] });
    expect((await repository.load()).games).toHaveLength(1);
    expect(() => parseStoredData({ schemaVersion: 99, data: { games: [] } })).toThrow("不支援");
  });
});
