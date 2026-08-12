import { importCSA, importKIF, importKI2, type ImmutableNode, type ImmutableRecord } from "tsshogi";
import type { Game } from "./model.js";

export type InputFormat = "KIF" | "KI2" | "CSA";

export function decodeRecordBytes(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    bytes = bytes.slice(3);
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
  if (ext === "csa" || /^(?:V\d|N[+-]|P[1-9][+-]|[+-]\d{4})/m.test(text)) return "CSA";
  if (ext === "ki2") return "KI2";
  return "KIF";
}

function parse(text: string, format: InputFormat): ImmutableRecord {
  const result = format === "CSA" ? importCSA(text) : format === "KI2" ? importKI2(text) : importKIF(text);
  if (result instanceof Error) throw new Error(`無法解析 ${format} 棋譜：${result.message}`);
  return result;
}

function isPlayableMove(node: ImmutableNode): boolean {
  return !("type" in node.move);
}

export function parseGame(text: string, format: InputFormat, title = "未命名棋局"): Game {
  if (!text.trim()) throw new Error("請貼上棋譜或選擇檔案。");
  const record = parse(text, format);
  const playableMoves = record.moves.filter(isPlayableMove);
  if (!playableMoves.length) throw new Error("棋譜沒有可重播的指し手，無法建立複盤。");
  const sfens = [record.initialPosition.sfen, ...playableMoves.map((node) => node.sfen)];
  const moves = playableMoves.map((node) => node.displayText);
  const canonical = `${sfens[0]}|${sfens.join("|")}`;
  const hash = fnv1a(canonical);
  const id = `game-${hash}`;
  return {
    id, title: title.trim() || "未命名棋局", sourceFormat: format, sourceText: text,
    initialSfen: sfens[0], sfens, moves, canonicalHash: hash,
    createdAt: new Date().toISOString(), reviewPoints: [],
  };
}

export function fnv1a(value: string): string {
  let hash = 14695981039346656037n;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= BigInt(value.charCodeAt(i));
    hash = BigInt.asUintN(64, hash * 1099511628211n);
  }
  return hash.toString(16).padStart(16, "0");
}
