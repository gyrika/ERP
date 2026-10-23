import { useState } from 'react';
import type { Actor } from '../domain/auth.ts';
import type { Supplier } from '../domain/inventoryData.ts';
import { parsePacks } from '../domain/inventory.ts';
import { receiveUnitOf, toPacks, unitName } from '../domain/counting.ts';
import {
  compareDelivery, expectedBy, grnTotals, undoCheck, UNDO_REASONS, type GrnDecisions, type PurchaseGrn, type PurchaseOrder, type PurchaseState,
} from '../domain/purchaseOrders.ts';
import type { StockSettings } from '../domain/stockSettings.ts';
import { receiveGoods, undoGrn, type InventoryRow } from '../services/inventoryStore.ts';
import { BigStepper } from './flow/BigStepper.tsx';
import { ChoiceCard, InfoCard } from './flow/ChoiceCard.tsx';
import { DoneStep } from './flow/DoneStep.tsx';
import { FlowSheet } from './flow/FlowSheet.tsx';
import { PinSheet } from './PinSheet.tsx';
import { RejectionNotices } from './Rejections.tsx';

/**
 * GRN, goods received: a delivery came. Serves the person at the door with the supplier's
 * bill in hand, one step at a time (src/ui/flow):
 *   1 Which delivery?  big cards, newest first, with the day it is expected (one order: skipped)
 *   2 Check each item  one card per item, filled in with what is still owed; ✓ All came, or change the number
 *   3 Review           what matched and what did not; Save GRN, or Manager approves when something differs
 *   4 Approve          (only if different) a manager's PIN, then what happens to the short lines (wait for
 *                      the rest, or close the order) and the extra (accept it, or return it), then Approve
 *                      or Don't approve. The approver goes on the record, never on the screen.
 *   Done               a tick and what to do next. Undo (Recent GRNs): only the latest GRN of an order,
 *                      within the allowed hours, a manager's PIN and a reason; the GRN stays, marked Undone.
 * The rules are in purchaseOrders.ts and on the server; this file only walks through them.
 */
const round = (n: number) => Math.round(n * 1000) / 1000;
const day = (at: number) => new Date(at).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

const SHORT_CHOICES = [['wait', 'Wait for the rest', 'The order stays open for what is still to come.'], ['close', 'Close order', 'What did not come is dropped.']] as const;
const OVER_CHOICES = [['accept', 'Accept extra', 'Everything that came goes into stock.'], ['return', 'Return extra', 'Only what was ordered goes in; the rest goes back.']] as const;

type Step = 'pick' | 'check' | 'review' | 'decide' | 'done' | 'recent' | 'why';

