import { useCallback, useEffect, useRef, useState } from 'react';
import type { Actor } from '../domain/auth.ts';
import { itemById } from '../domain/menu.ts';
import { fmt } from '../domain/money.ts';
import {
  addLine, addLines, emptyOrder, markSent, newLineId, orderTotal, removeLine, unsentLines, updateLine,
} from '../domain/order.ts';
import type { NewTicket } from '../domain/kitchen.ts';
import {
  applyManagerChange, isRefusal, undoManagerChange, type Applied, type Inverse,
  type ManagerChange, type Refusal,
} from '../domain/manager.ts';
import { discountLabel } from '../domain/totals.ts';
import type { LineSpec, Order, OrderLine, PaidOrder, Tender } from '../domain/types.ts';
import { demoSnapshot } from '../fake/demo.ts';
import { currentCashier, shopId } from '../services/auth.ts';
import { appendEvent } from './eventLog.ts';
import { isDemo, storageKey } from './storage.ts';

/**
 * Register state. Everything the cashier does is an instant, optimistic local
 * action with a one-step Undo. The screen state is a device-local cache in
 * localStorage; what the shop shares (kitchen, audit) travels as events
 * through the event log, which is the sync outbox.
 *
 * Customers eat first and pay after: an order is sent to the kitchen, waits in
 * `open` until the customer pays, and can take more rounds in between.
 * Sends, payments and manager changes are written to the event log; the
 * kitchen screen is built from those events alone.
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
export interface Toast {
  id: number;
  message: string;
  /** A manager change: its Undo belongs to manager mode, not to the cashier's Undo. */
  manager?: boolean;
}

/** One applied manager change, kept so Ctrl+Z / the Undo bar can reverse it exactly. */
interface ManagerRecord {
  orderNumber: number;
  /** The order right after the change, in case it has since left the screen (e.g. every line voided). */
  orderAfter: Order;
  inverse: Inverse;
  eventId: string;
  eventType: string;
}

export type ManageResult = Refusal | { applied: Applied; undo: () => void };

const KEY = () => storageKey('pos.v0');
const HISTORY = 20;
const FIRED_KEPT = 50;
const TOAST_MS = 6000;

const fresh = (): Snapshot => ({ order: emptyOrder(1001), open: [], paid: null, sales: [], nextNumber: 1001, fired: [] });

const load = (): Snapshot => {
  try {
    const raw = localStorage.getItem(KEY());
    if (raw) {
      const s = JSON.parse(raw) as Partial<Snapshot>;
      if (s?.order && Array.isArray(s.order.lines)) {
        // Older saves predate open orders: fill the gaps rather than lose the order.
        return { ...fresh(), ...s, open: s.open ?? [], fired: s.fired ?? [] } as Snapshot;
      }
    }
  } catch { /* corrupted or unavailable storage: start clean */ }
  if (isDemo()) return { ...fresh(), ...demoSnapshot(Date.now()) };
  return fresh();
};

const blank = (s: Snapshot): Order => emptyOrder(s.nextNumber);

const isToday = (at: number): boolean => new Date(at).toDateString() === new Date().toDateString();

/** After a sale, the next tap on the menu silently opens a new order. */
const ensureOpen = (s: Snapshot): Snapshot => (s.paid ? { ...s, order: blank(s), paid: null } : s);

/** Puts a changed order back on screen and keeps its "Waiting to pay" copy in step. */
const withOrder = (s: Snapshot, order: Order): Snapshot => {
  const emptied = order.lines.length === 0 && order.sentAt !== undefined;
  const open = s.open.filter((o) => o.number !== order.number);
  return {
    ...s,
    paid: null,
    order: emptied ? blank(s) : order,
    open: order.sentAt !== undefined && !emptied ? [...open, order].sort((a, b) => a.number - b.number) : open,
  };
};

/**
 * Marks the order's unsent lines as sent and builds their kitchen ticket.
 * The first send of a new order claims its number; later sends are add-ons.
 */
