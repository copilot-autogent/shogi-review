import { createBackup, parseBackup } from "./backup.js";
import { detectFormat, decodeRecordBytes, parseGame, type InputFormat } from "./parser.js";
import { ISSUE_TAGS, REASONS, type AppData, type Game, type IssueTag, type Reason, type ReviewPoint } from "./model.js";
import { IndexedDbRepository, MemoryProfileRepository, type ProfileKey, type ProfileRepository } from "./repository.js";
import { AutoSyncEngine, currentUser, downloadKifu, finishPkceCallback, googleRedirectUrl, payloadHash, startGoogleLogin, supabase, SupabaseSyncRepository, SUPABASE_PUBLISHABLE_KEY, type SyncMetadata, type SyncStatus } from "./sync.js";
import "./style.css";

let repo: ProfileRepository;
try { repo = "indexedDB" in window ? new IndexedDbRepository() : new MemoryProfileRepository(); }
catch { repo = new MemoryProfileRepository(); }
let data: AppData = { games: [] };
let activeProfile: ProfileKey = "guest";
let activeUser: { id: string; email?: string; user_metadata?: Record<string, unknown> } | null = null;
let profileGeneration = 0;
let profileLoadFailed = false;
let selectedGame: Game | undefined;
let selectedPly = 0;
let rethinkMode = false;
let startupError = "";
let renderedRoute = "";
let syncStatus: SyncStatus = "僅本機";
let syncMessage = "";
let syncMetadata: SyncMetadata = { hashVersion: 1 };
let pendingConflict: { userId: string; rowRevision: number; cloudData: AppData } | undefined;
const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("找不到 app 容器。");
const esc = (value: string): string => value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c] ?? c));
const uid = (prefix: string): string => `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`;
const autosync = new AutoSyncEngine({
  identity: () => activeUser && !profileLoadFailed ? { uid: activeUser.id, profile: activeProfile, generation: profileGeneration } : null,
  load: () => Promise.resolve(globalThis.structuredClone(data)),
  save: async (next) => { await repo.saveProfile(activeProfile, next); data = globalThis.structuredClone(next); },
  getMetadata: (userId) => readMetadata(userId),
  setMetadata: (userId, metadata) => { syncMetadata = metadata; writeMetadata(userId, metadata); },
  cloud: new SupabaseSyncRepository(),
  onConflict: (conflict) => { pendingConflict = conflict; },
  onStatus: (status, message) => { syncStatus = status; syncMessage = message ?? ""; render(); },
});

