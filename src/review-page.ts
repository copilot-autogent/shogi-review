import type { AppData, Game, ReviewPoint } from "./model.js";
import { boardView, pieceRotated, type BoardOrientation } from "./orientation.js";

export type ReviewRoute =
  | { kind: "review"; gameId: string; pointId: string }
  | { kind: "legacy"; pointId: string }
  | { kind: "invalid"; reason: "malformed" | "ambiguous" };

export type ReviewEntry = { game: Game; point: ReviewPoint };

export type ReviewState = {
  revealed: boolean;
  continuationOpen: boolean;
  displayedPly: number;
  continuationPly: number;
};

export type ReviewViewModel = {
  status: "ready" | "missing" | "invalid";
  game?: Game;
  point?: ReviewPoint;
  reason?: string;
  orientation: BoardOrientation;
  displayedPly: number;
  continuationPly: number;
  revealed: boolean;
  continuationOpen: boolean;
  entries: ReviewEntry[];
  index: number;
};

const PIECES: Record<string, string> = { P: "歩", L: "香", N: "桂", S: "銀", G: "金", B: "角", R: "飛", K: "玉" };
const PROMOTED: Record<string, string> = { P: "と", L: "杏", N: "圭", S: "全", B: "馬", R: "龍" };

export function escapeReviewHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char] ?? char));
}

export function parseReviewRoute(hash: string): ReviewRoute | null {
  if (!hash.startsWith("#/review/")) return null;
  const parts = hash.slice("#/review/".length).split("/");
  if (parts.length === 2 && parts.every((part) => part.length > 0)) {
    try {
      return { kind: "review", gameId: decodeURIComponent(parts[0]!), pointId: decodeURIComponent(parts[1]!) };
    } catch {
      return { kind: "invalid", reason: "malformed" };
    }
  }
  if (parts.length === 1 && parts[0]) {
    try { return { kind: "legacy", pointId: decodeURIComponent(parts[0]!) }; } catch { return { kind: "invalid", reason: "malformed" }; }
  }
  return { kind: "invalid", reason: "malformed" };
}

function compareEntries(a: ReviewEntry, b: ReviewEntry): number {
  const created = Date.parse(a.game.createdAt) - Date.parse(b.game.createdAt);
  return created || a.game.id.localeCompare(b.game.id) || a.point.ply - b.point.ply || a.point.id.localeCompare(b.point.id);
}

export function reviewEntries(data: AppData): ReviewEntry[] {
  return data.games.flatMap((game) => game.reviewPoints.map((point) => ({ game, point }))).sort(compareEntries);
}

export function reviewRoute(gameId: string, pointId: string): string {
  return `#/review/${encodeURIComponent(gameId)}/${encodeURIComponent(pointId)}`;
}

export function findReviewEntry(data: AppData, route: ReviewRoute): { entry?: ReviewEntry; reason?: string } {
  if (route.kind === "invalid") return { reason: route.reason === "ambiguous" ? "複盤局面識別不唯一" : "複盤路徑格式無效" };
  const matches = reviewEntries(data).filter(({ game, point }) => point.id === route.pointId && (route.kind === "legacy" || game.id === route.gameId));
  if (matches.length > 1) return { reason: "複盤局面識別不唯一" };
  if (!matches.length) return {};
  return { entry: matches[0] };
}

export function anchorIsValid(game: Game, point: ReviewPoint): boolean {
  return Number.isInteger(point.ply) && point.ply >= 0 && point.ply < game.sfens.length && point.sfen === game.sfens[point.ply];
}

export function boundedHistoryPly(anchorPly: number, requestedPly: number): number {
  return Math.max(Math.max(0, anchorPly - 5), Math.min(anchorPly, Math.floor(requestedPly)));
}

export function continuationPly(anchorPly: number, gameLength: number, requestedPly: number): number {
  return Math.max(anchorPly, Math.min(gameLength, Math.floor(requestedPly)));
}

