import type { OrderEvent } from '../domain/events.ts';
import { newLineId } from '../domain/order.ts';
import type { NewSyncEvent, SyncEvent } from '../domain/sync.ts';
import { shopId } from '../services/auth.ts';
import { storageKey } from './storage.ts';

/**
 * This device's copy of the shop's events, and the sync outbox
 * (docs/sync-contract.md). Every action is written here first, so a sale
 * never waits for the network. Events are never edited or removed while
 * unsent; once the server has them, routine events older than KEEP_SYNCED_MS
 * are dropped. The ingredient and supplier lists are kept, so screens can rebuild them.
 *
 * localStorage, not IndexedDB: synchronous, so screens stay simple; the
 * durable record is MySQL on the same PC, and trimming keeps us far below
 * the 5 MB limit. Other tabs hear about changes over BroadcastChannel.
 */
const KEY = () => storageKey('events.v0');
const OUTBOX = () => storageKey('outbox.v0');
const REJECTED = () => storageKey('rejected.v0');
const KEEP_SYNCED_MS = 2 * 24 * 60 * 60_000;

const read = <T>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback; // corrupted or unavailable storage: start clean rather than crash
  }
};
const write = (key: string, value: unknown): void => {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full/blocked: the sale must not fail */ }
};

export const readAll = (): SyncEvent[] => {
  const parsed = read<unknown>(KEY(), []);
  return Array.isArray(parsed) ? (parsed as SyncEvent[]) : [];
};

/** The order events (the audit trail). */
export const readEvents = (): OrderEvent[] => readAll().filter((e): e is OrderEvent => e.type.startsWith('order.'));

/** Ids written on this device that the server has not confirmed yet, oldest first. */
export const readOutbox = (): string[] => read<string[]>(OUTBOX(), []);

// ----- change notification (this tab + other tabs on this device) -----

const listeners = new Set<() => void>();
const hasChannel = typeof BroadcastChannel !== 'undefined';
let outbound: BroadcastChannel | null = null;

const changed = () => {
  listeners.forEach((l) => l());
  if (hasChannel) {
    outbound ??= new BroadcastChannel(storageKey('events'));
    outbound.postMessage('changed');
  }
};

export const subscribeEvents = (onChange: () => void): (() => void) => {
  listeners.add(onChange);
  const channel = hasChannel ? new BroadcastChannel(storageKey('events')) : null;
  const onStorage = (e: StorageEvent) => { if (e.key === KEY()) onChange(); };
  if (channel) channel.onmessage = onChange;
  else window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(onChange);
    channel?.close();
    window.removeEventListener('storage', onStorage);
  };
};

// ----- writes -----

/** A new action on this device: stored, queued for the server, then everyone is told. */
export const appendEvent = <E extends NewSyncEvent>(event: E): E & { id: string; shopId: string } => {
  const full = { ...event, id: newLineId(), shopId: shopId() };
  write(KEY(), [...readAll(), full]);
  write(OUTBOX(), [...readOutbox(), full.id]);
  changed();
  return full;
};

/**
 * Events already given an id elsewhere (the server, or fixed demo data).
 * Skips ids this device has, so applying the same event twice is harmless.
 * `local` = written here and still to be pushed (demo data never is).
 */
export const addEvents = (events: readonly SyncEvent[], { local = false } = {}): number => {
  const all = readAll();
  const known = new Set(all.map((e) => e.id));
  const fresh = events.filter((e) => (known.has(e.id) ? false : (known.add(e.id), true)));
  if (!fresh.length) return 0;
  write(KEY(), [...all, ...fresh]);
  if (local) write(OUTBOX(), [...readOutbox(), ...fresh.map((e) => e.id)]);
  changed();
  return fresh.length;
};

/** The server stored these: take them out of the outbox, and let old synced events go. */
export const markSynced = (ids: readonly string[], now = Date.now()): void => {
  const done = new Set(ids);
  const outbox = readOutbox().filter((id) => !done.has(id));
  write(OUTBOX(), outbox);
  const pending = new Set(outbox);
  const all = readAll();
  // The ingredient and supplier lists and menu changes are the shop's data itself: kept for good.
  // Stock amounts need the whole history: the Inventory screen reads it from the server.
  const kept = all.filter((e) =>
    pending.has(e.id) ||
    now - e.at < KEEP_SYNCED_MS ||
    e.type.startsWith('menu.') ||
    e.type.startsWith('recipe.') ||
    e.type === 'stock.item_added' ||
    e.type === 'stock.supplier_added' ||
    e.type === 'stock.item_archived' ||
    e.type === 'stock.item_restored' ||
    e.type === 'stock.supplier_archived' ||
    e.type === 'stock.supplier_restored');
  if (kept.length !== all.length) write(KEY(), kept);
};

/**
 * The server refused these for good (not logged in, or not allowed). They leave
 * the outbox so the rest keeps flowing, and are listed apart for the owner.
 */
export const markRejected = (ids: readonly string[]): void => {
  const gone = new Set(ids);
  write(OUTBOX(), readOutbox().filter((id) => !gone.has(id)));
  write(REJECTED(), [...read<string[]>(REJECTED(), []), ...ids]);
  changed();
};