function pieceName(char: string, promoted: boolean): string {
  const base: Record<string, string> = { P: "歩", L: "香", N: "桂", S: "銀", G: "金", B: "角", R: "飛", K: "玉" };
  if (!promoted) return base[char.toUpperCase()] ?? char;
  return ({ P: "と", L: "杏", N: "圭", S: "全", B: "馬", R: "龍" }[char.toUpperCase()] ?? base[char.toUpperCase()] ?? char);
}
function hands(sfen: string, side: "gote" | "sente"): string {
  const hand = sfen.split(" ")[2] ?? "-";
  const counts = new Map<string, number>(); let multiplier = 0;
  for (const char of hand) {
    if (/\d/.test(char)) { multiplier = multiplier * 10 + Number(char); continue; }
    const isGote = char === char.toLowerCase();
    if (char !== "-" && isGote === (side === "gote")) counts.set(char.toUpperCase(), (counts.get(char.toUpperCase()) ?? 0) + (multiplier || 1));
    multiplier = 0;
  }
  return [...counts.entries()].map(([char, count]) => `<span class="hand-piece">${pieceName(char, false)}${count > 1 ? `<b aria-label="${count}枚">×${count}</b>` : ""}</span>`).join("") || "<span class=\"empty-hand\">なし</span>";
}
function board(sfen: string): string {
  const rows = (sfen.split(" ")[0] ?? "").split("/");
  if (rows.length !== 9) return `<p class="error">此局面的 SFEN 不完整，無法安全顯示。</p>`;
  const cells = rows.map((row) => {
    const out: string[] = [];
    for (let i = 0; i < row.length; i += 1) {
      const char = row[i]!;
      if (/\d/.test(char)) { for (let n = 0; n < Number(char); n += 1) out.push("<span class=\"square\"></span>"); }
      else {
        const promoted = char === "+";
        const piece = promoted ? row[++i] : char;
        if (!piece || !/[PLNSGBRKplnsgbrk]/.test(piece)) return "";
        const owner = piece === piece.toUpperCase() ? "sente" : "gote";
        out.push(`<span class="square piece ${owner}">${pieceName(piece, promoted)}</span>`);
      }
    }
    return out.length === 9 ? out.join("") : "";
  });
  if (cells.some((row) => !row)) return `<p class="error">此局面的 SFEN 不完整，無法安全顯示。</p>`;
  return `<div class="position"><div class="hand gote" aria-label="後手持駒">${hands(sfen, "gote")}</div><div class="board" aria-label="將棋盤">${cells.join("")}</div><div class="hand sente" aria-label="先手持駒">${hands(sfen, "sente")}</div></div>`;
}
function optionList(values: readonly string[], selected: string): string { return values.map((value) => `<option value="${esc(value)}" ${value === selected ? "selected" : ""}>${esc(value)}</option>`).join(""); }
function tagChecks(selected: IssueTag[]): string { return ISSUE_TAGS.map((tag) => `<label class="check"><input type="checkbox" name="issueTags" value="${esc(tag)}" ${selected.includes(tag) ? "checked" : ""}>${esc(tag)}</label>`).join(""); }
function gameHash(gameId: string, ply: number, rethink = false): string {
  return `#/game/${encodeURIComponent(gameId)}?ply=${ply}${rethink ? "&rethink=1" : ""}`;
}
function setPly(ply: number): void {
  if (!selectedGame) return;
  const nextPly = Math.max(0, Math.min(ply, selectedGame.moves.length));
  location.hash = gameHash(selectedGame.id, nextPly, rethinkMode);
}
function resetScroll(): void {
  if (typeof window.scrollTo === "function") window.scrollTo({ top: 0, left: 0, behavior: "auto" });
}