export function buildReviewViewModel(
  data: AppData,
  route: ReviewRoute,
  state: ReviewState,
  activeEntries?: ReviewEntry[],
  orientation: BoardOrientation = "normal",
): ReviewViewModel {
  const found = findReviewEntry(data, route);
  const entries = activeEntries?.length ? activeEntries : reviewEntries(data);
  if (!found.entry) return { status: found.reason ? "invalid" : "missing", reason: found.reason ?? "此複盤局面已不存在", orientation, displayedPly: 0, continuationPly: 0, revealed: false, continuationOpen: false, entries, index: -1 };
  const { game, point } = found.entry;
  if (!anchorIsValid(game, point)) return { status: "invalid", reason: "儲存的複盤局面與原棋譜不一致", game, point, orientation, displayedPly: point.ply, continuationPly: point.ply, revealed: false, continuationOpen: false, entries, index: -1 };
  const index = entries.findIndex((entry) => entry.game.id === game.id && entry.point.id === point.id);
  const displayedPly = boundedHistoryPly(point.ply, state.displayedPly);
  const opened = state.revealed && state.continuationOpen;
  return { status: "ready", game, point, orientation, displayedPly: opened ? continuationPly(point.ply, game.moves.length, state.continuationPly) : displayedPly, continuationPly: opened ? continuationPly(point.ply, game.moves.length, state.continuationPly) : point.ply, revealed: state.revealed, continuationOpen: opened, entries, index };
}

function pieceName(piece: string, promoted: boolean): string {
  return (promoted ? PROMOTED[piece.toUpperCase()] : PIECES[piece.toUpperCase()]) ?? piece;
}

function hands(sfen: string, side: "gote" | "sente", orientation: BoardOrientation): string {
  const hand = sfen.split(" ")[2] ?? "-";
  const counts = new Map<string, number>();
  let multiplier = 0;
  for (const char of hand) {
    if (/\d/.test(char)) { multiplier = multiplier * 10 + Number(char); continue; }
    const isGote = char === char.toLowerCase();
    if (char !== "-" && isGote === (side === "gote")) counts.set(char.toUpperCase(), (counts.get(char.toUpperCase()) ?? 0) + (multiplier || 1));
    multiplier = 0;
  }
  const rotated = orientation === "normal" ? side === "gote" : side === "sente";
  return [...counts.entries()].map(([piece, count]) => `<span class="hand-piece${rotated ? " rotated" : ""}">${pieceName(piece, false)}${count > 1 ? `<b aria-label="${count}枚">×${count}</b>` : ""}</span>`).join("") || "<span class=\"empty-hand\">なし</span>";
}

function board(sfen: string, orientation: BoardOrientation): string {
  const view = boardView(sfen, orientation);
  if (!view) return `<p class="error">此局面無法安全顯示。</p>`;
  const cells = view.cells.map((cell) => {
    if (!cell.piece) return `<span class="square"></span>`;
    const owner = cell.piece === cell.piece.toUpperCase() ? "sente" : "gote";
    return `<span class="square piece ${owner}${pieceRotated(cell.piece, orientation) ? " rotated" : ""}${cell.promoted ? " promoted" : ""}">${pieceName(cell.piece, Boolean(cell.promoted))}</span>`;
  }).join("");
  const hand = (owner: "gote" | "sente") => `<div class="hand" aria-label="${owner === "gote" ? "後手持駒" : "先手持駒"}" role="region" tabindex="0"><span class="hand-label">${owner === "gote" ? "後手持駒" : "先手持駒"}</span>${hands(sfen, owner, orientation)}</div>`;
  const turn = (sfen.split(" ")[1] ?? "b") === "w" ? "輪到後手" : "輪到先手";
  return `<div class="position" data-orientation="${orientation}"><div class="orientation-toolbar"><span role="status" aria-live="polite">${turn}</span><button type="button" class="secondary" data-review-flip aria-label="翻轉棋盤" aria-pressed="${orientation === "flipped"}">翻轉棋盤</button></div>${hand(view.topHandOwner)}<div class="board" aria-label="將棋盤">${cells}</div>${hand(view.bottomHandOwner)}</div>`;
}

