import { useEffect, useState } from 'react';
import { ticketsFromEvents, type KitchenTicket } from '../domain/kitchen.ts';
import type { KitchenEvent } from '../domain/sync.ts';
import { appendEvent, readAll, subscribeEvents } from './eventLog.ts';

/**
 * Kitchen tickets are not stored: they are folded from the event log
 * (`ticketsFromEvents`), so whatever reaches this device, from this tab, another
 * tab or the server, shows up the same way. Kitchen taps are events too.
 */
export const readTickets = (): KitchenTicket[] => ticketsFromEvents(readAll(), Date.now());

export function useKitchenTickets(): KitchenTicket[] {
  const [tickets, setTickets] = useState(readTickets);
  useEffect(() => {
    const refresh = () => setTickets(readTickets());
    const unsubscribe = subscribeEvents(refresh);
    // Done tickets age out after an hour even when nothing new happens.
    const t = setInterval(refresh, 60_000);
    return () => { unsubscribe(); clearInterval(t); };
  }, []);
  return tickets;
}

export type KitchenTap = KitchenEvent['type'];

export const recordKitchen = (type: KitchenTap, ticket: Pick<KitchenTicket, 'id' | 'number'>): void => {
  appendEvent({ type, at: Date.now(), orderNumber: ticket.number, ticketId: ticket.id });
};
