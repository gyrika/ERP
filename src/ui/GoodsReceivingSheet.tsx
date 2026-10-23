import { useState, type ReactNode } from 'react';
import type { Actor } from '../domain/auth.ts';
import type { Supplier } from '../domain/inventoryData.ts';
import { parsePacks } from '../domain/inventory.ts';
import { formatInUnit, fromPacks, packPrice, receiveUnitOf, roundForUnit, toPacks, unitName, unitPrice, type CountUnit } from '../domain/counting.ts';
import { fmt, parseLKR } from '../domain/money.ts';
import {
  compareDelivery, expectedBy, grnValueCents, settleGrn, undoCheck, UNDO_REASONS, type GrnDecisions, type PurchaseGrn, type PurchaseOrder, type PurchaseState,
} from '../domain/purchaseOrders.ts';
import type { StockSettings } from '../domain/stockSettings.ts';
import { receiveGoods, undoGrn, type InventoryRow } from '../services/inventoryStore.ts';
import { ChoiceCard } from './flow/ChoiceCard.tsx';
import { DoneStep } from './flow/DoneStep.tsx';
import { FlowSheet } from './flow/FlowSheet.tsx';
import { GrnDocument, printGrn } from './GrnDocument.tsx';
import { PinSheet } from './PinSheet.tsx';
import { RejectionNotices } from './Rejections.tsx';
import { NumberInput } from './NumberInput.tsx';

/**
 * GRN, goods received: a delivery came. Serves the person at the door with the supplier's
 * bill in hand, one step at a time (src/ui/flow):
 *   1 Which delivery?  big cards, newest first, with the day it is expected (one order: skipped, Back still
 *                      reaches it)
 *   2 Check and save   a list of what is still owed, ticked one by one; change a number or price where it
 *                      differs; the bill below; then Save GRN, or Manager approves when something differs
 *   3 Approve          (only if different) a manager's PIN, then what happens to the short lines (wait for
 *                      the rest, or close the order) and the extra (accept it, or return it), then Approve
 *                      or Don't approve. The approver goes on the record, never on the screen.
 *   GRN history        every GRN, newest first; one opens as its document, with Export PDF and Undo.
 *   Done               a tick and what to do next. Undo (here or in history): only the latest GRN of an order,
 *                      within the allowed hours, a manager's PIN and a reason; the GRN stays, marked Undone.
 * The rules are in purchaseOrders.ts and on the server; this file only walks through them.
 */
/** Packs are kept to 6 decimals, so 48.53 kg of a 25 kg pack stays 48.53 kg. */
const round = (n: number) => Math.round(n * 1e6) / 1e6;
const day = (at: number) => new Date(at).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

const SHORT_CHOICES = [['wait', 'Wait for the rest', 'The order stays open for what is still to come.'], ['close', 'Close order', 'What did not come is dropped.']] as const;
const OVER_CHOICES = [['accept', 'Accept extra', 'Everything that came goes into stock.'], ['return', 'Return extra', 'Only what was ordered goes in; the rest goes back.']] as const;

type Step = 'pick' | 'check' | 'decide' | 'done' | 'history' | 'grn' | 'why';

interface BillLine {
  itemId: string;
  name: string;
  expectedPacks: number;
  quantityPacks: number;
  receivedPacks: number;
  returnedPacks: number;
  unitPriceCents: number;
  orderPriceCents?: number;
  status?: string;
  /** What the item is received in (a pack, kg, a Tray), and its pack size. */
  unit: CountUnit;
  packQty: number;
}