function render(): void {
  const route = location.hash;
  if (route.startsWith("#/game/")) {
    const [rawId, query = ""] = route.slice(7).split("?");
    let id = "";
    try { id = decodeURIComponent(rawId ?? ""); } catch { location.hash = "#/"; return; }
    const params = new URLSearchParams(query);
    const requestedPly = Number(params.get("ply"));
    selectedPly = Number.isInteger(requestedPly) && requestedPly >= 0 ? requestedPly : 0; rethinkMode = params.get("rethink") === "1";
    selectedGame = data.games.find((game) => game.id === id);
    if (!selectedGame) location.hash = "#/";
    else {
      selectedPly = Math.min(selectedPly, selectedGame.moves.length);
      const routeKey = `#/game/${rawId}`;
      if (routeKey !== renderedRoute) resetScroll();
      renderedRoute = routeKey;
      renderGame(selectedGame);
      return;
    }
  }
  if (renderedRoute !== "#/") resetScroll();
  renderedRoute = "#/";
  renderHome();
}
function renderHome(): void {
  selectedGame = undefined;
  app!.innerHTML = `<header><h1>將棋複盤室</h1><p>把棋譜變成可重複使用的複盤局面。</p></header><main class="home">
    <section class="panel import"><h2>匯入棋譜</h2><label>棋局名稱<input id="title" placeholder="例如：2026-08-12 對局"></label><label>格式<select id="format"><option>KIF</option><option>KI2</option><option>CSA</option></select></label><label>貼上棋譜<textarea id="source" rows="9"></textarea></label><div class="actions"><button id="import">載入棋譜</button><label class="file-button">選擇檔案<input id="file" type="file" accept=".kif,.ki2,.csa,.txt"></label></div><p id="error" class="error" role="alert">${esc(startupError)}</p></section>
    <section class="panel library"><h2>複盤局面</h2>${renderLibrary()}</section>
    <section class="panel"><h2>我的棋局</h2>${data.games.length ? data.games.map(gameCard).join("") : "<p class='muted'>尚未有棋局。</p>"}</section>
    <section class="panel"><h2>備份</h2><p class="muted">備份會完整取代目前本機資料。</p><div class="actions"><button id="export">下載 JSON</button><label class="file-button">還原備份<input id="backup" type="file" accept=".json"></label></div></section>
    <section class="panel"><h2>帳號與同步</h2>${activeUser ? `<p><strong>Google：${esc(activeUser.email ?? activeUser.id)}</strong></p><p>此帳號本機棋局：${data.games.length} 局</p>` : `<p>本機訪客資料：${data.games.length} 局</p><p class="muted">登出時只會顯示訪客資料；帳號資料仍保留在本機但不會暴露。</p>`}<p id="sync-status" role="status">${esc(syncStatus)}${syncMessage ? `：${esc(syncMessage)}` : ""}</p><p class="muted">公開 publishable key：${esc(SUPABASE_PUBLISHABLE_KEY.slice(0, 18))}…；本機資料仍是離線主資料。</p><div class="actions">${!activeUser ? `<button id="google-login">使用 Google 登入</button>` : `<button id="logout" class="secondary">登出</button>`}<button id="sync-now" class="secondary" ${!activeUser || profileLoadFailed ? "disabled" : ""}>立即同步</button></div>${pendingConflict ? `<div class="actions"><button id="use-cloud">使用雲端</button><button id="keep-local" class="secondary">保留這台裝置</button></div>` : ""}</section></main>`;
  document.querySelector("#import")?.addEventListener("click", () => void importText());
  document.querySelector<HTMLInputElement>("#file")?.addEventListener("change", (e) => void importFile(e));
  document.querySelector("#export")?.addEventListener("click", exportData);
  document.querySelector<HTMLInputElement>("#backup")?.addEventListener("change", (e) => void restoreFile(e));
  document.querySelector("#google-login")?.addEventListener("click", () => void startGoogleLoginFromUi());
  document.querySelector("#sync-now")?.addEventListener("click", () => void syncNow());
  document.querySelector("#logout")?.addEventListener("click", () => void logout());
  document.querySelector("#use-cloud")?.addEventListener("click", () => void resolveConflict("cloud"));
  document.querySelector("#keep-local")?.addEventListener("click", () => void resolveConflict("local"));
  document.querySelector("#library")?.addEventListener("change", filterLibrary);
  document.querySelectorAll<HTMLElement>("[data-open]").forEach((el) => el.addEventListener("click", () => { location.hash = gameHash(el.dataset.open ?? "", Number(el.dataset.ply ?? 0)); }));
  document.querySelectorAll<HTMLElement>("[data-download]").forEach((el) => el.addEventListener("click", () => { const game = data.games.find((item) => item.id === el.dataset.download); if (game) downloadKifu(game.sourceText, game.sourceFormat, game.title); }));
  document.querySelectorAll<HTMLElement>("[data-edit]").forEach((el) => el.addEventListener("click", () => editPoint(el.dataset.edit!)));
  document.querySelectorAll<HTMLElement>("[data-delete]").forEach((el) => el.addEventListener("click", () => void deletePoint(el.dataset.delete!)));
  document.querySelectorAll<HTMLElement>("[data-rethink]").forEach((el) => el.addEventListener("click", () => { location.hash = gameHash(el.dataset.rethink ?? "", Number(el.dataset.ply ?? 0), true); }));
}
function renderLibrary(): string {
  const points = data.games.flatMap((game) => game.reviewPoints.map((point) => ({ game, point })));
  return `<div id="library"><div class="filters"><label>棋局<select name="game"><option value="">全部</option>${data.games.map((game) => `<option value="${esc(game.id)}">${esc(game.title)}</option>`).join("")}</select></label><label>原因<select name="reason"><option value="">全部</option>${optionList(REASONS, "")}</select></label><fieldset><legend>問題標籤</legend>${tagChecks([])}</fieldset></div><div id="library-list">${points.length ? points.map(({ game, point }) => libraryItem(game, point)).join("") : "<p class='muted'>儲存第一個複盤局面後，它會出現在這裡。</p>"}</div></div>`;
}
function libraryItem(game: Game, point: ReviewPoint): string {
  return `<article class="library-item" data-game="${esc(game.id)}" data-reason="${esc(point.reason)}" data-tags="${esc(point.issueTags.join("|"))}"><h3>${esc(game.title)} · 第 ${point.ply} 手</h3><p>${esc(point.reason)}${point.issueTags.length ? ` · ${point.issueTags.map(esc).join("、")}` : ""}</p><div class="actions"><button data-open="${esc(game.id)}" data-ply="${point.ply}">開啟局面</button><button data-rethink="${esc(game.id)}" data-ply="${point.ply}">重新思考</button><button class="secondary" data-edit="${esc(point.id)}">編輯</button><button class="danger" data-delete="${esc(point.id)}">刪除</button></div></article>`;
}
function filterLibrary(): void {
  const root = document.querySelector("#library"); if (!root) return;
  const game = (root.querySelector('[name="game"]') as HTMLSelectElement).value;
  const reason = (root.querySelector('[name="reason"]') as HTMLSelectElement).value;
  const tags = Array.from(root.querySelectorAll<HTMLInputElement>('input[name="issueTags"]:checked')).map((input) => input.value);
  root.querySelectorAll<HTMLElement>(".library-item").forEach((item) => {
    const visible = (!game || item.dataset.game === game) && (!reason || item.dataset.reason === reason) && (!tags.length || tags.some((tag) => (item.dataset.tags ?? "").split("|").includes(tag)));
    item.style.display = visible ? "" : "none";
  });
}
function gameCard(game: Game): string { return `<article class="game-card"><div><h3>${esc(game.title)}</h3><p>${game.sourceFormat} · ${game.moves.length} 手 · ${game.reviewPoints.length} 個複盤局面</p></div><div class="actions"><button data-open="${esc(game.id)}" data-ply="0">開啟</button><button class="secondary" data-download="${esc(game.id)}">下載原始棋譜</button></div></article>`; }
function renderGame(game: Game): void {
  const sfen = game.sfens[selectedPly] ?? game.initialSfen;
  const point = game.reviewPoints.find((item) => item.ply === selectedPly);
  const rethink = rethinkMode && point ? `<section class="rethink panel"><h2>重新思考</h2>${board(point.sfen)}<p class="prompt">如果再遇到這個局面，你會先注意什麼？</p><button id="reveal">揭示記錄</button><div id="reveal-content" hidden><p><strong>原因：</strong>${esc(point.reason)}</p><p><strong>問題：</strong>${point.issueTags.length ? point.issueTags.map(esc).join("、") : "未標記"}</p>${point.note ? `<p><strong>下次注意：</strong>${esc(point.note)}</p>` : ""}${point.externalNotes ? `<p><strong>外部分析：</strong>${esc(point.externalNotes)}</p>` : ""}${point.legacyNotes ? `<details><summary>舊版筆記</summary><p>${esc(point.legacyNotes)}</p></details>` : ""}</div></section>` : "";
  app!.innerHTML = `<header><a href="#/">← 首頁</a><h1>${esc(game.title)}</h1><p>${game.sourceFormat} · ${game.moves.length} 手</p></header><main class="review-layout"><section class="panel replay">${board(sfen)}<p class="sfen">${esc(sfen)}</p><div class="replay-controls"><button id="prev" ${selectedPly === 0 ? "disabled" : ""}>上一手</button><strong>第 ${selectedPly} / ${game.moves.length} 手</strong><button id="next" ${selectedPly >= game.moves.length ? "disabled" : ""}>下一手</button></div><ol class="moves">${game.moves.map((move, i) => `<li class="${i + 1 === selectedPly ? "active" : ""}"><button data-ply="${i + 1}">${esc(move)}</button></li>`).join("")}</ol><button class="secondary" id="download-kifu">下載原始棋譜</button></section><section class="panel note-panel"><h2>${point ? "編輯" : "建立"}複盤局面</h2><form id="point-form"><label for="reason"><span>為什麼標記這裡？ <strong>必填</strong></span></label><select id="reason" name="reason" required>${`<option value="" disabled ${point ? "" : "selected"}>請選擇原因</option>`}${optionList(REASONS, point?.reason ?? "")}</select><fieldset><legend>涉及哪些問題？（可複選）</legend>${tagChecks(point?.issueTags ?? [])}</fieldset><label for="note"><span>下次要注意什麼？</span></label><textarea id="note" name="note">${esc(point?.note ?? "")}</textarea><details><summary>外部分析筆記</summary><label for="external-notes">外部分析筆記</label><textarea id="external-notes" name="externalNotes">${esc(point?.externalNotes ?? "")}</textarea></details>${point?.legacyNotes ? `<details open><summary>舊版筆記</summary><textarea name="legacyNotes" readonly>${esc(point.legacyNotes)}</textarea></details>` : ""}<button type="submit">${point ? "更新" : "儲存"}複盤局面</button></form></section>${rethink}</main>`;
  document.querySelector("#prev")?.addEventListener("click", () => setPly(selectedPly - 1));
  document.querySelector("#next")?.addEventListener("click", () => setPly(selectedPly + 1));
  document.querySelectorAll<HTMLElement>("[data-ply]").forEach((el) => el.addEventListener("click", () => setPly(Number(el.dataset.ply))));
  document.querySelector("#point-form")?.addEventListener("submit", (event) => void savePoint(event, game));
  document.querySelector("#download-kifu")?.addEventListener("click", () => downloadKifu(game.sourceText, game.sourceFormat, game.title));
  document.querySelector("#reveal")?.addEventListener("click", () => { const content = document.querySelector<HTMLElement>("#reveal-content"); if (content) { content.hidden = false; (document.querySelector("#reveal") as HTMLButtonElement).remove(); } });
}
function showError(error: unknown): void { const target = document.querySelector("#error"); if (target) target.textContent = error instanceof Error ? error.message : "發生未知錯誤。"; }
async function importText(): Promise<void> { try { await addGame(document.querySelector<HTMLTextAreaElement>("#source")?.value ?? "", document.querySelector<HTMLSelectElement>("#format")?.value as InputFormat, document.querySelector<HTMLInputElement>("#title")?.value ?? ""); } catch (error) { showError(error); } }
async function importFile(event: Event): Promise<void> { const file = (event.target as HTMLInputElement).files?.[0]; if (!file) return; try { const source = decodeRecordBytes(new Uint8Array(await file.arrayBuffer())); await addGame(source, detectFormat(source, file.name), file.name); } catch (error) { showError(error); } }
async function addGame(source: string, format: InputFormat, title: string): Promise<void> {
  const game = parseGame(source, format, title); const existing = data.games.find((item) => item.canonicalHash === game.canonicalHash);
  if (!existing) { const previous = data.games; data.games = [...previous, game]; try { await persist(); } catch (error) { data.games = previous; throw error; } }
  location.hash = gameHash((existing ?? game).id, 0); render();
}
async function savePoint(event: Event, game: Game): Promise<void> {
  const form = event.currentTarget as HTMLFormElement;
  if (!form.reportValidity()) return;
  event.preventDefault(); const values = new FormData(form); const reason = String(values.get("reason") ?? "");
  if (!REASONS.includes(reason as Reason)) { form.reportValidity(); return; }
  const old = game.reviewPoints.find((item) => item.ply === selectedPly); const point: ReviewPoint = { id: old?.id ?? uid("point"), ply: selectedPly, sfen: game.sfens[selectedPly]!, reason: reason as Reason, issueTags: values.getAll("issueTags").filter((tag): tag is IssueTag => ISSUE_TAGS.includes(tag as IssueTag)), note: text(values.get("note")), externalNotes: text(values.get("externalNotes")), legacyNotes: old?.legacyNotes, createdAt: old?.createdAt ?? new Date().toISOString() };
  const previous = game.reviewPoints; game.reviewPoints = [...previous.filter((item) => item.ply !== selectedPly), point].sort((a, b) => a.ply - b.ply);
  try { await persist(); render(); } catch (error) { game.reviewPoints = previous; render(); showError(error); }
}
function text(value: FormDataEntryValue | null): string | undefined { return typeof value === "string" && value.trim() ? value : undefined; }
function editPoint(id: string): void { const point = data.games.flatMap((game) => game.reviewPoints.map((item) => ({ game, item }))).find(({ item }) => item.id === id); if (point) { location.hash = `#/game/${encodeURIComponent(point.game.id)}?ply=${point.item.ply}`; } }
async function deletePoint(id: string): Promise<void> { if (!window.confirm("確定刪除此複盤局面？")) return; const game = data.games.find((item) => item.reviewPoints.some((point) => point.id === id)); if (!game) return; const previous = game.reviewPoints; game.reviewPoints = previous.filter((point) => point.id !== id); try { await persist(); render(); } catch (error) { game.reviewPoints = previous; showError(error); } }
async function persist(): Promise<void> {
  await repo.saveProfile(activeProfile, data);
  if (activeUser && !profileLoadFailed) {
    syncStatus = "尚未同步";
    autosync.schedule();
  }
}
function exportData(): void { const link = document.createElement("a"); link.href = URL.createObjectURL(new Blob([JSON.stringify(createBackup(data), null, 2)], { type: "application/json" })); link.download = "shogi-review-backup.json"; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000); }
async function restoreFile(event: Event): Promise<void> { const file = (event.target as HTMLInputElement).files?.[0]; if (!file) return; try { const restored = parseBackup(await file.text()); if (!window.confirm("這會完整取代目前本機資料，確定要還原嗎？")) return; const previous = data; try { data = restored; await persist(); render(); } catch (error) { data = previous; throw error; } } catch (error) { showError(error); } }
async function startGoogleLoginFromUi(): Promise<void> {
  const button = document.querySelector<HTMLButtonElement>("#google-login");
  if (button) { button.disabled = true; button.textContent = "正在前往 Google…"; }
  try {
    const error = await startGoogleLogin(supabase, window.localStorage, googleRedirectUrl(window.location.origin));
    if (!error) return;
    syncMessage = error;
  } catch (error) {
    syncMessage = error instanceof Error ? `Google 登入啟動失敗：${error.message}` : "Google 登入啟動失敗，請重試。";
  }
  render();
}
async function logout(): Promise<void> {
  profileGeneration += 1;
  autosync.invalidate();
  const { error } = await supabase.auth.signOut();
  if (error) { syncStatus = "離線／同步失敗"; syncMessage = `登出失敗：${error.message}`; }
  else {
    activeUser = null; activeProfile = "guest"; profileLoadFailed = false; syncStatus = "僅本機";
    syncMessage = "已登出；帳號資料仍保留在本機但已隱藏。";
    await activateProfile("guest");
  }
  render();
}
async function syncNow(): Promise<void> {
  if (!activeUser || profileLoadFailed) return;
  await autosync.reconcile();
  return;
  /*
  syncMessage = "";
  try {
    const user = await currentUser();
    if (!user) { syncStatus = "僅本機"; syncMessage = "請先登入；同步不會自動執行。"; render(); return; }
    const cloud = new SupabaseSyncRepository();
    const row = await cloud.read(user.id);
    const localHash = await payloadHash(data);
    const cloudData = row ? validateCloudPayload(row.payload) : null;
    const cloudHash = cloudData ? await payloadHash(cloudData) : undefined;
    syncMetadata = readMetadata(user.id);
    const baseline = syncMetadata.ownerUid === user.id && syncMetadata.lastSyncedRevision !== undefined;
    const localChanged = !baseline || localHash !== syncMetadata.lastSyncedPayloadHash;
    const cloudChanged = !baseline || !row || row.revision !== syncMetadata.lastSyncedRevision || cloudHash !== syncMetadata.lastSyncedPayloadHash;
    if (row && row.user_id !== user.id) throw new Error("雲端資料屬於另一個帳號，未套用任何變更。");
    if (baseline && !row) throw new Error("雲端資料已不存在；未自動覆蓋本機資料，請重新同步建立基線。");
    const decision = decideSync({ baseline, local: data, cloud: cloudData, localHash, cloudHash, localChanged, cloudChanged });
    if (decision === "conflict" && cloudData && row) { pendingConflict = { userId: user.id, rowRevision: row.revision, cloudData }; syncStatus = "衝突"; syncMessage = `本機 ${data.games.length} 局、雲端 ${cloudData.games.length} 局；請先備份再選擇。`; render(); return; }
    if (decision === "download-cloud" && cloudData && row) {
      if (!window.confirm("這會以已驗證的雲端資料取代本機資料，確定嗎？")) return;
      await repo.save(cloudData);
      data = cloudData;
      syncMetadata = { ownerUid: user.id, lastSyncedRevision: row.revision, lastSyncedPayloadHash: cloudHash, hashVersion: 1 };
    } else if (decision === "initialize-empty" || decision === "initialize-local" || decision === "push-local") {
      if (decision === "initialize-local" && !window.confirm("要將這台裝置的棋局上傳為新帳號基線嗎？")) return;
      const saved = decision === "push-local" && row ? await cloud.casUpdate(user.id, row.revision, createBackup(data)) : await cloud.insert(user.id, createBackup(data), 1);
      syncMetadata = { ownerUid: user.id, lastSyncedRevision: saved.revision, lastSyncedPayloadHash: localHash, hashVersion: 1 };
    }
    writeMetadata(user.id, syncMetadata);
    pendingConflict = undefined;
    syncStatus = "已同步";
    syncMessage = "";
    render();
  } catch (error) {
    syncStatus = "離線／同步失敗";
    syncMessage = error instanceof Error ? error.message : "同步失敗，未套用任何變更。";
    render();
  }
}
*/
}
function readMetadata(userId: string): SyncMetadata {
  try { return JSON.parse(window.localStorage.getItem(`shogi-review-sync:${userId}`) ?? '{"hashVersion":1}') as SyncMetadata; }
  catch { return { hashVersion: 1 }; }
}
function writeMetadata(userId: string, value: SyncMetadata): void { window.localStorage.setItem(`shogi-review-sync:${userId}`, JSON.stringify(value)); }
async function resolveConflict(choice: "cloud" | "local"): Promise<void> {
  if (!pendingConflict) return;
  if (!window.confirm(choice === "cloud" ? "先下載一份本機 JSON 後，以驗證過的雲端資料取代本機嗎？" : "先下載一份雲端 JSON 後，以本機資料覆蓋雲端嗎？")) return;
  try {
    const conflict = pendingConflict;
    if (choice === "cloud") {
      exportData();
      await repo.saveProfile(activeProfile, conflict.cloudData);
      data = conflict.cloudData;
      syncMetadata = { ownerUid: conflict.userId, lastSyncedRevision: conflict.rowRevision, lastSyncedPayloadHash: await payloadHash(data), hashVersion: 1 };
    } else {
      exportData();
      const saved = await new SupabaseSyncRepository().casUpdate(conflict.userId, conflict.rowRevision, createBackup(data));
      syncMetadata = { ownerUid: conflict.userId, lastSyncedRevision: saved.revision, lastSyncedPayloadHash: await payloadHash(data), hashVersion: 1 };
    }
    writeMetadata(conflict.userId, syncMetadata);
    pendingConflict = undefined;
    syncStatus = "已同步";
    syncMessage = "";
  } catch (error) {
    syncStatus = "離線／同步失敗";
    syncMessage = error instanceof Error ? error.message : "衝突處理失敗，未套用任何變更。";
  }
  render();
}
window.addEventListener("hashchange", render);
async function bootstrap(): Promise<void> {
  const callbackError = await finishPkceCallback();
  if (callbackError) startupError = callbackError;
  try {
    const user = await currentUser();
    if (user) { activeUser = user; activeProfile = `user:${user.id}`; await prepareAccountProfile(user.id); }
    await activateProfile(activeProfile);
  } catch (error) {
    startupError = `${error instanceof Error ? error.message : "本機資料格式無效。"} 未套用變更。`;
    profileLoadFailed = true; data = { games: [] };
    syncStatus = "離線／同步失敗";
    syncMessage = "本機資料載入失敗；已停用同步。";
  }
  render();
  if (activeUser && !profileLoadFailed) void autosync.reconcile();
}
void bootstrap();

