import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { canManage, seesTakings } from '../domain/auth.ts';
import { DISCOUNT_CHIPS, type ManagerChange } from '../domain/manager.ts';
import { comboById, itemById, menuItems } from '../domain/menu.ts';
import { boxLines } from '../domain/combos.ts';
import { lineCookState } from '../domain/kitchen.ts';
import { balanceDue, bareLine, orderTotal, unsentLines } from '../domain/order.ts';
import type { MenuItem, OrderLine, PaidOrder, SizeId, Tender } from '../domain/types.ts';
import { currentCashier } from '../services/auth.ts';
import { useFlyToRail } from './flyToRail.ts';
import { KeyHints } from './KeyHints.tsx';
import { canPrint, printChangedBill, printDeliveryBill, printPartSlip, printReceipt } from '../services/printer.ts';
import { deliveryBill } from '../domain/receipt.ts';
import { lineGross } from '../domain/totals.ts';
import { fmt } from '../domain/money.ts';
import { CommandPalette, type Command } from './CommandPalette.tsx';
import { MoneyOutSheet } from './MoneyOutSheet.tsx';
import { ReceiveSheet } from './WorkViews.tsx';
import { ExtrasPanel } from './ExtrasPanel.tsx';
import { KitchenChip } from './KitchenChip.tsx';
import { OnlineChip, OnlineSheet, useOnline } from './Online.tsx';
import { onlineOrders } from '../services/onlineClient.ts';
import type { OnlineOrder } from '../domain/online.ts';
import { Menu, menuTabs, type CategoryId } from './Menu.tsx';
import { OrderPanel, VOID_REASONS, orderSummary, type ManagePanel } from './OrderPanel.tsx';
import { kitchenWord, railRows } from './OrdersRail.tsx';
import { BillHistory } from './BillHistory.tsx';
import { ActionBar, type BarAction } from './ActionBar.tsx';
import { kitchenScreenOn, setKitchenScreen } from './kitchenScreen.ts';
import { label } from './labels.ts';
import { useNow } from './Kitchen.tsx';
import { crmClient, crmReachable } from '../services/crmClient.ts';
import { modulesHere, readAll } from './eventLog.ts';
import { paidEdits } from '../domain/paidEdits.ts';
import { CustomerBar } from './CustomerBar.tsx';
import { customerOrders, visitsFromEvents } from '../domain/customers.ts';
import { usualOrder } from '../domain/usualOrder.ts';
import { PinSheet } from './PinSheet.tsx';
import { ShorthandBar, describe } from './ShorthandBar.tsx';
import { SyncSign } from './SyncSign.tsx';
import { useKitchenTickets } from './kitchenStore.ts';
import { setSoundOn, soundOn } from './sound.ts';
import { useManagerMode } from './useManagerMode.ts';
import { useRegister } from './useRegister.ts';
import { BinIcon, WasteSheet } from './WasteSheet.tsx';
import { MicIcon } from './VoiceKey.tsx';
import { useMenu } from './menuStore.ts';
import { THEME_LABEL, applyTheme, setTheme, themeChoice, themeStored, type ThemeChoice } from './theme.ts';
import { useFleet } from './ShopsView.tsx';
import { lineItemName } from '../domain/halves.ts';
import { isPlatformId, PLATFORMS, type Platform } from '../domain/platforms.ts';
import { PlatformSheet } from './PlatformSheet.tsx';

type Sheet =
  | { kind: 'extras'; item: MenuItem; size?: SizeId }
  | { kind: 'edit'; line: OrderLine }
  | { kind: 'pay' }
  /** `voidLine`: the PIN was asked by VOID on a sent line; once given, that line's reasons show. */
  | { kind: 'pin'; voidLine?: string }
  | { kind: 'online' }
  | { kind: 'waste' }
  | { kind: 'platform'; platform: Platform }
  | { kind: 'money' }
  | { kind: 'receive' }
  | null;

/** The Tables chip carries the floor's fold (SCRUM-168): loaded beside the Register, so the Register does not grow. */
const TablesChip = lazy(() => import('./TablesChip.tsx'));
/** "Table N needs cleaning" for 5 s (the owner's exception to "no banners", 2026-10-26): from the same chunk. */
const CleaningNote = lazy(() => import('./TablesChip.tsx').then((m) => ({ default: m.CleaningNote })));

const isTypingTarget = (el: EventTarget | null): boolean =>
  el instanceof HTMLElement && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);

/**
 * `onKitchen`: flips the counter screen to the Kitchen view (see Root).
 * `onSwitch`: locks the screen for the next person (real logins only).
 */
/** Keys with no button of their own, shown while Alt is held (SCRUM-245). */
const CASHIER_KEYS = [['A–Z', 'Type an order'], ['Ctrl Enter', 'Send / Pay'], ['Ctrl Z', 'Undo'], ['Esc', 'New order'], ['Alt 1–9', 'Menu tabs']] as const;
const PAYING_KEYS = [['0–9', 'Cash given'], ['Enter', 'Take'], ['Esc', 'Back to order']] as const;
const MANAGER_KEYS = [['↑ ↓', 'Pick a line'], ['Enter', 'Change'], ['Del', 'Void'], ['P', 'Price'], ['1–4', 'Discount'], ['Ctrl Z', 'Undo']] as const;

