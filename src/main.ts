import { createBackup, parseBackup } from "./backup.js";
import { detectFormat, decodeRecordBytes, parseGame, type InputFormat } from "./parser.js";
import { CATEGORIES, type AppData, type Game, type ReviewPoint } from "./model.js";
import { answerCard, isDue, newCard } from "./schedule.js";
import { IndexedDbRepository, MemoryRepository, type Repository } from "./repository.js";
import "./style.css";

let repo: Repository = "indexedDB" in window ? new IndexedDbRepository() : new MemoryRepository();
let data: AppData = { games: [] };
let selectedGame: Game | undefined;
let selectedPly = 0;
let startupError = "";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("找不到 app 容器。");

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[char] ?? char));
}

function board(sfen: string): string {
  const boardPart = sfen.split(" ")[0] ?? "";
  const rows = boardPart.split("/");
  if (rows.length !== 9) return `<p class="error">此局面的 SFEN 不完整，無法安全顯示。</p>`;
  return `<div class="board" aria-label="將棋盤">${rows.map((row) => {
    const cells: string[] = [];
    for (let index = 0; index < row.length; index += 1) {
      const char = row[index];
      if (/\d/.test(char)) for (let i = 0; i < Number(char); i += 1) cells.push("<span></span>");
      else {
        const promoted = char === "+";
        const piece = promoted ? row[++index] : char;
        if (!piece || !/[PLNSGBRKplnsgbrk]/.test(piece)) return "";
        cells.push(`<span class="${piece === piece.toUpperCase() ? "black" : "white"}${promoted ? " promoted" : ""}">${pieceName(piece)}${promoted ? "成" : ""}</span>`);
      }
    }
    return cells.length === 9 ? cells.join("") : "";
  }).join("")}</div>`;
}

function pieceName(char: string): string {
  return ({ P: "歩", L: "香", N: "桂", S: "銀", G: "金", B: "角", R: "飛", K: "玉",
    p: "歩", l: "香", n: "桂", s: "銀", g: "金", b: "角", r: "飛", k: "玉" }[char] ?? char);
}

function render(): void {
  const route = location.hash;
  if (route.startsWith("#/game/")) {
    try {
      const id = decodeURIComponent(route.slice(7));
      if (selectedGame?.id !== id) selectedPly = 0;
      selectedGame = data.games.find((game) => game.id === id);
    } catch {
      selectedGame = undefined;
      location.hash = "#/";
    }
  } else if (route === "#/cards") {
    selectedGame = undefined;
    renderCards();
    return;
  }
  if (!route.startsWith("#/game/")) selectedGame = undefined;
  if (!selectedGame) renderHome(); else renderGame(selectedGame);
}

function renderHome(): void {
  selectedGame = undefined;
  app!.innerHTML = `<header><h1>將棋複盤室</h1><p>把棋譜變成下一次看得懂的學習卡片。</p></header>
    <main class="home"><section class="panel import"><h2>匯入棋譜</h2>
      <label>棋局名稱<input id="title" placeholder="例如：2026-08-12 對局" /></label>
      <label>格式<select id="format"><option>KIF</option><option>KI2</option><option>CSA</option></select></label>
      <label>貼上棋譜<textarea id="source" rows="9" placeholder="可直接貼上 KIF、KI2 或 CSA"></textarea></label>
      <div class="actions"><button id="import">載入棋譜</button><label class="file-button">選擇檔案<input id="file" type="file" accept=".kif,.ki2,.csa,.txt" /></label></div>
      <p id="error" class="error" role="alert">${esc(startupError)}</p></section>
      <section class="panel"><h2>我的棋局</h2>${data.games.length ? data.games.map(gameCard).join("") : "<p class='muted'>尚未有棋局。資料只儲存在本機瀏覽器。</p>"}</section>
      <section class="panel"><h2>複習卡</h2><p class="muted">到期卡片：${data.games.reduce((count, game) => count + game.cards.filter((card) => isDue(card)).length, 0)} 張 · 日期採 UTC。</p><a class="button-link" href="#/cards">開始複習</a></section>
      <section class="panel"><h2>備份</h2><p class="muted">備份會保留棋譜、局面、複盤點、卡片與排程；日期採 UTC。</p>
        <div class="actions"><button id="export">下載完整 JSON</button><label class="file-button">還原備份<input id="backup" type="file" accept=".json" /></label></div></section></main>`;
  document.querySelector("#import")?.addEventListener("click", () => void importText());
  document.querySelector<HTMLInputElement>("#file")?.addEventListener("change", (event) => void importFile(event));
  document.querySelector("#export")?.addEventListener("click", exportData);
  document.querySelector<HTMLInputElement>("#backup")?.addEventListener("change", (event) => void restoreFile(event));
  document.querySelectorAll<HTMLElement>("[data-open]").forEach((button) => button.addEventListener("click", () => {
    selectedPly = 0; location.hash = `#/game/${encodeURIComponent(button.dataset.open ?? "")}`;
  }));
}

