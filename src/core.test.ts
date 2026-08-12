import { describe, expect, it } from "vitest";
import { createBackup, parseBackup } from "./backup.js";
import { decodeRecordBytes, fnv1a, parseGame } from "./parser.js";
import { answerCard, addDays, newCard, type Clock } from "./schedule.js";
import { MemoryRepository, parseStoredData } from "./repository.js";

const kif = `手合割：平手
先手：A
後手：B

   1 ７六歩(77)
   2 ３四歩(33)
   3 ２六歩(27)
`;
const ki2 = `手合割：平手
先手：A
後手：B

▲７六歩(77)△３四歩(33)▲２六歩(27)`;
const csa = `V2.2
PI
+
+7776FU
-3334FU
+2726FU
%TORYO
`;

const expectedMoves = ["☗７六歩", "☖３四歩", "☗２六歩"];

describe("record parsing and canonical identity", () => {
  it.each([
    ["KIF", kif],
    ["KI2", ki2],
    ["CSA", csa],
  ] as const)("parses a %s main line without root or terminal nodes", (format, source) => {
    const game = parseGame(source, format, "測試");
    expect(game.moves).toEqual(expectedMoves);
    expect(game.moves).toHaveLength(3);
    expect(game.sfens).toHaveLength(4);
    expect(game.initialSfen).toContain("lnsgkgsnl");
    expect(game.sfens[0]).toBe(game.initialSfen);
    expect(game.sfens[1]).not.toBe(game.initialSfen);
    expect(game.sfens[3]).toContain("2P4P1");
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
    expect(parseBackup(JSON.stringify({ schemaVersion: 1, data })).games[0]?.moves).toEqual(data.games[0]?.moves);
    const game = data.games[0]!;
    const legacySfens = [game.sfens[0]!, ...game.sfens];
    const legacyData = {
      games: [{
        ...game,
        sfens: legacySfens,
        moves: ["開始局面", ...game.moves],
        canonicalHash: fnv1a(`${game.sfens[0]}|${legacySfens.join("|")}`),
      }],
    };
    expect(() => parseBackup(JSON.stringify({ schemaVersion: 1, data: legacyData }))).toThrow("重新匯入");
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
  it("validates legacy raw IndexedDB data instead of silently shifting or accepting it", () => {
    const data = { games: [parseGame(kif, "KIF")] };
    expect(parseStoredData(data).games[0]?.sfens).toEqual(data.games[0]?.sfens);
    const game = data.games[0]!;
    const legacySfens = [game.sfens[0]!, ...game.sfens];
    expect(() => parseStoredData({
      games: [{
        ...game,
        sfens: legacySfens,
        moves: ["開始局面", ...game.moves],
        canonicalHash: fnv1a(`${game.sfens[0]}|${legacySfens.join("|")}`),
      }],
    })).toThrow("重新匯入");
  });
});
