import { creditFromEvents, daysSince, isOverdue, nearLimit, OVERDUE_DAYS, type CreditAccount } from './credit.ts';
import type { Insight } from './insights.ts';
import { fmt } from './money.ts';
import { modulesFromEvents } from './modules.ts';
import type { SyncEvent } from './sync.ts';

/**
 * Credit for the owner's To do. Who: the owner, who lets regulars eat now and pay at the month's end.
 * What he needs told: who has not paid back for a month, who is close to their limit, and at the
 * start of a month, what is owed in all. Like every customer card it says no name or number (the
 * phone has neither): one tap opens Customers › Owes on the shop PC, where the names are.
 */

/** The first days of a month, when "pay at the end of the month" has come round. */
export const MONTH_START_DAYS = 7;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const row = (a: CreditAccount, now: number) => ({
  primary: `Owes Rs ${fmt(a.owes)}`,
  secondary: [
    a.setting?.limit ? `limit Rs ${fmt(a.setting.limit)}` : null,
    a.lastPaidAt ? `last paid ${daysSince(a.lastPaidAt, now)} days ago` : 'never paid back',
    a.oldestOpenAt ? `oldest bill ${daysSince(a.oldestOpenAt, now)} days old` : null,
  ].filter(Boolean).join(' · '),
  amount: a.owes,
});
const GO = '#customers/owes';

export function creditInsights(events: readonly SyncEvent[], now: number): Insight[] {
  if (!modulesFromEvents(events).crm) return [];
  const owing = [...creditFromEvents(events).values()].filter((a) => a.owes > 0).sort((a, b) => b.owes - a.owes);
  if (!owing.length) return [];
  const out: Insight[] = [];

  const overdue = owing.filter((a) => isOverdue(a, now));
  if (overdue.length) {
    const sum = overdue.reduce((n, a) => n + a.owes, 0);
    out.push({
      id: 'credit-overdue', tone: 'attention',
      title: overdue.length === 1 ? `A customer owes Rs ${fmt(sum)}, nothing paid for ${OVERDUE_DAYS}+ days` : `${overdue.length} customers owe Rs ${fmt(sum)}, nothing paid for ${OVERDUE_DAYS}+ days`,
      detail: 'They eat on credit and have not paid anything back for a month or more. Ask them when they come in, or turn their credit off until they pay.',
      action: { label: 'See who', go: GO, items: overdue.map((a) => row(a, now)) },
    });
  }

  const near = owing.filter((a) => nearLimit(a) && !overdue.includes(a));
  if (near.length) {
    out.push({
      id: 'credit-near-limit', tone: 'info',
      title: `${plural(near.length, 'customer is', 'customers are')} near their credit limit`,
      detail: 'At the limit the counter cannot put more on their credit without a manager. Raise the limit, or ask them to pay something back.',
      action: { label: 'See who', go: GO, items: near.map((a) => row(a, now)) },
    });
  }

  // "End of the month" has come: what is owed in all, once a month, for the first week.
  if (new Date(now).getDate() <= MONTH_START_DAYS) {
    const sum = owing.reduce((n, a) => n + a.owes, 0);
    out.push({
      id: 'credit-month', tone: 'info',
      title: `${plural(owing.length, 'customer owes', 'customers owe')} Rs ${fmt(sum)} on credit`,
      detail: 'A new month: time for credit customers to pay what they ate last month. The cashier takes it from their name on the Register.',
      action: { label: 'See who', go: GO, items: owing.map((a) => row(a, now)) },
    });
  }
  return out;
}