function GrnBill({ lines, totalCents, priceEntry }: {
  lines: BillLine[];
  totalCents: number;
  priceEntry?: (itemId: string) => ReactNode;
}) {
  return (
    <table className="bill grn-bill" aria-label="Delivery bill">
      <thead><tr><th>Item</th><th className="bill__num">Quantity</th><th className="bill__num">Price</th><th className="bill__num">Total price</th></tr></thead>
      <tbody>
        {lines.map((l) => {
          const packs = (n: number) => formatInUnit(n, l.unit, l.packQty);
          const per = `/ ${unitName(l.unit)}`;
          return (
          <tr key={l.itemId}>
            <td>
              <span className="bill__name">{l.name}</span>
              <span className="bill__sub">
                Expected {packs(l.expectedPacks)} · {l.orderPriceCents === undefined ? 'Order price not recorded' : `Order Rs ${fmt(unitPrice(l.orderPriceCents, l.unit, l.packQty))} ${per}`}
                {l.returnedPacks > 0 ? ` · ${packs(l.receivedPacks)} received, ${packs(l.returnedPacks)} returned` : ''}
              </span>
              {l.status && <span className="bill__sub grn-bill__status">{l.status}</span>}
            </td>
            <td className="bill__num">{packs(l.quantityPacks)}</td>
            <td className="bill__num">{priceEntry ? priceEntry(l.itemId) : `Rs ${fmt(unitPrice(l.unitPriceCents, l.unit, l.packQty))} ${per}`}</td>
            <td className="bill__num">Rs {fmt(Math.round(l.quantityPacks * l.unitPriceCents))}</td>
          </tr>
          );
        })}
      </tbody>
      <tfoot>
        <tr><th colSpan={3}>Final total</th><th className="bill__num" aria-label="Final total price">Rs {fmt(totalCents)}</th></tr>
      </tfoot>
    </table>
  );
}