function renderCards(): void {
  const due = data.games.flatMap((game) => game.cards.filter((card) => isDue(card).valueOf()).map((card) => ({ game, card, point: game.reviewPoints.find((item) => item.id === card.reviewPointId) }))).filter((item) => item.point);
  app!.innerHTML = `<header><a href="#/">← 我的棋局</a><h1>複習卡</h1><p>先看局面，心中選一手，再揭示自己的記錄。</p></header><main><section class="panel">${due.length ? due.map(({ game, card, point }) => `<article class="card-review" data-card="${esc(card.id)}" data-game="${esc(game.id)}"><h2>${esc(game.title)} · 第 ${point!.ply} 手</h2>${board(point!.sfen)}<p class="prompt">我當時在想什麼？</p><button class="reveal">揭示記錄</button><div class="answer-content" hidden><p><strong>我的記錄：</strong>${esc(point!.thinking)}</p><p><strong>下次先考慮：</strong>${esc(point!.nextConsideration)}</p>${point!.externalNotes ? `<p><strong>外部筆記：</strong>${esc(point!.externalNotes)}</p>` : ""}<div class="actions"><button data-answer="again">再想一次（1 天）</button><button data-answer="remembered">記住了（下一階段）</button></div></div></article>`).join("") : "<p class='muted'>目前沒有到期卡片。從棋局複盤點加入卡片吧。</p>"}</section></main>`;
  document.querySelectorAll<HTMLElement>(".reveal").forEach((button) => button.addEventListener("click", () => {
    const content = button.parentElement?.querySelector<HTMLElement>(".answer-content"); if (content) { content.hidden = false; button.remove(); }
  }));
  document.querySelectorAll<HTMLButtonElement>("[data-answer]").forEach((button) => button.addEventListener("click", () => {
    const cardElement = button.closest<HTMLElement>("[data-card]"); const game = data.games.find((item) => item.id === cardElement?.dataset.game); const card = game?.cards.find((item) => item.id === cardElement?.dataset.card);
    if (game && card) {
      const previous = { ...card };
      Object.assign(card, answerCard(card, button.dataset.answer === "again" ? "again" : "remembered"));
      void persist().then(renderCards).catch(() => Object.assign(card, previous));
    }
  }));
}

function gameCard(game: Game): string {
  const due = game.cards.filter((card) => isDue(card)).length;
  return `<article class="game-card"><div><h3>${esc(game.title)}</h3><p>${game.sourceFormat} · ${game.moves.length} 手 · ${game.reviewPoints.length} 個複盤點${due ? ` · <strong>${due} 張到期卡</strong>` : ""}</p></div><button data-open="${esc(game.id)}">開啟</button></article>`;
}

