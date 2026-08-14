export type BoardOrientation = "normal" | "flipped";

export interface BoardCell {
  piece?: string;
  promoted?: boolean;
}

export interface BoardView {
  cells: BoardCell[];
  topHandOwner: "gote" | "sente";
  bottomHandOwner: "gote" | "sente";
}

function parseCells(sfen: string): BoardCell[] | null {
  const rows = (sfen.split(" ")[0] ?? "").split("/");
  if (rows.length !== 9) return null;
  const cells: BoardCell[] = [];
  for (const row of rows) {
    const parsed: BoardCell[] = [];
    for (let i = 0; i < row.length; i += 1) {
      const char = row[i]!;
      if (/\d/.test(char)) {
        for (let n = 0; n < Number(char); n += 1) parsed.push({});
      } else {
        const promoted = char === "+";
        const piece = promoted ? row[++i] : char;
        if (!piece || !/[PLNSGBRKplnsgbrk]/.test(piece)) return null;
        parsed.push({ piece, promoted });
      }
    }
    if (parsed.length !== 9) return null;
    cells.push(...parsed);
  }
  return cells;
}

export function boardView(sfen: string, orientation: BoardOrientation): BoardView | null {
  const cells = parseCells(sfen);
  if (!cells) return null;
  return {
    cells: orientation === "normal" ? cells : [...cells].reverse(),
    topHandOwner: orientation === "normal" ? "gote" : "sente",
    bottomHandOwner: orientation === "normal" ? "sente" : "gote",
  };
}

export function pieceRotated(piece: string, orientation: BoardOrientation): boolean {
  const isGote = piece === piece.toLowerCase();
  return orientation === "normal" ? isGote : !isGote;
}
