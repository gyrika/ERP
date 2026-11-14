import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type MouseEvent } from 'react';
import { canManage, seesTakings } from '../domain/auth.ts';
import { DISCOUNT_CHIPS, type ManagerChange } from '../domain/manager.ts';
import { comboById, itemById, menuItems } from '../domain/menu.ts';
import { boxLines } from '../domain/combos.ts';
import { lineCookState } from '../domain/kitchen.ts';
import { bareLine, orderTotal, unsentLines } from '../domain/order.ts';
import type { MenuItem, OrderLine, PaidOrder, SizeId, Tender } from '../domain/types.ts';
import { currentCashier } from '../services/auth.ts';
import { canPrint, printDeliveryBill, printReceipt } from '../services/printer.ts';
import { deliveryBill } from '../domain/receipt.ts';
import { lineGross } from '../domain/totals.ts';
import { CommandPalette, type Command } from './CommandPalette.tsx';
import { MoneyOutSheet } from './MoneyOutSheet.tsx';
import { ReceiveSheet } from './WorkViews.tsx';
import { ExtrasSheet } from './ExtrasSheet.tsx';
import { KitchenChip } from './KitchenChip.tsx';
import { OnlineChip, OnlineSheet, useOnline } from './Online.tsx';
import { onlineOrders } from '../services/onlineClient.ts';
import type { OnlineOrder } from '../domain/online.ts';
import { Menu, menuTabs, type CategoryId } from './Menu.tsx';
import { OrderPanel, VOID_REASONS, type ManagePanel } from './OrderPanel.tsx';
import { crmReachable } from '../services/crmClient.ts';
import { modulesHere } from './eventLog.ts';
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
import { THEME_LABEL, setTheme, themeChoice, type ThemeChoice } from './theme.ts';
import { useFleet } from './ShopsView.tsx';
import { lineItemName } from '../domain/halves.ts';
import { isPlatformId, PLATFORMS, type Platform } from '../domain/platforms.ts';
import { PlatformSheet } from './PlatformSheet.tsx';

