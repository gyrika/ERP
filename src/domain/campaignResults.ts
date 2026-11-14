import type { Visit } from './customers.ts';
import type { Cents } from './types.ts';

/**
 * Did a campaign bring anyone in? (CRM, campaigns.ts.) The owner's real question after Send.
 * For the customers it reached: how many came in within a week, and what they spent. Beside it, the
 * same for the customers in the same audience it could not reach (no app, or asked for no messages):
 * the shop's own "would they have come anyway". Not a controlled trial (app users may be keener),
 * so the screen shows both numbers side by side and lets the owner judge; it never claims a lift.
 *
 * Who was reached and who was compared are kept on the shop PC only (server/crm/push.ts); this
 * folds them with the visits (customers.ts) into counts, which is all that leaves it.
 */

/** A week: long enough for a weekend offer, short enough that the next campaign has not muddied it. */
export const RESULT_DAYS = 7;
const DAY_MS = 86_400_000;

export interface CampaignResult {
  /** Customers the message arrived at. */
  reached: number;
  /** Of those, how many paid for something within RESULT_DAYS after it was sent. */
  cameIn: number;
  /** What they paid in that week (every visit, not only the first). */
  spent: Cents;
  /** Customers in the same audience it could not reach, and how many of them came in that week. */
  compared: number;
  comparedCameIn: number;
  /** The week is over: the numbers will not change. */
  final: boolean;
}

/** Visits in the week after `at` (a visit at the very moment of sending does not count). */
const inWeek = (visits: readonly Visit[] | undefined, from: number, to: number) =>
  (visits ?? []).filter((v) => v.at > from && v.at <= to);

export function campaignResult(
  at: number,
  reached: readonly string[],
  compared: readonly string[],
  visits: ReadonlyMap<string, readonly Visit[]>,
  now: number,
): CampaignResult {
  const end = at + RESULT_DAYS * DAY_MS;
  const to = Math.min(now, end);
  let cameIn = 0;
  let spent = 0;
  for (const id of new Set(reached)) {
    const week = inWeek(visits.get(id), at, to);
    if (week.length) cameIn++;
    spent += week.reduce((s, v) => s + v.total, 0);
  }
  const others = new Set(compared);
  let comparedCameIn = 0;
  for (const id of others) if (inWeek(visits.get(id), at, to).length) comparedCameIn++;
  return { reached: new Set(reached).size, cameIn, spent, compared: others.size, comparedCameIn, final: now >= end };
}

const pct = (n: number, of: number) => `${Math.round((n / of) * 100)}%`;

/** The result in words for the Sent list: what it brought, then the others beside it. */
export function resultText(r: CampaignResult, fmtCents: (c: Cents) => string): { brought: string; others: string | null } {
  const sofar = r.final ? '' : ' so far';
  const brought = r.reached === 0 ? 'Reached nobody'
    : `${r.cameIn} of ${r.reached} came in${sofar}${r.spent > 0 ? ` · Rs ${fmtCents(r.spent)}` : ''}`;
  const others = r.compared === 0 ? null
    : `Others in it: ${r.comparedCameIn} of ${r.compared} (${pct(r.comparedCameIn, r.compared)})${r.reached ? ` vs ${pct(r.cameIn, r.reached)}` : ''}`;
  return { brought, others };
}
