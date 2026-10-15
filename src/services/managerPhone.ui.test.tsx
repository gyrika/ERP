import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { appendEvent, readOutbox } from '../ui/eventLog.ts';
import { flushOutbox, loadMe, phoneAuth } from './managerPhone.ts';

// The manager's phone app (SCRUM-94): who it is for, and its counts to the cloud's inbox.

const ravi = { id: 'staff-ravi', name: 'Ravi', role: 'manager' as const };
beforeEach(() => { vi.stubEnv('VITE_SITE', 'cloud'); localStorage.clear(); localStorage.setItem('cb.manager.token', 'k'.repeat(43)); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

test('the phone learns once who it belongs to, and signs with them', async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ actor: ravi, shopId: 'shop-a' })));
  vi.stubGlobal('fetch', fetchMock);
  await loadMe();
  await loadMe();
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(phoneAuth.currentCashier()).toEqual(ravi);
  expect(phoneAuth.shopId()).toBe('shop-a');
  expect(await phoneAuth.verifyManagerPin('2580')).toBeNull();
});

test('counts go to the inbox; accepted leave the outbox, the rest wait for the signal', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ actor: ravi, shopId: 'shop-a' }))));
  await loadMe();
  const e = appendEvent({ type: 'stock.unit_set', at: 1, orderNumber: 0, actor: ravi, itemId: 'inv-0006', name: 'Tray', base: 30 });
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('no signal'); }));
  await flushOutbox();
  expect(readOutbox()).toEqual([e.id]);

  const posted: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    posted.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ accepted: [{ id: e.id, seq: 1 }], serverTime: 2 }));
  }));
  await flushOutbox();
  expect(posted).toEqual([{ events: [expect.objectContaining({ id: e.id, shopId: 'shop-a', actor: ravi })] }]);
  expect(readOutbox()).toEqual([]);
});
