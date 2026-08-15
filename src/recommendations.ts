import type { RecommendedMove } from "./model.js";

export function normalizeRecommendedMoves(value: unknown): RecommendedMove[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("備份含有無效推薦手，未套用任何變更。");
  const ids = new Set<string>();
  const result: RecommendedMove[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") throw new Error("備份含有無效推薦手，未套用任何變更。");
    const raw = item as Record<string, unknown>;
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    if (!id || ids.has(id)) {
      throw new Error("備份含有無效或重複推薦手 ID，未套用任何變更。");
    }
    if (typeof raw.move !== "string" || !raw.move.trim()) {
      throw new Error("備份含有無效推薦手，未套用任何變更。");
    }
    if (raw.comment !== undefined && typeof raw.comment !== "string") {
      throw new Error("備份含有無效推薦手說明，未套用任何變更。");
    }
    ids.add(id);
    const move = raw.move.trim();
    const comment = typeof raw.comment === "string" && raw.comment.trim() ? raw.comment.trim() : undefined;
    result.push(comment === undefined ? { id, move } : { id, move, comment });
  }
  return result.length ? result : undefined;
}

export function recommendationMap(value: unknown): Map<string, RecommendedMove> {
  return new Map((normalizeRecommendedMoves(value) ?? []).map((item) => [item.id, item]));
}
