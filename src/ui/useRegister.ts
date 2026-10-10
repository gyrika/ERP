import { useCallback, useEffect, useRef, useState } from 'react';
import { canChangeSentItems, currentCashier, type Actor } from '../domain/auth.ts';
import { itemById } from '../domain/menu.ts';
import { fmt } from '../domain/money.ts';
import {
  addLine, addLines, emptyOrder, markSent, newLineId, orderTotal, removeLine, unsentLines, updateLine,
} from '../domain/order.ts';
import { amendLine, fire, recall, type NewTicket } from '../domain/kitchen.ts';
import type { LineSpec, Order, OrderLine, PaidOrder, Tender } from '../domain/types.ts';
import { appendEvent } from './eventLog.ts';
import { updateTickets } from './kitchenStore.ts';

/**
 * Register state. Everything the cashier does is an instant, optimistic local
 * action with a one-step Undo. Persisted to localStorage for now; slice 4
 * replaces this with IndexedDB + an outbox that syncs to MySQL.
 *
 * Customers eat first and pay after: an order is sent to the kitchen, waits in
 * `open` until the customer pays, and can take more rounds in between.
 * Sends, payments and manager changes are written to the event log.
 */
interface Snapshot {
  /** The order on screen: a new one, or an open one being added to or charged. */
  order: Order;
  /** Sent to the kitchen, not paid yet. */
  open: Order[];
  paid: PaidOrder | null;
  sales: PaidOrder[];
  /** Number for the next new order. Claimed when that order is first sent, so numbers have no gaps. */
  nextNumber: number;
  /** Recent kitchen ticket ids, so Undo can recall exactly what a step sent. */
  fired: string[];
}
export interface Toast { id: number; message: string }

const KEY = 'cb.pos.v0';
const HISTORY = 20;
const FIRED_KEPT = 50;
const TOAST_MS = 6000;

const fresh = (): Snapshot => ({ order: emptyOrder(1001), open: [], paid: null, sales: [], nextNumber: 1001, fired: [] });

const load = (): Snapshot => {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw) as Partial<Snapshot>;
      if (s?.order && Array.isArray(s.order.lines)) {
        // Older saves predate open orders: fill the gaps rather than lose the order.
        return { ...fresh(), ...s, open: s.open ?? [], fired: s.fired ?? [] } as Snapshot;
      }
    }
  } catch { /* corrupted or unavailable storage: start clean */ }
  return fresh();
};

const blank = (s: Snapshot): Order => emptyOrder(s.nextNumber);

const isToday = (at: number): boolean => new Date(at).toDateString() === new Date().toDateString();

/** After a sale, the next tap on the menu silently opens a new order. */
const ensureOpen = (s: Snapshot): Snapshot => (s.paid ? { ...s, order: blank(s), paid: null } : s);

/**
 * Marks the order's unsent lines as sent and builds their kitchen ticket.
 * The first send of a new order claims its number; later sends are add-ons.
 */
const sendUnsent = (s: Snapshot, at: number): { s: Snapshot; order: Order; ticket: NewTicket | null } => {
  const lines = unsentLines(s.order);
  if (!lines.length) return { s, order: s.order, ticket: null };
  const order = markSent(s.order, at);
  const ticket: NewTicket = {
    id: newLineId(), number: order.number, lines: lines.map((l) => ({ ...l, sent: true })), firedAt: at,
    addOn: s.order.sentAt !== undefined,
  };
  return {
    order,
    ticket,
    s: {
      ...s,
      nextNumber: order.number === s.nextNumber ? s.nextNumber + 1 : s.nextNumber,
      fired: [...s.fired.slice(-(FIRED_KEPT - 1)), ticket.id],
    },
  };
};

const fireTicket = (ticket: NewTicket) => {
  updateTickets((t) => fire(t, ticket));
  appendEvent({
    type: 'order.sent', at: ticket.firedAt, actor: currentCashier(), orderNumber: ticket.number,
    ticketId: ticket.id, lines: ticket.lines, addOn: Boolean(ticket.addOn),
  });
};

