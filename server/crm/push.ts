import { randomUUID } from 'node:crypto';
import type { Actor } from '../../src/domain/auth.ts';
import { checkMessage, isPushSubscription, winbackFromEvents, type Audience, type CampaignEvent, type Message } from '../../src/domain/campaigns.ts';
import { DEFAULT_SEGMENT_RULES, segmentsOf, visitsFromEvents, type Customer } from '../../src/domain/customers.ts';
import { toLkMobile } from '../../src/domain/phone.ts';
import type { SyncEvent } from '../../src/domain/sync.ts';
import type { Device } from '../store.ts';
import type { CustomerStore, PushSub } from './store.ts';
import { sendPush, type Vapid } from './webpush.ts';

/**
 * Push campaigns from the shop PC (campaigns.ts): who a message reaches, sending it once per
 * customer, the automatic "we miss you", and the app's sign-ups arriving from the cloud. Every
 * send is recorded as one crm.campaign_sent with counts only, so the owner's phone sees how many
 * were reached, never who.
 */
const DAY = 86_400_000;
/** "We miss you" goes to customers who became Inactive in the last week, not to everyone long gone. */
const WINBACK_WINDOW_DAYS = 7;
/** Sri Lanka time (UTC+05:30): automatic messages only between 10:00 and 19:59. */
const lkHour = (at: number) => new Date(at + 330 * 60_000).getUTCHours();

export interface PushOptions {
  customers: CustomerStore;
  /** The shop's whole history (visits, segments, the automatic message's settings). */
  history: (tenantId: string) => Promise<SyncEvent[]>;
  vapid: () => Promise<Vapid>;
  /** Stores events as the shop server's own and streams them to the screens (app.ts ingest). */
  ingest: (device: Device, events: SyncEvent[]) => Promise<unknown>;
  now?: () => number;
  fetch?: typeof fetch;
}

export interface Reach { customers: number; reachable: number }

