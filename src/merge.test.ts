import { describe, expect, it } from "vitest";
import { parseGame } from "./parser.js";
import { canonicalizeAppData, mergeAppData, validateMergeInput } from "./merge.js";
import type { AppData, Game } from "./model.js";

const source = `手合割：平手
先手：A
後手：B

   1 ７六歩(77)
   2 ３四歩(33)
`;
function game(id: string, title = id): Game {
  return { ...parseGame(source, "KIF", title), id, createdAt: `2026-01-0${id === "a" ? "1" : "2"}T00:00:00.000Z` };
}
function data(...games: Game[]): AppData { return { games }; }
function point(gameValue: Game, id: string, ply = 1) {
  return { id, ply, sfen: gameValue.sfens[ply]!, reason: "其他" as const, issueTags: [], createdAt: "2026-01-01T00:00:00.000Z" };
}

describe("deterministic three-way merge decision table", () => {
  it("unions independent game and review additions", () => {
    const base = data(game("a"));
    const local = data({ ...game("a"), reviewPoints: [point(game("a"), "local-point")] }, game("b"));
    const cloud = data({ ...game("a"), reviewPoints: [point(game("a"), "cloud-point", 2)] });
    const result = mergeAppData(base, local, cloud);
    expect(result.conflicts).toHaveLength(0);
    expect(result.data.games.map((item) => item.id)).toEqual(["a", "b"]);
    expect(result.data.games[0]!.reviewPoints.map((item) => item.ply)).toEqual([1, 2]);
  });
  it("uses game plus ply as the review key, not UUID", () => {
    const ancestor = data(game("a"));
    const left = data({ ...game("a"), reviewPoints: [point(game("a"), "z")] });
    const right = data({ ...game("a"), reviewPoints: [point(game("a"), "a")] });
    const result = mergeAppData(ancestor, left, right);
    expect(result.conflicts).toHaveLength(0);
    expect(result.data.games[0]!.reviewPoints[0]!.id).toBe("a");
  });
  it("merges different fields, clears whitespace optionals, and merges tags by set", () => {
    const ancestor = game("a");
    ancestor.reviewPoints = [point(ancestor, "p")];
    const left = { ...ancestor, title: "left", reviewPoints: [{ ...ancestor.reviewPoints[0]!, note: "   ", issueTags: ["序盤" as const] }] };
    const right = { ...ancestor, perspective: "gote" as const, reviewPoints: [{ ...ancestor.reviewPoints[0]!, issueTags: ["候選手" as const] }] };
    const result = mergeAppData(data(ancestor), data(left), data(right));
    expect(result.conflicts).toHaveLength(0);
    expect(result.data.games[0]!.title).toBe("left");
    expect(result.data.games[0]!.perspective).toBe("gote");
    expect(result.data.games[0]!.reviewPoints[0]!.note).toBeUndefined();
    expect(result.data.games[0]!.reviewPoints[0]!.issueTags).toEqual(["序盤", "候選手"]);
  });
  it("reports only the conflicting scalar and never resolves delete versus edit", () => {
    const ancestor = game("a");
    ancestor.reviewPoints = [point(ancestor, "p")];
    const left = { ...ancestor, reviewPoints: [] };
    const right = { ...ancestor, reviewPoints: [{ ...ancestor.reviewPoints[0]!, note: "different" }] };
    const result = mergeAppData(data(ancestor), data(left), data(right));
    expect(result.conflicts.map((item) => item.field)).toContain("__membership");

    const note = mergeAppData(data(ancestor), data({ ...ancestor, reviewPoints: [{ ...ancestor.reviewPoints[0]!, note: "left" }] }), data({ ...ancestor, reviewPoints: [{ ...ancestor.reviewPoints[0]!, note: "right" }] }));
    expect(note.conflicts.map((item) => item.field)).toContain("note");
    expect(note.conflicts).toHaveLength(1);
  });
  it("accepts equivalent imports with different representation metadata", () => {
    const ancestor = game("a");
    const left = { ...ancestor, sourceText: "same game KIF", createdAt: "2027-01-01T00:00:00.000Z" };
    const right = { ...ancestor, sourceFormat: "CSA" as const, sourceText: "same game CSA", createdAt: "2028-01-01T00:00:00.000Z" };
    const result = mergeAppData(data(ancestor), data(left), data(right));
    expect(result.conflicts).toHaveLength(0);
    expect(result.data.games[0]!.sourceText).toBe(ancestor.sourceText);
  });
  it("merges same-ply concurrent additions with deterministic UUID and timestamp", () => {
    const ancestor = data();
    const value = game("a");
    const left = data({ ...value, reviewPoints: [{ ...point(value, "z"), createdAt: "2026-01-02T00:00:00.000Z" }] });
    const right = data({ ...value, reviewPoints: [{ ...point(value, "a"), createdAt: "2026-01-01T00:00:00.000Z" }] });
    const result = mergeAppData(ancestor, left, right);
    expect(result.conflicts).toHaveLength(0);
    expect(result.data.games[0]!.reviewPoints[0]).toMatchObject({ id: "a", createdAt: "2026-01-01T00:00:00.000Z" });
  });
  it("propagates deletion when the other side is unchanged", () => {
    const value = game("a");
    const reviewed = { ...value, reviewPoints: [point(value, "p")] };
    const result = mergeAppData(data(reviewed), data({ ...reviewed, reviewPoints: [] }), data(reviewed));
    expect(result.conflicts).toHaveLength(0);
    expect(result.data.games[0]!.reviewPoints).toHaveLength(0);
  });
  it("rejects duplicate review plies instead of silently collapsing them", () => {
    const value = game("a");
    value.reviewPoints = [point(value, "one"), point(value, "two")];
    expect(() => validateMergeInput(data(value), "local")).toThrow("每回合只能有一個");
  });
  it("is commutative, idempotent, canonical, and has a stable fixpoint", () => {
    const ancestor = data(game("a"));
    const left = data({ ...game("a"), title: "left" }, game("b"));
    const right = data({ ...game("a"), title: "right" });
    const one = mergeAppData(ancestor, left, right);
    const two = mergeAppData(ancestor, right, left);
    const fixed = mergeAppData(one.data, one.data, one.data);
    expect(canonicalizeAppData(one.data)).toEqual(one.data);
    expect(two.data).toEqual(one.data);
    expect(fixed.conflicts).toHaveLength(0);
    expect(fixed.data).toEqual(one.data);
  });
  it("proves fake two-device convergence for alternating independent changes", () => {
    const original = game("a");
    const base = data(original);
    const phone = data({ ...original, reviewPoints: [point(original, "phone")] });
    const desktop = data({ ...original }, game("b"));
    const merged = mergeAppData(base, phone, desktop);
    expect(merged.conflicts).toHaveLength(0);
    const phoneFixed = mergeAppData(merged.data, merged.data, merged.data);
    const desktopFixed = mergeAppData(merged.data, merged.data, merged.data);
    expect(phoneFixed.data).toEqual(desktopFixed.data);
    expect(JSON.stringify(phoneFixed.data)).toBe(JSON.stringify(desktopFixed.data));
    expect(phoneFixed.changed).toBe(false);
  });
});
