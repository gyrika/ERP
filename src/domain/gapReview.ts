import type { GapReason } from './counting.ts';
import type { SyncEvent } from './sync.ts';
import type { Cents } from './types.ts';

/**
 * The owner checks the gaps (SCRUM-95). A count beyond the allowance carries the
 * manager's reason and, from the phone, a shelf photo. The owner sees each one once:
 * OK (it is understood) or Ask (a question to the manager, who answers on the Manager
 * page). Nothing is decided for anyone; the record of who said what stays.
 */
export const MAX_NOTE = 200;
export const isNote = (n: unknown): n is string => typeof n === 'string' && n.length <= MAX_NOTE;

export type Review =
  | { kind: 'open' }
  | { kind: 'asked'; note: string; at: number; by: string; answer: { note: string; at: number; by: string } | null }
  | { kind: 'ok'; at: number; by: string };

export interface GapCase {
  countId: string;
  itemId: string;
  at: number;
  by: string;
  /** Counted minus expected, in base units (negative: short). */
  delta: number;
  valueCents: Cents;
  reason: GapReason;
  /** What happened, when the reason is Other. */
  note: string | null;
  photo: string | null;
  review: Review;
}

/** Standing counts with a gap beyond the allowance (they carry a reason), with their review; newest first. */
export const gapCases = (events: readonly SyncEvent[]): GapCase[] => {
  const undone = new Set(events.flatMap((e) => (e.type === 'stock.count_undone' ? [e.countId] : [])));
  const cases = new Map<string, GapCase>();
  for (const e of events) {
    if (e.type === 'stock.counted' && e.reason && !undone.has(e.id)) {
      cases.set(e.id, {
        countId: e.id, itemId: e.itemId, at: e.at, by: e.actor.name, delta: e.counted - Math.max(0, e.expected),
        valueCents: e.valueCents, reason: e.reason, note: e.note ?? null, photo: e.photo ?? null, review: { kind: 'open' },
      });
    }
  }
  // Events arrive in order: the latest word on a case stands.
  for (const e of events) {
    if (e.type !== 'stock.gap_reviewed' && e.type !== 'stock.gap_answered') continue;
    const c = cases.get(e.countId);
    if (!c) continue;
    if (e.type === 'stock.gap_reviewed') {
      c.review = e.decision === 'ok' ? { kind: 'ok', at: e.at, by: e.actor.name } : { kind: 'asked', note: e.note, at: e.at, by: e.actor.name, answer: null };
    } else if (c.review.kind === 'asked') {
      c.review = { ...c.review, answer: { note: e.note, at: e.at, by: e.actor.name } };
    }
  }
  return [...cases.values()].sort((a, b) => b.at - a.at);
};

/** For the owner: not OK'd yet (open, or asked). */
export const toCheck = (cases: readonly GapCase[]): GapCase[] => cases.filter((c) => c.review.kind !== 'ok');
/** For the manager: the owner's questions not answered yet. */
export const asked = (cases: readonly GapCase[]): GapCase[] => cases.filter((c) => c.review.kind === 'asked' && !c.review.answer);

const DAY = 24 * 60 * 60 * 1000;
const dayStart = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };

/** What counts found missing (every standing count, small gaps too), this week and the week before. */
export const weekLoss = (events: readonly SyncEvent[], now: number): { thisWeek: Cents; lastWeek: Cents } => {
  const undone = new Set(events.flatMap((e) => (e.type === 'stock.count_undone' ? [e.countId] : [])));
  const from = dayStart(now) - 6 * DAY;
  let thisWeek = 0;
  let lastWeek = 0;
  for (const e of events) {
    if (e.type !== 'stock.counted' || undone.has(e.id) || e.valueCents >= 0 || e.at > now) continue;
    if (e.at >= from) thisWeek -= e.valueCents;
    else if (e.at >= from - 7 * DAY) lastWeek -= e.valueCents;
  }
  return { thisWeek, lastWeek };
};

/** Items whose last `min` or more counts in a row were all short beyond the allowance: a pattern, not bad luck. */
export const shortStreaks = (events: readonly SyncEvent[], min = 3): { itemId: string; counts: number; cents: Cents }[] => {
  const undone = new Set(events.flatMap((e) => (e.type === 'stock.count_undone' ? [e.countId] : [])));
  const byItem = new Map<string, { short: boolean; cents: Cents }[]>();
  for (const e of events) {
    if (e.type !== 'stock.counted' || undone.has(e.id)) continue;
    const short = e.reason !== null && e.valueCents < 0;
    byItem.set(e.itemId, [...(byItem.get(e.itemId) ?? []), { short, cents: -e.valueCents }]);
  }
  const out: { itemId: string; counts: number; cents: Cents }[] = [];
  for (const [itemId, list] of byItem) {
    let n = 0;
    let cents = 0;
    for (let i = list.length - 1; i >= 0 && list[i].short; i--) { n++; cents += list[i].cents; }
    if (n >= min) out.push({ itemId, counts: n, cents });
  }
  return out.sort((a, b) => b.cents - a.cents);
};
