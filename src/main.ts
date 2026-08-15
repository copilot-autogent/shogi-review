import { createBackup, parseBackup } from "./backup.js";
import { detectFormat, decodeRecordBytes, parseGame, type InputFormat } from "./parser.js";
import { ISSUE_TAGS, PERSPECTIVES, REASONS, type AppData, type Game, type IssueTag, type Perspective, type Reason, type ReviewPoint } from "./model.js";
import { normalizeRecommendedMoves } from "./recommendations.js";
import { IndexedDbRepository, MemoryProfileRepository, type ProfileKey, type ProfileRepository } from "./repository.js";
import { AutoSyncEngine, currentUser, downloadKifu, finishPkceCallback, googleRedirectUrl, startGoogleLogin, supabase, SupabaseSyncRepository, type PendingConflict, type SyncMetadata, type SyncStatus } from "./sync.js";
import { resolveConflict as resolveConflictSafely } from "./conflict-resolution.js";
import { dialogInitialFocus } from "./dialog-focus.js";
import { boardView, pieceRotated, type BoardOrientation } from "./orientation.js";
import { AuthTransitionGate, drainLatestAuthTransitions, loadGuestSafely, loadProfileIfCurrent, settleAccountCleanup } from "./profile-state.js";
import { buildReviewViewModel, findReviewEntry, parseReviewRoute, renderReviewPage, reviewEntries, reviewRoute, type ReviewEntry, type ReviewState } from "./review-page.js";
import type { Session } from "@supabase/supabase-js";
import "./style.css";