const sendUnsent = (s: Snapshot, at: number): { s: Snapshot; order: Order; ticket: NewTicket | null } => {
  const lines = unsentLines(s.order);
  if (!lines.length) return { s, order: s.order, ticket: null };
  const order = markSent(s.order, at);
  const ticket: NewTicket = {
    id: newLineId(), shopId: shopId(), number: order.number, lines: lines.map((l) => ({ ...l, sent: true })), firedAt: at,
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
  appendEvent({
    type: 'order.sent', at: ticket.firedAt, actor: currentCashier(), orderNumber: ticket.number,
    ticketId: ticket.id, lines: ticket.lines, addOn: Boolean(ticket.addOn), ...(ticket.online ? { online: ticket.online } : {}),
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
  /** Manager changes made in the current manager session, newest last. Cleared when the session ends. */
  const managerStack = useRef<ManagerRecord[]>([]);

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
    try { localStorage.setItem(KEY(), JSON.stringify(snap)); } catch { /* storage full/blocked */ }
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

  /** Cashier edits: unsent lines only. Sent lines need a manager (`manage`). */
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

  /**
   * An online order the counter accepted: it takes the next number and goes straight to the
   * kitchen, waiting to be paid at pickup. The order on screen is left alone (a new one moves
   * up a number). Not undoable here: the customer has already been told.
   */
  const acceptOnline = useCallback((specs: LineSpec[], pickupBy: number): number => {
    seal();
    const s = ref.current;
    const at = Date.now();
    const number = s.nextNumber;
    const online = { pickupBy };
    const order = { ...markSent(addLines(emptyOrder(number), specs), at), online };
    const ticket: NewTicket = { id: newLineId(), shopId: shopId(), number, lines: order.lines, firedAt: at, addOn: false, online };
    const onScreen = !s.paid && s.order.sentAt === undefined && s.order.number === number ? { ...s.order, number: number + 1 } : s.order;
    const next: Snapshot = {
      ...s, order: onScreen, nextNumber: number + 1,
      open: [...s.open, order].sort((a, b) => a.number - b.number),
      fired: [...s.fired.slice(-(FIRED_KEPT - 1)), ticket.id],
    };
    ref.current = next;
    setSnap(next);
    setToast({ id: ++toastSeq.current, message: `Online order ${number} sent to kitchen` });
    fireTicket(ticket);
    return number;
  }, [seal]);

  /** Returns the paid order (for its receipt), or undefined when there was nothing to pay. */
  const pay = useCallback((tender: Tender, tendered: number): PaidOrder | undefined => {
    const total = orderTotal(ref.current.order);
    // A comped order (Free) closes at 0 with tender 'comp'; anything else needs something to pay.
    const comped = ref.current.order.adjust?.discount?.kind === 'comp';
    if (comped ? tender !== 'comp' || !ref.current.order.lines.length : total <= 0) return undefined;
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
    }), comped ? `Closed ${order.number} · Free` : `Paid ${fmt(total)}`);
    appendEvent({ type: 'order.paid', at: paid.paidAt, actor: currentCashier(), orderNumber: paid.number, total, tender, tendered });
    return paid;
  }, [commit]);

  const toastFor = useCallback((message: string) => setToast({ id: ++toastSeq.current, message, manager: true }), []);

  const undoRecord = useCallback((actor: Actor, record: ManagerRecord) => {
    const s = ref.current;
    const at = Date.now();
    const current = s.order.number === record.orderNumber
      ? s.order
      : s.open.find((o) => o.number === record.orderNumber) ?? record.orderAfter;
    const u = undoManagerChange(current, record, actor, at);
    const next = withOrder(s, u.order);
    ref.current = next;
    setSnap(next);
    appendEvent(u.event); // the kitchen restores the line from this event
    toastFor('Undone');
  }, [toastFor]);


  /**
   * THE entry point for every manager change (void, edit, line adjustment,
   * discount, Free). Applies it to the order on screen, writes exactly one
   * audit event, tells the kitchen when a sent line changed, and returns the
   * Undo. Clears the cashier's Undo: a cashier must not step back over it.
   */
  const manage = useCallback((actor: Actor, change: ManagerChange): ManageResult => {
    const s = ref.current;
    const at = Date.now();
    const r = applyManagerChange(s.order, change, actor, at);
    if (isRefusal(r)) return r;

    const next = withOrder(s, r.order);
    sendOpen.current = false;
    setHistory([]);
    ref.current = next;
    setSnap(next);

    const event = appendEvent(r.event); // the kitchen shows the change from this event
    const record: ManagerRecord = {
      orderNumber: s.order.number, orderAfter: r.order, inverse: r.inverse,
      eventId: event.id, eventType: event.type,
    };
    managerStack.current.push(record);

    const name = (id: string) => itemById(s.order.lines.find((l) => l.id === id)!.itemId).name.en;
    toastFor(
      change.kind === 'discount' ? (change.discount ? discountLabel(change.discount) : 'Discount removed')
        : change.kind === 'void' ? `Voided ${name(change.lineId)}`
          : change.kind === 'edit' ? `Changed ${name(change.lineId)}`
            : `Adjusted ${name(change.lineId)} · −${fmt(change.cents)}`,
    );
    if (navigator.vibrate) navigator.vibrate(8);

    const undo = () => {
      const i = managerStack.current.indexOf(record);
      if (i < 0) return; // already undone, or the manager session ended
      managerStack.current.splice(i, 1);
      undoRecord(actor, record);
    };
    return { applied: r, undo };
  }, [setHistory, undoRecord]);

  /** Ctrl+Z in manager mode: reverse the newest manager change of this session. */
  const undoManager = useCallback((actor: Actor) => {
    const record = managerStack.current.pop();
    if (record) undoRecord(actor, record);
    return Boolean(record);
  }, [undoRecord]);

  /** Leaving manager mode: its changes can no longer be undone from the counter. */
  const endManagerSession = useCallback(() => {
    managerStack.current = [];
    setToast((t) => (t?.manager ? null : t));
  }, []);

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
    canUndoManager: () => managerStack.current.length > 0,
    /** The number the next order (or accepted online order) gets. */
    nextNumber: snap.nextNumber,
    addSpec, addSpecs, editLine, dropLine, send, acceptOnline, pay, manage, undoManager, endManagerSession, openOrder, startNew, undo,
  };
}