function renderGame(game: Game): void {
  const sfen = game.sfens[selectedPly] ?? game.initialSfen;
  const point = game.reviewPoints.find((item) => item.ply === selectedPly);
  app!.innerHTML = `<header class="game-header"><a href="#/">← 我的棋局</a><h1>${esc(game.title)}</h1><span>${game.sourceFormat} · ${game.moves.length} 手</span></header>
    <main class="review-layout"><section class="panel replay"><div class="board-wrap">${board(sfen)}<p class="sfen">${esc(sfen)}</p></div>
      <div class="replay-controls"><button id="prev" ${selectedPly === 0 ? "disabled" : ""}>上一手</button><strong>第 ${selectedPly} / ${game.moves.length} 手</strong><button id="next" ${selectedPly >= game.moves.length ? "disabled" : ""}>下一手</button></div>
      <ol class="moves">${game.moves.map((move, index) => `<li class="${index + 1 === selectedPly ? "active" : ""}"><button data-ply="${index + 1}">${index + 1}. ${esc(move)}</button></li>`).join("")}</ol></section>
      <section class="panel note-panel"><h2>在第 ${selectedPly} 手建立複盤點</h2><form id="point-form">
        <label>我當時在想什麼？<textarea name="thinking" required>${esc(point?.thinking ?? "")}</textarea></label>
        <label>下次看到類似局面要先考慮什麼？<textarea name="nextConsideration" required>${esc(point?.nextConsideration ?? "")}</textarea></label>
        <label>分類<select name="category"><option value="">未分類</option>${CATEGORIES.map((cat) => `<option ${point?.category === cat ? "selected" : ""}>${cat}</option>`).join("")}</select></label>
        <label>標籤<input name="tag" value="${esc(point?.tag ?? "")}" /></label><label>候選手與對手應手<textarea name="candidates">${esc(point?.candidates ?? "")}</textarea></label>
        <label>外部 ShogiGUI／引擎筆記<textarea name="externalNotes">${esc(point?.externalNotes ?? "")}</textarea></label>
        <label>重要性<input name="importance" type="range" min="1" max="5" value="${point?.importance ?? 3}" /></label>
        <button type="submit">${point ? "更新複盤點" : "儲存複盤點"}</button></form>
        ${point ? `<button class="secondary" id="card">${game.cards.some((card) => card.reviewPointId === point.id) ? "已加入複習卡" : "加入複習卡"}</button>` : ""}
        <div class="points"><h3>本局複盤點</h3><label>篩選分類<select id="point-filter"><option value="">全部</option>${CATEGORIES.map((category) => `<option>${category}</option>`).join("")}</select></label><div id="point-list">${game.reviewPoints.map((item) => `<button data-category="${esc(item.category ?? "")}" data-ply="${item.ply}">第 ${item.ply} 手 · ${esc(item.category ?? "未分類")}</button>`).join("") || "<p class='muted'>選擇任意手數開始記錄。</p>"}</div></div>
      </section></main>`;
  document.querySelector("#prev")?.addEventListener("click", () => { selectedPly -= 1; render(); });
  document.querySelector("#next")?.addEventListener("click", () => { selectedPly += 1; render(); });
  document.querySelectorAll<HTMLElement>("[data-ply]").forEach((element) => element.addEventListener("click", () => { selectedPly = Number(element.dataset.ply); render(); }));
  document.querySelector<HTMLSelectElement>("#point-filter")?.addEventListener("change", (event) => {
    const category = (event.target as HTMLSelectElement).value;
    document.querySelectorAll<HTMLElement>("#point-list [data-category]").forEach((item) => { item.hidden = Boolean(category && item.dataset.category !== category); });
  });
  document.querySelector("#point-form")?.addEventListener("submit", (event) => void savePoint(event, game));
  document.querySelector("#card")?.addEventListener("click", () => void addCard(game, point));
}

async function importText(): Promise<void> {
  const source = document.querySelector<HTMLTextAreaElement>("#source")?.value ?? "";
  const format = document.querySelector<HTMLSelectElement>("#format")?.value as InputFormat;
  const title = document.querySelector<HTMLInputElement>("#title")?.value ?? "";
  await addGame(source, format, title);
}