let repo: ProfileRepository;
try { repo = "indexedDB" in window ? new IndexedDbRepository() : new MemoryProfileRepository(); } catch { repo = new MemoryProfileRepository(); }
let data: AppData = { games: [] };
let activeProfile: ProfileKey = "guest";
let activeUser: { id: string; email?: string; user_metadata?: Record<string, unknown> } | null = null;
let profileGeneration = 0;
type TransitionUser = { id: string; email?: string; user_metadata?: Record<string, unknown> };
type ProfileTransition = { generation: number; profile: ProfileKey; user: TransitionUser | null };
let profileTransition: ProfileTransition | undefined;
let desiredUserId: string | undefined;
let queuedAuthSession: Session | null | undefined;
let authTransitionRunning = false;
let activeAuthSession: Session | null | undefined;
let profileLoadFailed = false;
let selectedGame: Game | undefined;
let selectedPly = 0;
let startupError = "";
let renderedRoute = "";
let syncStatus: SyncStatus = "僅本機";
let syncMessage = "";
let syncMetadata: SyncMetadata = { hashVersion: 1 };
let localDataVersion = 0;
let pendingConflict: PendingConflict | undefined;
let dialogBusy = false;
let conflictResolutionRunning = false;
let conflictResolutionAbort: AbortController | undefined;
const authTransitionGate = new AuthTransitionGate();
let backupReady = false;
let dialogReturnFocus: HTMLElement | null = null;
let pendingGuestImport: { uid: string; guest: AppData } | undefined;
let temporaryFlip: { gameId: string; flipped: boolean } | undefined;
let reviewNavigation: ReviewEntry[] | undefined;
let reviewState: ReviewState = { revealed: false, continuationOpen: false, displayedPly: 0, continuationPly: 0 };
let reviewIdentity = "";
let importDraft = { title: "", format: "KIF" as InputFormat, source: "", perspective: "spectator" as Perspective };
const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("找不到 app 容器。");
const esc = (value: string): string => value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c] ?? c));
const uid = (prefix: string): string => `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`;
const statusText = (): string => {
  if (syncStatus === "已同步") return `已同步 · ${relativeTime(syncMetadata.lastSyncedAt)}`;
  if (syncStatus === "離線／同步失敗") return "同步失敗 · 重試";
  if (syncStatus === "衝突") return "需要處理衝突";
  return syncStatus;
};
function relativeTime(value?: string): string {
  if (!value) return "剛剛";
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 1000));
  if (seconds < 60) return "剛剛";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分鐘前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小時前`;
  return `${Math.floor(seconds / 86400)} 天前`;
}
const autosync = new AutoSyncEngine({
  identity: () => activeUser && !profileTransition && !profileLoadFailed && !pendingConflict && !pendingGuestImport ? { uid: activeUser.id, profile: activeProfile, generation: profileGeneration } : null,
  load: () => Promise.resolve(globalThis.structuredClone(data)),
  save: async (next) => {
    const profile = activeProfile; const uid = activeUser?.id; const generation = profileGeneration;
    if (!uid || profileTransition || profileLoadFailed) return;
    await repo.saveProfile(profile, next);
    if (activeUser?.id === uid && activeProfile === profile && profileGeneration === generation && !profileTransition && !profileLoadFailed) data = globalThis.structuredClone(next);
  },
  getMetadata: (userId) => readMetadata(userId),
  setMetadata: (userId, metadata) => { syncMetadata = metadata; return Promise.resolve(writeMetadata(userId, metadata)); },
  loadBase: (userId) => repo.loadSyncBase(`user:${userId}`),
  saveBase: (userId, base) => repo.saveSyncBase(`user:${userId}`, base),
  cloud: new SupabaseSyncRepository(),
  onConflict: (conflict) => { pendingConflict = conflict; },
  onStatus: (status, message) => updateSyncStatus(status, message),
});

function updateSyncStatus(status: SyncStatus, message = ""): void {
  syncStatus = status; syncMessage = message;
  document.querySelectorAll<HTMLElement>("[data-sync-status]").forEach((node) => {
    node.textContent = `${statusText()}${syncMessage ? `：${syncMessage}` : ""}`;
  });
  const retry = document.querySelector<HTMLButtonElement>("[data-sync-retry]");
  if (retry) retry.hidden = !activeUser || (status !== "離線／同步失敗" && status !== "衝突");
  const conflict = document.querySelector<HTMLElement>("[data-conflict-action]");
  if (conflict) conflict.hidden = !pendingConflict;
}
function readMetadata(userId: string): SyncMetadata {
  try {
    const value = window.localStorage.getItem(`shogi-review-sync:${userId}`);
    return value ? JSON.parse(value) as SyncMetadata : { hashVersion: 1 };
  } catch {
    return { hashVersion: 1 };
  }
}
function writeMetadata(userId: string, value: SyncMetadata): void {
  window.localStorage.setItem(`shogi-review-sync:${userId}`, JSON.stringify(value));
}
function pieceName(char: string, promoted: boolean): string {
  const base: Record<string, string> = { P: "歩", L: "香", N: "桂", S: "銀", G: "金", B: "角", R: "飛", K: "玉" };
  return promoted ? ({ P: "と", L: "杏", N: "圭", S: "全", B: "馬", R: "龍" }[char.toUpperCase()] ?? base[char.toUpperCase()] ?? char) : base[char.toUpperCase()] ?? char;
}
function hands(sfen: string, side: "gote" | "sente", orientation: BoardOrientation): string {
  const hand = sfen.split(" ")[2] ?? "-"; const counts = new Map<string, number>(); let multiplier = 0;
  for (const char of hand) {
    if (/\d/.test(char)) { multiplier = multiplier * 10 + Number(char); continue; }
    const isGote = char === char.toLowerCase();
    if (char !== "-" && isGote === (side === "gote")) counts.set(char.toUpperCase(), (counts.get(char.toUpperCase()) ?? 0) + (multiplier || 1));
    multiplier = 0;
  }
  const rotated = orientation === "normal" ? side === "gote" : side === "sente";
  return [...counts.entries()].map(([char, count]) => `<span class="hand-piece${rotated ? " rotated" : ""}">${pieceName(char, false)}${count > 1 ? `<b aria-label="${count}枚">×${count}</b>` : ""}</span>`).join("") || "<span class=\"empty-hand\">なし</span>";
}
function defaultOrientation(game: Game): BoardOrientation { return game.perspective === "gote" ? "flipped" : "normal"; }
function currentOrientation(game: Game): BoardOrientation { return temporaryFlip?.gameId === game.id ? (temporaryFlip.flipped ? "flipped" : "normal") : defaultOrientation(game); }
function board(sfen: string, orientation: BoardOrientation): string {
  const view = boardView(sfen, orientation);
  if (!view) return `<p class="error">此局面的 SFEN 不完整，無法安全顯示。</p>`;
  const cells = view.cells.map((cell) => {
    if (!cell.piece) return `<span class="square"></span>`;
    const owner = cell.piece === cell.piece.toUpperCase() ? "sente" : "gote";
    const rotated = pieceRotated(cell.piece, orientation);
    return `<span class="square piece ${owner}${rotated ? " rotated" : ""}${cell.promoted ? " promoted" : ""}">${pieceName(cell.piece, Boolean(cell.promoted))}</span>`;
  }).join("");
  const hand = (owner: "gote" | "sente") => `<div class="hand ${owner}" aria-label="${owner === "gote" ? "後手持駒" : "先手持駒"}" role="region" tabindex="0"><span class="hand-label">${owner === "gote" ? "後手持駒" : "先手持駒"}</span>${hands(sfen, owner, orientation)}</div>`;
  const turn = (sfen.split(" ")[1] ?? "b") === "w" ? "輪到後手" : "輪到先手";
  return `<div class="position" data-orientation="${orientation}"><div class="orientation-toolbar"><span role="status" aria-live="polite">${turn}</span><button type="button" class="secondary" data-flip aria-label="翻轉棋盤" aria-pressed="${orientation === "flipped"}">翻轉棋盤</button></div>${hand(view.topHandOwner)}<div class="board" aria-label="將棋盤">${cells}</div>${hand(view.bottomHandOwner)}</div>`;
}
function optionList(values: readonly string[], selected: string): string { return values.map((value) => `<option value="${esc(value)}" ${value === selected ? "selected" : ""}>${esc(value)}</option>`).join(""); }
function perspectiveOptions(selected: Perspective): string {
  return optionList(["spectator", "sente", "gote"] as const, selected)
    .replace('value="spectator"', 'value="spectator"') // keep optionList escaping centralized
    .replace(">spectator<", ">觀戰<").replace(">sente<", ">我是先手<").replace(">gote<", ">我是後手<");
}
function updateImportDraft(): void {
  importDraft = {
    title: document.querySelector<HTMLInputElement>("#title")?.value ?? importDraft.title,
    format: (document.querySelector<HTMLSelectElement>("#format")?.value as InputFormat | undefined) ?? importDraft.format,
    source: document.querySelector<HTMLTextAreaElement>("#source")?.value ?? importDraft.source,
    perspective: (document.querySelector<HTMLSelectElement>("#perspective")?.value as Perspective | undefined) ?? importDraft.perspective,
  };
}
function tagChecks(selected: IssueTag[]): string { return ISSUE_TAGS.map((tag) => `<label class="check"><input type="checkbox" name="issueTags" value="${esc(tag)}" ${selected.includes(tag) ? "checked" : ""}>${esc(tag)}</label>`).join(""); }
function gameHash(gameId: string, ply: number): string { return `#/game/${encodeURIComponent(gameId)}?ply=${ply}`; }
function setPly(ply: number): void { if (selectedGame) location.hash = gameHash(selectedGame.id, Math.max(0, Math.min(ply, selectedGame.moves.length))); }
function resetScroll(): void { if (typeof window.scrollTo === "function") window.scrollTo({ top: 0, left: 0, behavior: "auto" }); }
function header(): string {
  const account = activeUser
    ? `<div class="account"><span class="avatar">${esc(initials())}</span><span><strong>${esc(activeUser.email ?? "已登入")}</strong><span class="sync-copy" data-sync-status role="status" aria-live="polite">${esc(statusText())}</span></span><button class="secondary" data-conflict-action hidden>處理衝突</button><a class="nav-link" href="#/settings">設定</a></div>`
    : `<div class="account"><strong>訪客模式</strong><a class="nav-link" href="#/settings">設定</a><a class="button-link" href="#/login" data-login>使用 Google 登入</a></div>`;
  return `<header><div class="header-inner"><a class="brand" href="#/"><strong>將棋複盤室</strong><span>把每局變成下一次的線索</span></a>${account}</div></header>`;
}
function initials(): string { const name = activeUser?.user_metadata?.full_name; return (typeof name === "string" ? name : "").split(/\s+/).filter(Boolean).map((part) => part[0]).join("").slice(0, 2).toUpperCase() || (activeUser?.email?.[0] ?? "棋").toUpperCase(); }
function render(): void {
  if (profileTransition) {
    renderedRoute = "";
    app!.innerHTML = `<main class="loading"><section class="panel"><h1>載入資料中…</h1><p>正在安全切換帳號，請稍候。</p></section></main>`;
    return;
  }
  const route = location.hash || "#/";
  const reviewRouteValue = parseReviewRoute(route);
  if (reviewRouteValue) {
    if (renderedRoute !== route) resetScroll();
    renderedRoute = route;
    renderReview(reviewRouteValue);
    return;
  }
  reviewIdentity = "";
  reviewNavigation = undefined;
  if (route.startsWith("#/game/")) {
    const [rawId, query = ""] = route.slice(7).split("?"); let id = "";
    try { id = decodeURIComponent(rawId ?? ""); } catch { location.hash = "#/"; return; }
    const params = new URLSearchParams(query); const requestedPly = Number(params.get("ply"));
    selectedPly = Number.isInteger(requestedPly) && requestedPly >= 0 ? requestedPly : 0; selectedGame = data.games.find((game) => game.id === id);
    if (!selectedGame) { location.hash = "#/"; return; }
    const sameGameRoute = renderedRoute.startsWith("#/game/") && renderedRoute.slice(7).split("?")[0] === rawId;
    if (!sameGameRoute || temporaryFlip?.gameId !== selectedGame.id) temporaryFlip = { gameId: selectedGame.id, flipped: defaultOrientation(selectedGame) === "flipped" };
    selectedPly = Math.min(selectedPly, selectedGame.moves.length);
    if (renderedRoute !== `#/game/${rawId}`) resetScroll(); renderedRoute = `#/game/${rawId}`; renderGame(selectedGame); return;
  }
  if (renderedRoute !== route) resetScroll(); renderedRoute = route;
  if (route === "#/settings") renderSettings();
  else if (route === "#/games") renderGames();
  else renderHome();
}
function renderHome(): void {
  selectedGame = undefined; const recent = [...data.games].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, 5);
  app!.innerHTML = `${header()}<main class="home"><section class="panel recent"><div class="section-heading"><h1>最近棋局</h1><a class="nav-link" href="#/games">查看全部</a></div>${recent.length ? recent.map(gameCard).join("") : `<div class="empty"><h2>從一局開始</h2><p>匯入棋譜 → 標記局面 → 重新思考</p></div>`}</section><section class="panel library"><h2>複盤局面</h2>${renderLibrary()}</section><section class="panel import"><details id="import-panel"><summary><strong>＋ 匯入棋譜</strong><span>新增一局棋譜，開始標記值得回看的局面</span><span class="chevron" aria-hidden="true">⌄</span></summary><div class="import-form"><label>棋局名稱<input id="title" value="${esc(importDraft.title)}" placeholder="例如：2026-08-12 對局"></label><label>格式<select id="format">${optionList(["KIF", "KI2", "CSA"] as const, importDraft.format)}</select></label><label>我的執棋方<select id="perspective">${perspectiveOptions(importDraft.perspective)}</select></label><label>貼上棋譜<textarea id="source" rows="9">${esc(importDraft.source)}</textarea></label><div class="actions"><button id="import">載入棋譜</button><label class="file-button">選擇檔案<input id="file" type="file" accept=".kif,.ki2,.csa,.txt"></label></div><p id="error" class="error" role="alert">${esc(startupError)}</p></div></details></section></main>`;
  bindCommon(); document.querySelector("#import")?.addEventListener("click", () => void importText()); document.querySelector<HTMLInputElement>("#file")?.addEventListener("change", (e) => void importFile(e));
  document.querySelector("#title")?.addEventListener("input", updateImportDraft); document.querySelector("#format")?.addEventListener("change", updateImportDraft); document.querySelector("#perspective")?.addEventListener("change", updateImportDraft); document.querySelector("#source")?.addEventListener("input", updateImportDraft);
  document.querySelector("#library")?.addEventListener("change", filterLibrary); document.querySelectorAll<HTMLElement>("[data-open]").forEach((el) => el.addEventListener("click", () => { location.hash = gameHash(el.dataset.open ?? "", Number(el.dataset.ply ?? 0)); }));
  document.querySelectorAll<HTMLElement>("[data-download]").forEach((el) => el.addEventListener("click", () => { const game = data.games.find((item) => item.id === el.dataset.download); if (game) downloadKifu(game.sourceText, game.sourceFormat, game.title); }));
}
function gameCard(game: Game): string { return `<article class="game-card"><div><h2>${esc(game.title)}</h2><p class="muted">${game.sourceFormat} · ${game.moves.length} 手 · ${game.reviewPoints.length} 個複盤局面</p></div><div class="actions"><button data-open="${esc(game.id)}" data-ply="0">開啟</button><button class="secondary" data-download="${esc(game.id)}">下載棋譜</button></div></article>`; }
function renderGames(): void {
  selectedGame = undefined; app!.innerHTML = `${header()}<main><div class="section-heading"><div><a class="nav-link" href="#/">← 首頁</a><h1>所有棋局</h1></div><a class="button-link" href="#/import">匯入棋譜</a></div><section class="panel">${data.games.length ? data.games.slice().sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).map(gameCard).join("") : `<div class="empty"><h2>還沒有棋局</h2><p>匯入一份棋譜，開始你的複盤。</p></div>`}</section></main>`; bindCommon(); document.querySelectorAll<HTMLElement>("[data-open]").forEach((el) => el.addEventListener("click", () => { location.hash = gameHash(el.dataset.open ?? "", 0); })); document.querySelectorAll<HTMLElement>("[data-download]").forEach((el) => el.addEventListener("click", () => { const game = data.games.find((item) => item.id === el.dataset.download); if (game) downloadKifu(game.sourceText, game.sourceFormat, game.title); }));
}
function renderLibrary(): string {
  const points = data.games.flatMap((game) => game.reviewPoints.map((point) => ({ game, point })));
  return `<div id="library"><div class="filters"><label>棋局<select name="game"><option value="">全部</option>${data.games.map((game) => `<option value="${esc(game.id)}">${esc(game.title)}</option>`).join("")}</select></label><label>原因<select name="reason"><option value="">全部</option>${optionList(REASONS, "")}</select></label><fieldset><legend>問題標籤</legend>${tagChecks([])}</fieldset></div><div id="library-list">${points.length ? points.map(({ game, point }) => `<article class="library-item" data-game="${esc(game.id)}" data-point="${esc(point.id)}" data-reason="${esc(point.reason)}" data-tags="${esc(point.issueTags.join("|"))}"><h3>${esc(game.title)} · 第 ${point.ply} 手後</h3><p class="muted">已儲存複盤局面</p><div class="actions"><button data-review="${esc(game.id)}" data-point="${esc(point.id)}">開始複盤</button><details class="compact-actions"><summary>更多操作</summary><div class="actions"><button class="secondary" data-open="${esc(game.id)}" data-ply="${point.ply}">在棋局中查看</button><button class="secondary" data-edit="${esc(point.id)}">編輯</button><button class="danger" data-delete="${esc(point.id)}">刪除</button></div></details></div></article>`).join("") : "<p class='muted'>儲存第一個複盤局面後，它會出現在這裡。</p>"}</div></div>`;
}
function renderGame(game: Game): void {
  const sfen = game.sfens[selectedPly] ?? game.initialSfen; const point = game.reviewPoints.find((item) => item.ply === selectedPly);
  const orientation = currentOrientation(game);
  app!.innerHTML = `${header()}<main class="review-layout"><section class="panel replay"><div class="game-header"><a class="nav-link" href="#/games">← 棋局</a><h1>${esc(game.title)}</h1><button class="secondary" data-rename="${esc(game.id)}">編輯棋局</button><button class="danger" data-game-delete="${esc(game.id)}">刪除</button></div>${board(sfen, orientation)}<div class="replay-controls"><button id="prev" ${selectedPly === 0 ? "disabled" : ""}>上一手</button><strong>第 ${selectedPly} / ${game.moves.length} 手</strong><button id="next" ${selectedPly >= game.moves.length ? "disabled" : ""}>下一手</button></div><ol class="moves">${game.moves.map((move, i) => `<li class="${i + 1 === selectedPly ? "active" : ""}"><button data-ply="${i + 1}">${esc(move)}</button></li>`).join("")}</ol><button class="secondary" id="download-kifu">下載原始棋譜</button></section><section class="panel note-panel"><h2>${point ? "編輯" : "建立"}複盤局面</h2><form id="point-form"><label for="reason">為什麼標記這裡？ <strong>必填</strong></label><select id="reason" name="reason" required><option value="" disabled ${point ? "" : "selected"}>請選擇原因</option>${optionList(REASONS, point?.reason ?? "")}</select><fieldset><legend>涉及哪些問題？（可複選）</legend>${tagChecks(point?.issueTags ?? [])}</fieldset><label for="note">下次要注意什麼？</label><textarea id="note" name="note">${esc(point?.note ?? "")}</textarea><details><summary>推薦手（選填）</summary><div id="recommended-moves">${(point?.recommendedMoves ?? []).map(recommendationRow).join("")}</div><button type="button" class="secondary" data-add-recommendation>＋ 新增推薦手</button></details><details><summary>外部分析筆記</summary><textarea id="external-notes" name="externalNotes">${esc(point?.externalNotes ?? "")}</textarea></details><button type="submit">${point ? "更新" : "儲存"}複盤局面</button></form></section><section class="panel saved-review-list"><h2>這局的複盤局面</h2>${game.reviewPoints.length ? game.reviewPoints.map((saved) => `<p><a class="button-link" href="${reviewRoute(game.id, saved.id)}">第 ${saved.ply} 手後 · 開始複盤</a></p>`).join("") : "<p class='muted'>這局還沒有儲存的複盤局面。</p>"}</section></main>`; bindCommon();
  document.querySelector("#prev")?.addEventListener("click", () => setPly(selectedPly - 1)); document.querySelector("#next")?.addEventListener("click", () => setPly(selectedPly + 1)); document.querySelectorAll<HTMLElement>("[data-ply]").forEach((el) => el.addEventListener("click", () => setPly(Number(el.dataset.ply))));
  document.querySelectorAll<HTMLElement>("[data-flip]").forEach((el) => el.addEventListener("click", () => { temporaryFlip = { gameId: game.id, flipped: !el.getAttribute("aria-pressed") || el.getAttribute("aria-pressed") !== "true" }; renderGame(game); }));
  document.querySelector("#point-form")?.addEventListener("submit", (event) => void savePoint(event, game)); document.querySelector("#download-kifu")?.addEventListener("click", () => downloadKifu(game.sourceText, game.sourceFormat, game.title));
  document.querySelector("[data-add-recommendation]")?.addEventListener("click", () => {
    document.querySelector("#recommended-moves")?.insertAdjacentHTML("beforeend", recommendationRow({ id: uid("recommendation"), move: "" }));
    bindRecommendationRows();
  });
  bindRecommendationRows();
}
function recommendationRow(item: { id: string; move: string; comment?: string }): string {
  return `<div class="recommendation-row"><input type="hidden" name="recommendedMoveId" value="${esc(item.id)}"><label>推薦手<input name="recommendedMove" value="${esc(item.move)}" placeholder="例如：７六歩"></label><label>說明（選填）<input name="recommendedComment" value="${esc(item.comment ?? "")}"></label><button type="button" class="secondary" data-remove-recommendation>移除</button><button type="button" class="secondary" data-move-recommendation="up">上移</button><button type="button" class="secondary" data-move-recommendation="down">下移</button></div>`;
}
function bindRecommendationRows(): void {
  document.querySelectorAll<HTMLElement>("[data-remove-recommendation]").forEach((button) => {
    button.onclick = () => button.closest(".recommendation-row")?.remove();
  });
  document.querySelectorAll<HTMLElement>("[data-move-recommendation]").forEach((button) => {
    button.onclick = () => {
      const row = button.closest(".recommendation-row");
      if (!row) return;
      const sibling = button.dataset.moveRecommendation === "up" ? row.previousElementSibling : row.nextElementSibling;
      if (!sibling) return;
      if (button.dataset.moveRecommendation === "up") row.parentElement?.insertBefore(row, sibling);
      else row.parentElement?.insertBefore(sibling, row);
    };
  });
}
function renderReview(route: NonNullable<ReturnType<typeof parseReviewRoute>>): void {
  const currentEntries = reviewEntries(data);
  const foundResult = route.kind === "invalid" ? { entry: undefined } : findReviewEntry(data, route);
  const found = foundResult.entry;
  const identity = found ? `${found.game.id}/${found.point.id}` : location.hash;
  if (identity !== reviewIdentity) {
    reviewState = { revealed: false, continuationOpen: false, displayedPly: found?.point.ply ?? 0, continuationPly: found?.point.ply ?? 0 };
    if (found && temporaryFlip?.gameId !== found.game.id) temporaryFlip = { gameId: found.game.id, flipped: defaultOrientation(found.game) === "flipped" };
    reviewIdentity = identity;
  }
  const orientation = found && temporaryFlip?.gameId === found.game.id ? (temporaryFlip.flipped ? "flipped" : "normal") : found ? defaultOrientation(found.game) : "normal";
  const activeEntries = reviewNavigation?.map(({ game, point }) => currentEntries.find((entry) => entry.game.id === game.id && entry.point.id === point.id)).filter((entry): entry is ReviewEntry => Boolean(entry));
  const vm = buildReviewViewModel(data, route, reviewState, activeEntries, orientation);
  app!.innerHTML = `${header()}${renderReviewPage(vm)}`;
  bindCommon();
  document.querySelectorAll<HTMLElement>("[data-review-flip]").forEach((element) => element.addEventListener("click", () => {
    if (!found) return;
    temporaryFlip = { gameId: found.game.id, flipped: !temporaryFlip?.flipped };
    renderReview(route);
  }));
  document.querySelectorAll<HTMLElement>("[data-review-history]").forEach((element) => element.addEventListener("click", () => {
    reviewState.displayedPly = Number(element.dataset.reviewHistory ?? found?.point.ply ?? 0);
    renderReview(route);
  }));
  document.querySelector("[data-review-prev-history]")?.addEventListener("click", () => {
    if (!found) return;
    reviewState.displayedPly = Math.max(found.point.ply - 5, Math.min(found.point.ply, reviewState.displayedPly - 1));
    renderReview(route);
  });
  document.querySelector("[data-review-anchor]")?.addEventListener("click", () => {
    if (!found) return;
    reviewState.displayedPly = found.point.ply;
    renderReview(route);
  });
  document.querySelector("[data-review-reveal]")?.addEventListener("click", () => {
    reviewState.revealed = true;
    renderReview(route);
    document.querySelector<HTMLElement>("#review-answer")?.focus();
  });
  document.querySelector("[data-review-continuation]")?.addEventListener("click", () => {
    reviewState.continuationOpen = true;
    reviewState.continuationPly = (found?.point.ply ?? 0) + 1;
    renderReview(route);
  });
  document.querySelector("[data-review-continuation-step]")?.addEventListener("click", () => {
    if (!found) return;
    reviewState.continuationPly = Math.min(found.game.moves.length, reviewState.continuationPly + 1);
    renderReview(route);
  });
  document.querySelector("[data-review-close-continuation]")?.addEventListener("click", () => {
    reviewState.continuationOpen = false;
    reviewState.displayedPly = found?.point.ply ?? 0;
    renderReview(route);
  });
  document.querySelector("[data-review-prev]")?.addEventListener("click", () => navigateReview(-1));
  document.querySelector("[data-review-next]")?.addEventListener("click", () => navigateReview(1));
}
function navigateReview(direction: -1 | 1): void {
  const route = parseReviewRoute(location.hash);
  if (!route || route.kind === "invalid") return;
  const currentEntries = reviewEntries(data);
  const current = currentEntries.findIndex(({ game, point }) => point.id === route.pointId && (route.kind === "legacy" || game.id === route.gameId));
  const entries = reviewNavigation?.length
    ? reviewNavigation.map(({ game, point }) => currentEntries.find((entry) => entry.game.id === game.id && entry.point.id === point.id)).filter((entry): entry is ReviewEntry => Boolean(entry))
    : currentEntries;
  const activeIndex = entries.findIndex(({ game, point }) => point.id === route.pointId && (route.kind === "legacy" || game.id === route.gameId));
  const index = activeIndex >= 0 ? activeIndex : current;
  const next = entries[index + direction];
  if (next) location.hash = reviewRoute(next.game.id, next.point.id);
}
function renderSettings(): void {
  selectedGame = undefined; const count = data.games.length; app!.innerHTML = `${header()}<main><a class="nav-link" href="#/">← 首頁</a><h1>設定</h1><div class="settings-grid"><section class="panel"><h2>帳號與同步</h2>${activeUser ? `<p><strong>${esc(activeUser.email ?? "Google 帳號")}</strong></p><p>此裝置資料：${count} 局</p><p data-sync-status role="status" aria-live="polite">${esc(statusText())}${syncMessage ? `：${esc(syncMessage)}` : ""}</p><button data-sync-retry ${syncStatus === "已同步" ? "hidden" : ""}>${syncStatus === "衝突" ? "處理衝突" : "立即同步"}</button><button id="logout-remove" class="danger">登出並移除此裝置的帳號資料</button>` : `<p>訪客資料只保存在此裝置。</p><button data-login>使用 Google 登入</button><button id="clear-guest" class="danger" ${count ? "" : "disabled"}>清除訪客資料</button>`}</section><section class="panel"><h2>備份與還原</h2><p>資料先保存在此裝置；登入後會安全同步至你的私人雲端。</p><div class="actions"><button id="export">下載備份</button><label class="file-button">還原備份<input id="backup" type="file" accept=".json"></label></div><p id="error" class="error" role="alert">${esc(startupError)}</p></section></div></main>`; bindCommon(); document.querySelector("#export")?.addEventListener("click", () => { generateBackup(); }); document.querySelector<HTMLInputElement>("#backup")?.addEventListener("change", (e) => void restoreFile(e)); document.querySelector("#clear-guest")?.addEventListener("click", () => openDestructive("clear-guest")); document.querySelector("#logout-remove")?.addEventListener("click", () => openDestructive("remove-profile")); document.querySelector("[data-sync-retry]")?.addEventListener("click", () => { if (pendingConflict) openDestructive("conflict"); else void syncNow(); });
}
function bindCommon(): void {
  document.querySelectorAll<HTMLElement>("[data-login]").forEach((el) => el.addEventListener("click", (event) => { event.preventDefault(); void startGoogleLoginFromUi(); }));
  document.querySelectorAll<HTMLElement>("[data-conflict-action]").forEach((el) => el.addEventListener("click", () => openDestructive("conflict")));
  document.querySelectorAll<HTMLElement>("[data-delete]").forEach((el) => el.addEventListener("click", () => openDestructive("delete-point", el.dataset.delete)));
  document.querySelectorAll<HTMLElement>("[data-edit]").forEach((el) => el.addEventListener("click", () => { const item = data.games.flatMap((game) => game.reviewPoints.map((point) => ({ game, point }))).find(({ point }) => point.id === el.dataset.edit); if (item) location.hash = gameHash(item.game.id, item.point.ply); }));
  document.querySelectorAll<HTMLElement>("[data-review]").forEach((el) => el.addEventListener("click", () => {
    const visible = Array.from(document.querySelectorAll<HTMLElement>(".library-item")).filter((item) => item.style.display !== "none");
    reviewNavigation = visible.map((item) => reviewEntries(data).find(({ game, point }) => game.id === item.dataset.game && point.id === item.dataset.point)).filter((entry): entry is ReviewEntry => Boolean(entry));
    reviewState = { revealed: false, continuationOpen: false, displayedPly: 0, continuationPly: 0 };
    reviewIdentity = "";
    location.hash = reviewRoute(el.dataset.review ?? "", el.dataset.point ?? "");
  }));
  document.querySelectorAll<HTMLElement>("[data-rename]").forEach((el) => el.addEventListener("click", () => openDestructive("rename-game", el.dataset.rename)));
  document.querySelectorAll<HTMLElement>("[data-game-delete]").forEach((el) => el.addEventListener("click", () => openDestructive("delete-game", el.dataset.gameDelete)));
  updateSyncStatus(syncStatus, syncMessage);
}
function openDestructive(kind: "delete-point" | "delete-game" | "rename-game" | "clear-guest" | "remove-profile" | "conflict" | "guest-import", id?: string): void {
  dialogReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null; backupReady = false;
  const game = id ? data.games.find((item) => item.id === id) : undefined; const pointGame = kind === "delete-point" ? data.games.find((item) => item.reviewPoints.some((point) => point.id === id)) : undefined;
  const title = kind === "rename-game" ? "重新命名棋局" : kind === "delete-point" ? "刪除複盤局面？" : kind === "delete-game" ? "刪除整局棋？" : kind === "clear-guest" ? "清除訪客資料？" : kind === "remove-profile" ? "移除此裝置的帳號資料？" : kind === "guest-import" ? "保留訪客資料？" : "處理同步衝突";
  const body = kind === "rename-game" ? `<label for="dialog-input">棋局名稱<input id="dialog-input" value="${esc(game?.title ?? "")}" required></label><label for="dialog-perspective">我的執棋方<select id="dialog-perspective">${perspectiveOptions(game?.perspective ?? "spectator")}</select></label>` : kind === "delete-point" ? `<p>這會刪除「${esc(pointGame?.title ?? "")}」中的 1 個複盤局面。棋局與其他局面不受影響。</p>` : kind === "delete-game" ? `<p>這會一次刪除棋局與其中 ${game?.reviewPoints.length ?? 0} 個複盤局面，且無法復原。</p>` : kind === "clear-guest" ? `<p>清除訪客資料只影響此裝置，不會影響雲端。請先下載 JSON 備份。</p>${backupGate()}` : kind === "remove-profile" ? `<p>這只會移除此裝置的帳號資料，不會刪除雲端帳號。若尚未同步，未同步變更會從備份保留。</p>${backupGate()}<label class="check"><input id="ack" type="checkbox">我了解未同步變更只會保留在備份，雲端不會被刪除。</label>` : kind === "guest-import" ? `<p>本機訪客：${data.games.length} 局、${data.games.reduce((n, game) => n + game.reviewPoints.length, 0)} 個複盤局面。帳號雲端：0 局。</p><p>訪客資料會永遠保留在此裝置。</p><div class="actions"><button type="button" data-guest-copy>複製訪客資料</button><button type="button" class="secondary" data-guest-skip>略過，使用帳號雲端</button></div>` : conflictBody();
  const action = kind === "rename-game" ? "儲存名稱" : kind === "delete-point" || kind === "delete-game" || kind === "clear-guest" || kind === "remove-profile" ? "確認" : "套用選擇";
  app!.insertAdjacentHTML("beforeend", `<div class="dialog-backdrop" data-dialog><section class="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title" tabindex="-1"><h2 id="dialog-title">${title}</h2><div>${body}</div><div class="actions dialog-actions"><button data-dialog-cancel class="secondary">取消</button>${kind !== "guest-import" ? `<button data-dialog-submit ${kind === "conflict" || kind === "clear-guest" || kind === "remove-profile" ? "disabled" : ""}>${action}</button>` : ""}</div></section></div>`);
  const dialog = document.querySelector<HTMLElement>("[data-dialog] .dialog"); document.body.classList.add("dialog-lock");
  const focusSelector = {
    cancel: "[data-dialog-cancel]",
    input: "#dialog-input",
    backup: "[data-dialog-backup]",
    "guest-copy": "[data-guest-copy]",
  }[dialogInitialFocus(kind)];
  const focusTarget = document.querySelector<HTMLElement>(`[data-dialog] ${focusSelector}`);
  if (focusTarget) focusTarget.focus();
  else dialog?.focus();
  document.querySelector("[data-dialog-cancel]")?.addEventListener("click", closeDialog); document.querySelector("[data-dialog-submit]")?.addEventListener("click", () => void submitDialog(kind, id)); document.querySelector("[data-dialog-backup]")?.addEventListener("click", () => { backupReady = generateBackup(); const checkbox = document.querySelector<HTMLInputElement>("#backup-ack"); if (checkbox) checkbox.disabled = !backupReady; updateDialogGate(); });
  document.querySelector("[data-guest-copy]")?.addEventListener("click", () => void copyGuestData());
  document.querySelector("[data-guest-skip]")?.addEventListener("click", () => { pendingGuestImport = undefined; closeDialog(); });
  document.querySelector("[data-dialog]")?.addEventListener("keydown", (event) => dialogKeydown(event as KeyboardEvent)); document.querySelectorAll("[data-dialog] input").forEach((input) => input.addEventListener("input", updateDialogGate)); updateDialogGate();
}
function conflictBody(): string {
  const conflicts = pendingConflict?.conflicts ?? [];
  const choices = conflicts.map((item, index) => `<fieldset><legend>${esc(item.entity === "game" ? `棋局 ${item.entityId}` : `複盤局面 ${item.entityId}`)} · ${esc(item.field)}</legend><label class="check"><input type="radio" name="merge-${index}" value="local">使用本機</label><label class="check"><input type="radio" name="merge-${index}" value="cloud">使用雲端</label></fieldset>`).join("");
  return `<p>同步已暫停。${conflicts.length ? `以下 ${conflicts.length} 個欄位需要選擇；其餘變更已自動合併。` : "首次同步需要確認兩份資料。"}</p><p class="warning">套用前請先下載本機 JSON 備份。</p>${backupGate()}${choices}`;
}
function backupGate(): string { return `<div class="backup-gate"><button type="button" data-dialog-backup>先下載本機 JSON 備份</button><label class="check"><input id="backup-ack" type="checkbox" disabled>我已保存備份</label></div>`; }
function updateDialogGate(): void {
  const backupAck = document.querySelector<HTMLInputElement>("#backup-ack"); const ack = document.querySelector<HTMLInputElement>("#ack"); const submit = document.querySelector<HTMLButtonElement>("[data-dialog-submit]");
  if (backupAck && !backupAck.checked) { if (submit) submit.disabled = true; } else if (ack && !ack.checked) { if (submit) submit.disabled = true; } else if (submit && !dialogBusy) submit.disabled = false;
}
function dialogKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape" && !dialogBusy) { closeDialog(); return; }
  if (event.key !== "Tab") return;
  const focusable = Array.from(document.querySelectorAll<HTMLElement>("[data-dialog] button:not([disabled]), [data-dialog] input:not([disabled]), [data-dialog] select:not([disabled]), [data-dialog] textarea:not([disabled]), [data-dialog] a[href]")).filter((element) => element.offsetParent !== null); if (!focusable.length) return;
  const index = focusable.indexOf(document.activeElement as HTMLElement); const next = focusable[(index + (event.shiftKey ? -1 : 1) + focusable.length) % focusable.length]; event.preventDefault(); next?.focus();
}
function closeDialog(): void { if (dialogBusy) return; document.querySelector("[data-dialog]")?.remove(); document.body.classList.remove("dialog-lock"); dialogReturnFocus?.focus(); dialogReturnFocus = null; }
async function submitDialog(kind: Parameters<typeof openDestructive>[0], id?: string): Promise<void> {
  if (dialogBusy || profileTransition) return; const submit = document.querySelector<HTMLButtonElement>("[data-dialog-submit]"); dialogBusy = true; if (submit) submit.disabled = true;
  try {
    if (kind === "rename-game") { const game = data.games.find((item) => item.id === id); const title = document.querySelector<HTMLInputElement>("#dialog-input")?.value.trim() ?? ""; const perspective = document.querySelector<HTMLSelectElement>("#dialog-perspective")?.value as Perspective | undefined; if (!game || !title || !perspective || !PERSPECTIVES.includes(perspective)) throw new Error("棋局名稱與執棋方不可為空白。"); const previous = { title: game.title, perspective: game.perspective }; game.title = title; game.perspective = perspective; temporaryFlip = { gameId: game.id, flipped: defaultOrientation(game) === "flipped" }; try { await persist(); } catch (error) { game.title = previous.title; game.perspective = previous.perspective; throw error; } }
    if (kind === "delete-point") await deletePoint(id);
    if (kind === "delete-game") await deleteGame(id);
    if (kind === "clear-guest") { await repo.deleteProfile("guest"); data = { games: [] }; }
    if (kind === "remove-profile") await removeLocalAccount();
    if (kind === "guest-import") return;
    if (kind === "conflict") {
      if (!backupReady) throw new Error("請先備份本機資料。");
      const choices: Record<string, "local" | "cloud"> = {};
      for (let index = 0; index < (pendingConflict?.conflicts.length ?? 0); index += 1) {
        const choice = document.querySelector<HTMLInputElement>(`input[name="merge-${index}"]:checked`)?.value;
        if (choice !== "local" && choice !== "cloud") throw new Error("請為每個衝突欄位選擇本機或雲端。");
        choices[String(index)] = choice;
      }
      await resolveConflict(choices);
    }
    dialogBusy = false; closeDialog(); render();
  } catch (error) {
    dialogBusy = false;
    if (submit) submit.disabled = false;
    if (kind === "conflict") {
      closeDialog();
      render();
      if (pendingConflict) openDestructive("conflict");
    } 
    showError(error);
  }
}
function generateBackup(): boolean { try { const link = document.createElement("a"); link.href = URL.createObjectURL(new Blob([JSON.stringify(createBackup(data), null, 2)], { type: "application/json" })); link.download = "shogi-review-backup.json"; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000); return true; } catch (error) { showError(error); return false; } }
async function importText(): Promise<void> { updateImportDraft(); try { await addGame(importDraft.source, importDraft.format, importDraft.title, importDraft.perspective); } catch (error) { showError(error); } }
async function importFile(event: Event): Promise<void> { const file = (event.target as HTMLInputElement).files?.[0]; if (!file) return; try { const source = decodeRecordBytes(new Uint8Array(await file.arrayBuffer())); importDraft = { ...importDraft, title: file.name, format: detectFormat(source, file.name), source }; await addGame(source, importDraft.format, importDraft.title, importDraft.perspective); } catch (error) { showError(error); } }
async function addGame(source: string, format: InputFormat, title: string, perspective: Perspective = "spectator"): Promise<void> { assertWritable(); const game = parseGame(source, format, title); game.perspective = perspective; const existing = data.games.find((item) => item.canonicalHash === game.canonicalHash); if (!existing) { const previous = data.games; data.games = [...previous, game]; try { await persist(); } catch (error) { if (!profileTransition) data.games = previous; throw error; } } else if (existing.perspective !== perspective) { const previous = existing.perspective; existing.perspective = perspective; try { await persist(); } catch (error) { if (!profileTransition) existing.perspective = previous; throw error; } } importDraft = { title: "", format: "KIF", source: "", perspective: "spectator" }; location.hash = gameHash((existing ?? game).id, 0); render(); }
async function savePoint(event: Event, game: Game): Promise<void> { assertWritable(); const form = event.currentTarget as HTMLFormElement; if (!form.reportValidity()) return; event.preventDefault(); const values = new FormData(form); const reason = String(values.get("reason") ?? ""); if (!REASONS.includes(reason as Reason)) return; const old = game.reviewPoints.find((item) => item.ply === selectedPly); const ids = values.getAll("recommendedMoveId").map(String); const moves = values.getAll("recommendedMove").map(String); const comments = values.getAll("recommendedComment").map(String); let recommendedMoves; try { recommendedMoves = normalizeRecommendedMoves(ids.map((id, index) => ({ id, move: moves[index] ?? "", comment: comments[index] ?? "" }))); } catch (error) { showError(error); return; } const point: ReviewPoint = old ? { ...old, ply: selectedPly, sfen: game.sfens[selectedPly]!, reason: reason as Reason, issueTags: values.getAll("issueTags").filter((tag): tag is IssueTag => ISSUE_TAGS.includes(tag as IssueTag)), note: text(values.get("note")), externalNotes: text(values.get("externalNotes")), ...(recommendedMoves ? { recommendedMoves } : {}) } : { id: uid("point"), ply: selectedPly, sfen: game.sfens[selectedPly]!, reason: reason as Reason, issueTags: values.getAll("issueTags").filter((tag): tag is IssueTag => ISSUE_TAGS.includes(tag as IssueTag)), note: text(values.get("note")), externalNotes: text(values.get("externalNotes")), createdAt: new Date().toISOString(), ...(recommendedMoves ? { recommendedMoves } : {}) }; if (!recommendedMoves) delete point.recommendedMoves; const previous = game.reviewPoints; game.reviewPoints = [...previous.filter((item) => item.ply !== selectedPly), point].sort((a, b) => a.ply - b.ply); try { await persist(); render(); } catch (error) { if (!profileTransition) game.reviewPoints = previous; render(); showError(error); } }
function text(value: FormDataEntryValue | null): string | undefined { return typeof value === "string" && value.trim() ? value : undefined; }
async function deletePoint(id?: string): Promise<void> { assertWritable(); const game = data.games.find((item) => item.reviewPoints.some((point) => point.id === id)); if (!game) return; const previous = game.reviewPoints; game.reviewPoints = previous.filter((point) => point.id !== id); try { await persist(); } catch (error) { if (!profileTransition) game.reviewPoints = previous; throw error; } }
async function deleteGame(id?: string): Promise<void> { assertWritable(); const index = data.games.findIndex((item) => item.id === id); if (index < 0) return; const previous = data.games; data.games = previous.filter((item) => item.id !== id); try { await persist(); } catch (error) { if (!profileTransition) data.games = previous; throw error; } location.hash = "#/games"; }
async function persist(): Promise<void> { assertWritable(); const identity = currentPersistenceIdentity(); if (!identity) throw new Error("尚未完成帳號資料載入。"); localDataVersion += 1; await repo.saveProfile(identity.profile, data); if (!identityIsCurrent(identity)) throw new Error("帳號身分已變更，未儲存變更。"); if (pendingConflict) autosync.invalidate(); else if (activeUser && !profileLoadFailed) { updateSyncStatus("尚未同步"); autosync.schedule(); } }
async function restoreFile(event: Event): Promise<void> { const file = (event.target as HTMLInputElement).files?.[0]; if (!file) return; try { const restored = parseBackup(await file.text()); openRestoreDialog(restored); } catch (error) { showError(error); } }
function openRestoreDialog(restored: AppData): void { dialogReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null; app!.insertAdjacentHTML("beforeend", `<div class="dialog-backdrop" data-dialog><section class="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title" tabindex="-1"><h2 id="dialog-title">還原備份？</h2><p>即將完整取代目前資料：${restored.games.length} 局棋、${restored.games.reduce((total, game) => total + game.reviewPoints.length, 0)} 個複盤局面。</p><p class="warning">這是目前登入帳號的本機分支；若雲端較新，同步會停在衝突處理，不會覆蓋雲端。</p><div class="actions dialog-actions"><button data-dialog-cancel class="secondary">取消</button><button data-dialog-submit>還原</button></div></section></div>`); document.querySelector("[data-dialog-cancel]")?.addEventListener("click", closeDialog); document.querySelector("[data-dialog-submit]")?.addEventListener("click", async () => { if (profileTransition) return; const previous = data; try { data = restored; await persist(); closeDialog(); render(); } catch (error) { if (!profileTransition) data = previous; showError(error); } }); document.querySelector("[data-dialog] .dialog")?.setAttribute("aria-describedby", "dialog-title"); document.body.classList.add("dialog-lock"); const cancel = document.querySelector<HTMLElement>("[data-dialog] [data-dialog-cancel]"); if (cancel) cancel.focus(); }
async function startGoogleLoginFromUi(): Promise<void> { try { const error = await startGoogleLogin(supabase, window.localStorage, googleRedirectUrl(window.location.origin)); if (error) { syncMessage = error; render(); } } catch (error) { syncMessage = error instanceof Error ? error.message : "Google 登入啟動失敗，請重試。"; render(); } }
async function removeLocalAccount(): Promise<void> {
  if (!activeUser) return;
  if (syncStatus === "同步中") throw new Error("同步完成前不能移除此裝置資料。");
  const uid = activeUser.id;
  const previousUser = activeUser;
  const previousProfile = activeProfile;
  const previousData = data;
  const previousPending = pendingConflict;
  const removalToken = authTransitionGate.beginRemoval();
  conflictResolutionAbort?.abort();
  beginProfileTransition(null);
  const { error } = await supabase.auth.signOut();
  if (error) {
    activeUser = previousUser;
    activeProfile = previousProfile;
    data = previousData;
    pendingConflict = previousPending;
    desiredUserId = previousUser.id;
    profileTransition = undefined;
    render();
    const queuedSession = authTransitionGate.finishRemoval(removalToken);
    if (queuedSession !== undefined) processAuthSession(queuedSession);
    throw new Error(`登出失敗：${error.message}`);
  }
  try {
    if (!authTransitionGate.isCurrentRemoval(removalToken)) return;
    activeUser = null;
    activeProfile = "guest";
    pendingConflict = undefined;
    pendingGuestImport = undefined;
    profileLoadFailed = false;
    data = { games: [] };
    selectedGame = undefined;
    syncMetadata = { hashVersion: 1 };
    updateSyncStatus("僅本機");
    render();

    const cleanupErrors = await settleAccountCleanup([
      () => repo.deleteProfile(`user:${uid}`),
      () => repo.deleteSyncBase(`user:${uid}`),
    ]);
    activeUser = null;
    activeProfile = "guest";
    pendingConflict = undefined;
    const guestLoad = await loadGuestSafely(() => repo.loadProfile("guest"));
    if ("error" in guestLoad) {
      profileLoadFailed = true;
      data = { games: [] };
      startupError = guestLoad.error instanceof Error ? guestLoad.error.message : "訪客資料載入失敗。";
    } else {
      data = guestLoad.data.data;
      profileLoadFailed = false;
      startupError = "";
    }
    const cleanupDetails = cleanupErrors
      .map((cleanupError) => cleanupError instanceof Error ? cleanupError.message : String(cleanupError))
      .join("；");
    if (cleanupErrors.length) {
      const warning = `部分本機帳號資料可能仍留在裝置上，但已隱藏；雲端未受影響。${cleanupDetails ? ` 清理錯誤：${cleanupDetails}` : ""}`;
      startupError = startupError ? `${startupError} ${warning}` : warning;
    }
    if ("error" in guestLoad || cleanupErrors.length) {
      updateSyncStatus("離線／同步失敗", startupError);
    } else {
      updateSyncStatus("僅本機");
    }
    render();
    if ("error" in guestLoad || cleanupErrors.length) throw new Error(startupError);
  } catch (error) {
    if (!authTransitionGate.isCurrentRemoval(removalToken)) throw error;
    activeUser = null;
    activeProfile = "guest";
    pendingConflict = undefined;
    data = { games: [] };
    profileLoadFailed = true;
    updateSyncStatus("離線／同步失敗", error instanceof Error ? error.message : "帳號資料移除失敗。");
    render();
    throw error;
  } finally {
    const queuedSession = authTransitionGate.finishRemoval(removalToken);
    if (queuedSession !== undefined) processAuthSession(queuedSession);
  }
}
function currentIdentity(): { uid: string; profile: ProfileKey; generation: number } | null {
  return activeUser && !profileTransition && !profileLoadFailed
    ? { uid: activeUser.id, profile: activeProfile, generation: profileGeneration }
    : null;
}
function currentPersistenceIdentity(): { uid: string; profile: ProfileKey; generation: number } | null {
  return !profileTransition && !profileLoadFailed
    ? { uid: activeUser?.id ?? "guest", profile: activeProfile, generation: profileGeneration }
    : null;
}
function assertWritable(): void {
  if (profileTransition) throw new Error("帳號資料載入中，暫時不能修改。");
}
function identityIsCurrent(identity: { uid: string; profile: ProfileKey; generation: number }): boolean {
  const current = currentPersistenceIdentity();
  return Boolean(current && current.uid === identity.uid && current.profile === identity.profile && current.generation === identity.generation);
}
async function copyGuestData(): Promise<void> {
  const pending = pendingGuestImport;
  const identity = currentIdentity();
  if (!pending || !identity || identity.uid !== pending.uid) return;
  await repo.saveProfile(`user:${pending.uid}`, pending.guest);
  if (!identityIsCurrent(identity) || pendingGuestImport !== pending) return;
  pendingGuestImport = undefined;
  const user = activeUser;
  const token = beginProfileTransition(user);
  if (await activateProfile(`user:${pending.uid}`, token) === "aborted") return;
  closeDialog(); render(); void autosync.reconcile();
}
function conflictBelongsToCurrentProfile(): boolean {
  return !pendingConflict || Boolean(activeUser
    && pendingConflict.userId === activeUser.id
    && pendingConflict.profile === activeProfile
    && pendingConflict.generation === profileGeneration);
}
async function syncNow(): Promise<void> {
  assertWritable();
  if (pendingConflict && !conflictBelongsToCurrentProfile()) pendingConflict = undefined;
  if (!activeUser || profileLoadFailed || pendingConflict) { if (pendingConflict) openDestructive("conflict"); return; }
  await autosync.reconcile();
}
async function resolveConflict(choices: Record<string, "cloud" | "local">): Promise<void> {
  assertWritable();
  if (conflictResolutionRunning) throw new Error("衝突處理正在進行中。");
  conflictResolutionRunning = true;
  const abortController = new AbortController();
  const capturedPending = pendingConflict;
  conflictResolutionAbort = abortController;
  try {
    const result = await resolveConflictSafely(choices, {
      identity: currentIdentity,
      pending: () => pendingConflict,
      setPending: (next) => { pendingConflict = next; },
      data: () => data,
      setData: (next) => {
        const current = currentIdentity();
        if (current && capturedPending && current.uid === capturedPending.userId && current.profile === capturedPending.profile && current.generation === capturedPending.generation) data = globalThis.structuredClone(next);
      },
        repository: { saveProfileAndBase: repo.saveProfileAndBase.bind(repo) },
      cloud: new SupabaseSyncRepository(),
      metadata: async (uid, value) => {
        const current = currentIdentity();
        if (pendingConflict !== capturedPending || current?.uid !== uid || pendingConflict?.profile !== current.profile || pendingConflict.generation !== current.generation) throw new Error("同步身分已變更。");
        await writeMetadata(uid, value);
        const after = currentIdentity();
        if (pendingConflict !== capturedPending || after?.uid !== uid || pendingConflict?.profile !== after.profile || pendingConflict.generation !== after.generation) throw new Error("同步身分已變更。");
        syncMetadata = value;
      },
      onResolved: () => updateSyncStatus("已同步"),
      signal: abortController.signal,
      localVersion: () => localDataVersion,
    });
    if (result === "aborted") return;
  } finally {
    if (conflictResolutionAbort === abortController) conflictResolutionAbort = undefined;
    conflictResolutionRunning = false;
  }
}
function showError(error: unknown): void { const target = document.querySelector("#error"); if (target) target.textContent = error instanceof Error ? error.message : "發生未知錯誤。"; }
async function prepareAccountProfile(uid: string, isCurrent: () => boolean = () => true): Promise<void> {
  const guest = await repo.loadProfile("guest");
  if (!isCurrent()) return;
  const account = await repo.loadProfile(`user:${uid}`);
  if (isCurrent() && guest.data.games.length && !account.data.games.length) {
    pendingGuestImport = { uid, guest: guest.data };
    openGuestImportDialog(uid, guest.data, account.data);
  }
}
function openGuestImportDialog(_uid: string, _guest: AppData, _cloud: AppData): void { openDestructive("guest-import"); }
type ActivationResult = "activated" | "aborted";
async function activateProfile(profile: ProfileKey, token: ProfileTransition): Promise<ActivationResult> {
  autosync.invalidate();
  pendingConflict = undefined;
  const expectedUserId = profile.startsWith("user:") ? profile.slice("user:".length) : undefined;
  const isCurrent = () => profileTransition === token && desiredUserId === (token.user?.id);
  const loaded = await loadProfileIfCurrent(() => repo.loadProfile(profile), isCurrent);
  if (!loaded) return "aborted";
  if (loaded.migrated) {
    await repo.saveProfile("guest", loaded.data);
    if (!isCurrent()) return "aborted";
  }
  if (!isCurrent()) return "aborted";
  activeUser = token.user;
  activeProfile = profile;
  data = loaded.data;
  syncMetadata = expectedUserId ? readMetadata(expectedUserId) : { hashVersion: 1 };
  profileLoadFailed = false;
  profileTransition = undefined;
  return "activated";
}
function filterLibrary(): void { const root = document.querySelector("#library"); if (!root) return; const game = (root.querySelector('[name="game"]') as HTMLSelectElement).value; const reason = (root.querySelector('[name="reason"]') as HTMLSelectElement).value; const tags = Array.from(root.querySelectorAll<HTMLInputElement>('input[name="issueTags"]:checked')).map((input) => input.value); root.querySelectorAll<HTMLElement>(".library-item").forEach((item) => { item.style.display = (!game || item.dataset.game === game) && (!reason || item.dataset.reason === reason) && (!tags.length || tags.some((tag) => (item.dataset.tags ?? "").split("|").includes(tag))) ? "" : "none"; }); }
window.addEventListener("hashchange", () => { if (location.hash === "#/import") { location.hash = "#/"; setTimeout(() => document.querySelector<HTMLDetailsElement>("#import-panel")?.setAttribute("open", ""), 0); } else render(); });
function beginProfileTransition(user: TransitionUser | null): ProfileTransition {
  const token = { generation: ++profileGeneration, profile: user ? `user:${user.id}` as ProfileKey : "guest", user };
  desiredUserId = user?.id;
  profileTransition = token;
  activeUser = null;
  activeProfile = "guest";
  data = { games: [] };
  profileLoadFailed = false;
  selectedGame = undefined;
  pendingConflict = undefined;
  pendingGuestImport = undefined;
  conflictResolutionAbort?.abort();
  autosync.invalidate();
  render();
  return token;
}
async function bootstrap(): Promise<void> {
  const callbackError = await finishPkceCallback();
  if (callbackError) startupError = callbackError;
  try {
    const user = await currentUser();
    const transition = beginProfileTransition(user ? { id: user.id, email: user.email, user_metadata: user.user_metadata } : null);
    if (await activateProfile(transition.profile, transition) === "aborted") return;
  } catch (error) {
    startupError = `${error instanceof Error ? error.message : "本機資料格式無效。"} 未套用變更。`;
    profileLoadFailed = true;
    profileTransition = undefined;
    data = { games: [] };
    updateSyncStatus("離線／同步失敗", "本機資料載入失敗；已停用同步。");
  }
  render();
  if (activeUser && !profileLoadFailed) { await prepareAccountProfile(activeUser.id); void autosync.reconcile(); }
}
void bootstrap();
function processAuthSession(session: Session | null): void {
  const next = session?.user;
  const alreadyActivated = !profileTransition
    && (next?.id === activeUser?.id || (!next && !activeUser));
  if (alreadyActivated || (authTransitionRunning && session === activeAuthSession)) return;
  const user = next ? { id: next.id, email: next.email, user_metadata: next.user_metadata } : null;
  const transition = beginProfileTransition(user);
  queuedAuthSession = session;
  if (authTransitionRunning) return;
  authTransitionRunning = true;
  void (async () => {
    let failedTransition = transition;
    try {
      await drainLatestAuthTransitions(
        () => queuedAuthSession !== undefined,
        () => {
          const sessionToActivate = queuedAuthSession;
          queuedAuthSession = undefined;
          activeAuthSession = sessionToActivate;
          return sessionToActivate;
        },
        async () => {
          const current = profileTransition;
          if (!current) return;
          failedTransition = current;
          if (await activateProfile(current.profile, current) === "aborted") return;
          if (!profileTransition) {
            render();
            if (activeUser) {
              await prepareAccountProfile(activeUser.id, () => profileGeneration === current.generation && !profileTransition);
              if (profileGeneration === current.generation && !profileTransition) void autosync.reconcile();
            }
          }
        },
      );
    } catch (error) {
      if (profileTransition === failedTransition) {
        profileTransition = undefined;
        profileLoadFailed = true;
        data = { games: [] };
        updateSyncStatus("離線／同步失敗", error instanceof Error ? error.message : "本機資料載入失敗。");
        render();
      }
    } finally {
      activeAuthSession = undefined;
      authTransitionRunning = false;
      if (queuedAuthSession !== undefined) processAuthSession(queuedAuthSession);
    }
  })();
}
supabase.auth.onAuthStateChange((_event, session) => {
  if (authTransitionGate.queueDuringRemoval(session)) return;
  processAuthSession(session);
});
