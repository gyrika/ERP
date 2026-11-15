import { menuItems } from './menu.ts';
import { checkPin, LIMITS, normalisePhone, type DeliveryPin, type OnlineKind, type OnlineLine, type OnlineStatus } from './online.ts';
import type { Cents, MenuItem } from './types.ts';

/**
 * Customer accounts on cheesybeez.com (cloud/src/accounts.ts keeps them, sealed, in the cloud).
 * Serves the customer at home: they already know what they like and where they live, and want the
 * next order to be two taps. So an account holds only what ordering needs (owner, 2026-11-16):
 * name, mobile, saved addresses with their map pin. No photo, no birthday yet, no marketing switch
 * (offers stay their own sign-up). It fills itself from the orders placed while signed in.
 */
export interface Profile { name: string; phone: string; email: string | null }
export interface SavedAddress { id: string; label: string; address: string; pin: DeliveryPin | null; lastUsedAt: number }
/** One past order, as "Your orders" shows it (no contact details: the customer knows them). */
export interface PastOrder {
  id: string; createdAt: number; kind: OnlineKind; status: OnlineStatus; lines: OnlineLine[]; total: Cents; orderNumber: number | null;
}
/** What the page gets once signed in. */
export interface Account { profile: Profile; addresses: SavedAddress[]; orders: PastOrder[] }

/** At most this many saved addresses; a new one past it replaces the one used longest ago. */
export const MAX_ADDRESSES = 5;
/** Orders shown under "Your orders". */
export const PAST_ORDERS = 10;
const LABEL_MAX = 20;

const clean = (v: unknown): string => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '');

/** The name and mobile the customer typed, checked like an order's; either may be left empty. */
export const checkProfile = (body: unknown): { name: string; phone: string } | { reason: string } => {
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const name = clean(b.name);
  if (name.length > LIMITS.name) return { reason: 'a shorter name, please' };
  const typed = clean(b.phone);
  const phone = typed ? normalisePhone(typed) : '';
  if (phone === null) return { reason: 'type your phone number, like 077 123 4567' };
  return { name, phone };
};

/** A saved address: the words for the rider, a short label ("Home"), and the pin when shared. */
export const checkAddress = (body: unknown): { label: string; address: string; pin: DeliveryPin | null } | { reason: string } => {
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const address = clean(b.address);
  if (!address) return { reason: 'type the address' };
  if (address.length > LIMITS.address) return { reason: `an address of at most ${LIMITS.address} letters` };
  const label = clean(b.label);
  if (label.length > LABEL_MAX) return { reason: `a label of at most ${LABEL_MAX} letters` };
  const pin = checkPin(b.pin);
  if (typeof pin === 'string') return { reason: pin };
  return { label, address, pin };
};

/** Same place: the same words (any case or spacing), so an order to it updates it rather than adding another. */
export const sameAddress = (a: string, b: string): boolean => clean(a).toLowerCase() === clean(b).toLowerCase();

/**
 * A past order's lines as they can be ordered today: dishes gone from the menu, hidden or sold out
 * are left out, and so are extras or leave-outs it no longer offers (the rest of the line stays).
 */
export const reorderable = (lines: readonly OnlineLine[], items: readonly MenuItem[] = menuItems()): OnlineLine[] =>
  lines.flatMap((l) => {
    const item = items.find((m) => m.id === l.itemId);
    if (!item || item.hidden || item.soldOut) return [];
    const size = item.variants ? (item.variants.some((v) => v.id === l.size) ? l.size : undefined) : undefined;
    if (item.variants && !size) return [];
    return [{
      itemId: item.id, qty: Math.min(LIMITS.qty, Math.max(1, l.qty)), ...(size ? { size } : {}),
      adds: l.adds.filter((id) => item.adds.some((o) => o.id === id)),
      outs: l.outs.filter((id) => item.leaveOut.some((o) => o.id === id)),
    }];
  });
