import { describe, expect, it } from "vitest";
import { createBackup, parseBackup } from "./backup.js";
import { decodeRecordBytes, fnv1a, parseGame } from "./parser.js";
import { answerCard, addDays, newCard, type Clock } from "./schedule.js";
import { MemoryRepository } from "./repository.js";

const kif = `手合割：平手
先手：A
後手：B

   1 ７六歩(77)
   2 ３四歩(33)
   3 ２六歩(27)
`;

describe("record parsing and canonical identity", () => {
  it("parses a KIF main line and stores every SFEN", () => {
    const game = parseGame(kif, "KIF", "測試");
    expect(game.moves.length).toBeGreaterThan(0);
    expect(game.sfens).toHaveLength(game.moves.length + 1);
    expect(game.initialSfen).toContain("lnsgkgsnl");
  });
  it("decodes UTF-8 and Shift-JIS explicitly", () => {
    const utf8 = new TextEncoder().encode("手合割：平手");
    expect(decodeRecordBytes(utf8)).toContain("平手");
    const sjis = Uint8Array.from([0x8e, 0x71]);
    expect(decodeRecordBytes(sjis)).toBe("子");
  });
  it("hashes equivalent normalized sequences independently of source format", () => {
    expect(fnv1a("a|b")).toBe(fnv1a("a|b"));
    expect(fnv1a("a|b")).not.toBe(fnv1a("a|c"));
  });
});

describe("durable data and scheduling", () => {
  const clock: Clock = { now: () => new Date("2026-08-12T11:00:00Z") };
  it("round-trips a complete backup and rejects unknown versions", () => {
    const data = { games: [parseGame(kif, "KIF")] };
    const restored = parseBackup(JSON.stringify(createBackup(data, clock.now())));
    expect(restored.games[0]?.sfens).toEqual(data.games[0]?.sfens);
    expect(() => parseBackup(JSON.stringify({ schemaVersion: 99, data }))).toThrow("不支援");
  });
  it("uses deterministic UTC dates and caps remembered cards at 14 days", () => {
    const card = newCard("point", clock);
    expect(card.dueDate).toBe("2026-08-13");
    const remembered = answerCard(answerCard(answerCard(card, "remembered", clock), "remembered", clock), "remembered", clock);
    expect(remembered.interval).toBe(14);
    expect(answerCard(remembered, "remembered", clock).interval).toBe(14);
    expect(addDays("2026-08-12", 1)).toBe("2026-08-13");
  });
  it("keeps repository round-trip isolated", async () => {
    const repository = new MemoryRepository();
    const data = { games: [parseGame(kif, "KIF")] };
    await repository.save(data);
    expect((await repository.load()).games).toHaveLength(1);
  });
});
