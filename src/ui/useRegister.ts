import { useCallback, useEffect, useRef, useState } from 'react';
import type { Actor } from '../domain/auth.ts';
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
import type { Cents, LineSpec, Order, OrderCustomer, OrderLine, PaidOrder, Tender } from '../domain/types.ts';
import { platformLabel, type PlatformMark } from '../domain/platforms.ts';
import { demoSnapshot } from '../fake/demo.ts';
import { currentCashier, shopId } from '../services/auth.ts';
import { appendEvent } from './eventLog.ts';
import { isDemo, storageKey } from './storage.ts';
import { lineItemName } from '../domain/halves.ts';

/**
 * Register state. Everything the cashier does is an instant, optimistic local
 * action with a one-step Undo. The screen state is a device-local cache in
 * localStorage; what the shop shares (kitchen, audit) travels as events
 * through the event log, which is the sync outbox.
 *
 * Send and Pay are independent (SCRUM-239): an order can go to the kitchen first and be paid
 * later (customers eating in), or be paid first and sent when the cashier presses Send (a held
 * send). Every order with something on it keeps its number and waits in `open` until it is
 * paid; a paid one stays on the Register's list until the kitchen has made it (`sales`).
 * Sends, payments and manager changes are written to the event log; the kitchen screen is
 * built from those events alone.
 */
