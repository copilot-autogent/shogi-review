export const CATEGORIES = ["序盤知識", "候選手不足", "漏算對手強手", "戰術", "終盤", "時間管理", "其他"] as const;
export type Category = (typeof CATEGORIES)[number];

export interface ReviewPoint {
  id: string;
  ply: number;
  sfen: string;
  thinking: string;
  nextConsideration: string;
  category?: Category;
  tag?: string;
  candidates?: string;
  opponentResponse?: string;
  externalNotes?: string;
  importance?: number;
  createdAt: string;
}

export interface Card {
  id: string;
  reviewPointId: string;
  dueDate: string;
  interval: 1 | 3 | 7 | 14;
  createdAt: string;
}

export interface Game {
  id: string;
  title: string;
  sourceFormat: "KIF" | "KI2" | "CSA";
  sourceText: string;
  initialSfen: string;
  sfens: string[];
  moves: string[];
  canonicalHash: string;
  createdAt: string;
  reviewPoints: ReviewPoint[];
  cards: Card[];
}

export interface AppData {
  games: Game[];
}
