import { DEFAULT_SEGMENT_RULES, visitsFromEvents, type Visit } from './customers.ts';
import type { Insight } from './insights.ts';
import { fmt } from './money.ts';
import { modulesFromEvents } from './modules.ts';
import type { SyncEvent } from './sync.ts';

/**
 * Customers for the owner's To do (CRM). Who: the owner, asking what needs him today. What he knows:
 * his regulars by face, not by numbers. The one next thing: regulars drifting away, while an offer
 * can still bring them back (once they are Inactive, at 30 days, it is a harder win).
 *
 * "Gone quiet" is by each regular's own rhythm: someone who comes every 4 days and has not for 2 weeks
 * is drifting; someone who comes monthly is not. Only payments with a customer (order.paid.customerId)
 * are read, so it runs the same on the shop PC and the owner's phone, and says nobody's name or number.
 */
const DAY_MS = 86_400_000;
/** At least this many visits to be a regular whose rhythm means something. */
export const REGULAR_VISITS = 3;
/** Quiet: away for more than this many times their usual gap... */
export const QUIET_FACTOR = 2;
/** ...and at least two weeks, but not yet Inactive (customers.ts: 30 days). */
export const QUIET_MIN_DAYS = 14;
/** One quiet regular is a person; two or more is a pattern worth the owner's time. */
export const QUIET_SHOW = 2;

export interface QuietRegular { visits: number; spent: number; usualDays: number; awayDays: number }

/**
 * A regular's rhythm: how far apart their visits usually are (the mean gap, first to last visit),
 * when they last came, when they are next likely back, and from when they count as gone quiet.
 * Null under REGULAR_VISITS visits: too early to tell.
 */
export interface Rhythm { visits: number; usual: number; usualDays: number; lastAt: number; nextAt: number; quietFrom: number }

export function rhythmOf(visits: readonly Pick<Visit, 'at'>[]): Rhythm | null {
  if (visits.length < REGULAR_VISITS) return null;
  const times = visits.map((v) => v.at).sort((a, b) => a - b);
  const lastAt = times[times.length - 1];
  const usual = (lastAt - times[0]) / (times.length - 1);
  return {
    visits: times.length,
    usual,
    usualDays: Math.max(1, Math.round(usual / DAY_MS)),
    lastAt,
    nextAt: lastAt + usual,
    quietFrom: lastAt + Math.max(QUIET_FACTOR * usual, QUIET_MIN_DAYS * DAY_MS),
  };
}

/** Gone quiet: a regular away more than twice their usual gap and two weeks or more, not yet Inactive (30 days). */
export function isGoneQuiet(visits: readonly Pick<Visit, 'at'>[], now: number): boolean {
  const r = rhythmOf(visits);
  if (!r) return false;
  const away = now - r.lastAt;
  return away >= QUIET_MIN_DAYS * DAY_MS && away < DEFAULT_SEGMENT_RULES.inactiveDays * DAY_MS && away > QUIET_FACTOR * r.usual;
}

export function quietRegulars(events: readonly SyncEvent[], now: number): QuietRegular[] {
  const out: QuietRegular[] = [];
  for (const list of visitsFromEvents(events).values()) {
    if (!isGoneQuiet(list, now)) continue;
    const r = rhythmOf(list)!;
    out.push({
      visits: list.length,
      spent: list.reduce((s, v) => s + v.total, 0),
      usualDays: r.usualDays,
      awayDays: Math.floor((now - r.lastAt) / DAY_MS),
    });
  }
  // The ones worth most to the shop first.
  return out.sort((a, b) => b.spent - a.spent);
}

/** The To do card: regulars gone quiet, with one tap to Campaigns. Only while the CRM is on. */
export function regularsGoneQuiet(events: readonly SyncEvent[], now: number): Insight | null {
  if (!modulesFromEvents(events).crm) return null;
  const quiet = quietRegulars(events, now);
  if (quiet.length < QUIET_SHOW) return null;
  const spent = quiet.reduce((s, q) => s + q.spent, 0);
  return {
    id: 'regulars-quiet',
    tone: 'attention',
    title: `${quiet.length} regulars have gone quiet`,
    detail: `Each has stayed away more than twice as long as usual, two weeks or more. Together they have spent Rs ${fmt(spent)} here. An offer now can bring them back before they stop coming.`,
    action: {
      label: 'Send an offer',
      go: '#customers/campaigns',
      items: quiet.map((q) => ({
        primary: `Usually every ${q.usualDays} ${q.usualDays === 1 ? 'day' : 'days'}, away ${q.awayDays} days`,
        secondary: `${q.visits} visits · Rs ${fmt(q.spent)}`,
        amount: q.spent,
      })),
    },
  };
}