export function useRegister() {
  const [snap, setSnap] = useState<Snapshot>(load);
  const [past, setPast] = useState<Snapshot[]>([]);
  const [toast, setToast] = useState<Toast | null>(null);
  const ref = useRef(snap);
  const pastRef = useRef(past);
  const toastSeq = useRef(0);
  /**
   * A cashier may undo a send only straight after pressing it. Once anything
   * else happens (or the Undo toast times out) the send is sealed: history
   * before it is dropped, and only a manager can change what was sent.
   */
  const sendOpen = useRef(false);

  const setHistory = useCallback((p: Snapshot[]) => {
    pastRef.current = p;
    setPast(p);
  }, []);

  const seal = useCallback(() => {
    if (!sendOpen.current) return;
    sendOpen.current = false;
    setHistory([]);
  }, [setHistory]);

  useEffect(() => {
    try { localStorage.setItem(KEY, JSON.stringify(snap)); } catch { /* storage full/blocked */ }
  }, [snap]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => { setToast(null); seal(); }, TOAST_MS);
    return () => clearTimeout(t);
  }, [toast, seal]);

  const commit = useCallback((fn: (s: Snapshot) => Snapshot, message: string) => {
    seal();
    const cur = ref.current;
    const next = fn(cur);
    ref.current = next;
    setHistory([...pastRef.current.slice(-(HISTORY - 1)), cur]);
    setSnap(next);
    setToast({ id: ++toastSeq.current, message });
    if (navigator.vibrate) navigator.vibrate(8); // haptic where supported
  }, [seal, setHistory]);

  /** Screen changes (not data changes): no Undo entry, no toast. */
  const show = useCallback((fn: (s: Snapshot) => Snapshot) => {
    seal();
    const next = fn(ref.current);
    ref.current = next;
    setSnap(next);
  }, [seal]);

  const addSpecs = useCallback((specs: LineSpec[], message: string) => {
    if (specs.length) commit((s) => ({ ...ensureOpen(s), order: addLines(ensureOpen(s).order, specs) }), message);
  }, [commit]);

  const addSpec = useCallback((spec: LineSpec, message: string) => {
    commit((s) => { const o = ensureOpen(s); return { ...o, order: addLine(o.order, spec) }; }, message);
  }, [commit]);

  /** Cashier edits: unsent lines only. Sent lines need `managerChange`. */
  const editLine = useCallback((line: OrderLine, message: string) => {
    if (ref.current.order.lines.find((l) => l.id === line.id)?.sent) return;
    commit((s) => ({ ...s, order: updateLine(s.order, line) }), message);
  }, [commit]);

  const dropLine = useCallback((id: string, message: string) => {
    if (ref.current.order.lines.find((l) => l.id === id)?.sent) return;
    commit((s) => ({ ...s, order: removeLine(s.order, id) }), message);
  }, [commit]);

  /** Sends the new lines to the kitchen and frees the register for the next customer. */
  const send = useCallback(() => {
    const { s, order, ticket } = sendUnsent(ref.current, Date.now());
    if (!ticket) return;
    commit(() => ({
      ...s,
      open: [...s.open.filter((o) => o.number !== order.number), order],
      order: blank(s),
    }), ticket.addOn ? `Sent more for ${order.number}` : `Sent ${order.number} to kitchen`);
    sendOpen.current = true;
    fireTicket(ticket);
  }, [commit]);

  const pay = useCallback((tender: Tender, tendered: number) => {
    const total = orderTotal(ref.current.order);
    if (total <= 0) return;
    // Anything not yet sent goes to the kitchen first (a sealed send), so
    // undoing the payment later never pulls food back off the kitchen screen.
    const sent = sendUnsent(ref.current, Date.now());
    if (sent.ticket) {
      const { ticket } = sent;
      commit(() => ({ ...sent.s, order: sent.order }), `Sent ${sent.order.number} to kitchen`);
      sendOpen.current = true; // sealed by the payment commit below
      fireTicket(ticket);
    }
    const order = ref.current.order;
    const paid: PaidOrder = {
      ...order, total, tender, tendered, change: Math.max(0, tendered - total), paidAt: Date.now(),
    };
    commit((s) => ({
      ...s,
      paid,
      open: s.open.filter((o) => o.number !== order.number),
      sales: [...s.sales, paid],
    }), `Paid ${fmt(total)}`);
    appendEvent({ type: 'order.paid', at: paid.paidAt, actor: currentCashier(), orderNumber: paid.number, total, tender, tendered });
  }, [commit]);

  /**
   * A manager or owner changes (`after`) or cancels (`after` = null) a line
   * already sent. Updates the bill and the kitchen ticket, logs the event, and
   * clears Undo: a cashier must not be able to step back over it.
   */
  const managerChange = useCallback((actor: Actor, lineId: string, after: LineSpec | null, reason: string) => {
    const s = ref.current;
    const before = s.order.lines.find((l) => l.id === lineId);
    if (!before?.sent || !canChangeSentItems(actor) || s.paid || !reason.trim()) return;
    const at = Date.now();
    const changed: OrderLine | null = after ? { ...after, id: lineId, sent: true } : null;
    const apply = (o: Order): Order => (changed ? updateLine(o, changed) : removeLine(o, lineId));
    const order = apply(s.order);
    const emptied = order.lines.length === 0;
    const next: Snapshot = {
      ...s,
      order: emptied ? blank(s) : order,
      open: s.open
        .map((o) => (o.number === order.number ? apply(o) : o))
        .filter((o) => o.lines.length > 0),
    };
    sendOpen.current = false;
    setHistory([]);
    ref.current = next;
    setSnap(next);
    const name = itemById(before.itemId).name.en;
    setToast({ id: ++toastSeq.current, message: `${changed ? 'Changed' : 'Cancelled'} ${name}` });

    updateTickets((t) => amendLine(t, lineId, changed, at));
    const base = { at, actor, orderNumber: s.order.number, lineId, before, reason: reason.trim() };
    appendEvent(changed ? { ...base, type: 'order.item_changed', after: changed } : { ...base, type: 'order.item_cancelled' });
  }, [setHistory]);

  /** Brings a waiting order on screen to charge it or add a round. */
  const openOrder = useCallback((number: number) => {
    show((s) => {
      const hit = s.open.find((o) => o.number === number);
      return hit && !unsentLines(s.order).length ? { ...s, order: hit, paid: null } : s;
    });
  }, [show]);

  /** Back to a new order, leaving the open one waiting. */
  const startNew = useCallback(() => {
    show((s) => (unsentLines(s.order).length ? s : { ...s, order: blank(s), paid: null }));
  }, [show]);

  const undo = useCallback(() => {
    const p = pastRef.current;
    if (!p.length) return;
    const cur = ref.current;
    const prev = p[p.length - 1];
    sendOpen.current = false;
    setHistory(p.slice(0, -1));
    ref.current = prev;
    setSnap(prev);
    setToast(null);
    const at = Date.now();
    const actor = currentCashier();
    // Undoing a send (only possible straight after it) takes its ticket back off the kitchen screen.
    const recalled = cur.fired.filter((id) => !prev.fired.includes(id));
    if (recalled.length) {
      updateTickets((t) => recalled.reduce(recall, t));
      recalled.forEach((ticketId) =>
        appendEvent({ type: 'order.send_undone', at, actor, orderNumber: prev.order.number, ticketId }));
    }
    if (cur.paid && cur.paid.number !== prev.paid?.number) {
      appendEvent({ type: 'order.payment_undone', at, actor, orderNumber: cur.paid.number });
    }
  }, [setHistory]);

  return {
    order: snap.order,
    /** Waiting to pay, oldest first; excludes the order on screen. */
    open: snap.open.filter((o) => o.number !== snap.order.number),
    paidToday: snap.sales.filter((o) => isToday(o.paidAt)).reverse(),
    paid: snap.paid,
    toast,
    canUndo: past.length > 0,
    addSpec, addSpecs, editLine, dropLine, send, pay, managerChange, openOrder, startNew, undo,
  };
}
