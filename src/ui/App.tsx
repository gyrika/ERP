import { useCallback, useEffect, useMemo, useState, type MouseEvent } from 'react';
import { seesTakings } from '../domain/auth.ts';
import { DISCOUNT_CHIPS, type ManagerChange } from '../domain/manager.ts';
import { itemById } from '../domain/menu.ts';
import { bareLine, orderTotal, unsentLines } from '../domain/order.ts';
import type { MenuItem, OrderLine, PaidOrder, SizeId, Tender } from '../domain/types.ts';
import { currentCashier } from '../services/auth.ts';
import { canPrint, printReceipt } from '../services/printer.ts';
import { CommandPalette, type Command } from './CommandPalette.tsx';
import { ExtrasSheet } from './ExtrasSheet.tsx';
import { KitchenChip } from './KitchenChip.tsx';
import { Menu, type CategoryId } from './Menu.tsx';
import { OrderPanel, VOID_REASONS, type ManagePanel } from './OrderPanel.tsx';
import { PaySheet } from './PaySheet.tsx';
import { PinSheet } from './PinSheet.tsx';
import { ShorthandBar, describe } from './ShorthandBar.tsx';
import { SyncSign } from './SyncSign.tsx';
import { useKitchenTickets } from './kitchenStore.ts';
import { setSoundOn, soundOn } from './sound.ts';
import { useManagerMode } from './useManagerMode.ts';
import { useRegister } from './useRegister.ts';

type Sheet =
  | { kind: 'extras'; item: MenuItem; size?: SizeId }
  | { kind: 'edit'; line: OrderLine }
  | { kind: 'pay' }
  | { kind: 'pin' }
  | null;

const isTypingTarget = (el: EventTarget | null): boolean =>
  el instanceof HTMLElement && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);

/**
 * `onKitchen`: flips the counter screen to the Kitchen view (see Root).
 * `onSwitch`: locks the screen for the next person (real logins only).
 */
