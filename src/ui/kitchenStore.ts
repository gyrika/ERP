import { useEffect, useState } from 'react';
import { ticketsFromEvents, type KitchenTicket } from '../domain/kitchen.ts';
import { itemById } from '../domain/menu.ts';
import { lineItemName } from '../domain/halves.ts';
import type { OrderLine } from '../domain/types.ts';
import { currentCashier } from '../services/auth.ts';
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

/** Why the kitchen remakes a dish (SCRUM-177): the bin's reasons that happen at the oven. */
export const REMAKE_REASONS = [
  { id: 'burnt', label: 'Burnt' },
  { id: 'dropped', label: 'Dropped' },
  { id: 'wrong', label: 'Made wrong' },
] as const;
export type RemakeReason = (typeof REMAKE_REASONS)[number]['id'];

/** "Margherita · Large", as the bin names a dish. */
export const remakeName = (line: OrderLine): string => {
  const size = itemById(line.itemId).variants?.find((v) => v.id === line.size)?.label;
  return `${lineItemName(line)}${size ? ` · ${size}` : ''}`;
};

/**
 * The kitchen's Remake (SCRUM-177): one of this line was thrown away and is being made again. It is
 * waste like the bin's (stock comes off through the recipe), signed by whoever is signed in, and
 * marks the line on its ticket. Returns the Undo.
 */
export const recordRemake = (ticket: Pick<KitchenTicket, 'id'>, line: OrderLine, reason: RemakeReason): (() => void) => {
  const actor = currentCashier();
  const e = appendEvent({
    type: 'stock.wasted', at: Date.now(), orderNumber: 0, actor,
    what: { kind: 'dish', itemId: line.itemId, ...(line.size ? { size: line.size } : {}) },
    name: remakeName(line), qty: 1, reason, ticketId: ticket.id, lineId: line.id,
  });
  return () => { appendEvent({ type: 'stock.waste_undone', at: Date.now(), orderNumber: 0, actor, wasteId: e.id, ticketId: ticket.id }); };
};
