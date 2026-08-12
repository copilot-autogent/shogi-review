export const REASONS = ["不知道怎麼走", "漏看對手的手", "計畫或方向錯誤", "計算錯誤", "終盤失誤", "時間不足", "想記住這個好手", "其他"] as const;
export type Reason = (typeof REASONS)[number];
export const ISSUE_TAGS = ["序盤", "攻守判斷", "候選手", "王的安全", "駒的活用", "手筋", "寄せ・詰棋"] as const;
export type IssueTag = (typeof ISSUE_TAGS)[number];

export interface ReviewPoint {
  id: string;
  ply: number;
  sfen: string;
  reason: Reason;
  issueTags: IssueTag[];
  note?: string;
  externalNotes?: string;
  legacyNotes?: string;
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
}

export interface AppData {
  games: Game[];
}

export const CATEGORY_MIGRATION: Record<string, { reason: Reason; tag?: IssueTag }> = {
  "序盤知識": { reason: "計畫或方向錯誤", tag: "序盤" },
  "候選手不足": { reason: "不知道怎麼走", tag: "候選手" },
  "漏算對手強手": { reason: "漏看對手的手" },
  "戰術": { reason: "計算錯誤", tag: "手筋" },
  "終盤": { reason: "終盤失誤", tag: "寄せ・詰棋" },
  "時間管理": { reason: "時間不足" },
  "其他": { reason: "其他" },
};
