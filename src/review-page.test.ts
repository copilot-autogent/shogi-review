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
const game = (id: string, createdAt: string, pointIds: string[], pointPlys = pointIds.map((_, index) => index + 1)): Game => ({
  id, title: `棋局 ${id}`, sourceFormat: "KIF", sourceText: "source", initialSfen: positions[0]!, sfens: positions,
  moves: ["一", "二", "三", "四", "五", "六"], canonicalHash: id, createdAt,
  reviewPoints: pointIds.map((pointId, index) => ({ id: pointId, ply: pointPlys[index]!, sfen: positions[pointPlys[index]!]!, reason: "計算錯誤", issueTags: ["候選手"], note: `秘密答案-${pointId}`, externalNotes: `外部-${pointId}`, legacyNotes: `舊版-${pointId}`, createdAt })),
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
    expect(continuation).toContain("實戰後續第 2 手");
    expect(continuation).toContain("#/game/a?ply=3");
    const laterContinuation = renderReviewPage(buildReviewViewModel(data, route, state({ revealed: true, continuationOpen: true, continuationPly: 4 })));
    expect(laterContinuation).toContain("四");
    expect(laterContinuation).toContain("實戰後續第 3 手");
    expect(laterContinuation).toContain("#/game/a?ply=4");
  });

  it("keeps recommendation text and metadata out of the DOM until reveal", () => {
    const item = game("a", "2026-01-01", ["p"]);
    item.reviewPoints[0]!.recommendedMoves = [{ id: "rec-1", move: "<script>alert(1)</script>", comment: "comment & text" }];
    const route = parseReviewRoute(reviewRoute("a", "p"))!;
    const hidden = renderReviewPage(buildReviewViewModel({ games: [item] }, route, state()));
    expect(hidden).not.toContain("推薦手");
    expect(hidden).not.toContain("rec-1");
    expect(hidden).not.toContain("comment");
    const revealed = renderReviewPage(buildReviewViewModel({ games: [item] }, route, state({ revealed: true })));
    expect(revealed).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(revealed).toContain("comment &amp; text");
    expect(revealed).not.toContain("<script>alert(1)</script>");
  });

  it("separates history, anchor, and continuation phases at game boundaries", () => {
    const data: AppData = { games: [game("a", "2026-01-01", ["start", "middle", "end"], [0, 3, 6])] };
    const make = (pointId: string, overrides: Partial<Parameters<typeof buildReviewViewModel>[2]>) => buildReviewViewModel(
      data,
      parseReviewRoute(reviewRoute("a", pointId))!,
      state(overrides),
    );

    const startHistory = make("start", { displayedPly: 0 });
    expect(startHistory.phase).toBe("anchor");
    expect(startHistory.displayedPly).toBe(0);
    expect(renderReviewPage(startHistory)).toContain("儲存的決策局面");
    expect(renderReviewPage(startHistory)).toContain("輪到先手");
    const startContinuation = make("start", { revealed: true, continuationOpen: true, continuationPly: 1 });
    expect(startContinuation.phase).toBe("continuation");
    expect(startContinuation.displayedPly).toBe(1);
    expect(renderReviewPage(startContinuation)).toContain("實戰後續第 1 手");
    expect(renderReviewPage(startContinuation)).toContain("#/game/a?ply=1");
    expect(renderReviewPage(startContinuation)).not.toContain("data-review-prev-history");
    expect(renderReviewPage(startContinuation)).toContain("data-review-close-continuation");

    const middleHistory = make("middle", { displayedPly: 2 });
    expect(middleHistory.phase).toBe("history");
    expect(middleHistory.displayedPly).toBe(2);
    expect(renderReviewPage(middleHistory)).toContain("目前顯示的是決策局面之前的歷史");
    expect(renderReviewPage(middleHistory)).toContain("輪到先手");
    const middleAnchor = make("middle", { displayedPly: 3 });
    expect(middleAnchor.phase).toBe("anchor");
    expect(middleAnchor.displayedPly).toBe(3);
    expect(renderReviewPage(middleAnchor)).toContain("儲存的決策局面");
    expect(renderReviewPage(middleAnchor)).toContain("輪到後手");
    const middleContinuation = make("middle", { revealed: true, continuationOpen: true, continuationPly: 4 });
    expect(middleContinuation.phase).toBe("continuation");
    expect(middleContinuation.displayedPly).toBe(4);
    expect(renderReviewPage(middleContinuation)).toContain("實戰後續第 1 手");
    expect(renderReviewPage(middleContinuation)).toContain("#/game/a?ply=4");

    const end = make("end", { revealed: true, continuationOpen: true, displayedPly: 6, continuationPly: 7 });
    expect(end.phase).toBe("anchor");
    expect(end.continuationOpen).toBe(false);
    expect(end.displayedPly).toBe(6);
    expect(renderReviewPage(end)).toContain("這局在儲存局面後沒有更多實戰後續。");
    expect(renderReviewPage(end)).not.toContain("實戰後續第");
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
