import type { Actor } from './auth.ts';

/**
 * What the shorthand parser could not read (SCRUM-143): the cashier pressed Enter with parts left
 * over, or Esc and picked from the menu instead. Only what was typed, never customer data. The
 * cloud's `npm run misses` lists the commonest; they decide between better rules and a language
 * model behind OrderInterpreter, and become its test set.
 */
export interface ShorthandEvent {
  id: string;
  shopId: string;
  at: number;
  orderNumber: 0;
  actor: Actor;
  type: 'shorthand.missed';
  /** Everything typed. */
  text: string;
  /** The parts the parser could not place. */
  unresolved: string[];
  /** Esc: the cashier gave up on it. Enter: the rest was added. */
  gaveUp: boolean;
}

export const SHORTHAND_EVENT_TYPES = ['shorthand.missed'] as const satisfies readonly ShorthandEvent['type'][];

export const MISS_TEXT_MAX = 200;
export const MISS_PART_MAX = 64;
export const MISS_PARTS_MAX = 10;

/** A miss trimmed to what the server accepts, or null when nothing was left unread. */
export const missFrom = (text: string, unresolved: readonly string[]): { text: string; unresolved: string[] } | null => {
  const parts = unresolved.map((u) => u.trim().slice(0, MISS_PART_MAX)).filter(Boolean).slice(0, MISS_PARTS_MAX);
  const typed = text.trim().slice(0, MISS_TEXT_MAX);
  return parts.length && typed ? { text: typed, unresolved: parts } : null;
};

/** Why a recorded miss is not acceptable, or null. */
export const checkMiss = (text: unknown, unresolved: unknown, gaveUp: unknown): string | null => {
  if (typeof text !== 'string' || !text.trim() || text.length > MISS_TEXT_MAX) return 'the typed text is missing or too long';
  if (!Array.isArray(unresolved) || unresolved.length === 0 || unresolved.length > MISS_PARTS_MAX) return 'the unread parts are missing or too many';
  if (!unresolved.every((u) => typeof u === 'string' && u.trim() && u.length <= MISS_PART_MAX)) return 'an unread part is empty or too long';
  if (typeof gaveUp !== 'boolean') return 'it does not say whether the cashier gave up';
  return null;
};