function answer(point: ReviewPoint): string {
  return `<section id="review-answer" tabindex="-1"><h2>揭示的記錄</h2><p><strong>原因：</strong>${escapeReviewHtml(point.reason)}</p><p><strong>問題：</strong>${point.issueTags.length ? point.issueTags.map(escapeReviewHtml).join("、") : "未標記"}</p>${point.note ? `<p><strong>下次要注意什麼：</strong>${escapeReviewHtml(point.note)}</p>` : ""}${point.externalNotes ? `<p><strong>外部分析：</strong>${escapeReviewHtml(point.externalNotes)}</p>` : ""}${point.legacyNotes ? `<details><summary>舊版筆記</summary><p>${escapeReviewHtml(point.legacyNotes)}</p></details>` : ""}</section>`;
}

export function renderReviewPage(vm: ReviewViewModel): string {
  if (vm.status !== "ready" || !vm.game || !vm.point) return `<main class="review-page"><section class="panel" role="alert"><h1>${escapeReviewHtml(vm.reason ?? "複盤局面無效")}</h1><a class="button-link" href="#/games">返回棋局</a></section></main>`;
  const { game, point } = vm;
  const atAnchor = vm.displayedPly === point.ply;
  const displaySfen = game.sfens[vm.displayedPly] ?? point.sfen;
  const historyStart = Math.max(0, point.ply - 5);
  const history = game.moves.slice(historyStart, point.ply).map((move, index) => `<li><button type="button" data-review-history="${historyStart + index + 1}">${escapeReviewHtml(move)}</button></li>`).join("");
  const continuation = vm.continuationOpen
    ? `<section class="panel continuation"><h2>實戰後續</h2><p>這裡是實戰後續第 ${Math.max(1, vm.continuationPly - point.ply)} 手。</p><ol class="moves">${game.moves.slice(point.ply, vm.continuationPly).map((move) => `<li>${escapeReviewHtml(move)}</li>`).join("")}</ol><a class="button-link" href="#/game/${encodeURIComponent(game.id)}?ply=${point.ply}">在原棋局繼續查看</a></section>`
    : "";
  const revealed = vm.revealed ? `${answer(point)}${vm.continuationOpen ? continuation : point.ply < game.moves.length ? `<button type="button" data-review-continuation>查看實戰後續</button>` : "<p class=\"muted\">這局在儲存局面後沒有更多實戰後續。</p>"}` : `<button type="button" data-review-reveal>揭示記錄</button>`;
  return `<main class="review-page"><div class="review-header"><a href="#/games">← 棋局</a><p class="muted">${escapeReviewHtml(game.title)} · 第 ${point.ply} 手後</p><h1>重新思考</h1><p role="status" aria-live="polite">複盤進度 ${Math.max(0, vm.index + 1)} / ${vm.entries.length}</p></div><section class="panel review-study">${board(displaySfen, vm.orientation)}<p class="review-anchor-status" role="status">${atAnchor ? "儲存的決策局面" : "目前顯示的是決策局面之前的歷史"}</p><ol class="moves">${history}</ol><div class="replay-controls"><button type="button" data-review-prev-history ${vm.displayedPly <= historyStart ? "disabled" : ""}>上一個歷史局面</button><button type="button" data-review-anchor ${atAnchor ? "disabled" : ""}>回到決策局面</button></div><p>如果再次遇到這個局面，你會怎麼想？</p>${revealed}</section><nav class="review-navigation" aria-label="複盤局面導航"><button type="button" data-review-prev ${vm.index <= 0 ? "disabled" : ""}>上一個複盤局面</button><button type="button" data-review-next ${vm.index < 0 || vm.index >= vm.entries.length - 1 ? "disabled" : ""}>下一個複盤局面</button></nav></main>`;
}
