import { importCSA, importKIF, importKI2, type ImmutableRecord } from "tsshogi";
import type { Game } from "./model.js";

export type InputFormat = "KIF" | "KI2" | "CSA";

export function decodeRecordBytes(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.slice(3));
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    try {
      return new TextDecoder("shift-jis", { fatal: true }).decode(bytes);
    } catch {
      throw new Error("檔案不是有效的 UTF-8 或 Shift-JIS，無法安全解碼。");
    }
  }
}

export function detectFormat(text: string, fileName = ""): InputFormat {
  const ext = fileName.toLowerCase().split(".").pop();
  if (ext === "csa" || text.includes("N+" ) || text.includes("N-")) return "CSA";
  if (ext === "ki2") return "KI2";
  return "KIF";
}

function parse(text: string, format: InputFormat): ImmutableRecord {
  const result = format === "CSA" ? importCSA(text) : format === "KI2" ? importKI2(text) : importKIF(text);
  if (result instanceof Error) throw new Error(`無法解析 ${format} 棋譜：${result.message}`);
  if (!result.moves.length && !result.initialPosition) throw new Error("棋譜沒有可重播的內容。");
  return result;
}

export function parseGame(text: string, format: InputFormat, title = "未命名棋局"): Game {
  if (!text.trim()) throw new Error("請貼上棋譜或選擇檔案。");
  const record = parse(text, format);
  const sfens = [record.initialPosition.sfen, ...record.moves.map((node) => node.sfen)];
  const moves = record.moves.map((node) => node.displayText);
  const canonical = `${sfens[0]}|${sfens.join("|")}`;
  const hash = fnv1a(canonical);
  const id = `game-${hash}`;
  return {
    id, title: title.trim() || "未命名棋局", sourceFormat: format, sourceText: text,
    initialSfen: sfens[0], sfens, moves, canonicalHash: hash,
    createdAt: new Date().toISOString(), reviewPoints: [], cards: [],
  };
}

export function fnv1a(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
