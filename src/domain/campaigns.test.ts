import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  campaignsFromEvents, checkCampaignEvent, checkMessage, checkReceiptOffer, DEFAULT_WINBACK, isPushSubscription, MAX_BODY, MAX_TITLE,
  receiptOfferFromEvents, winbackFromEvents, type CampaignEvent,
} from './campaigns.ts';
import { rulesSuggestions } from './insights.ts';
import { SEED_INVENTORY, SEED_SUPPLIERS } from './inventoryData.ts';
import type { SyncEvent } from './sync.ts';

const NOW = Date.UTC(2026, 10, 11, 6, 0);
const DAY = 86_400_000;
const owner = { id: 'o', name: 'Owner', role: 'owner' as const };
const sent = (at: number, over: Partial<Extract<CampaignEvent, { type: 'crm.campaign_sent' }>> = {}): CampaignEvent => ({
  id: `c${at}`, shopId: 's', at, orderNumber: 0, actor: owner, type: 'crm.campaign_sent', audience: 'vip', kind: 'campaign',
  title: 'Weekend offer', body: 'Two pizzas, one price.', customers: 30, reachable: 12, delivered: 11, failed: 1, ...over,
});

test('a message: a title and two lines, plain words, short enough for a phone\'s notification', () => {
  assert.equal(checkMessage({ title: 'Weekend offer', body: 'Two pizzas, one price.' }), null);
  assert.equal(checkMessage({ title: '  ', body: 'x' }), 'write a title');
  assert.equal(checkMessage({ title: 'x', body: '' }), 'write the message');
  assert.match(String(checkMessage({ title: 'x'.repeat(MAX_TITLE + 1), body: 'x' })), /title is longer/);
  assert.match(String(checkMessage({ title: 'x', body: 'x'.repeat(MAX_BODY + 1) })), /message is longer/);
  // Sinhala counts letters as people see them typed, not bytes.
  assert.equal(checkMessage({ title: 'ස'.repeat(MAX_TITLE), body: 'இ'.repeat(MAX_BODY) }), null);
  assert.match(String(checkMessage({ title: 'x', body: '<a href=x>' })), /< and >/);
});

test('campaign records carry counts and words only, checked like any event', () => {
  assert.equal(checkCampaignEvent(sent(NOW) as never), null);
  assert.equal(checkCampaignEvent({ ...sent(NOW), audience: 'everyone-ever' } as never), 'unknown audience');
  assert.equal(checkCampaignEvent({ ...sent(NOW), delivered: -1 } as never), 'counts are whole numbers');
  assert.equal(checkCampaignEvent({ ...sent(NOW), orderNumber: 4 } as never), 'a campaign is not about an order');
  const auto = { id: 'a', shopId: 's', at: NOW, orderNumber: 0, actor: owner, type: 'crm.auto_set', on: true, title: 'We miss you', body: 'Come by.' };
  assert.equal(checkCampaignEvent(auto), null);
  assert.equal(checkCampaignEvent({ ...auto, on: 'yes' }), 'on or off');
});

test('"we miss you": off with its default words until the owner sets it; the latest wins', () => {
  assert.deepEqual(winbackFromEvents([]), DEFAULT_WINBACK);
  const set = (on: boolean, at: number): SyncEvent => ({ id: `a${at}`, shopId: 's', at, orderNumber: 0, actor: owner, type: 'crm.auto_set', on, title: 'T', body: `B${at}` });
  assert.deepEqual(winbackFromEvents([set(true, 1), set(false, 2)]), { on: false, title: 'T', body: 'B2' });
  assert.deepEqual(campaignsFromEvents([sent(1), sent(2, { audience: 'test' }), sent(3)]).map((c) => c.at), [3, 1], 'newest first, tests left out');
});

test('the receipt\'s words above the QR code: a reason to scan by default, the owner\'s once set; checked for the printer', () => {
  assert.deepEqual(receiptOfferFromEvents([]), { headline: 'Scan for offers on your phone', line: '' });
  const set = (headline: string, line: string, at: number): SyncEvent => ({ id: `r${at}`, shopId: 's', at, orderNumber: 0, actor: owner, type: 'crm.receipt_set', headline, line });
  assert.deepEqual(receiptOfferFromEvents([set('A', '', 1), set('Scan for 10% off', 'Your next pizza', 2)]), { headline: 'Scan for 10% off', line: 'Your next pizza' });
  assert.equal(checkReceiptOffer({ headline: 'Scan for 10% off', line: '' }), null);
  assert.match(String(checkReceiptOffer({ headline: ' ', line: 'x' })), /scan/);
  assert.match(String(checkReceiptOffer({ headline: 'x'.repeat(41), line: '' })), /40/);
  assert.match(String(checkReceiptOffer({ headline: 'Offers', line: 'y'.repeat(49) })), /48/);
  assert.match(String(checkReceiptOffer({ headline: 'වට්ටම්', line: '' })), /English/, 'the printer has no Sinhala');
  // Checked like any event, so the cloud and the shop server agree.
  assert.equal(checkCampaignEvent(set('Scan for 10% off', '', 3) as unknown as Record<string, unknown>), null);
  assert.match(String(checkCampaignEvent(set('', '', 4) as unknown as Record<string, unknown>)), /scan/);
});

test('a phone\'s subscription: https and keys of the right size, nothing else', () => {
  const ok = { endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) } };
  assert.equal(isPushSubscription(ok), true);
  assert.equal(isPushSubscription({ ...ok, endpoint: 'http://fcm.googleapis.com/x' }), false);
  assert.equal(isPushSubscription({ ...ok, keys: { p256dh: 'short', auth: ok.keys.auth } }), false);
  assert.equal(isPushSubscription({ endpoint: ok.endpoint }), false);
  assert.equal(isPushSubscription(null), false);
});

test('the owner\'s feed (and phone): how many the week\'s offers reached, never who', () => {
  const feed = (events: SyncEvent[]) => rulesSuggestions.insights({ events, now: NOW, stock: { items: SEED_INVENTORY, suppliers: SEED_SUPPLIERS } })
    .find((i) => i.id === 'campaign-reach');
  assert.equal(feed([]), undefined);
  assert.equal(feed([sent(NOW - 8 * DAY)]), undefined, 'older than a week');
  const card = feed([sent(NOW - 3 * DAY, { title: 'Old one' }), sent(NOW - DAY)])!;
  assert.equal(card.title, '“Weekend offer” reached 11 of 12 phones');
  assert.match(card.detail, /to vip customers/);
  assert.deepEqual(card.action.items.map((i) => i.primary), ['Weekend offer', 'Old one']);
  assert.equal(feed([sent(NOW, { reachable: 0, delivered: 0 })])!.title, '“Weekend offer” reached nobody: no customer in it has signed up for offers yet');
  assert.equal(feed([sent(NOW, { kind: 'auto', audience: 'inactive' })])!.detail, 'Sent by itself to customers who stopped coming.');
});