export function GoodsReceivingSheet({ items, suppliers, purchases, settings, inline = false, onClose, onDone }: {
  items: InventoryRow[];
  suppliers: Supplier[];
  purchases: PurchaseState;
  settings: Pick<StockSettings, 'defaultLeadDays' | 'grnUndoHours'>;
  /** In the Receive page itself, not a sheet over it. */
  inline?: boolean;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  // Newest first: the delivery that just arrived is the one at the top.
  const open = [...purchases.open].reverse();
  const [orderId, setOrderId] = useState<string | null>(open.length === 1 ? open[0].id : null);
  const [step, setStep] = useState<Step>(open.length === 1 ? 'check' : 'pick');
  /** The items ticked off the list (as the person checks them on the bill and in the boxes). */
  const [ticked, setTicked] = useState<Set<string>>(() => new Set());
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [priceAmounts, setPriceAmounts] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [asking, setAsking] = useState(false);
  /** The manager whose PIN was accepted, deciding. */
  const [deciding, setDeciding] = useState<Actor | null>(null);
  const [decisions, setDecisions] = useState<GrnDecisions>({ short: null, over: null });
  /** The GRN just saved here. */
  const [saved, setSaved] = useState<{ grnId: string; no: string; line: string } | null>(null);
  /** Undoing a GRN: first the manager's PIN, then why. */
  const [undoing, setUndoing] = useState<{ grn: PurchaseGrn; manager: Actor | null } | null>(null);
  /** The GRN open as a document in history. */
  const [viewing, setViewing] = useState<string | null>(null);

  const supplierName = (id: string) => suppliers.find((s) => s.id === id)?.name ?? 'Supplier';
  const order: PurchaseOrder | null = open.find((o) => o.id === orderId) ?? null;
  /** Only what is still owed. */
  const lines = order ? order.lines.filter((l) => l.remaining > 0).flatMap((l) => {
    const row = items.find((i) => i.id === l.itemId);
    if (!row) return [];
    const unit = receiveUnitOf(row);
    return [{
      row, unit, expected: l.remaining, expectedInUnit: roundForUnit(fromPacks(l.remaining, unit, row.packQty)),
      orderPriceCents: l.unitPriceCents,
    }];
  }) : [];

  const typed = (l: (typeof lines)[number]) => (amounts[l.row.id] ?? String(l.expectedInUnit)).trim();
  /** The pack price it was ordered at (or today's), the one the price box starts from. */
  const startPrice = (l: (typeof lines)[number]) => l.orderPriceCents ?? l.row.workingPriceCents;
  /** The price box, in the unit it is received in: Rs 260 a kg, not Rs 6,500 a pack. */
  const typedPrice = (l: (typeof lines)[number]) =>
    (priceAmounts[l.row.id] ?? fmt(unitPrice(startPrice(l), l.unit, l.row.packQty))).trim();
  /** The delivered price of one pack; untouched, exactly the order's (no rounding through the unit). */
  const priceFor = (l: (typeof lines)[number]) => {
    if (priceAmounts[l.row.id] === undefined) return startPrice(l);
    const cents = parseLKR(typedPrice(l));
    if (cents === null) return null;
    return cents === unitPrice(startPrice(l), l.unit, l.row.packQty) ? startPrice(l) : packPrice(cents, l.unit, l.row.packQty);
  };
  /** What came, line by line in packs; null when a number is not a number. */
  const received = () => {
    const out = [];
    for (const l of lines) {
      const n = typed(l) === '' ? 0 : parsePacks(typed(l));
      if (n === null) { setError(`Type the amount of ${l.row.name} as a number, like 2 or 1.5.`); return null; }
      const unitPriceCents = priceFor(l);
      if (unitPriceCents === null) { setError(`Type the delivered price for ${l.row.name} in rupees, like 6400 or 6400.50.`); return null; }
      out.push({ itemId: l.row.id, ordered: l.expected, received: round(toPacks(n, l.unit, l.row.packQty)), unitPriceCents });
    }
    return out;
  };
  const check = compareDelivery(lines.map((l) => {
    const n = parsePacks(typed(l) || '0');
    return {
      itemId: l.row.id, ordered: l.expected,
      received: n === null ? l.expected : round(toPacks(n, l.unit, l.row.packQty)),
      unitPriceCents: priceFor(l) ?? l.orderPriceCents ?? l.row.workingPriceCents,
    };
  }), lines.map((l) => ({ itemId: l.row.id, unitPriceCents: l.orderPriceCents })));
  const choiceReady = (!check.hasShort || decisions.short !== null) && (!check.hasOver || decisions.over !== null);
  const diff = (c: (typeof check.lines)[number], l: (typeof lines)[number]) => `${c.diff > 0 ? '+' : '−'}${roundForUnit(fromPacks(Math.abs(c.diff), l.unit, l.row.packQty))}${l.unit.id === 'pack' ? '' : ` ${unitName(l.unit)}`}`;
  const word = (n: number, one: string, many: string) => (n === 1 ? one : many);
  const priceInput = (l: (typeof lines)[number], onTyped?: () => void) => (
    <span className="price">
      <span className="price__rs" aria-hidden="true">Rs</span>
      <NumberInput decimals={2} className="price__num" aria-label={`Delivered price per ${unitName(l.unit)} of ${l.row.name}`}
        value={typedPrice(l)} onFocus={(e) => e.currentTarget.select()} onText={(text) => { updatePrice(l.row.id, text); onTyped?.(); }} />
      <span className="bill__sub">/ {unitName(l.unit)}</span>
    </span>
  );
  const updatePrice = (itemId: string, text: string) => {
    setPriceAmounts({ ...priceAmounts, [itemId]: text });
    setError('');
  };
  const settledBill = settleGrn(check.lines, decisions.over);
  const billLines = check.lines.map((c, i): BillLine => {
    const l = lines[i];
    const settled = settledBill[i];
    return {
      itemId: c.itemId, name: l.row.name, expectedPacks: c.ordered,
      quantityPacks: settled.accepted ?? c.received, receivedPacks: c.received,
      returnedPacks: settled.returned ?? 0, unitPriceCents: c.unitPriceCents ?? 0,
      orderPriceCents: c.expectedUnitPriceCents, unit: l.unit, packQty: l.row.packQty,
      status: [
        c.match === 'ok' ? '' : `${c.match} ${diff(c, l)}`,
        c.priceMismatch ? 'delivered price differs from order' : '',
      ].filter(Boolean).join(' · ') || undefined,
    };
  });
  const billTotalCents = billLines.reduce((total, l) => total + Math.round(l.quantityPacks * l.unitPriceCents), 0);
  const billPriceEntry = (itemId: string) => {
    const line = lines.find((l) => l.row.id === itemId);
    return line ? priceInput(line) : null;
  };

  const bump = (l: (typeof lines)[number], by: number) => {
    const now = parsePacks(typed(l) || '0') ?? 0;
    setAmounts({ ...amounts, [l.row.id]: String(Math.max(0, roundForUnit(now + by))) });
    setError('');
  };

  /** Back to the list of deliveries, fresh. */
  const toList = () => { setOrderId(null); setStep('pick'); setTicked(new Set()); setAmounts({}); setPriceAmounts({}); setError(''); setDeciding(null); setDecisions({ short: null, over: null }); };
  const pick = (id: string) => { setOrderId(id); setStep('check'); setTicked(new Set()); setAmounts({}); setPriceAmounts({}); setError(''); setSaved(null); };

  const finish = (approvedBy: Actor | null) => {
    const got = received();
    if (!got || !order) return;
    const result = receiveGoods(order, got, decisions, approvedBy);
    if (typeof result === 'string') { setDeciding(null); setStep('check'); setError(result); return; }
    const prices = result.prices > 0 ? ` ${result.prices} ${result.prices === 1 ? 'price' : 'prices'} updated to what it came at.` : '';
    onDone(`${result.grnNo} from ${supplierName(order.supplierId)} saved${approvedBy ? ', approved by a manager' : ''}.${prices}`);
    setSaved({ grnId: result.id, no: result.grnNo, line: `From ${supplierName(order.supplierId)}${approvedBy ? ' · approved by a manager' : ''}` });
    setOrderId(null); setAmounts({}); setPriceAmounts({}); setError(''); setDeciding(null); setDecisions({ short: null, over: null });
    setStep('done');
  };

  const notApproved = () => {
    setDeciding(null);
    setDecisions({ short: null, over: null });
    setStep('check');
    setError('Not approved: nothing was saved. Fix the amounts, or check the delivery with the supplier.');
  };

  /** Save, or ask a manager first when something differs. */
  const toApproval = () => {
    if (!received()) return;
    if (check.needsApproval) setAsking(true);
    else finish(null);
  };

  /** Starts an undo, saying at once why it cannot be done when it cannot. */
  const startUndo = (grn: PurchaseGrn) => {
    const why = undoCheck(purchases, grn.id, Date.now(), settings.grnUndoHours);
    if (why) { setError(why); return; }
    setError('');
    setUndoing({ grn, manager: null });
  };
  const undo = (reason: string) => {
    if (!undoing?.manager) return;
    const why = undoGrn(purchases, undoing.grn.id, reason, undoing.manager, settings.grnUndoHours);
    if (why) { setError(why); setUndoing(null); setStep('history'); return; }
    onDone(`${undoing.grn.grnNo} undone.`);
    setSaved(null);
    setError('');
    setUndoing(null);
    setStep('history');
  };

  const itemName = (id: string) => items.find((i) => i.id === id)?.name ?? id;
  /** What an item is received in, for its GRN document; null: no longer on the price list (shown in packs). */
  const unitOf = (id: string) => { const row = items.find((i) => i.id === id); return row ? { unit: receiveUnitOf(row), packQty: row.packQty } : null; };
  const view = (id: string) => { setViewing(id); setError(''); setStep('grn'); };
  const pinOpen = asking || (undoing !== null && undoing.manager === null);
  const shared = { onClose, keys: !pinOpen, error, inline };
  const history = purchases.grns.length > 0 && (
    <section aria-label="GRN history" className="flow__list">
      <p className="flow-hint">GRN history</p>
      {purchases.grns.map((g) => (
        <ChoiceCard key={g.id} name={`${g.grnNo} · ${supplierName(g.supplierId)}`} tone={g.undone ? undefined : 'ok'}
          corner={g.undone ? `Undone by ${g.undone.by ?? 'a manager'}` : g.approvedBy ? `Approved by ${g.approvedBy.name}` : undefined}
          line={`${g.poNo} · ${day(g.at)} · Rs ${fmt(grnValueCents(g.lines))} · Received by ${g.receivedBy}${g.undone ? ` · Undone: ${g.undone.reason}` : ''}`}
          label={`Open ${g.grnNo}`} onClick={() => view(g.id)} />
      ))}
    </section>
  );

  const pins = (
    <>
      {asking && <PinSheet reason="The delivery differs from the order" onClose={() => setAsking(false)} onUnlock={(manager) => { setAsking(false); setDeciding(manager); setStep('decide'); }} />}
      {undoing && !undoing.manager && <PinSheet reason={`To undo ${undoing.grn.grnNo}`} onClose={() => setUndoing(null)} onUnlock={(manager) => { setUndoing({ ...undoing, manager }); setStep('why'); }} />}
    </>
  );

  // ----- Undo: why -----
  if (step === 'why' && undoing?.manager) {
    return (
      <>
        <FlowSheet title="GRN" {...shared} onBack={() => { setUndoing(null); setStep('history'); }}>
          <RejectionNotices />
          <section aria-label="Why undo" className="flow__list">
            <p className="flow-hint">Why is {undoing.grn.grnNo} being undone?</p>
            <div role="group" aria-label="Reason" className="flow__list">
              {UNDO_REASONS.map((r) => <ChoiceCard key={r} name={r} onClick={() => undo(r)} />)}
            </div>
          </section>
        </FlowSheet>
        {pins}
      </>
    );
  }

  // ----- GRN history -----
  if (step === 'history') {
    return (
      <>
        <FlowSheet title="GRN" {...shared} onBack={toList}>
          <RejectionNotices />
          {history || <p className="flow-hint">No GRNs yet.</p>}
        </FlowSheet>
        {pins}
      </>
    );
  }

  // ----- One GRN: the document, Export PDF -----
  const shown = step === 'grn' ? purchases.grns.find((g) => g.id === viewing) : undefined;
  if (shown) {
    const supplier = supplierName(shown.supplierId);
    return (
      <>
        <FlowSheet title={shown.grnNo} {...shared} onBack={() => { setViewing(null); setError(''); setStep('history'); }}
          primary={{ label: 'Export PDF', onClick: () => printGrn(`${shown.grnNo} ${supplier}`) }}
          extra={!shown.undone && undoCheck(purchases, shown.id, Date.now(), settings.grnUndoHours) === null
            ? <button type="button" className="linkbtn flow__back" aria-label={`Undo ${shown.grnNo}`} onClick={() => startUndo(shown)}>Undo</button> : undefined}>
          <RejectionNotices />
          <GrnDocument grn={shown} supplier={supplier} itemName={itemName} unitOf={unitOf} />
        </FlowSheet>
        {pins}
      </>
    );
  }

  // ----- Done -----
  if (step === 'done' && saved) {
    const next = open.length > 0;
    const grn = purchases.grns.find((g) => g.id === saved.grnId);
    return (
      <>
        <FlowSheet title="GRN" {...shared} primary={{ label: next ? 'Next delivery' : 'Done', onClick: next ? toList : onClose }}
          extra={grn && (
            <>
              {undoCheck(purchases, grn.id, Date.now(), settings.grnUndoHours) === null
                && <button type="button" className="linkbtn flow__back" aria-label={`Undo ${saved.no}`} onClick={() => startUndo(grn)}>Undo</button>}
              <button type="button" className="linkbtn flow__back" onClick={() => view(grn.id)}>View GRN</button>
            </>
          )}>
          <RejectionNotices />
          <DoneStep title={`${saved.no} saved`} line={saved.line} />
        </FlowSheet>
        {pins}
      </>
    );
  }

  // ----- 1 Which delivery? -----
  if (step === 'pick' || !order) {
    return (
      <>
        <FlowSheet title="GRN" {...shared}
          extra={open.length > 0 && purchases.grns.length > 0 ? <button type="button" className="linkbtn flow__back" onClick={() => setStep('history')}>GRN history</button> : undefined}>
          <RejectionNotices />
          {open.length === 0 ? (
            <>
              <p className="flow-hint">Nothing on order. Place a purchase order first; goods are received against it.</p>
              {history}
            </>
          ) : (
            <>
              <p className="flow-hint">Which delivery came?</p>
              <div role="group" aria-label="Open orders" className="flow__list">
                {open.map((o) => (
                  <ChoiceCard key={o.id} name={supplierName(o.supplierId)} tone={o.status === 'partly' ? 'warn' : undefined}
                    line={`${o.poNo} · expected ${day(expectedBy(o, purchases.leadDays, settings.defaultLeadDays))}`}
                    tag={o.status === 'partly' ? 'Partly received' : undefined}
                    label={`${supplierName(o.supplierId)} · ${o.poNo} · expected ${day(expectedBy(o, purchases.leadDays, settings.defaultLeadDays))}${o.status === 'partly' ? ' · partly received' : ''}`}
                    onClick={() => pick(o.id)} />
                ))}
              </div>
            </>
          )}
        </FlowSheet>
        {pins}
      </>
    );
  }

  const title = `Goods from ${supplierName(order.supplierId)} · ${order.poNo}`;
  const of = check.needsApproval ? 3 : 2;

  // ----- 2 Check and save: a list, ticked one by one, the bill below -----
  if (step !== 'decide' || !deciding) {
    const tick = (id: string, on = true) => setTicked((t) => { const n = new Set(t); if (on) n.add(id); else n.delete(id); return n; });
    const next = lines.find((l) => !ticked.has(l.row.id));
    const done = lines.filter((l) => ticked.has(l.row.id)).length;
    return (
      <>
        <FlowSheet title={title} {...shared} step={{ index: 2, of, label: 'Check and save' }} onBack={toList}
          // The big button ticks the next item, so Enter works down the list; when all are ticked it saves.
          primary={next
            ? { label: `✓ ${next.row.name} came`, onClick: () => { tick(next.row.id); setError(''); } }
            : { label: check.needsApproval ? 'Manager approves' : 'Save GRN', onClick: toApproval, disabled: lines.length === 0 }}>
          <RejectionNotices />
          <p className="flow-hint num">{done} of {lines.length} checked</p>
          <table className="bill grn-bill grn-check" aria-label="Delivery bill">
            <thead>
              <tr>
                <th scope="col"><span className="sr-only">Came</span></th><th scope="col">Item</th><th scope="col" className="bill__qty">Qty</th>
                <th scope="col" className="bill__num">Price</th><th scope="col" className="bill__num">Total</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l, k) => {
                const c = check.lines[k];
                const on = ticked.has(l.row.id);
                const fine = c.match === 'ok' && !c.priceMismatch;
                const unitWord = l.unit.id === 'pack' ? word(l.expectedInUnit, 'pack', 'packs') : unitName(l.unit);
                return (
                  <tr key={l.row.id} className={on ? (fine ? 'grn-check--ok' : 'grn-check--warn') : undefined}>
                    <td className="grn-check__tick">
                      <button type="button" role="checkbox" aria-checked={on} className={`tick${on ? ' tick--on' : ''}`} aria-label={`${l.row.name} came`}
                        onClick={() => { tick(l.row.id, !on); setError(''); }}>✓</button>
                    </td>
                    <td>
                      <span className="bill__name">{l.row.name}</span>
                      <span className="bill__sub num">Expected {l.expectedInUnit} {unitWord}</span>
                      <span className="bill__sub num">{l.orderPriceCents === undefined ? 'Order price not recorded' : <>Ordered at <span className="nowrap">Rs {fmt(unitPrice(l.orderPriceCents, l.unit, l.row.packQty))} / {unitName(l.unit)}</span></>}</span>
                      {on && (
                        <span className={`grn-match grn-match--${fine ? 'ok' : 'warn'}`}
                          aria-label={`${l.row.name}: ${fine ? 'as ordered' : c.match === 'ok' ? 'price differs' : c.match}`}>
                          {fine ? '✓ as ordered' : c.match === 'ok' ? 'price differs' : `${c.match} ${diff(c, l)}${c.priceMismatch ? ' · price differs' : ''}`}
                        </span>
                      )}
                    </td>
                    {/* A different amount or price ticks the item too: it has been checked. */}
                    <td className="bill__qty">
                      <span className="qty">
                        <button type="button" className="qty__btn" aria-label={`One less of ${l.row.name}`} onClick={() => { bump(l, -1); tick(l.row.id); }}>−</button>
                        <NumberInput className="qty__num" aria-label={l.unit.id === 'pack' ? `Packs of ${l.row.name}` : `${unitName(l.unit)} of ${l.row.name}`}
                          value={typed(l)} onFocus={(e) => e.currentTarget.select()}
                          onText={(text) => { setAmounts({ ...amounts, [l.row.id]: text }); tick(l.row.id); setError(''); }} />
                        <button type="button" className="qty__btn" aria-label={`One more of ${l.row.name}`} onClick={() => { bump(l, 1); tick(l.row.id); }}>+</button>
                      </span>
                      {l.unit.id !== 'pack' && <span className="bill__sub">{unitName(l.unit)}</span>}
                    </td>
                    <td className="bill__num">{priceInput(l, () => tick(l.row.id))}</td>
                    <td className="bill__num num">Rs {fmt(Math.round(billLines[k].quantityPacks * billLines[k].unitPriceCents))}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr><th colSpan={4} scope="row" className="bill__sum">Final total</th><td className="bill__num bill__grand num" aria-label="Final total price">Rs {fmt(billTotalCents)}</td></tr>
            </tfoot>
          </table>
        </FlowSheet>
        {pins}
      </>
    );
  }

  // ----- 3 Approve (a manager decides) -----
  return (
    <>
      <FlowSheet title={title} {...shared} step={{ index: 3, of: 3, label: 'Manager decides' }}
        onBack={() => { setDeciding(null); setStep('check'); }}
        primary={{ label: 'Approve', onClick: () => finish(deciding), disabled: !choiceReady }}
        extra={<button type="button" className="linkbtn flow__back" onClick={notApproved}>Don't approve</button>}>
        <section aria-label="Manager decision" className="flow__list">
          <p className="flow-hint">This delivery differs from {order.poNo}:</p>
          <GrnBill lines={billLines} totalCents={billTotalCents} priceEntry={billPriceEntry} />
          {check.hasShort && (
            <div role="group" aria-label="Short lines" className="flow__list">
              {SHORT_CHOICES.map(([id, name, line]) => (
                <ChoiceCard key={id} name={name} line={line} pressed={decisions.short === id} onClick={() => setDecisions({ ...decisions, short: id })} />
              ))}
            </div>
          )}
          {check.hasOver && (
            <div role="group" aria-label="Extra lines" className="flow__list">
              {OVER_CHOICES.map(([id, name, line]) => (
                <ChoiceCard key={id} name={name} line={line} pressed={decisions.over === id} onClick={() => setDecisions({ ...decisions, over: id })} />
              ))}
            </div>
          )}
        </section>
      </FlowSheet>
      {pins}
    </>
  );
}
