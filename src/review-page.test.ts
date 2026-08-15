import { describe, expect, it } from "vitest";
import type { AppData, Game } from "./model.js";
import { anchorIsValid, boundedHistoryPly, buildReviewViewModel, findReviewEntry, parseReviewRoute, renderReviewPage, reviewEntries, reviewRoute } from "./review-page.js";

const positions = [
  "9/9/9/9/9/9/9/9/9 b - 1",
  "9/9/9/9/9/9/9/9/9 w - 1",
  "9/9/9/9/9/9/9/9/9 b - 2",
  "9/9/9/9/9/9/9/9/9 w - 2",
  "9/9/9/9/9/9/9/9/9 b - 3",
  "9/9/9/9/9/9/9/9/9 w - 3",
  "9/9/9/9/9/9/9/9/9 b - 4",
];
const game = (id: string, createdAt: string, pointIds: string[]): Game => ({
  id, title: `棋局 ${id}`, sourceFormat: "KIF", sourceText: "source", initialSfen: positions[0]!, sfens: positions,
  moves: ["一", "二", "三", "四", "五", "六"], canonicalHash: id, createdAt,
  reviewPoints: pointIds.map((pointId, index) => ({ id: pointId, ply: index + 1, sfen: positions[index + 1]!, reason: "計算錯誤", issueTags: ["候選手"], note: `秘密答案-${pointId}`, externalNotes: `外部-${pointId}`, legacyNotes: `舊版-${pointId}`, createdAt })),
});
const state = (overrides: Partial<Parameters<typeof buildReviewViewModel>[2]> = {}) => ({ revealed: false, continuationOpen: false, displayedPly: 2, continuationPly: 2, ...overrides });

describe("dedicated review page seam", () => {
  it("uses composite identity and reports missing or ambiguous legacy routes", () => {
    const data: AppData = { games: [game("a", "2026-01-01", ["same"]), game("b", "2026-01-02", ["same"])] };
    expect(parseReviewRoute(reviewRoute("a", "same"))).toEqual({ kind: "review", gameId: "a", pointId: "same" });
    expect(findReviewEntry(data, parseReviewRoute("#/review/same")!)).toEqual({ reason: "複盤局面識別不唯一" });
    expect(buildReviewViewModel(data, parseReviewRoute("#/review/a/missing")!, state()).status).toBe("missing");
    expect(parseReviewRoute("#/review/a")).toEqual({ kind: "legacy", pointId: "a" });
    expect(parseReviewRoute("#/review/a/b/c")).toEqual({ kind: "invalid", reason: "malformed" });
  });

  it("renders no answer, continuation, or SFEN before reveal", () => {
    const data: AppData = { games: [game("a", "2026-01-01", ["p"])] };
    const route = parseReviewRoute(reviewRoute("a", "p"))!;
    const vm = buildReviewViewModel(data, route, state());
    const html = renderReviewPage(vm);
    expect(html).toContain("揭示記錄");
    expect(html).not.toContain("秘密答案-p");
    expect(html).not.toContain("外部-p");
    expect(html).not.toContain("舊版-p");
    expect(html).not.toContain(positions[2]!);
    expect(html).not.toContain("三");
    expect(html).not.toContain("查看實戰後續");
    const revealed = renderReviewPage(buildReviewViewModel(data, route, state({ revealed: true })) );
    expect(revealed).toContain("秘密答案-p");
    expect(revealed).toContain("查看實戰後續");
    expect(revealed).not.toContain("三");
    const continuation = renderReviewPage(buildReviewViewModel(data, route, state({ revealed: true, continuationOpen: true, continuationPly: 3 })));
    expect(continuation).toContain("三");
    const laterContinuation = renderReviewPage(buildReviewViewModel(data, route, state({ revealed: true, continuationOpen: true, continuationPly: 4 })));
    expect(laterContinuation).toContain("四");
  });

  it("clamps history to five plies and keeps anchor integrity explicit", () => {
    expect(boundedHistoryPly(0, -1)).toBe(0);
    expect(boundedHistoryPly(6, 0)).toBe(1);
    expect(boundedHistoryPly(6, 99)).toBe(6);
    const valid = game("a", "2026-01-01", ["p"]);
    expect(anchorIsValid(valid, valid.reviewPoints[0]!)).toBe(true);
    valid.reviewPoints[0]!.sfen = positions[0]!;
    expect(anchorIsValid(valid, valid.reviewPoints[0]!)).toBe(false);
    const vm = buildReviewViewModel({ games: [valid] }, parseReviewRoute(reviewRoute("a", "p"))!, state());
    expect(vm.status).toBe("invalid");
    expect(renderReviewPage(vm)).toContain("儲存的複盤局面與原棋譜不一致");
  });

  it("orders positions deterministically and exposes progress", () => {
    const data: AppData = { games: [game("b", "2026-01-02", ["p2"]), game("a", "2026-01-01", ["p1"])] };
    expect(reviewEntries(data).map(({ game: item }) => item.id)).toEqual(["a", "b"]);
    const vm = buildReviewViewModel(data, parseReviewRoute(reviewRoute("b", "p2"))!, state(), reviewEntries(data));
    expect(vm.index).toBe(1);
    expect(renderReviewPage(vm)).toContain("複盤進度 2 / 2");
  });
});