export function GoodsReceivingSheet({ items, suppliers, purchases, settings, onClose, onDone }: {
  items: InventoryRow[];
  suppliers: Supplier[];
  purchases: PurchaseState;
  settings: Pick<StockSettings, 'defaultLeadDays' | 'grnUndoHours'>;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  // Newest first: the delivery that just arrived is the one at the top.
  const open = [...purchases.open].reverse();
  const [orderId, setOrderId] = useState<string | null>(open.length === 1 ? open[0].id : null);
  const [step, setStep] = useState<Step>(open.length === 1 ? 'check' : 'pick');
  const [at, setAt] = useState(0);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [asking, setAsking] = useState(false);
  /** The manager whose PIN was accepted, deciding. */
  const [deciding, setDeciding] = useState<Actor | null>(null);
  const [decisions, setDecisions] = useState<GrnDecisions>({ short: null, over: null });
  /** The GRN just saved here. */
  const [saved, setSaved] = useState<{ grnId: string; no: string; line: string } | null>(null);
  /** Undoing a GRN: first the manager's PIN, then why. */
  const [undoing, setUndoing] = useState<{ grn: PurchaseGrn; manager: Actor | null } | null>(null);

  const supplierName = (id: string) => suppliers.find((s) => s.id === id)?.name ?? 'Supplier';
  const order: PurchaseOrder | null = open.find((o) => o.id === orderId) ?? null;
  /** Only what is still owed. */
  const lines = order ? order.lines.filter((l) => l.remaining > 0).flatMap((l) => {
    const row = items.find((i) => i.id === l.itemId);
    if (!row) return [];
    const unit = receiveUnitOf(row);
    return [{ row, unit, expected: l.remaining, expectedInUnit: round((l.remaining * row.packQty) / unit.base) }];
  }) : [];

  const typed = (l: (typeof lines)[number]) => (amounts[l.row.id] ?? String(l.expectedInUnit)).trim();
  /** What came, line by line in packs; null when a number is not a number. */
  const received = () => {
    const out = [];
    for (const l of lines) {
      const n = typed(l) === '' ? 0 : parsePacks(typed(l));
      if (n === null) { setError(`Type the amount of ${l.row.name} as a number, like 2 or 1.5.`); return null; }
      out.push({ itemId: l.row.id, ordered: l.expected, received: round(toPacks(n, l.unit, l.row.packQty)) });
    }
    return out;
  };
  const check = compareDelivery(lines.map((l) => {
    const n = parsePacks(typed(l) || '0');
    return { itemId: l.row.id, ordered: l.expected, received: n === null ? l.expected : round(toPacks(n, l.unit, l.row.packQty)) };
  }));
  const totals = grnTotals(check.lines);
  const choiceReady = (!check.hasShort || decisions.short !== null) && (!check.hasOver || decisions.over !== null);
  const diff = (c: (typeof check.lines)[number], l: (typeof lines)[number]) => `${c.diff > 0 ? '+' : '−'}${round(Math.abs(c.diff) * l.row.packQty / l.unit.base)}`;
  const word = (n: number, one: string, many: string) => (n === 1 ? one : many);

  const bump = (l: (typeof lines)[number], by: number) => {
    const now = parsePacks(typed(l) || '0') ?? 0;
    setAmounts({ ...amounts, [l.row.id]: String(Math.max(0, round(now + by))) });
    setError('');
  };

  /** Back to the list of deliveries, fresh. */
  const toList = () => { setOrderId(null); setStep('pick'); setAt(0); setAmounts({}); setError(''); setDeciding(null); setDecisions({ short: null, over: null }); };
  const pick = (id: string) => { setOrderId(id); setStep('check'); setAt(0); setAmounts({}); setError(''); setSaved(null); };

  const finish = (approvedBy: Actor | null) => {
    const got = received();
    if (!got || !order) return;
    const result = receiveGoods(order, got, decisions, approvedBy);
    if (typeof result === 'string') { setDeciding(null); setStep('review'); setError(result); return; }
    onDone(`${result.grnNo} from ${supplierName(order.supplierId)} saved${approvedBy ? ', approved by a manager' : ''}.`);
    setSaved({ grnId: result.id, no: result.grnNo, line: `From ${supplierName(order.supplierId)}${approvedBy ? ' · approved by a manager' : ''}` });
    setOrderId(null); setAmounts({}); setError(''); setDeciding(null); setDecisions({ short: null, over: null });
    setStep('done');
  };

  const notApproved = () => {
    setDeciding(null);
    setDecisions({ short: null, over: null });
    setAt(Math.max(0, check.lines.findIndex((c) => c.match !== 'ok')));
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
    if (why) { setError(why); setUndoing(null); setStep('recent'); return; }
    onDone(`${undoing.grn.grnNo} undone.`);
    setSaved(null);
    setError('');
    setUndoing(null);
    setStep('recent');
  };

  const recent = purchases.grns.slice(0, 5);
  const pinOpen = asking || (undoing !== null && undoing.manager === null);
  const shared = { onClose, keys: !pinOpen, error };
  const recentList = recent.length > 0 && (
    <section aria-label="Recent GRNs" className="flow__list">
      <p className="flow-hint">Recent GRNs</p>
      {recent.map((g) => (
        <InfoCard key={g.id} name={`${g.grnNo} · ${supplierName(g.supplierId)}`} tone={g.undone ? undefined : 'ok'}
          line={`${g.poNo} · ${day(g.at)}${g.undone ? ` · Undone: ${g.undone.reason}` : ''}`}>
          {!g.undone && undoCheck(purchases, g.id, Date.now(), settings.grnUndoHours) === null && (
            <button type="button" className="linkbtn" aria-label={`Undo ${g.grnNo}`} onClick={() => startUndo(g)}>Undo</button>
          )}
        </InfoCard>
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
        <FlowSheet title="GRN" {...shared} onBack={() => { setUndoing(null); setStep('recent'); }}>
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

  // ----- Recent GRNs -----
  if (step === 'recent') {
    return (
      <>
        <FlowSheet title="GRN" {...shared} onBack={toList}>
          <RejectionNotices />
          {recentList || <p className="flow-hint">No GRNs yet.</p>}
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
          extra={grn && undoCheck(purchases, grn.id, Date.now(), settings.grnUndoHours) === null
            ? <button type="button" className="linkbtn flow__back" aria-label={`Undo ${saved.no}`} onClick={() => startUndo(grn)}>Undo</button> : undefined}>
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
          extra={open.length > 0 && recent.length > 0 ? <button type="button" className="linkbtn flow__back" onClick={() => setStep('recent')}>Recent GRNs</button> : undefined}>
          <RejectionNotices />
          {open.length === 0 ? (
            <>
              <p className="flow-hint">Nothing on order. Place a purchase order first; goods are received against it.</p>
              {recentList}
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
  const of = check.needsApproval ? 4 : 3;
  const toPick = open.length === 1 ? undefined : toList; // one order: the list was skipped

  // ----- 2 Check each item -----
  if (step === 'check' && lines.length > 0) {
    const i = Math.min(at, lines.length - 1);
    const l = lines[i];
    const c = check.lines[i];
    const unitWord = l.unit.id === 'pack' ? word(l.expectedInUnit, 'pack', 'packs') : unitName(l.unit);
    const last = i === lines.length - 1;
    const here = c.match === 'ok' ? 'ok' : 'warn';
    return (
      <>
        <FlowSheet title={title} {...shared} step={{ index: 2, of, label: 'Check each item' }}
          onBack={i > 0 ? () => { setAt(i - 1); setError(''); } : toPick}
          primary={{ label: c.match === 'ok' ? '✓ All came' : last ? 'Review' : 'Next item', onClick: () => { if (!received()) return; if (last) setStep('review'); else setAt(i + 1); setError(''); } }}
          extra={<button type="button" className="linkbtn flow__back" onClick={() => { setAmounts({}); setError(''); setStep('review'); }}>Received everything</button>}>
          <RejectionNotices />
          <div className="flow__dots" aria-hidden>
            {lines.map((x, k) => <span key={x.row.id} className={`flow__dot${k === i ? ' flow__dot--on' : ''}${check.lines[k].match !== 'ok' ? ' flow__dot--warn' : ''}`} />)}
          </div>
          <p className="flow-hint">Item {i + 1} of {lines.length}</p>
          <InfoCard name={l.row.name} tone={here} line={`Expected ${l.expectedInUnit} ${unitWord}`}
            aside={c.match === 'ok' ? '✓' : `${c.match} ${diff(c, l)}`} label={`${l.row.name}: ${c.match === 'ok' ? 'as ordered' : c.match}`} />
          <BigStepper value={typed(l)} unit={l.unit.id === 'pack' ? 'packs' : unitName(l.unit)} tone={here}
            label={l.unit.id === 'pack' ? `Packs of ${l.row.name}` : `${unitName(l.unit)} of ${l.row.name}`}
            lessLabel={`One less of ${l.row.name}`} moreLabel={`One more of ${l.row.name}`}
            onText={(text) => { setAmounts({ ...amounts, [l.row.id]: text }); setError(''); }} onBump={(by) => bump(l, by)} />
        </FlowSheet>
        {pins}
      </>
    );
  }

  // ----- 4 Approve (a manager decides) -----
  if (step === 'decide' && deciding) {
    return (
      <>
        <FlowSheet title={title} {...shared} step={{ index: 4, of: 4, label: 'Manager decides' }}
          onBack={() => { setDeciding(null); setStep('review'); }}
          primary={{ label: 'Approve', onClick: () => finish(deciding), disabled: !choiceReady }}
          extra={<button type="button" className="linkbtn flow__back" onClick={notApproved}>Don't approve</button>}>
          <section aria-label="Manager decision" className="flow__list">
            <p className="flow-hint">This delivery differs from {order.poNo}:</p>
            {check.lines.filter((c) => c.match !== 'ok').map((c) => {
              const l = lines.find((x) => x.row.id === c.itemId)!;
              return <InfoCard key={c.itemId} name={l.row.name} tone="warn" line={`Expected ${l.expectedInUnit} · got ${round(c.received * l.row.packQty / l.unit.base)}`} aside={`${c.match} ${diff(c, l)}`} />;
            })}
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

  // ----- 3 Review -----
  return (
    <>
      <FlowSheet title={title} {...shared} step={{ index: 3, of, label: 'Review' }}
        onBack={() => { setStep('check'); setAt(Math.max(0, lines.length - 1)); setError(''); }}
        primary={{ label: check.needsApproval ? 'Manager approves' : 'Save GRN', onClick: toApproval, disabled: lines.length === 0 }}>
        <RejectionNotices />
        <ul className="flow__list flow__plain" aria-label="What came">
          {lines.map((l, i) => {
            const c = check.lines[i];
            return (
              <li key={l.row.id}>
                <InfoCard name={l.row.name} tone={c.match === 'ok' ? 'ok' : 'warn'}
                  line={`Expected ${l.expectedInUnit} · got ${round(c.received * l.row.packQty / l.unit.base)} ${l.unit.id === 'pack' ? word(round(c.received), 'pack', 'packs') : unitName(l.unit)}`}
                  aside={c.match === 'ok' ? '✓' : `${c.match} ${diff(c, l)}`} label={`${l.row.name}: ${c.match === 'ok' ? 'as ordered' : c.match}`} />
              </li>
            );
          })}
        </ul>
        <p className="flow__total" aria-label="Delivery total">
          Expected {totals.expected} {word(totals.expected, 'pack', 'packs')} · Received {totals.received} {word(totals.received, 'pack', 'packs')}
        </p>
      </FlowSheet>
      {pins}
    </>
  );
}
