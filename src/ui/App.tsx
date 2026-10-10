import { useCallback, useEffect, useState, type MouseEvent } from 'react';
import { bareLine, orderTotal, unsentLines } from '../domain/order.ts';
import { itemById } from '../domain/menu.ts';
import type { Actor } from '../domain/auth.ts';
import type { MenuItem, OrderLine, SizeId } from '../domain/types.ts';
import { ExtrasSheet } from './ExtrasSheet.tsx';
import { Menu, type CategoryId } from './Menu.tsx';
import { OrderPanel } from './OrderPanel.tsx';
import { PaySheet } from './PaySheet.tsx';
import { PinSheet } from './PinSheet.tsx';
import { ShorthandBar, describe } from './ShorthandBar.tsx';
import { useKitchenTickets } from './kitchenStore.ts';
import { useRegister } from './useRegister.ts';

type Sheet =
  | { kind: 'extras'; item: MenuItem; size?: SizeId }
  | { kind: 'edit'; line: OrderLine }
  | { kind: 'pay' }
  | { kind: 'pin' }
  | null;

/** A manager unlock covers one change on one order, and lapses if left unused. */
const MANAGER_IDLE_MS = 60_000;

const isTypingTarget = (el: EventTarget | null): boolean =>
  el instanceof HTMLElement && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);

export function App() {
  const reg = useRegister();
  const tickets = useKitchenTickets(); // live, so Cooking turns Done the moment the kitchen taps it
  const [category, setCategory] = useState<CategoryId>('popular');
  const [sheet, setSheet] = useState<Sheet>(null);
  const [typed, setTyped] = useState<string | null>(null); // non-null = shorthand bar open
  const closeSheet = useCallback(() => setSheet(null), []);
  const total = orderTotal(reg.order);
  const hasNew = unsentLines(reg.order).length > 0;
  /** A waiting order opened from the list, with nothing new on it: Charge, or go back. */
  const canCharge = !hasNew && reg.order.sentAt !== undefined && !reg.paid;
  const [unlock, setUnlock] = useState<{ actor: Actor; number: number } | null>(null);
  const manager = unlock && unlock.number === reg.order.number && !reg.paid ? unlock.actor : null;
  const exitManager = useCallback(() => setUnlock(null), []);

  // The unlock lapses when left idle, but never while the manager is mid-edit in a sheet.
  useEffect(() => {
    if (!unlock || sheet) return;
    const t = setTimeout(exitManager, MANAGER_IDLE_MS);
    return () => clearTimeout(t);
  }, [unlock, sheet, exitManager]);

  // A sent-item sheet with no manager behind it must close, never linger invisibly and block the register.
  useEffect(() => {
    if (sheet?.kind === 'edit' && sheet.line.sent && !manager) setSheet(null);
  }, [sheet, manager]);

  // Global keys: Ctrl/Cmd+Z undo, Ctrl/Cmd+Enter the primary action (send, else charge),
  // Escape leaves an opened order, any letter starts typing an order.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); reg.undo(); return; }
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
  }, [reg, sheet, typed, hasNew, canCharge]);

  // Tapping empty space outside an opened order goes back to the "Waiting to pay" list.
  // Cards, buttons and the order panel itself are not background, so adding a round still works.
  const onBackground = (e: MouseEvent) => {
    if (!canCharge || sheet || typed !== null) return;
    if ((e.target as Element).closest('button, input, a, .card, .panel, .typebar, .toast')) return;
    reg.startNew();
  };

  const quickAdd = (item: MenuItem, size?: SizeId) => {
    const label = item.variants?.find((v) => v.id === size)?.label;
    reg.addSpec(bareLine(item.id, size), `Added ${item.name.en}${label ? ` · ${label}` : ''}`);
  };

  return (
    <div className="register" onClick={onBackground}>
      <header className="register__head">
        <span className="brand">CheesyBeez</span>
        <span className="cashier">Nimal</span>
      </header>

      <div className="register__body">
        <main className="menu">
          {typed !== null && (
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
            hint="Start typing to order"
          />
        </main>

        <OrderPanel
          order={reg.order}
          open={reg.open}
          paidToday={reg.paidToday}
          tickets={tickets}
          paid={reg.paid}
          manager={manager}
          onAskManager={() => setSheet({ kind: 'pin' })}
          onExitManager={exitManager}
          onEdit={(line) => setSheet({ kind: 'edit', line })}
          onSend={reg.send}
          onCharge={() => setSheet({ kind: 'pay' })}
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
      {sheet?.kind === 'edit' && sheet.line.sent && manager && (
        <ExtrasSheet
          item={itemById(sheet.line.itemId)}
          line={sheet.line}
          manager
          onClose={closeSheet}
          // After the one change, control goes straight back to the cashier.
          onSubmit={(spec, reason) => { reg.managerChange(manager, sheet.line.id, spec, reason); exitManager(); closeSheet(); }}
          onRemove={(reason) => { reg.managerChange(manager, sheet.line.id, null, reason); exitManager(); closeSheet(); }}
        />
      )}
      {sheet?.kind === 'edit' && !sheet.line.sent && (
        <ExtrasSheet
          item={itemById(sheet.line.itemId)}
          line={sheet.line}
          onClose={closeSheet}
          onSubmit={(spec) => { reg.editLine({ ...spec, id: sheet.line.id }, 'Updated'); closeSheet(); }}
          onRemove={() => { reg.dropLine(sheet.line.id, 'Removed'); closeSheet(); }}
        />
      )}
      {sheet?.kind === 'pay' && (
        <PaySheet total={total} onClose={closeSheet} onPay={(tender, tendered) => { reg.pay(tender, tendered); closeSheet(); }} />
      )}

      {sheet?.kind === 'pin' && (
        <PinSheet
          onClose={closeSheet}
          onUnlock={(actor) => { setUnlock({ actor, number: reg.order.number }); closeSheet(); }}
        />
      )}

      {/* Hidden under an open sheet: it would cover the sheet's buttons (e.g. Card). */}
      {reg.toast && !sheet && (
        <div className="toast" role="status" key={reg.toast.id}>
          <span>{reg.toast.message}</span>
          {reg.canUndo && <button type="button" onClick={reg.undo}>Undo</button>}
        </div>
      )}
    </div>
  );
}