interface Snapshot {
  /** The order on screen: a new one, or an open one being added to or charged. */
  order: Order;
  /** Not paid yet: sent to the kitchen, or left on the list before it went (each keeps its number). */
  open: Order[];
  /** The paid order on screen: just paid, or opened again from the list. */
  paid: PaidOrder | null;
  /** `paid` was paid by the last step, so its Undo is the payment's. */
  justPaid?: boolean;
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
const ensureOpen = (s: Snapshot): Snapshot => (s.paid ? { ...s, order: blank(s), paid: null, justPaid: false } : s);

const byNumber = (list: Order[]): Order[] => [...list].sort((a, b) => a.number - b.number);
/** On the list already: sent, or left there with its number. */
const listed = (s: Snapshot, order: Order): boolean => order.sentAt !== undefined || s.open.some((o) => o.number === order.number);

/** Puts a changed order back on screen and keeps its copy on the list in step. */
const withOrder = (s: Snapshot, order: Order): Snapshot => {
  const onList = listed(s, order);
  const emptied = order.lines.length === 0 && onList;
  const open = s.open.filter((o) => o.number !== order.number);
  return {
    ...s,
    paid: null,
    justPaid: false,
    order: emptied ? blank(s) : order,
    open: onList && !emptied ? byNumber([...open, order]) : open,
  };
};

/**
 * Leaves the order on screen for another (SCRUM-239): with something on it, it keeps its number
 * (claimed now if new) and waits on the list, sent or not; an empty one is just let go.
 */
const park = (s: Snapshot): Snapshot => {
  if (s.paid) return { ...s, order: blank(s), paid: null, justPaid: false };
  const o = s.order;
  if (!o.lines.length) {
    const open = s.open.filter((x) => x.number !== o.number);
    return { ...s, open, order: blank(s) };
  }
  const next: Snapshot = {
    ...s,
    nextNumber: o.number === s.nextNumber ? s.nextNumber + 1 : s.nextNumber,
    open: byNumber([...s.open.filter((x) => x.number !== o.number), o]),
  };
  return { ...next, order: blank(next) };
};

/** The same sale in a list: numbers repeat across days and screens, so the payment time too. */
const sameSale = (a: PaidOrder, b: PaidOrder): boolean => a.number === b.number && a.paidAt === b.paidAt;

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
    addOn: s.order.sentAt !== undefined, ...(s.order.platform ? { platform: s.order.platform } : {}),
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

/** `held`: paid first; the kitchen sees it at Send (`order.released`). */
const fireTicket = (ticket: NewTicket, held = false) => {
  appendEvent({
    type: 'order.sent', at: ticket.firedAt, actor: currentCashier(), orderNumber: ticket.number,
    ticketId: ticket.id, lines: ticket.lines, addOn: Boolean(ticket.addOn), ...(ticket.online ? { online: ticket.online } : {}),
    ...(ticket.platform ? { platform: ticket.platform } : {}), ...(held ? { held: true as const } : {}),
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
  /** The cashier's last change to a sent line, while its Undo toast shows. */
  const [counterChange, setCounterChange] = useState<ManagerRecord | null>(null);
  const counterRef = useRef<ManagerRecord | null>(null);
  const setCounter = useCallback((r: ManagerRecord | null) => { counterRef.current = r; setCounterChange(r); }, []);

  const setHistory = useCallback((p: Snapshot[]) => {
    pastRef.current = p;
    setPast(p);
  }, []);

  const seal = useCallback(() => {
    setCounter(null); // anything else done at the counter ends a sent-line change's Undo
    if (!sendOpen.current) return;
    sendOpen.current = false;
    setHistory([]);
  }, [setHistory, setCounter]);

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

  /**
   * Marks the order on screen as a delivery app's (SCRUM-195), with its code there, or takes the
   * mark off (null). Only before it goes to the kitchen: the ticket and its event carry the mark.
   */
  const setPlatform = useCallback((mark: PlatformMark | null) => {
    const s = ensureOpen(ref.current);
    if (s.order.sentAt !== undefined) return;
    const { platform: _old, ...order } = s.order;
    commit(() => ({ ...s, order: mark ? { ...order, platform: mark } : order }), mark ? `${platformLabel(mark)}` : 'Not a delivery app order');
  }, [commit]);

  /**
   * Puts a customer (CRM) on the order on screen, or takes them off: a new order or one waiting to
   * pay. Nothing is written to the event log; the payment names them by id when it goes in.
   */
  const setCustomer = useCallback((customer: OrderCustomer | null) => {
    const s = ensureOpen(ref.current);
    const { customer: had, ...rest } = s.order;
    if (!customer && !had) return;
    const order: Order = customer ? { ...rest, customer } : rest;
    commit(() => withOrder(s, order), customer ? `${customer.name ?? 'Customer'} on order ${order.number}` : 'Customer taken off');
  }, [commit]);

  /** Cashier edits of unsent lines. A sent line goes through `changeSent` (audited, the kitchen told). */
  const editLine = useCallback((line: OrderLine, message: string) => {
    if (ref.current.order.lines.find((l) => l.id === line.id)?.sent) return;
    commit((s) => ({ ...s, order: updateLine(s.order, line) }), message);
  }, [commit]);

  const dropLine = useCallback((id: string, message: string) => {
    if (ref.current.order.lines.find((l) => l.id === id)?.sent) return;
    commit((s) => ({ ...s, order: removeLine(s.order, id) }), message);
  }, [commit]);

  /** A combo box (SCRUM-231) comes off whole: its price is shared by all its dishes. Unsent boxes only. */
  const dropBox = useCallback((boxId: string, message: string) => {
    if (ref.current.order.lines.some((l) => l.box?.id === boxId && l.sent)) return;
    commit((s) => ({ ...s, order: { ...s.order, lines: s.order.lines.filter((l) => l.box?.id !== boxId) } }), message);
  }, [commit]);

  /**
   * A paid order not yet sent (paid first) goes to the kitchen now. Final: the kitchen has it, so
   * there is no Undo (a manager can still change what was sent).
   */
  const release = useCallback(() => {
    const s = ref.current;
    const p = s.paid;
    if (!p?.held) return;
    const at = Date.now();
    const { held: ticketId, ...rest } = p;
    const done: PaidOrder = { ...rest, sentAt: p.sentAt ?? at };
    commit(() => ({
      ...s, order: blank(s), paid: null, justPaid: false,
      sales: s.sales.map((x) => (sameSale(x, p) ? done : x)),
    }), `Sent ${p.number} to kitchen`);
    sendOpen.current = false;
    setHistory([]);
    appendEvent({ type: 'order.released', at, actor: currentCashier(), orderNumber: p.number, ticketId });
  }, [commit, setHistory]);

  /** Sends the new lines to the kitchen and frees the register for the next customer. */
  const send = useCallback(() => {
    if (ref.current.paid) { release(); return; }
    const { s, order, ticket } = sendUnsent(ref.current, Date.now());
    if (!ticket) return;
    commit(() => ({
      ...s,
      open: [...s.open.filter((o) => o.number !== order.number), order],
      order: blank(s),
    }), ticket.addOn ? `Sent more for ${order.number}` : `Sent ${order.number} to kitchen`);
    sendOpen.current = true;
    fireTicket(ticket);
  }, [commit, release]);

  /**
   * An online order the counter accepted: it takes the next number and goes straight to the
   * kitchen, waiting to be paid at pickup (a delivery: when the rider is back with the cash). The order on screen is left alone (a new one moves
   * up a number). Not undoable here: the customer has already been told.
   */
  const acceptOnline = useCallback((specs: LineSpec[], pickupBy: number, delivery?: { fee: Cents }): number => {
    seal();
    const s = ref.current;
    const at = Date.now();
    const number = s.nextNumber;
    const online = { pickupBy, ...(delivery ? { delivery } : {}) };
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

  /**
   * Returns the paid order (for its receipt), or undefined when there was nothing to pay.
   * `customerId`: the customer whose mobile was given at Charge (CRM), named on the payment by id only.
   * `unlinked`: a mobile was given but the shop PC did not answer in time; the sale stands, and the
   * toast says the mobile was not saved (its Undo lets the cashier take the payment again).
   */
  const pay = useCallback((tender: Tender, tendered: number, customerId?: string, unlinked = false): PaidOrder | undefined => {
    const total = orderTotal(ref.current.order);
    // A comped order (Free) closes at 0 with tender 'comp'; anything else needs something to pay.
    const comped = ref.current.order.adjust?.discount?.kind === 'comp';
    if (comped ? tender !== 'comp' || !ref.current.order.lines.length : total <= 0) return undefined;
    // Paying never sends (SCRUM-239). What is not yet sent is written as a held send first, so
    // the sale and the stock count it as sold, while the kitchen waits for Send. Undoing the
    // payment takes the held send back with it (it is in `fired`).
    const at = Date.now();
    const before = ref.current;
    const sent = sendUnsent(before, at);
    let order = before.order;
    if (sent.ticket) {
      const { sentAt: _never, ...rest } = sent.order;
      order = { ...rest, ...(before.order.sentAt !== undefined ? { sentAt: before.order.sentAt } : {}), held: sent.ticket.id };
    }
    // A customer put on the order earlier is the one paying, unless Charge was given a number now.
    customerId ??= order.customer?.id;
    const paid: PaidOrder = { ...order, total, tender, tendered, change: Math.max(0, tendered - total), paidAt: at };
    commit(() => ({
      ...sent.s,
      order: paid,
      paid,
      justPaid: true,
      open: sent.s.open.filter((o) => o.number !== order.number),
      sales: [...sent.s.sales, paid],
    }), comped ? `Closed ${order.number} · Free` : `Paid ${fmt(total)}${unlinked ? ' · mobile not saved' : ''}`);
    if (sent.ticket) fireTicket(sent.ticket, true);
    appendEvent({ type: 'order.paid', at: paid.paidAt, actor: currentCashier(), orderNumber: paid.number, total, tender, tendered, ...(customerId ? { customerId } : {}) });
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

    const name = (id: string) => lineItemName(s.order.lines.find((l) => l.id === id)!);
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

  /** Undo of the cashier's last sent-line change (the toast's Undo, Ctrl+Z). */
  const undoCounter = useCallback((): boolean => {
    const record = counterRef.current;
    if (!record) return false;
    setCounter(null);
    undoRecord(currentCashier(), record);
    setToast({ id: ++toastSeq.current, message: 'Undone' });
    return true;
  }, [setCounter, undoRecord]);

  /**
   * The cashier changes or cancels a sent line (the customer changed their mind): no PIN, no
   * reason asked. Audited like a manager change, the kitchen is told, and the cashier's own
   * Undo (toast, Ctrl+Z) reverses it until anything else is done or the toast goes.
   * `made`: the kitchen had started or finished it (recorded as waste).
   */
  const changeSent = useCallback((change: Extract<ManagerChange, { kind: 'edit' | 'void' }>, made: boolean): ManageResult => {
    const s = ref.current;
    const actor = currentCashier();
    const at = Date.now();
    const r = applyManagerChange(s.order, { ...change, ...(made ? { made } : {}) }, actor, at);
    if (isRefusal(r)) return r;

    seal(); // a send's Undo window ends here: it must not step back over this change
    setHistory([]);
    const next = withOrder(s, r.order);
    ref.current = next;
    setSnap(next);
    const event = appendEvent(r.event);
    const record: ManagerRecord = { orderNumber: s.order.number, orderAfter: r.order, inverse: r.inverse, eventId: event.id, eventType: event.type };
    setCounter(record);
    const line = s.order.lines.find((l) => l.id === change.lineId)!;
    const name = lineItemName(change.kind === 'edit' ? { ...line, ...change.after } : line);
    setToast({
      id: ++toastSeq.current,
      message: `${change.kind === 'void' ? `Removed ${lineItemName(line)}` : `Changed ${name}`}${made ? ' · counted as waste' : ''} · kitchen told`,
    });
    if (navigator.vibrate) navigator.vibrate(8);
    return { applied: r, undo: undoCounter };
  }, [seal, setHistory, setCounter, undoCounter]);

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

  /**
   * Brings an order from the list on screen: one not paid (to add to, send or pay), or one paid
   * today and not yet made (to send it, or see it). The order that was on screen waits on the list.
   */
  const openOrder = useCallback((number: number) => {
    show((s) => {
      if (s.order.number === number && !s.paid) return s;
      const parked = park(s);
      const hit = parked.open.find((o) => o.number === number);
      if (hit) return { ...parked, order: hit, paid: null, justPaid: false };
      const sale = [...parked.sales].reverse().find((o) => o.number === number && isToday(o.paidAt));
      return sale ? { ...parked, order: sale, paid: sale, justPaid: false } : s;
    });
  }, [show]);

  /** A new order; the one on screen, if it has anything on it, waits on the list with its number. */
  const startNew = useCallback(() => {
    show(park);
  }, [show]);

  const undo = useCallback(() => {
    if (undoCounter()) return; // the last thing done was a change to a sent line
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
  }, [setHistory, undoCounter]);

  return {
    order: snap.order,
    /** Waiting to pay, oldest first; excludes the order on screen. */
    open: snap.open.filter((o) => o.number !== snap.order.number),
    paidToday: snap.sales.filter((o) => isToday(o.paidAt)).reverse(),
    paid: snap.paid,
    /** The paid order on screen was paid by the last step: its Undo is the payment's. */
    justPaid: Boolean(snap.paid && snap.justPaid),
    toast,
    canUndo: past.length > 0 || counterChange !== null,
    canUndoManager: () => managerStack.current.length > 0,
    /** The number the next order (or accepted online order) gets. */
    nextNumber: snap.nextNumber,
    addSpec, addSpecs, editLine, dropLine, dropBox, changeSent, send, acceptOnline, setPlatform, setCustomer, pay, manage, undoManager, endManagerSession, openOrder, startNew, undo,
  };
}