export function App({
  onKitchen,
  onTables,
  onOwner,
  onSwitch,
  canManageStock = true,
  onVoice,
}: {
  onKitchen?: () => void;
  /** Opens the floor of tables (SCRUM-168; F1 does the same). The chip shows only once there is a layout. */
  onTables?: () => void;
  /** Opens the Owner view (owners and managers; F10 does the same). */
  onOwner?: () => void;
  onSwitch?: () => void;
  canManageStock?: boolean;
  /** Hold to say which page to open (SCRUM-145; F9 does the same). */
  onVoice?: { start: () => void; stop: () => void };
} = {}) {
  const reg = useRegister();
  useMenu();
  // The counter is light unless someone chose otherwise (bright shop, arm's length).
  useEffect(() => { if (!themeStored()) applyTheme('light'); }, []);
  /** The Kitchen view is hidden until the staff are at home with the counter (kitchenScreen.ts). */
  const [kitchenOn, setKitchenOn] = useState(kitchenScreenOn);
  const tickets = useKitchenTickets(); // live, so Cooking turns Done the moment the kitchen taps it
  const online = useOnline();
  /** Tells the customer first (with the number this order will get), then sends it to the kitchen. */
  const acceptOnline = useCallback(async (o: OnlineOrder, minutes: number): Promise<string | null> => {
    const readyBy = Date.now() + minutes * 60_000;
    // Signed in on cheesybeez.com: the customer is found (or added) on the list while the cloud is told,
    // never holding the acceptance up (ensure gives up after 2 s; the order then simply has no customer).
    const [why, who] = await Promise.all([
      onlineOrders.answer(o.id, { status: 'accepted', orderNumber: reg.nextNumber, readyBy }),
      o.account && modulesHere().crm && crmReachable() ? crmClient.ensure(o.phone, o.name, 'app').then((r) => r.customer, () => undefined) : undefined,
    ]);
    if (!why) reg.acceptOnline(o.lines, readyBy, o.kind === 'delivery' ? { fee: o.deliveryFee } : undefined, who);
    return why;
  }, [reg]);
  /**
   * The rider leaves with a delivery: the customer's page says "On the way", and the bill for the
   * bag prints with the Register's own lines and total (a manager may have changed them since).
   */
  const outOnline = useCallback(async (o: OnlineOrder): Promise<string | null> => {
    const why = await onlineOrders.answer(o.id, { status: 'out' });
    if (!why && o.orderNumber !== null) reg.give(o.orderNumber); // out with the rider: the shop has handed it over (SCRUM-240)
    const order = [reg.order, ...reg.open].find((x) => x.number === o.orderNumber);
    if (!why && order && canPrint()) {
      void printDeliveryBill(deliveryBill({ ...o, lines: order.lines, total: orderTotal(order) }, order.lines.map(lineGross), { at: Date.now() }));
    }
    return why;
  }, [reg]);
  const [category, setCategory] = useState<CategoryId>('popular');
  const [sheet, setSheet] = useState<Sheet>(null);
  const [typed, setTyped] = useState<string | null>(null); // non-null = shorthand bar open
  /** Customers (CRM) is on and this counter can reach the list (the shop PC, someone signed in). */
  const crmOn = modulesHere().crm && crmReachable();
  const [custTyping, setCustTyping] = useState<string | null>(null); // non-null = typing a customer's mobile
  const closeSheet = useCallback(() => setSheet(null), []);
  /** The receipt of the sale on screen: printed by itself at payment, with the drawer for cash. */
  const [printing, setPrinting] = useState<{ number: number; state: 'printing' | 'printed' | 'failed' } | null>(null);
  const print = useCallback((paid: PaidOrder, reprint = false) => {
    if (!canPrint()) return;
    setPrinting({ number: paid.number, state: 'printing' });
    void printReceipt(paid, currentCashier().name, { reprint }).then((r) =>
      setPrinting((p) => (p?.number === paid.number ? { number: paid.number, state: r === 'printed' ? 'printed' : 'failed' } : p)));
  }, []);
  /** A paid order changed afterwards (SCRUM-242): the difference, with its slip and the drawer. */
  const settle = useCallback((tender: Tender, tendered: number) => {
    // No kitchen screen: items added after paying go out with their money, never held for Send.
    const done = reg.settle(tender, tendered, !kitchenOn);
    if (done && canPrint()) void printChangedBill(done.paid, currentCashier().name);
  }, [reg, kitchenOn]);
  const pay = useCallback((tender: Tender, tendered: number, customerId?: string, unlinked?: boolean) => {
    // Made and waiting: whoever pays for it is taking it (SCRUM-240). No kitchen screen: nothing to
    // wait for, so it goes with the payment and is handed over at once.
    const paid = reg.pay(tender, tendered, customerId, unlinked, !kitchenOn || kitchenWord(reg.order, tickets) === 'Ready', !kitchenOn);
    // A delivery app's order: the app gives the customer its receipt, and nothing goes in the drawer.
    if (paid && !isPlatformId(tender)) print(paid);
  }, [reg, print, tickets, kitchenOn]);
  const total = orderTotal(reg.order);
  const hasNew = unsentLines(reg.order).length > 0;
  /** Something to pay on screen: Pay works at any step, sent or not (SCRUM-239). */
  const canCharge = !reg.paid && reg.order.lines.length > 0;
  /** Every order still going, on the left (SCRUM-239); minutes for food waiting to be collected (SCRUM-240). */
  const now = useNow(30_000);
  // A paid order on screen: what changed after paying (SCRUM-253), from the log and the screen.
  const paidEditList = useMemo(() => (reg.paid ? paidEdits(readAll(), reg.paid) : []), [reg.paid]);
  const rows = railRows(reg.order, reg.paid, reg.open, reg.paidToday, tickets, now);
  // The bill flies from the right panel to its row on the left as it leaves the panel (SCRUM-246).
  useFlyToRail(reg.paid?.number ?? reg.order.number, Boolean(reg.paid) || reg.order.lines.length > 0);

  // ---------- manager mode ----------
  const [selected, setSelected] = useState(0);
  const [pendingVoid, setPendingVoid] = useState<string | null>(null);
  const [adjusting, setAdjusting] = useState<string | null>(null);
  const [palette, setPalette] = useState(false);
  const [sound, setSound] = useState(soundOn);
  /** The last waste or money out, for its Undo (toast and Ctrl+Z) while the toast shows. */
  const [noted, setNoted] = useState<{ id: number; message: string; undo: () => void } | null>(null);
  useEffect(() => {
    if (!noted) return;
    const t = setTimeout(() => setNoted(null), 6000);
    return () => clearTimeout(t);
  }, [noted]);
  const undoNoted = useCallback(() => { noted?.undo(); setNoted(null); }, [noted]);
  const fleet = useFleet();
  const { endManagerSession } = reg;
  const mode = useManagerMode(useCallback(() => {
    // However manager mode ends (Esc, Exit, 10 s idle), nothing of it stays open.
    setPalette(false);
    setPendingVoid(null);
    setAdjusting(null);
    setSheet((s) => (s?.kind === 'edit' || s?.kind === 'waste' || s?.kind === 'money' ? null : s));
    setNoted(null);
    endManagerSession();
  }, [endManagerSession]));
  const manager = mode.manager;

  // Another bill on screen: its last line selected, nothing half-done.
  const lines = (reg.paid ?? reg.order).lines;
  useEffect(() => {
    setSelected(Math.max(0, lines.length - 1));
    setPendingVoid(null);
    setAdjusting(null);
  }, [reg.order.number, reg.paid?.paidAt]); // eslint-disable-line react-hooks/exhaustive-deps
  // A line added: the selection follows it, so +, − and VOID act on what was just tapped.
  const [seenLines, setSeenLines] = useState(lines.length);
  if (seenLines !== lines.length) {
    if (lines.length > seenLines) setSelected(lines.length - 1);
    setSeenLines(lines.length);
  }

  const listing = lines.length === 0;
  const selectedLine: OrderLine | undefined = lines[Math.min(selected, lines.length - 1)];

  const manage = useCallback((change: ManagerChange) => {
    if (!manager) return;
    // A sent line the kitchen already made: what it used stays used (waste), whoever changes it.
    const made = (change.kind === 'edit' || change.kind === 'void')
      && Boolean(reg.order.lines.find((l) => l.id === change.lineId)?.sent)
      && lineCookState(tickets, change.lineId) !== 'waiting';
    reg.manage(manager, made ? { ...change, made } : change);
    setPendingVoid(null);
    setAdjusting(null);
  }, [manager, reg, tickets]);

  const askVoid = useCallback((line: OrderLine) => {
    setAdjusting(null);
    // Not sent yet: nothing for the kitchen to know, so it goes at once. Sent: a reason first (owner rule).
    if (line.sent) setPendingVoid(line.id); else manage({ kind: 'void', lineId: line.id });
  }, [manage]);

  const askAdjust = useCallback((line: OrderLine) => { setPendingVoid(null); setAdjusting(line.id); }, []);
  const toggleChip = useCallback((key: string) => {
    const chip = DISCOUNT_CHIPS.find((c) => c.key === key);
    if (!chip || listing) return;
    const on = JSON.stringify(reg.order.adjust?.discount ?? null) === JSON.stringify(chip.discount);
    manage({ kind: 'discount', discount: on ? null : chip.discount });
  }, [listing, manage, reg.order.adjust]);

  // Keep the selection on a real row as lines are voided or restored.
  useEffect(() => {
    if (selected > Math.max(0, lines.length - 1)) setSelected(Math.max(0, lines.length - 1));
  }, [lines.length, selected]);

  /**
   * VOID ITEM (F4, Delete, a row's ✕): a line not yet sent comes off at once, with Undo (a combo's
   * box comes off whole). A sent line is a manager's: the PIN first, then the reason, audited.
   * On a paid order a sent line comes off as Remove in its sheet does (no PIN, `afterPay`), and the
   * money side then shows Give back: staff from the old POS reach for VOID / ✕ / Delete first.
   */
  const voidLine = useCallback((line: OrderLine | undefined) => {
    if (!line) return;
    if (reg.paid && line.sent) { reg.changeSent({ kind: 'void', lineId: line.id }, lineCookState(tickets, line.id) !== 'waiting'); return; }
    const sent = line.box ? reg.order.lines.some((l) => l.box?.id === line.box!.id && l.sent) : Boolean(line.sent);
    if (sent) {
      if (manager) askVoid(line);
      else { setTyped(null); setSheet({ kind: 'pin', voidLine: line.id }); }
      return;
    }
    if (manager) { askVoid(line); return; }
    if (line.box) reg.dropBox(line.box.id, `Removed ${line.box.name}`);
    else reg.dropLine(line.id, `Removed ${lineItemName(line)}`);
  }, [reg, manager, askVoid, tickets]);

  const stepLine = useCallback((line: OrderLine, by: 1 | -1) => {
    if (line.sent || line.box) return;
    const qty = line.qty + by;
    if (qty < 1) reg.dropLine(line.id, `Removed ${lineItemName(line)}`);
    else reg.editLine({ ...line, qty }, `${qty} × ${lineItemName(line)}`);
  }, [reg]);

  // ---------- the bar's actions (always there; greyed when they cannot be done) ----------
  const due = reg.paid ? balanceDue(reg.paid) : 0;
  const comped = reg.order.adjust?.discount?.kind === 'comp';
  const lastSale: PaidOrder | undefined = reg.paid ?? reg.paidToday[0];
  const anySent = reg.order.lines.some((l) => l.sent);
  const payAction: BarAction = reg.paid
    ? due > 0 ? { id: 'pay', text: `Pay ${fmt(due)} more`, run: () => setSheet({ kind: 'pay' }), disabled: false }
      : due < 0 ? { id: 'pay', text: `Give back ${fmt(-due)}`, run: () => settle('cash', 0), disabled: false }
        : { id: 'pay', run: () => {}, disabled: true }
    : comped ? { id: 'pay', text: 'Close · Free', run: () => pay('comp', 0), disabled: listing }
      : reg.order.platform
        ? { id: 'pay', text: `Close · ${PLATFORMS.find((p) => p.id === reg.order.platform!.id)?.name ?? 'app'}`, run: () => pay(reg.order.platform!.id, total), disabled: listing }
        : { id: 'pay', run: () => setSheet({ kind: 'pay' }), disabled: !canCharge || total <= 0 };
  const barActions: BarAction[] = [
    payAction,
    ...(kitchenOn ? [{ id: 'send' as const, run: reg.send, disabled: !(reg.paid ? reg.paid.held : hasNew) }] : []),
    // VOID ITEM takes the selected item off, a paid bill's too (the money side then shows Give back);
    // a tap on the row still opens it to be changed (SCRUM-251).
    { id: 'void', run: () => voidLine(selectedLine), disabled: !selectedLine },
    { id: 'clear', run: reg.clear, disabled: Boolean(reg.paid) || listing || anySent },
    { id: 'new', run: reg.startNew, disabled: !reg.paid && listing },
    { id: 'print', run: () => { if (lastSale) print(lastSale, true); }, disabled: !canPrint() || !lastSale },
  ];
  /** F2 … F8: the bar's keys, doing exactly what its buttons do. */
  const fkey = (key: string): BarAction | undefined =>
    barActions.find((a) => ({ F2: 'pay', F3: 'send', F4: 'void', F5: 'clear', F6: 'new', F8: 'print' } as Record<string, string>)[key] === a.id);

  // ---------- keys ----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();

      // The bar's keys. F5 never reloads the page here, even under a sheet.
      if (/^F[2-8]$/.test(e.key) && !e.altKey && !mod) {
        e.preventDefault();
        if (sheet || palette || adjusting || pendingVoid) return;
        const a = fkey(e.key);
        if (a && !a.disabled) { setTyped(null); a.run(); }
        return;
      }

      if (manager) {
        // Esc leaves manager mode from ANY state: palette, sheet, half-done void or adjustment.
        if (e.key === 'Escape') { e.preventDefault(); mode.exit(); return; }
        if (mod && key === 'm') { e.preventDefault(); mode.exit(); return; }
        if (mod && key === 'z') { e.preventDefault(); if (noted) undoNoted(); else reg.undoManager(manager); return; }
        if (mod && key === 'k') { e.preventDefault(); setPalette(true); return; }
        if (palette || sheet || adjusting) return; // they own their keys (Enter, typing)
        if (pendingVoid) {
          const i = Number(e.key) - 1;
          if (VOID_REASONS[i] && !isTypingTarget(e.target)) { e.preventDefault(); manage({ kind: 'void', lineId: pendingVoid, reason: VOID_REASONS[i] }); }
          return;
        }
        if (isTypingTarget(e.target) || mod || e.altKey) return;
        const count = lines.length;
        if (e.key === 'ArrowDown') { e.preventDefault(); setSelected((s) => Math.min(s + 1, Math.max(0, count - 1))); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); setSelected((s) => Math.max(s - 1, 0)); return; }
        if (e.key === 'Enter') {
          e.preventDefault();
          if (selectedLine) setSheet({ kind: 'edit', line: selectedLine });
          return;
        }
        if ((e.key === 'Delete' || e.key === 'Backspace') && selectedLine && !listing) { e.preventDefault(); askVoid(selectedLine); return; }
        if (key === 'p' && selectedLine && !listing) { e.preventDefault(); askAdjust(selectedLine); return; }
        if (key === 'w') { e.preventDefault(); setSheet({ kind: 'waste' }); return; }
        if (/^[1-4]$/.test(e.key)) { e.preventDefault(); toggleChip(e.key); }
        return;
      }

      // Cashier mode.
      if (mod && key === 'm' && !sheet) { e.preventDefault(); setTyped(null); setSheet({ kind: 'pin' }); return; }
      if (mod && key === 'z') { e.preventDefault(); if (noted) undoNoted(); else reg.undo(); return; }
      // The dark one of the two buttons: Send while there is something new (or a paid order not sent), else Pay.
      if (mod && e.key === 'Enter' && !sheet) {
        e.preventDefault();
        if (reg.paid) {
          // changed after paying (SCRUM-242): the difference first
          if (due > 0) setSheet({ kind: 'pay' }); else if (due < 0) settle('cash', 0);
          else if (reg.paid.held) reg.send(); else if (kitchenWord(reg.paid, tickets) === 'Ready') reg.give();
        }
        else if (hasNew && kitchenOn) reg.send(); else if (!payAction.disabled) payAction.run();
        return;
      }
      // Alt+1 … Alt+9: the menu's tabs in their order (digits alone start typing an order).
      if (e.altKey && !mod && /^[1-9]$/.test(e.key) && !sheet) {
        const id = menuTabs()[Number(e.key) - 1];
        if (id) { e.preventDefault(); setCategory(id); }
        return;
      }
      if (sheet || typed !== null || custTyping !== null || mod || e.altKey || isTypingTarget(e.target)) return;
      // + New order: the one on screen waits on the list with its number.
      if (e.key === 'Escape' && (reg.order.lines.length > 0 || reg.paid)) { reg.startNew(); return; }
      // The selected line: arrows move it, + and − change how many, Delete voids it.
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setSelected((x) => (e.key === 'ArrowDown' ? Math.min(x + 1, Math.max(0, lines.length - 1)) : Math.max(x - 1, 0)));
        return;
      }
      if ((e.key === '+' || e.key === '-') && selectedLine) { e.preventDefault(); stepLine(selectedLine, e.key === '+' ? 1 : -1); return; }
      if (e.key === 'Delete' && selectedLine) { e.preventDefault(); voidLine(selectedLine); return; }
      // A mobile starts 0 (an order never does): typing one puts a customer on the order.
      if (crmOn && e.key === '0') { e.preventDefault(); setCustTyping(e.key); return; }
      if (e.key.length === 1 && /[a-z0-9]/i.test(e.key)) { e.preventDefault(); setTyped(e.key); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [reg, settle, sheet, typed, custTyping, crmOn, hasNew, manager, mode, palette, adjusting, pendingVoid, lines.length,
    selectedLine, askVoid, askAdjust, toggleChip, manage, noted, undoNoted, tickets, due, kitchenOn, payAction, fkey, stepLine, voidLine]);

  // Paying, and the order has nothing left on it (an Undo took the last line): back to the order.
  const paying = sheet?.kind === 'pay';
  const inExtras = sheet?.kind === 'extras' || sheet?.kind === 'edit';

  // ---------- the customer on the order (CRM) ----------
  const customer = reg.order.customer;
  // Visits come from the event log: worked out when the customer step opens and after each sale.
  const visits = useMemo(
    () => (crmOn ? visitsFromEvents(readAll()) : new Map<string, unknown[]>()),
    [crmOn, custTyping !== null, customer?.id, reg.paidToday.length], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const usual = useMemo(() => {
    if (!crmOn || !customer || reg.order.lines.length || reg.order.sentAt !== undefined) return null;
    return usualOrder(customerOrders(readAll(), customer.id), (id) => menuItems().find((m) => m.id === id));
  }, [crmOn, customer, reg.order.lines.length, reg.order.sentAt]);
  // Another order on screen: the half-typed number was for the last one.
  useEffect(() => { setCustTyping(null); }, [reg.order.number]);
  const customerBar = crmOn && !reg.paid ? (
    <CustomerBar
      customer={customer}
      typing={custTyping}
      onTyping={setCustTyping}
      onAttach={(c) => reg.setCustomer({ id: c.id, name: c.name })}
      onRemove={() => reg.setCustomer(null)}
      visits={(id) => visits.get(id)?.length ?? 0}
      usual={usual}
      onUsual={() => { if (usual) reg.addSpecs(usual.lines, usual.kind === 'usual' ? 'Added the usual' : 'Added the same as last time'); }}
      describeUsual={(u) => orderSummary(u.lines)}
    />
  ) : null;
  useEffect(() => { if (paying && listing) setSheet(null); }, [paying, listing]);

  const quickAdd = (item: MenuItem, size?: SizeId) => {
    // The menu stays live while paying or in extras: the customer remembered a drink, so it goes on and the order is back.
    if (paying || inExtras) setSheet(null);
    const label = item.variants?.find((v) => v.id === size)?.label;
    reg.addSpec(bareLine(item.id, size), `Added ${item.name.en}${label ? ` · ${label}` : ''}`);
  };

  /** One tap on a combo: the whole box with its usual picks, ready to send (SCRUM-231). */
  const addCombo = (comboId: string) => {
    const combo = comboById(comboId);
    const specs = combo && boxLines(comboId, combo, menuItems());
    if (paying || inExtras) setSheet(null);
    if (combo && specs) reg.addSpecs(specs, `Added ${combo.name.en}`);
  };

  /** An item's extras, in the order panel (no pop-up): adding from the menu, or changing a line. */
  const extrasPanel = (() => {
    if (sheet?.kind === 'extras') {
      return (
        <ExtrasPanel
          key={`add-${sheet.item.id}`}
          item={sheet.item}
          size={sheet.size}
          onClose={closeSheet}
          onSubmit={(spec) => { reg.addSpec(spec, `Added ${describe(spec)}`); closeSheet(); }}
        />
      );
    }
    if (sheet?.kind !== 'edit') return null;
    const line = sheet.line;
    const key = `edit-${line.id}`;
    const common = { item: itemById(line.itemId), line, combo: line.box && comboById(line.box.comboId), onClose: closeSheet };
    if (manager) {
      // Manager edit: through `manage`, so it is audited. A sent line needs a reason.
      return (
        <ExtrasPanel
          key={key}
          {...common}
          manager={Boolean(line.sent)}
          onSubmit={(spec, reason) => { manage({ kind: 'edit', lineId: line.id, after: spec, reason }); closeSheet(); }}
          onRemove={(reason) => { manage({ kind: 'void', lineId: line.id, reason }); closeSheet(); }}
        />
      );
    }
    if (line.sent) {
      // The customer changed their mind: the cashier changes the sent line, no PIN, no reason asked.
      // Two ways (SCRUM-242): the kitchen changes the same ticket (nothing wasted), or throws the old
      // one away and makes the new one on a new ticket (the old one is waste).
      const cook = lineCookState(tickets, line.id);
      return (
        <ExtrasPanel
          key={key}
          {...common}
          cook={cook}
          onSubmit={(spec, _reason, remake) => {
            reg.changeSent({ kind: 'edit', lineId: line.id, after: spec, ...(remake ? { remake } : {}) }, remake);
            closeSheet();
          }}
          // Taking a sent line off is VOID's: a manager's PIN first, then the reason. A paid order
          // changed afterwards (SCRUM-242) settles the difference instead, as before.
          onRemove={() => {
            closeSheet();
            if (reg.paid) reg.changeSent({ kind: 'void', lineId: line.id }, cook !== 'waiting'); else voidLine(line);
          }}
        />
      );
    }
    return (
      <ExtrasPanel
        key={key}
        {...common}
        onSubmit={(spec) => { reg.editLine({ ...spec, id: line.id }, 'Updated'); closeSheet(); }}
        onRemove={() => {
          const box = line.box;
          if (box) reg.dropBox(box.id, `Removed ${box.name}`); else reg.dropLine(line.id, 'Removed');
          closeSheet();
        }}
      />
    );
  })();

  const managePanel: ManagePanel | null = manager && {
    actor: manager, pendingVoid, adjusting,
    onEditLine: (line) => setSheet({ kind: 'edit', line }),
    onAskVoid: askVoid,
    onVoid: (lineId, reason) => manage({ kind: 'void', lineId, reason }),
    onAskAdjust: askAdjust,
    onAdjust: (lineId, cents) => manage({ kind: 'adjustLine', lineId, cents }),
    onDiscount: (discount) => manage({ kind: 'discount', discount }),
  };

  const commands = useMemo<Command[]>(() => {
    if (!manager) return [];
    const list: Command[] = [];
    if (!listing) {
      DISCOUNT_CHIPS.forEach((c) => list.push({
        id: `chip-${c.key}`, label: c.discount.kind === 'comp' ? 'Free (comp the whole order)' : `${c.label} off the order`,
        hint: c.key, run: () => manage({ kind: 'discount', discount: c.discount }),
      }));
      if (reg.order.adjust?.discount) list.push({ id: 'no-discount', label: 'Remove order discount', run: () => manage({ kind: 'discount', discount: null }) });
      if (selectedLine) {
        const name = lineItemName(selectedLine);
        list.push(
          { id: 'edit', label: `Edit ${name}`, hint: 'Enter', run: () => setSheet({ kind: 'edit', line: selectedLine }) },
          { id: 'adjust', label: `Adjust price of ${name}`, hint: 'P', run: () => askAdjust(selectedLine) },
          { id: 'void', label: `Void ${name}`, hint: 'Del', run: () => askVoid(selectedLine) },
        );
      }
    }
    list.push(
      // The kitchen comes back once the staff are at home with the counter (kitchenScreen.ts).
      {
        id: 'kitchen-screen', label: kitchenOn ? 'Kitchen screen: hide it' : 'Kitchen screen: show it (Send to kitchen, Kitchen key)',
        run: () => { setKitchenScreen(!kitchenOn); setKitchenOn(!kitchenOn); },
      },
      { id: 'owner', label: 'Today: what needs attention', run: () => { location.hash = '#owner'; } },
      // The developer's laptop only (its server holds the admin password).
      ...(fleet ? [{ id: 'shops', label: "Shops: every shop's sales (developer)", run: () => { location.hash = '#shops'; } }] : []),
      { id: 'menu', label: 'Menu (finished items): prices, names, sold out', run: () => { location.hash = '#items/finished'; } },
      // This screen's look; the current choice says "On".
      ...(['light', 'dark', 'auto'] as ThemeChoice[]).map((t) => ({
        id: `theme-${t}`, label: THEME_LABEL[t], hint: themeChoice() === t ? 'On' : undefined, run: () => setTheme(t),
      })),
      { id: 'setup', label: "Settings: staff, printer, devices, stock rules (owner's PIN)", run: () => { location.hash = '#setup'; } },
      { id: 'cameras', label: 'Computer vision: cameras and tables', run: () => { location.hash = '#vision'; } },
      { id: 'undo', label: 'Undo last change', hint: 'Ctrl+Z', run: () => reg.undoManager(manager) },
      { id: 'sound', label: sound ? 'Turn sound off' : 'Turn sound on', run: () => { setSoundOn(!sound); setSound(!sound); } },
      { id: 'leave', label: 'Leave manager mode', hint: 'Esc', run: mode.exit },
    );
    list.push({ id: 'waste', label: 'Waste: something was thrown away', hint: 'W', run: () => setSheet({ kind: 'waste' }) });
    list.push({ id: 'money', label: 'Money out: a bill paid, or cash from the drawer', hint: 'F6', run: () => setSheet({ kind: 'money' }) });
    list.push({ id: 'money-page', label: 'Money out this month', run: () => { location.hash = '#money'; } });
    if (canManageStock) {
      list.push({ id: 'receive', label: 'Receive: a delivery came', hint: 'F7', run: () => setSheet({ kind: 'receive' }) });
      list.push({ id: 'order', label: 'Order: what to buy', run: () => { location.hash = '#order'; } });
      list.push({ id: 'count', label: 'Count the shelves', run: () => { location.hash = '#count'; } });
      list.push({ id: 'inventory', label: 'Items: raw materials and stock', run: () => { location.hash = '#items'; } });
      list.push({ id: 'suppliers', label: 'Suppliers', run: () => { location.hash = '#suppliers'; } });
    }
    return list;
  }, [manager, listing, reg, selectedLine, sound, canManageStock, manage, askAdjust, askVoid, mode.exit, fleet, kitchenOn]);

  return (
    <div className={`register${manager ? ' register--managing' : ''}${paying ? ' register--paying' : ''}${inExtras ? ' register--extras' : ''}`}>
      {/* Hold Alt: every key shows (SCRUM-245); these are the ones with no button of their own. */}
      <KeyHints legend={manager ? MANAGER_KEYS : paying ? PAYING_KEYS : CASHIER_KEYS} />
      <header className="register__head">
        {/* Every place the counter uses in a day, by name, in one bar: nothing behind a menu. */}
        <nav className="tabs" aria-label="Places">
          <span className="tab tab--on" aria-current="page">Register</span>
          {!manager && kitchenOn && onKitchen && <KitchenChip tickets={tickets} onOpen={onKitchen} />}
          {!manager && onTables && <Suspense fallback={null}><TablesChip onOpen={onTables} /></Suspense>}
          {/* The owner and managers see their own screen. */}
          {!manager && onOwner && <button type="button" className="corner__key" onClick={onOwner}>Today <kbd>F10</kbd></button>}
          {!manager && <button type="button" className="corner__key" onClick={() => setSheet({ kind: 'money' })}>Money out</button>}
          {!manager && <button type="button" className="corner__key" onClick={() => setSheet({ kind: 'receive' })}>Receive</button>}
          {!manager && PLATFORMS.map((p) => (
            <button key={p.id} type="button" className="corner__key" disabled={reg.order.sentAt !== undefined || Boolean(reg.paid)}
              onClick={() => setSheet({ kind: 'platform', platform: p })}>{p.name}</button>
          ))}
        </nav>
        {manager ? (
          <span className="corner corner--managing" role="status">
            <span className="corner__who">Managing · {manager.name}</span>
            {/* Whoever is signed in, manager mode is a manager's PIN: the waste is theirs. */}
            <button type="button" className="corner__key corner__bin" onClick={() => setSheet({ kind: 'waste' })}>
              <BinIcon /> Waste <kbd>W</kbd>
            </button>
            <button type="button" className="corner__key" onClick={() => setSheet({ kind: 'money' })}>Money out</button>
            <button type="button" className="corner__key" onClick={() => setPalette(true)}>Commands <kbd>Ctrl K</kbd></button>
            <button type="button" className="corner__key" onClick={mode.exit}>Done <kbd>Esc</kbd></button>
          </span>
        ) : (
          <span className="corner">
            <OnlineChip state={online} looking={sheet?.kind === 'online'} onOpen={() => setSheet({ kind: 'online' })} />
            <SyncSign />
            {onVoice && (
              <button type="button" className="corner__key" aria-label="Hold and say which page to open"
                onPointerDown={(e) => { e.preventDefault(); onVoice.start(); }} onPointerUp={onVoice.stop} onPointerLeave={onVoice.stop}>
                <MicIcon /> Voice <kbd>F9</kbd>
              </button>
            )}
            <button type="button" className="corner__key" onClick={() => setSheet({ kind: 'pin' })}>Manager <kbd>Ctrl M</kbd></button>
            {onSwitch
              ? (
                <button type="button" className="corner__key" onClick={onSwitch} aria-label={`${currentCashier().name}: switch user`}>
                  {currentCashier().name} · Switch user
                </button>
              )
              : <span className="cashier">{currentCashier().name}</span>}
          </span>
        )}
      </header>

      <div className="register__body">
        <BillHistory
          // A held bill opened on the right stays on the list, marked; only a new bill not yet held is left off.
          held={rows.filter((r) => reg.paid || reg.onList || r.order.number !== reg.order.number)}
          paidToday={seesTakings(currentCashier().role) || !onSwitch ? reg.paidToday : []}
          tickets={tickets}
          kitchenOn={kitchenOn}
          current={{ number: (reg.paid ?? reg.order).number, paidAt: reg.paid?.paidAt }}
          onOpen={reg.openOrder}
        />
        <main className="menu" data-keyarea>
          {manager ? null : typed !== null ? (
            <ShorthandBar
              initial={typed}
              onClose={() => setTyped(null)}
              onOrderNumber={(n, open) => {
                // Any of today's bills, paid or not (SCRUM-247): the customer who comes back says their number.
                const known = (reg.paid ?? reg.order).number === n || reg.open.some((o) => o.number === n) || reg.paidToday.some((o) => o.number === n);
                if (known && open) reg.openOrder(n);
                return known;
              }}
              onSubmit={(specs) =>
                reg.addSpecs(specs, specs.length === 1 ? `Added ${describe(specs[0])}` : `Added ${specs.length} items`)}
            />
          ) : (
            // Always in sight; any letter or digit typed anywhere starts it too.
            <div className="typebar">
              <div className="typebar__field">
                <input readOnly value="" placeholder={label('typeOrSearch')} aria-label={label('typeOrSearch')}
                  onFocus={() => setTyped('')} onPointerDown={() => setTyped('')} />
              </div>
            </div>
          )}
          <Menu
            category={category}
            onCategory={setCategory}
            onQuickAdd={quickAdd}
            onCustomise={(item) => setSheet({ kind: 'extras', item })}
            onAddCombo={addCombo}
          />
        </main>

        <OrderPanel
          edits={paidEditList}
          order={reg.order}
          tickets={tickets}
          paid={reg.paid}
          justPaid={reg.justPaid}
          onGive={() => reg.give()}
          now={now}
          manage={managePanel}
          selected={selected}
          onSelect={(i) => { setSelected(i); setPendingVoid(null); setAdjusting(null); }}
          onEdit={(line) => setSheet({ kind: 'edit', line })}
          onStep={stepLine}
          onRemove={voidLine}
          onClearPlatform={() => reg.setPlatform(null)}
          onUndo={reg.undo}
          onGiveBack={(how) => settle(how, 0)}
          onOrderType={reg.setOrderType}
          onDeliveryFee={reg.setDeliveryFee}
          printState={canPrint() && reg.paid && printing?.number === reg.paid.number ? printing.state : null}
          onReprint={canPrint() ? () => { if (reg.paid) print(reg.paid, true); } : undefined}
          customerBar={customerBar}
          paying={paying ? {
            onPay: (tender, tendered, customerId, unlinked) => {
              if (reg.paid) settle(tender, tendered); else pay(tender, tendered, customerId, unlinked);
              closeSheet();
            },
            onPayPart: (tender, tendered, pick, customerId, unlinked) => {
              const r = reg.payPart(tender, tendered, pick, customerId, unlinked, !kitchenOn || kitchenWord(reg.order, tickets) === 'Ready', !kitchenOn);
              if (r?.kind === 'paid') { print(r.paid); closeSheet(); return; }
              if (r && canPrint()) {
                const lines = reg.order.lines.filter((l) => r.units[l.id]).map((l) => `${r.units[l.id]} x ${lineItemName(l)}`);
                void printPartSlip({ number: r.number, amount: r.amount, tender: r.tender, tendered: r.tendered, left: r.left, lines }, currentCashier().name);
              }
            },
            onClose: closeSheet,
            customers: crmOn,
          } : null}
          extras={extrasPanel}
        />
      </div>

      <ActionBar actions={barActions} />

      {sheet?.kind === 'platform' && (
        <PlatformSheet platform={sheet.platform} onClose={closeSheet} onMark={(m) => { reg.setPlatform(m); closeSheet(); }} />
      )}
      {sheet?.kind === 'online' && <OnlineSheet state={online} onAccept={acceptOnline} onOut={outOnline} onClose={closeSheet} />}
      {sheet?.kind === 'pin' && (
        <PinSheet
          onClose={closeSheet}
          reason={sheet.voidLine ? 'To void an item already sent to the kitchen' : undefined}
          onUnlock={(actor) => {
            const lineId = sheet.voidLine;
            closeSheet();
            mode.enter(actor);
            // Asked by VOID: straight on to that line's reasons.
            if (lineId) { const i = reg.order.lines.findIndex((l) => l.id === lineId); if (i >= 0) setSelected(i); setPendingVoid(lineId); }
          }}
        />
      )}
      {sheet?.kind === 'waste' && manager && (
        <WasteSheet
          actor={manager}
          onClose={closeSheet}
          onWasted={(message, undo) => { closeSheet(); setNoted({ id: Date.now(), message, undo }); }}
        />
      )}
      {sheet?.kind === 'money' && (
        <MoneyOutSheet
          actor={manager ?? currentCashier()}
          full={Boolean(manager) || canManage(currentCashier())}
          onClose={closeSheet}
          onDone={(message, undo) => { closeSheet(); setNoted({ id: Date.now(), message, undo }); }}
        />
      )}
      {sheet?.kind === 'receive' && (
        <ReceiveSheet
          manages={Boolean(manager) || canManage(currentCashier())}
          onClose={closeSheet}
          // The sheet says what happened on its own Done step (with Undo there); no toast under it.
          onDone={() => {}}
        />
      )}
      {palette && manager && <CommandPalette commands={commands} onClose={() => setPalette(false)} />}

      {/* Hidden under an open sheet, like the toasts: it never covers the sheet, the order or the primary action. */}
      {onTables && !sheet && !palette && <Suspense fallback={null}><CleaningNote /></Suspense>}
      {/* Hidden under an open sheet: it would cover the sheet's buttons (e.g. Card). */}
      {noted && !sheet && !palette && (
        <div className="toast" role="status" key={`waste-${noted.id}`}>
          <span>{noted.message}</span>
          <button type="button" onClick={undoNoted}>Undo</button>
        </div>
      )}
      {reg.toast && !noted && !sheet && !palette && (
        <div className="toast" role="status" key={reg.toast.id}>
          <span>{reg.toast.message}</span>
          {reg.toast.manager
            ? manager && <button type="button" onClick={() => reg.undoManager(manager)}>Undo</button>
            : reg.canUndo && <button type="button" onClick={reg.undo}>Undo</button>}
        </div>
      )}
    </div>
  );
}
