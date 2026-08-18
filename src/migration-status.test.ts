import { describe, expect, it } from "vitest";
import { parseGame } from "./parser.js";
import { renderFinalizedMigrationStatus } from "./migration-status.js";

describe("finalized migration status rendering", () => {
  it("shows non-sensitive proof and normalized counts without migration controls", () => {
    const game = parseGame(`手合割：平手
先手：A
後手：B

   1 ７六歩(77)
`, "KIF", "私的棋局標題");
    game.reviewPoints = [{
      id: "point-1",
      ply: 1,
      sfen: game.sfens[1] ?? game.initialSfen,
      reason: "計算錯誤",
      issueTags: [],
      note: "私的複盤內容",
      recommendedMoves: [{ id: "recommendation-1", move: "７七銀", comment: "私的建議" }],
      createdAt: game.createdAt,
    }];
    const html = renderFinalizedMigrationStatus({
      status: "finalized",
      source_hash: "source-hash",
      target_hash: "target-hash",
    }, { games: [game] });

    expect(html).toContain("status=finalized");
    expect(html).toContain("source-hash");
    expect(html).toContain("target-hash");
    expect(html).toContain("1 / 1 / 1");
    expect(html).toContain("正規化雲端資料現在是此帳號的權威來源；legacy 備份已保留。");
    expect(html).not.toContain("私的棋局標題");
    expect(html).not.toContain("私的複盤內容");
    expect(html).not.toContain("migration-audit");
    expect(html).not.toContain("migration-run");
    expect(html).not.toContain('id="migration-finalize"');
  });

  it("does not expose absent hashes as raw values", () => {
    const html = renderFinalizedMigrationStatus({ status: "finalized" }, { games: [] });
    expect(html).toContain("未提供");
    expect(html).toContain("0 / 0 / 0");
  });
});
