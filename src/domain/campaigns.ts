import type { Actor } from './auth.ts';
import { SEGMENTS, type Segment } from './customers.ts';
import type { SyncEvent } from './sync.ts';

/**
 * Push campaigns (CRM): the owner writes a short message to a segment; the shop server sends it as
 * a push notification to the customers who signed up for offers in the CheesyBeez app and have not
 * opted out. One automatic message ("we miss you") goes to a customer the day they become Inactive.
 *
 * What is recorded here carries no name or number, only the message and the counts, so it syncs
 * like any event: the owner's phone sees how many were reached, never who.
 */

export const MAX_TITLE = 60;
export const MAX_BODY = 180;

/** Who a campaign goes to: a segment, everyone, or (a test) the one number the owner typed. */
export type Audience = Segment | 'all' | 'test';
export const AUDIENCES: readonly Audience[] = ['all', ...SEGMENTS, 'test'];
export const isAudience = (v: unknown): v is Audience => AUDIENCES.includes(v as never);

export interface Message { title: string; body: string }

export type CampaignEvent =
  | {
    id: string; shopId: string; at: number; orderNumber: 0; actor: Actor;
    type: 'crm.campaign_sent';
    audience: Audience;
    /** 'auto': the automatic "we miss you", sent by the shop server's daily run. */
    kind: 'campaign' | 'auto';
    title: string; body: string;
    /** Customers in the audience; those with the app and not opted out; delivered; failed. */
    customers: number; reachable: number; delivered: number; failed: number;
  }
  | {
    id: string; shopId: string; at: number; orderNumber: 0; actor: Actor;
    type: 'crm.auto_set';
    /** The automatic message to a customer who has just become Inactive. */
    on: boolean; title: string; body: string;
  };

export const CAMPAIGN_EVENT_TYPES = ['crm.campaign_sent', 'crm.auto_set'] as const satisfies readonly CampaignEvent['type'][];

/** Why this message cannot be sent, or null. Plain words only: no links, nothing that looks like code. */
export const checkMessage = (m: { title?: unknown; body?: unknown }): string | null => {
  const title = typeof m.title === 'string' ? m.title.trim() : '';
  const body = typeof m.body === 'string' ? m.body.trim() : '';
  if (!title) return 'write a title';
  if (!body) return 'write the message';
  if ([...title].length > MAX_TITLE) return `the title is longer than ${MAX_TITLE} letters`;
  if ([...body].length > MAX_BODY) return `the message is longer than ${MAX_BODY} letters`;
  if (/[<>]/.test(title + body)) return 'leave out < and >';
  return null;
};

const count = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;

/** Why this campaign event is not as the shop server records it, or null (validate.ts). */
export const checkCampaignEvent = (e: Record<string, unknown>): string | null => {
  if (e.orderNumber !== 0) return 'a campaign is not about an order';
  const message = checkMessage(e);
  if (e.type === 'crm.auto_set') return typeof e.on !== 'boolean' ? 'on or off' : message;
  if (!isAudience(e.audience)) return 'unknown audience';
  if (e.kind !== 'campaign' && e.kind !== 'auto') return 'unknown kind';
  if (!['customers', 'reachable', 'delivered', 'failed'].every((k) => count(e[k]))) return 'counts are whole numbers';
  return message;
};

export const DEFAULT_WINBACK: Message & { on: boolean } = {
  on: false,
  title: 'We miss you at CheesyBeez',
  body: 'It has been a while. Come by for a hot pizza this week.',
};

/** The automatic "we miss you" as the owner last set it (off until he turns it on). */
export const winbackFromEvents = (events: readonly SyncEvent[]): Message & { on: boolean } => {
  let out = DEFAULT_WINBACK;
  for (const e of events) if (e.type === 'crm.auto_set') out = { on: e.on, title: e.title, body: e.body };
  return out;
};

export type SentCampaign = Extract<CampaignEvent, { type: 'crm.campaign_sent' }>;

/** Campaigns sent, newest first (tests to the owner's own number left out unless asked). */
export const campaignsFromEvents = (events: readonly SyncEvent[], withTests = false): SentCampaign[] =>
  events.filter((e): e is SentCampaign => e.type === 'crm.campaign_sent' && (withTests || e.audience !== 'test')).reverse();

export const AUDIENCE_LABEL: Record<Audience, string> = {
  all: 'Everyone', new: 'New', regular: 'Regular', vip: 'VIP', inactive: 'Inactive', test: 'Test to my number',
};

/** A phone that allowed notifications: the browser's PushSubscription as JSON (endpoint and two keys). */
export interface PushSubscriptionJson { endpoint: string; keys: { p256dh: string; auth: string } }

/** An https endpoint and keys of the right size: what the app sends, checked by the cloud and the shop PC alike. */
export const isPushSubscription = (v: unknown): v is PushSubscriptionJson => {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  return typeof s.endpoint === 'string' && /^https:\/\/[^\s]{1,800}$/.test(s.endpoint)
    && typeof s.keys?.p256dh === 'string' && /^[\w-]{80,100}$/.test(s.keys.p256dh)
    && typeof s.keys?.auth === 'string' && /^[\w-]{16,30}$/.test(s.keys.auth);
};
