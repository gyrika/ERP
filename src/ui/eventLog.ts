import type { NewOrderEvent, OrderEvent } from '../domain/events.ts';
import { newLineId } from '../domain/order.ts';
import { shopId } from '../services/auth.ts';
import { storageKey } from './storage.ts';

/**
 * Append-only order event log on this device. Nothing is ever edited or
 * removed here; slice 4 drains it to MySQL as the sync outbox.
 */
const KEY = () => storageKey('events.v0');

export const readEvents = (): OrderEvent[] => {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY()) ?? '[]');
    return Array.isArray(parsed) ? (parsed as OrderEvent[]) : [];
  } catch {
    return [];
  }
};

export const appendEvent = (event: NewOrderEvent): OrderEvent => {
  const full = { ...event, id: newLineId(), shopId: shopId() } as OrderEvent;
  try {
    localStorage.setItem(KEY(), JSON.stringify([...readEvents(), full]));
  } catch { /* storage full/blocked: the sale itself must not fail */ }
  return full;
};