type Sheet =
  | { kind: 'extras'; item: MenuItem; size?: SizeId }
  | { kind: 'edit'; line: OrderLine }
  | { kind: 'pay' }
  | { kind: 'pin' }
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
  /** Opens the Owner view (owners and managers; F3 does the same). */
  onOwner?: () => void;
  onSwitch?: () => void;
  canManageStock?: boolean;
  /** Hold to say which page to open (SCRUM-145; F9 does the same). */
  onVoice?: { start: () => void; stop: () => void };
} = {}) {
  const reg = useRegister();
  useMenu();
  const tickets = useKitchenTickets(); // live, so Cooking turns Done the moment the kitchen taps it
  const online = useOnline();
  /** Tells the customer first (with the number this order will get), then sends it to the kitchen. */
  const acceptOnline = useCallback(async (o: OnlineOrder, minutes: number): Promise<string | null> => {
    const readyBy = Date.now() + minutes * 60_000;
    const why = await onlineOrders.answer(o.id, { status: 'accepted', orderNumber: reg.nextNumber, readyBy });
    if (!why) reg.acceptOnline(o.lines, readyBy, o.kind === 'delivery' ? { fee: o.deliveryFee } : undefined);
    return why;
  }, [reg]);
  /**
   * The rider leaves with a delivery: the customer's page says "On the way", and the bill for the
   * bag prints with the Register's own lines and total (a manager may have changed them since).
   */
  const outOnline = useCallback(async (o: OnlineOrder): Promise<string | null> => {
    const why = await onlineOrders.answer(o.id, { status: 'out' });
    const order = [reg.order, ...reg.open].find((x) => x.number === o.orderNumber);
    if (!why && order && canPrint()) {
      void printDeliveryBill(deliveryBill({ ...o, lines: order.lines, total: orderTotal(order) }, order.lines.map(lineGross), { at: Date.now() }));
    }
    return why;
  }, [reg]);
  const [category, setCategory] = useState<CategoryId>('popular');
  const [sheet, setSheet] = useState<Sheet>(null);
  const [typed, setTyped] = useState<string | null>(null); // non-null = shorthand bar open
  const closeSheet = useCallback(() => setSheet(null), []);
  /** The receipt of the sale on screen: printed by itself at payment, with the drawer for cash. */
  const [printing, setPrinting] = useState<{ number: number; state: 'printing' | 'printed' | 'failed' } | null>(null);
  const print = useCallback((paid: PaidOrder, reprint = false) => {
    if (!canPrint()) return;
    setPrinting({ number: paid.number, state: 'printing' });
    void printReceipt(paid, currentCashier().name, { reprint }).then((r) =>
      setPrinting((p) => (p?.number === paid.number ? { number: paid.number, state: r === 'printed' ? 'printed' : 'failed' } : p)));
  }, []);
  const pay = useCallback((tender: Tender, tendered: number, customerId?: string, unlinked?: boolean) => {
    const paid = reg.pay(tender, tendered, customerId, unlinked);
    // A delivery app's order: the app gives the customer its receipt, and nothing goes in the drawer.
    if (paid && !isPlatformId(tender)) print(paid);
  }, [reg, print]);
  const total = orderTotal(reg.order);
  const hasNew = unsentLines(reg.order).length > 0;
  /** A waiting order opened from the list, with nothing new on it: Charge, or go back. */
  const canCharge = !hasNew && reg.order.sentAt !== undefined && !reg.paid;

  // ---------- manager mode ----------
  const [selected, setSelected] = useState(0);
  const [pendingVoid, setPendingVoid] = useState<string | null>(null);
  const [adjusting, setAdjusting] = useState<string | null>(null);
  const [palette, setPalette] = useState(false);
  // A small counter screen folds the corner's keys behind one "More" key (CSS shows it only there).
  const [more, setMore] = useState(false);
  useEffect(() => {
    if (!more) return;
    const away = (e: PointerEvent) => { if (!(e.target as Element).closest('.corner')) setMore(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setMore(false); };
    document.addEventListener('pointerdown', away);
    window.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', away); window.removeEventListener('keydown', esc); };
  }, [more]);
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

  // A new order on screen starts with the first line selected and nothing half-done.
  useEffect(() => {
    setSelected(0);
    setPendingVoid(null);
    setAdjusting(null);
  }, [reg.order.number]);

  const lines = reg.order.lines;
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
    const max = (listing ? reg.open.length : lines.length) - 1;
    if (selected > Math.max(0, max)) setSelected(Math.max(0, max));
  }, [listing, lines.length, reg.open.length, selected]);

  // ---------- keys ----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();

      if (e.key === 'F6' && !sheet && !palette) { e.preventDefault(); setTyped(null); setSheet({ kind: 'money' }); return; }
      // A delivery came (SCRUM-226): whoever works the counter receives it and can pay it from the drawer.
      if (e.key === 'F7' && !sheet && !palette) { e.preventDefault(); setTyped(null); setSheet({ kind: 'receive' }); return; }

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
        const count = listing ? reg.open.length : lines.length;
        if (e.key === 'ArrowDown') { e.preventDefault(); setSelected((s) => Math.min(s + 1, Math.max(0, count - 1))); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); setSelected((s) => Math.max(s - 1, 0)); return; }
        if (e.key === 'Enter') {
          e.preventDefault();
          if (listing) { const o = reg.open[selected]; if (o) reg.openOrder(o.number); }
          else if (selectedLine) setSheet({ kind: 'edit', line: selectedLine });
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
      // F8: a delivery app's order (today Uber Eats), keyed in from the app's tablet.
      if (e.key === 'F8' && !sheet && PLATFORMS[0] && reg.order.sentAt === undefined) {
        e.preventDefault(); setTyped(null); setSheet({ kind: 'platform', platform: PLATFORMS[0] }); return;
      }
      if (mod && key === 'z') { e.preventDefault(); if (noted) undoNoted(); else reg.undo(); return; }
      if (mod && e.key === 'Enter' && !sheet && !reg.paid) {
        e.preventDefault();
        if (hasNew) reg.send(); else if (canCharge) setSheet({ kind: 'pay' });
        return;
      }
      // Alt+1 … Alt+9: the menu's tabs in their order (digits alone start typing an order).
      if (e.altKey && !mod && /^[1-9]$/.test(e.key) && !sheet) {
        const id = menuTabs()[Number(e.key) - 1];
        if (id) { e.preventDefault(); setCategory(id); }
        return;
      }
      if (sheet || typed !== null || mod || e.altKey || isTypingTarget(e.target)) return;
      if (e.key === 'Escape' && canCharge) { reg.startNew(); return; }
      if (e.key.length === 1 && /[a-z0-9]/i.test(e.key)) { e.preventDefault(); setTyped(e.key); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [reg, sheet, typed, hasNew, canCharge, manager, mode, palette, adjusting, pendingVoid, listing, lines.length,
    selected, selectedLine, askVoid, askAdjust, toggleChip, manage, noted, undoNoted]);

  // Tapping empty space outside an opened order goes back to the "Waiting to pay" list.
  // Cards, buttons and the order panel itself are not background, so adding a round still works.
  const onBackground = (e: MouseEvent) => {
    if (!canCharge || sheet || typed !== null || palette) return;
    if ((e.target as Element).closest('button, input, a, .card, .panel, .typebar, .toast')) return;
    reg.startNew();
  };

  // Paying, and the order has nothing left on it (an Undo took the last line): back to the order.
  const paying = sheet?.kind === 'pay';
  useEffect(() => { if (paying && listing) setSheet(null); }, [paying, listing]);

  const quickAdd = (item: MenuItem, size?: SizeId) => {
    // The menu stays live while paying: the customer remembered a drink, so it goes on and the order is back.
    if (paying) setSheet(null);
    const label = item.variants?.find((v) => v.id === size)?.label;
    reg.addSpec(bareLine(item.id, size), `Added ${item.name.en}${label ? ` · ${label}` : ''}`);
  };

  /** One tap on a combo: the whole box with its usual picks, ready to send (SCRUM-231). */
  const addCombo = (comboId: string) => {
    const combo = comboById(comboId);
    const specs = combo && boxLines(comboId, combo, menuItems());
    if (paying) setSheet(null);
    if (combo && specs) reg.addSpecs(specs, `Added ${combo.name.en}`);
  };

  const managePanel: ManagePanel | null = manager && {
    actor: manager, selected, pendingVoid, adjusting,
    onSelect: (i) => { setSelected(i); setPendingVoid(null); setAdjusting(null); },
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
    reg.open.forEach((o) => list.push({ id: `open-${o.number}`, label: `Open order ${o.number}`, run: () => reg.openOrder(o.number) }));
    list.push(
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
  }, [manager, listing, reg, selectedLine, sound, canManageStock, manage, askAdjust, askVoid, mode.exit, fleet]);

  return (
    <div className={`register${manager ? ' register--managing' : ''}${paying ? ' register--paying' : ''}`} onClick={onBackground}>
      <header className="register__head">
        <span className="brand">CheesyBeez</span>
        {manager ? (
          <span className="corner corner--managing" role="status">
            <span className="corner__who">Managing · {manager.name}</span>
            {/* Whoever is signed in, manager mode is a manager's PIN: the waste is theirs. */}
            <button type="button" className="corner__key corner__bin" onClick={() => setSheet({ kind: 'waste' })}>
              <BinIcon /> Waste <kbd>W</kbd>
            </button>
            <button type="button" className="corner__key" onClick={() => setPalette(true)}>Commands <kbd>Ctrl K</kbd></button>
            <button type="button" className="corner__key" onClick={mode.exit}>Done <kbd>Esc</kbd></button>
          </span>
        ) : (
          <span className="corner">
            <OnlineChip state={online} looking={sheet?.kind === 'online'} onOpen={() => setSheet({ kind: 'online' })} />
            {onTables && <Suspense fallback={null}><TablesChip onOpen={onTables} /></Suspense>}
            {onKitchen && <KitchenChip tickets={tickets} onOpen={onKitchen} />}
            <SyncSign />
            <span className={`corner__rest${more ? ' corner__rest--open' : ''}`} id="corner-rest" onClick={() => setMore(false)}>
              {PLATFORMS.map((p, i) => (
                <button key={p.id} type="button" className="corner__key" onClick={() => setSheet({ kind: 'platform', platform: p })}>
                  {p.name}{i === 0 && <kbd>F8</kbd>}
                </button>
              ))}
              {onVoice && (
                <button type="button" className="corner__key" aria-label="Hold and say which page to open"
                  onPointerDown={(e) => { e.preventDefault(); onVoice.start(); }} onPointerUp={onVoice.stop} onPointerLeave={onVoice.stop}>
                  <MicIcon /> Voice <kbd>F9</kbd>
                </button>
              )}
              <button type="button" className="corner__key" onClick={() => setSheet({ kind: 'receive' })}>Receive <kbd>F7</kbd></button>
              <button type="button" className="corner__key" onClick={() => setSheet({ kind: 'money' })}>Money out <kbd>F6</kbd></button>
              {/* The owner and managers see their own screen without any shortcut. */}
              {onOwner && <button type="button" className="corner__key" onClick={onOwner}>Owner view <kbd>F3</kbd></button>}
              {onSwitch
                ? (
                  <button type="button" className="corner__key" onClick={onSwitch} aria-label={`${currentCashier().name}: switch user`}>
                    {currentCashier().name} <kbd>F4</kbd>
                  </button>
                )
                : <span className="cashier">{currentCashier().name}</span>}
              <button type="button" className="corner__key" onClick={() => setSheet({ kind: 'pin' })}>Manager <kbd>Ctrl M</kbd></button>
            </span>
            <button type="button" className="corner__more" aria-label="More" aria-expanded={more} aria-controls="corner-rest"
              onClick={() => setMore(!more)}>
              <span aria-hidden="true">•••</span>
            </button>
          </span>
        )}
      </header>

      <div className="register__body">
        <main className="menu">
          {typed !== null && !manager && (
            <ShorthandBar
              initial={typed}
              onClose={() => setTyped(null)}
              onSubmit={(specs) =>
                reg.addSpecs(specs, specs.length === 1 ? `Added ${describe(specs[0])}` : `Added ${specs.length} items`)}
            />
          )}
          <Menu
            category={category}
            onCategory={setCategory}
            onQuickAdd={quickAdd}
            onCustomise={(item) => setSheet({ kind: 'extras', item })}
            onAddCombo={addCombo}
            hint={manager ? '' : 'Start typing to order'}
          />
        </main>

        <OrderPanel
          order={reg.order}
          open={reg.open}
          paidToday={seesTakings(currentCashier().role) || !onSwitch ? reg.paidToday : []}
          tickets={tickets}
          paid={reg.paid}
          manage={managePanel}
          onEdit={(line) => setSheet({ kind: 'edit', line })}
          onSend={reg.send}
          onCharge={() => setSheet({ kind: 'pay' })}
          onCloseFree={() => pay('comp', 0)}
          onClosePlatform={() => { if (reg.order.platform) pay(reg.order.platform.id, total); }}
          onClearPlatform={() => reg.setPlatform(null)}
          printState={canPrint() && reg.paid && printing?.number === reg.paid.number ? printing.state : null}
          onReprint={canPrint() ? () => { if (reg.paid) print(reg.paid, true); } : undefined}
          onOpen={reg.openOrder}
          onNext={reg.startNew}
          onUndo={reg.undo}
          paying={paying ? {
            onPay: (tender, tendered, customerId, unlinked) => { pay(tender, tendered, customerId, unlinked); closeSheet(); },
            onClose: closeSheet,
            customers: modulesHere().crm && crmReachable(),
          } : null}
        />
      </div>

      {sheet?.kind === 'platform' && (
        <PlatformSheet platform={sheet.platform} onClose={closeSheet} onMark={(m) => { reg.setPlatform(m); closeSheet(); }} />
      )}
      {sheet?.kind === 'extras' && (
        <ExtrasSheet
          item={sheet.item}
          size={sheet.size}
          onClose={closeSheet}
          onSubmit={(spec) => { reg.addSpec(spec, `Added ${describe(spec)}`); closeSheet(); }}
        />
      )}
      {sheet?.kind === 'edit' && manager && (
        // Manager edit: through `manage`, so it is audited. A sent line needs a reason.
        <ExtrasSheet
          item={itemById(sheet.line.itemId)}
          line={sheet.line}
          combo={sheet.line.box && comboById(sheet.line.box.comboId)}
          manager={Boolean(sheet.line.sent)}
          onClose={closeSheet}
          onSubmit={(spec, reason) => { manage({ kind: 'edit', lineId: sheet.line.id, after: spec, reason }); closeSheet(); }}
          onRemove={(reason) => { manage({ kind: 'void', lineId: sheet.line.id, reason }); closeSheet(); }}
        />
      )}
      {sheet?.kind === 'edit' && !manager && sheet.line.sent && (() => {
        // The customer changed their mind: the cashier changes the sent line, no PIN, no reason asked.
        const made = lineCookState(tickets, sheet.line.id) !== 'waiting';
        return (
          <ExtrasSheet
            item={itemById(sheet.line.itemId)}
            line={sheet.line}
            combo={sheet.line.box && comboById(sheet.line.box.comboId)}
            made={made}
            onClose={closeSheet}
            onSubmit={(spec) => { reg.changeSent({ kind: 'edit', lineId: sheet.line.id, after: spec }, made); closeSheet(); }}
            onRemove={() => { reg.changeSent({ kind: 'void', lineId: sheet.line.id }, made); closeSheet(); }}
          />
        );
      })()}
      {sheet?.kind === 'edit' && !manager && !sheet.line.sent && (
        <ExtrasSheet
          item={itemById(sheet.line.itemId)}
          line={sheet.line}
          combo={sheet.line.box && comboById(sheet.line.box.comboId)}
          onClose={closeSheet}
          onSubmit={(spec) => { reg.editLine({ ...spec, id: sheet.line.id }, 'Updated'); closeSheet(); }}
          onRemove={() => {
            const box = sheet.line.box;
            if (box) reg.dropBox(box.id, `Removed ${box.name}`); else reg.dropLine(sheet.line.id, 'Removed');
            closeSheet();
          }}
        />
      )}
      {sheet?.kind === 'online' && <OnlineSheet state={online} onAccept={acceptOnline} onOut={outOnline} onClose={closeSheet} />}
      {sheet?.kind === 'pin' && (
        <PinSheet onClose={closeSheet} onUnlock={(actor) => { closeSheet(); mode.enter(actor); }} />
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
