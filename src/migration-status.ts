import type { AppData } from "./model.js";
import { countData } from "./migration-flow.js";
import type { MigrationStatus } from "./normalized.js";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[character] ?? character));
}

function proofValue(value: string | null | undefined): string {
  return value ? escapeHtml(value) : "未提供";
}

function countValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

export function renderFinalizedMigrationStatus(status: MigrationStatus, data: AppData): string {
  const localCounts = countData(data);
  const counts = {
    games: countValue(status.counts?.games, localCounts.games),
    points: countValue(status.counts?.points ?? status.counts?.review_points ?? status.counts?.reviewPoints, localCounts.points),
    recommendations: countValue(status.counts?.recommendations ?? status.counts?.recommended_moves ?? status.counts?.recommendedMoves, localCounts.recommendations),
  };
  return `<section class="panel migration-finalized" data-migration-finalized><h2>資料遷移已完成</h2><p role="status">status=finalized</p><p class="success">正規化雲端資料現在是此帳號的權威來源；legacy 備份已保留。</p><dl><dt>source hash</dt><dd><code>${proofValue(status.source_hash)}</code></dd><dt>target hash</dt><dd><code>${proofValue(status.target_hash)}</code></dd><dt>games / review points / recommendations</dt><dd>${counts.games} / ${counts.points} / ${counts.recommendations}</dd></dl></section>`;
}