async function activateProfile(profile: ProfileKey): Promise<void> {
  profileGeneration += 1;
  autosync.invalidate();
  profileLoadFailed = false;
  try {
    const loaded = await repo.loadProfile(profile);
    data = loaded.data;
    activeProfile = profile;
    if (loaded.migrated) await repo.saveProfile("guest", data);
  } catch (error) {
    profileLoadFailed = true;
    throw error;
  }
}
async function prepareAccountProfile(uid: string): Promise<void> {
  const guest = await repo.loadProfile("guest");
  const account = await repo.loadProfile(`user:${uid}`);
  if (guest.data.games.length > 0 && account.data.games.length === 0) {
    const copy = window.confirm("發現本機訪客棋局。要複製到此 Google 帳號嗎？訪客資料會保留；選擇取消則使用此帳號雲端資料。");
    if (copy) await repo.saveProfile(`user:${uid}`, guest.data);
  }
}

supabase.auth.onAuthStateChange((_event, session) => {
  const next = session?.user;
  if (next?.id === activeUser?.id || (!next && !activeUser)) return;
  void (async () => {
    profileGeneration += 1;
    autosync.invalidate();
    activeUser = next ? { id: next.id, email: next.email, user_metadata: next.user_metadata } : null;
    activeProfile = next ? `user:${next.id}` : "guest";
    try {
      if (activeUser) await prepareAccountProfile(activeUser.id);
      await activateProfile(activeProfile);
      syncStatus = activeUser ? "同步中" : "僅本機";
      render();
      if (activeUser) await autosync.reconcile();
    } catch (error) {
      syncStatus = "離線／同步失敗";
      syncMessage = error instanceof Error ? `本機資料載入失敗：${error.message}；已停用同步。` : "本機資料載入失敗；已停用同步。";
      render();
    }
  })();
});

let lastFocusSync = 0;
function triggerVisibleSync(): void {
  if (!activeUser || profileLoadFailed || syncStatus === "尚未同步") return;
  const now = Date.now();
  if (now - lastFocusSync < 5000) return;
  lastFocusSync = now;
  void autosync.reconcile();
}
window.addEventListener("online", () => { if (activeUser && !profileLoadFailed) void autosync.reconcile(); });
window.addEventListener("focus", triggerVisibleSync);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") triggerVisibleSync(); });