export function App({ onKitchen, onSwitch }: { onKitchen?: () => void; onSwitch?: () => void } = {}) {
  const reg = useRegister();
  const tickets = useKitchenTickets(); // live, so Cooking turns Done the moment the kitchen taps it
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
  const pay = useCallback((tender: Tender, tendered: number) => {
    const paid = reg.pay(tender, tendered);
    if (paid) print(paid);
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
  const [sound, setSound] = useState(soundOn);
  const { endManagerSession } = reg;
  const mode = useManagerMode(useCallback(() => {
    // However manager mode ends (Esc, Exit, 10 s idle), nothing of it stays open.
    setPalette(false);
    setPendingVoid(null);
    setAdjusting(null);
    setSheet((s) => (s?.kind === 'edit' ? null : s));
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
    reg.manage(manager, change);
    setPendingVoid(null);
    setAdjusting(null);
  }, [manager, reg]);

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

      if (manager) {
        // Esc leaves manager mode from ANY state: palette, sheet, half-done void or adjustment.
        if (e.key === 'Escape') { e.preventDefault(); mode.exit(); return; }
        if (mod && key === 'm') { e.preventDefault(); mode.exit(); return; }
        if (mod && key === 'z') { e.preventDefault(); reg.undoManager(manager); return; }
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
        if (/^[1-4]$/.test(e.key)) { e.preventDefault(); toggleChip(e.key); }
        return;
      }

      // Cashier mode.
      if (mod && key === 'm' && !sheet) { e.preventDefault(); setTyped(null); setSheet({ kind: 'pin' }); return; }
      if (mod && key === 'z') { e.preventDefault(); reg.undo(); return; }
      if (mod && e.key === 'Enter' && !sheet && !reg.paid) {
        e.preventDefault();
        if (hasNew) reg.send(); else if (canCharge) setSheet({ kind: 'pay' });
        return;
      }
      if (sheet || typed !== null || mod || e.altKey || isTypingTarget(e.target)) return;
      if (e.key === 'Escape' && canCharge) { reg.startNew(); return; }
      if (e.key.length === 1 && /[a-z0-9]/i.test(e.key)) { e.preventDefault(); setTyped(e.key); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [reg, sheet, typed, hasNew, canCharge, manager, mode, palette, adjusting, pendingVoid, listing, lines.length,
    selected, selectedLine, askVoid, askAdjust, toggleChip, manage]);

  // Tapping empty space outside an opened order goes back to the "Waiting to pay" list.
  // Cards, buttons and the order panel itself are not background, so adding a round still works.
  const onBackground = (e: MouseEvent) => {
    if (!canCharge || sheet || typed !== null || palette) return;
    if ((e.target as Element).closest('button, input, a, .card, .panel, .typebar, .toast')) return;
    reg.startNew();
  };

  const quickAdd = (item: MenuItem, size?: SizeId) => {
    const label = item.variants?.find((v) => v.id === size)?.label;
    reg.addSpec(bareLine(item.id, size), `Added ${item.name.en}${label ? ` · ${label}` : ''}`);
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
        const name = itemById(selectedLine.itemId).name.en;
        list.push(
          { id: 'edit', label: `Edit ${name}`, hint: 'Enter', run: () => setSheet({ kind: 'edit', line: selectedLine }) },
          { id: 'adjust', label: `Adjust price of ${name}`, hint: 'P', run: () => askAdjust(selectedLine) },
          { id: 'void', label: `Void ${name}`, hint: 'Del', run: () => askVoid(selectedLine) },
        );
      }
    }
    reg.open.forEach((o) => list.push({ id: `open-${o.number}`, label: `Open order ${o.number}`, run: () => reg.openOrder(o.number) }));
    list.push(
      { id: 'owner', label: 'Owner view: what needs attention today', run: () => { location.hash = '#owner'; } },
      { id: 'inventory', label: 'Inventory and stock', run: () => { location.hash = '#inventory'; } },
      { id: 'undo', label: 'Undo last change', hint: 'Ctrl+Z', run: () => reg.undoManager(manager) },
      { id: 'sound', label: sound ? 'Turn sound off' : 'Turn sound on', run: () => { setSoundOn(!sound); setSound(!sound); } },
      { id: 'leave', label: 'Leave manager mode', hint: 'Esc', run: mode.exit },
    );
    return list;
  }, [manager, listing, reg, selectedLine, sound, manage, askAdjust, askVoid, mode.exit]);

  return (
    <div className={`register${manager ? ' register--managing' : ''}`} onClick={onBackground}>
      <header className="register__head">
        <span className="brand">CheesyBeez</span>
        {manager ? (
          <span className="corner corner--managing" role="status">
            <span className="corner__who">Managing · {manager.name}</span>
            <button type="button" className="corner__key" onClick={() => setPalette(true)}>Commands <kbd>Ctrl K</kbd></button>
            <button type="button" className="corner__key" onClick={mode.exit}>Done <kbd>Esc</kbd></button>
          </span>
        ) : (
          <span className="corner">
            {onKitchen && <KitchenChip tickets={tickets} onOpen={onKitchen} />}
            <SyncSign />
            {onSwitch
              ? (
                <button type="button" className="corner__key" onClick={onSwitch} aria-label={`${currentCashier().name}: switch user`}>
                  {currentCashier().name} <kbd>F4</kbd>
                </button>
              )
              : <span className="cashier">{currentCashier().name}</span>}
            <button type="button" className="corner__key" onClick={() => setSheet({ kind: 'pin' })}>Manager <kbd>Ctrl M</kbd></button>
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
          printState={canPrint() && reg.paid && printing?.number === reg.paid.number ? printing.state : null}
          onReprint={canPrint() ? () => { if (reg.paid) print(reg.paid, true); } : undefined}
          onOpen={reg.openOrder}
          onNext={reg.startNew}
          onUndo={reg.undo}
        />
      </div>

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
          manager={Boolean(sheet.line.sent)}
          onClose={closeSheet}
          onSubmit={(spec, reason) => { manage({ kind: 'edit', lineId: sheet.line.id, after: spec, reason }); closeSheet(); }}
          onRemove={(reason) => { manage({ kind: 'void', lineId: sheet.line.id, reason }); closeSheet(); }}
        />
      )}
      {sheet?.kind === 'edit' && !manager && !sheet.line.sent && (
        <ExtrasSheet
          item={itemById(sheet.line.itemId)}
          line={sheet.line}
          onClose={closeSheet}
          onSubmit={(spec) => { reg.editLine({ ...spec, id: sheet.line.id }, 'Updated'); closeSheet(); }}
          onRemove={() => { reg.dropLine(sheet.line.id, 'Removed'); closeSheet(); }}
        />
      )}
      {sheet?.kind === 'pay' && (
        <PaySheet total={total} onClose={closeSheet} onPay={(tender, tendered) => { pay(tender, tendered); closeSheet(); }} />
      )}
      {sheet?.kind === 'pin' && (
        <PinSheet onClose={closeSheet} onUnlock={(actor) => { closeSheet(); mode.enter(actor); }} />
      )}
      {palette && manager && <CommandPalette commands={commands} onClose={() => setPalette(false)} />}

      {/* Hidden under an open sheet: it would cover the sheet's buttons (e.g. Card). */}
      {reg.toast && !sheet && !palette && (
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
