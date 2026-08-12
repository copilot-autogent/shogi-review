import type { Card } from "./model.js";

export interface Clock { now(): Date; }
export const utcClock: Clock = { now: () => new Date() };

export function utcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return utcDate(value);
}

export function newCard(reviewPointId: string, clock: Clock = utcClock): Card {
  const now = clock.now();
  return { id: `card-${reviewPointId}`, reviewPointId, interval: 1, dueDate: addDays(utcDate(now), 1), createdAt: now.toISOString() };
}

export function answerCard(card: Card, answer: "again" | "remembered", clock: Clock = utcClock): Card {
  const interval = answer === "again" ? 1 : card.interval === 1 ? 3 : card.interval === 3 ? 7 : 14;
  return { ...card, interval: interval as Card["interval"], dueDate: addDays(utcDate(clock.now()), interval) };
}

export function isDue(card: Card, clock: Clock = utcClock): boolean {
  return card.dueDate <= utcDate(clock.now());
}