async function importFile(event: Event): Promise<void> {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  try {
    const text = decodeRecordBytes(new Uint8Array(await file.arrayBuffer()));
    await addGame(text, detectFormat(text, file.name), file.name);
  } catch (error) { showError(error); }
}

async function addGame(source: string, format: InputFormat, title: string): Promise<void> {
  try {
    const game = parseGame(source, format, title);
    const existing = data.games.find((item) => item.canonicalHash === game.canonicalHash);
    if (!existing) {
      const previous = data.games;
      data.games = [...previous, game];
      try { await persist(); } catch { data.games = previous; throw new Error("匯入後儲存失敗，棋局未加入。"); }
    }
    location.hash = `#/game/${encodeURIComponent((existing ?? game).id)}`; selectedPly = 0; render();
  } catch (error) { showError(error); }
}

function showError(error: unknown): void {
  const message = error instanceof Error ? error.message : "發生未知錯誤。";
  const target = document.querySelector("#error"); if (target) target.textContent = message;
}

async function savePoint(event: Event, game: Game): Promise<void> {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const values = new FormData(form);
  const point: ReviewPoint = {
    id: game.reviewPoints.find((item) => item.ply === selectedPly)?.id ?? `point-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`,
    ply: selectedPly, sfen: game.sfens[selectedPly], thinking: String(values.get("thinking") ?? ""),
    nextConsideration: String(values.get("nextConsideration") ?? ""), category: (String(values.get("category") || "") || undefined) as ReviewPoint["category"],
    tag: String(values.get("tag") || "") || undefined, candidates: String(values.get("candidates") || "") || undefined,
    externalNotes: String(values.get("externalNotes") || "") || undefined, importance: Number(values.get("importance") ?? 3),     createdAt: game.reviewPoints.find((item) => item.ply === selectedPly)?.createdAt ?? new Date().toISOString(),
  };
  if (!point.thinking || !point.nextConsideration) return;
  const previous = game.reviewPoints;
  game.reviewPoints = [...previous.filter((item) => item.ply !== selectedPly), point].sort((a, b) => a.ply - b.ply);
  try { await persist(); render(); } catch { game.reviewPoints = previous; render(); }
}

async function addCard(game: Game, point: ReviewPoint | undefined): Promise<void> {
  if (!point || game.cards.some((card) => card.reviewPointId === point.id)) return;
  const card = newCard(point.id);
  game.cards.push(card);
  try { await persist(); render(); } catch { game.cards = game.cards.filter((item) => item !== card); render(); }
}

async function persist(): Promise<void> {
  try { await repo.save(data); } catch (error) { showError(error); throw error; }
}

function exportData(): void {
  const blob = new Blob([JSON.stringify(createBackup(data), null, 2)], { type: "application/json" });
  const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = "shogi-review-backup.json"; link.style.display = "none";
  document.body.append(link); link.click(); setTimeout(() => { URL.revokeObjectURL(link.href); link.remove(); }, 1000);
}

async function restoreFile(event: Event): Promise<void> {
  const file = (event.target as HTMLInputElement).files?.[0]; if (!file) return;
  try {
    const restored = parseBackup(await file.text());
    if (!window.confirm("這會完整取代目前本機資料，確定要還原嗎？")) return;
    const previous = data;
    try { data = restored; await persist(); render(); } catch (error) { data = previous; throw error; }
  } catch (error) { showError(error); }
}

window.addEventListener("hashchange", render);
void repo.load().then((loaded) => { data = loaded; render(); }).catch((error) => {
  startupError = `${error instanceof Error ? error.message : "本機儲存空間無法使用"} 本次改用暫存模式，重新整理後不會保留新資料。`;
  repo = new MemoryRepository();
  data = { games: [] };
  render();
});