export function createPush(o: PushOptions) {
  const now = o.now ?? Date.now;

  /** The audience's customers today, and the phones of those not opted out. */
  const audience = async (tenantId: string, who: Audience, testPhone?: unknown) => {
    const list = await o.customers.list(tenantId);
    let picked: Customer[];
    if (who === 'test') {
      const check = toLkMobile(testPhone);
      if (!('phone' in check)) throw new PushError(`your number: ${check.reason}`);
      picked = list.filter((c) => c.phone === check.phone);
      if (!picked.length) throw new PushError('that number has not signed up for offers in the app');
    } else if (who === 'all') {
      picked = list;
    } else {
      const segments = segmentsOf(list, visitsFromEvents(await o.history(tenantId)), DEFAULT_SEGMENT_RULES, now());
      picked = list.filter((c) => segments.get(c.id) === who);
    }
    const subs = await o.customers.subs(tenantId);
    const phones = new Map<string, PushSub[]>();
    for (const s of subs) phones.set(s.customerId, [...(phones.get(s.customerId) ?? []), s.sub]);
    const reachable = picked.filter((c) => !c.optedOut && phones.has(c.id));
    return { picked, reachable, phones };
  };

  /** Sends to each reachable customer once (dedupe key), and forgets phones the push service says are gone. */
  const deliver = async (tenantId: string, targets: Customer[], phones: Map<string, PushSub[]>, message: Message, key: (c: Customer) => string) => {
    const vapid = await o.vapid();
    let delivered = 0;
    let failed = 0;
    for (const c of targets) {
      const k = key(c);
      if (!(await o.customers.logOnce(tenantId, k, c.id, now()))) continue; // already sent
      let ok = false;
      for (const sub of phones.get(c.id) ?? []) {
        const r = await sendPush(sub, message, vapid, { now: now(), fetch: o.fetch });
        if (r === 'sent') ok = true;
        if (r === 'gone') await o.customers.removeSub(tenantId, sub.endpoint);
      }
      if (ok) delivered++;
      else { failed++; await o.customers.unlog(tenantId, k); } // tried again next time (the automatic message)
    }
    return { delivered, failed };
  };

  const record = async (device: Device, actor: Actor, fields: Omit<Extract<CampaignEvent, { type: 'crm.campaign_sent' }>, 'id' | 'shopId' | 'at' | 'orderNumber' | 'actor' | 'type'>) => {
    const event = {
      id: randomUUID(), shopId: device.tenantId, at: now(), orderNumber: 0 as const, actor, type: 'crm.campaign_sent' as const, ...fields,
    } satisfies CampaignEvent;
    await o.ingest(device, [event]);
    return event;
  };

  return {
    /** How many a message to this audience would reach (the Campaigns page, before Send). */
    async reach(tenantId: string, who: Audience): Promise<Reach> {
      if (who === 'test') return { customers: 1, reachable: 1 };
      const a = await audience(tenantId, who);
      return { customers: a.picked.length, reachable: a.reachable.length };
    },

    /** The owner's campaign: sent now, to the audience's customers with the app who have not opted out. */
    async campaign(device: Device, actor: Actor, who: Audience, message: Message, testPhone?: unknown) {
      const why = checkMessage(message);
      if (why) throw new PushError(why);
      const m = { title: message.title.trim(), body: message.body.trim() };
      const a = await audience(device.tenantId, who, testPhone);
      const id = randomUUID();
      const { delivered, failed } = await deliver(device.tenantId, a.reachable, a.phones, m, (c) => `campaign:${id}:${c.id}`);
      return record(device, actor, {
        audience: who, kind: 'campaign', ...m, customers: a.picked.length, reachable: a.reachable.length, delivered, failed,
      });
    },

    /**
     * The automatic "we miss you" (hourly from main.ts): to each customer with the app who became
     * Inactive in the last week, once per quiet spell (their last visit is in the key), 10:00-19:59.
     */
    async winback(device: Device, actor: Actor): Promise<CampaignEvent | null> {
      if (lkHour(now()) < 10 || lkHour(now()) >= 20) return null;
      const events = await o.history(device.tenantId);
      const setting = winbackFromEvents(events);
      if (!setting.on) return null;
      const t = now();
      const rules = DEFAULT_SEGMENT_RULES;
      const visits = visitsFromEvents(events);
      const a = await audience(device.tenantId, 'inactive');
      const lastOf = (c: Customer) => Math.max(...(visits.get(c.id) ?? []).map((v) => v.at));
      const justGone = (c: Customer) => {
        if (!visits.get(c.id)?.length) return false; // never bought: no "we miss you"
        const quiet = t - lastOf(c);
        return quiet >= rules.inactiveDays * DAY && quiet < (rules.inactiveDays + WINBACK_WINDOW_DAYS) * DAY;
      };
      const targets = a.reachable.filter(justGone);
      if (!targets.length) return null;
      const { delivered, failed } = await deliver(device.tenantId, targets, a.phones, setting, (c) => `winback:${c.id}:${lastOf(c)}`);
      if (!delivered && !failed) return null; // all sent before
      return record(device, actor, {
        audience: 'inactive', kind: 'auto', title: setting.title, body: setting.body,
        customers: a.picked.filter(justGone).length, reachable: targets.length, delivered, failed,
      });
    },

    /**
     * Sign-ups from the app, as the cloud passed them on (cloud/src/push.ts): a phone with its number
     * joins that customer (made if new, source 'app'); a phone that said stop is forgotten.
     */
    async applyInbox(tenantId: string, rows: InboxRow[]): Promise<string[]> {
      const done: string[] = [];
      for (const r of rows) {
        if (r.kind === 'subscribe') {
          const check = toLkMobile(r.phone);
          if ('phone' in check && isSub(r.subscription)) {
            const { customer } = await o.customers.ensure(tenantId, check.phone, 'app', 'app', now());
            await o.customers.addSub(tenantId, customer.id, r.subscription, now());
          }
        } else if (r.kind === 'unsubscribe' && typeof r.endpoint === 'string') {
          await o.customers.removeSub(tenantId, r.endpoint);
        }
        done.push(r.id); // a row that cannot be used is still taken off the cloud's list
      }
      return done;
    },
  };
}
export type Push = ReturnType<typeof createPush>;

export class PushError extends Error {}

/** One sign-up or stop, as the cloud keeps it until the shop has taken it. */
export type InboxRow =
  | { id: string; kind: 'subscribe'; phone: string; subscription: PushSub }
  | { id: string; kind: 'unsubscribe'; endpoint: string };

/** A browser's PushSubscription as JSON (campaigns.ts checks it, here and in the cloud). */
export const isSub = isPushSubscription;
