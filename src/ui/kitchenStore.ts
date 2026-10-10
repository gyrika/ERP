import { useEffect, useState } from 'react';
import { prune, type KitchenTicket } from '../domain/kitchen.ts';

/**
 * Kitchen tickets shared between the Register and Kitchen tabs on one device.
 * localStorage holds them (a reload or a late-opened kitchen tab still sees
 * every ticket); BroadcastChannel tells other tabs to re-read. Slice 4 swaps
 * this for the server + WebSocket without changing the screens.
 */
const KEY = 'cb.kitchen.v0';
const CHANNEL = 'cb.kitchen';

const listeners = new Set<() => void>();
let outbound: BroadcastChannel | null = null;
const hasChannel = typeof BroadcastChannel !== 'undefined';

export const readTickets = (): KitchenTicket[] => {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    // Tickets saved before ids existed cannot be bumped by id: drop them.
    return Array.isArray(parsed) ? (parsed as KitchenTicket[]).filter((t) => typeof t?.id === 'string') : [];
  } catch {
    return []; // corrupted or unavailable storage: an empty queue beats a crash
  }
};

/** Read-modify-write against the latest stored state, then tell everyone. */
export const updateTickets = (fn: (tickets: KitchenTicket[]) => KitchenTicket[]): void => {
  const next = prune(fn(readTickets()), Date.now());
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* storage full/blocked */ }
  listeners.forEach((l) => l());
  if (hasChannel) {
    outbound ??= new BroadcastChannel(CHANNEL);
    outbound.postMessage('changed');
  }
};

const subscribe = (onChange: () => void): (() => void) => {
  listeners.add(onChange);
  // Other tabs: BroadcastChannel where available, the storage event otherwise.
  const channel = hasChannel ? new BroadcastChannel(CHANNEL) : null;
  const onStorage = (e: StorageEvent) => { if (e.key === KEY) onChange(); };
  if (channel) channel.onmessage = onChange;
  else window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(onChange);
    channel?.close();
    window.removeEventListener('storage', onStorage);
  };
};

export function useKitchenTickets(): KitchenTicket[] {
  const [tickets, setTickets] = useState(readTickets);
  useEffect(() => subscribe(() => setTickets(readTickets())), []);
  return tickets;
}
