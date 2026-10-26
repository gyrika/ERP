import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { dishKey } from '../domain/kitchen.ts';
import type { Actor } from '../domain/auth.ts';
import { menuItems } from '../domain/menu.ts';
import { formatQuantity } from '../domain/quantity.ts';
import type { BaseUnit } from '../domain/inventoryData.ts';
import { wasteUsage } from '../domain/stockUsage.ts';
import {
  WASTE_REASONS, checkWaste, dishesLeftToWaste, matchesWaste, wasteChoices, type WasteChoice, type WasteReason,
} from '../domain/waste.ts';
import { recordWaste, useCatalog, useCostContext } from '../services/inventoryStore.ts';
import { NumberInput } from './NumberInput.tsx';
import { readAll, subscribeEvents } from './eventLog.ts';

/**
 * The bin (manager mode). Serves the manager: something was burnt, dropped or went off,
 * and stock must know. Already knows what it was; needs only: what, how much, why.
 * Type to find it (dish, semi-processed or raw), set the amount, tap a reason, Waste.
 * Stock goes down through the recipes, like a sale; Undo in the toast.
 * Finished dishes are made to order, so the bin offers only those the kitchen made today, up to
 * how many are left (SCRUM-183): a pizza never made cannot be thrown away.
 */
export const BinIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6" />
  </svg>
);

const UNIT_WORD: Record<string, string> = { pcs: 'pcs', g: 'g', ml: 'ml', sheets: 'sheets' };
const isBase = (u: string): u is BaseUnit => u in UNIT_WORD;

/** Dishes made today and not yet wasted, kept fresh as the kitchen works. */
function useDishesLeft(): Map<string, number> {
  const [left, setLeft] = useState(() => dishesLeftToWaste(readAll(), Date.now()));
  useEffect(() => subscribeEvents(() => setLeft(dishesLeftToWaste(readAll(), Date.now()))), []);
  return left;
}
const keyOf = (c: WasteChoice) => (c.what.kind === 'dish' ? dishKey(c.what.itemId, c.what.size) : null);

export function WasteSheet({ actor, onClose, onWasted }: {
  actor: Actor;
  onClose: () => void;
  /** After recording: what to say, and its Undo. */
  onWasted: (message: string, undo: () => void) => void;
}) {
  const { answers } = useCostContext();
  const { items } = useCatalog(); // the price list, without archived items
  const left = useDishesLeft();
  const choices = useMemo(
    () => wasteChoices(menuItems(), answers, items).filter((c) => { const k = keyOf(c); return k === null || left.has(k); }),
    [answers, items, left],
  );
  const leftOf = (c: WasteChoice) => { const k = keyOf(c); return k === null ? null : left.get(k) ?? 0; };
  const [query, setQuery] = useState('');
  /** One kind at a time when tapped, else everything; typing searches within it. */
  const [group, setGroup] = useState<WasteChoice['group'] | null>(null);
  const [active, setActive] = useState(0);
  const [picked, setPicked] = useState<WasteChoice | null>(null);
  const [qty, setQty] = useState('1');
  const [reason, setReason] = useState<WasteReason | null>(null);
  const [note, setNote] = useState('');
  const qtyRef = useRef<HTMLInputElement>(null);

  const found = useMemo(
    () => choices.filter((c) => (!group || c.group === group) && matchesWaste(c, query)).slice(0, 60),
    [choices, query, group],
  );
  useEffect(() => setActive(0), [query, group]);

  const amount = Number(qty);
  const takes = useMemo(
    () => (picked && amount > 0 ? wasteUsage(picked.what, amount, answers) : []),
    [picked, amount, answers],
  );
  const most = picked ? leftOf(picked) : null;
  const problem = !picked ? 'Choose what was thrown away'
    : most !== null && amount > most ? `Only ${most} made today`
    : checkWaste(picked.what, amount, reason, reason === 'other' ? note : undefined, picked.name);

  const pick = (c: WasteChoice) => {
    setPicked(c);
    setQty(c.what.kind === 'dish' ? '1' : '');
    setTimeout(() => qtyRef.current?.focus(), 0);
  };

  const submit = () => {
    if (!picked || problem) return;
    const undo = recordWaste(picked, amount, reason as WasteReason, reason === 'other' ? note : '', actor);
    const how = picked.what.kind === 'dish' ? `${amount} × ` : isBase(picked.unit) ? `${formatQuantity(amount, picked.unit)} ` : `${amount} ${picked.unit} `;
    onWasted(`Wasted ${how}${picked.name}`, undo);
  };

  // Keys: arrows + Enter pick from the list; 1-6 pick a reason (outside a field); Enter wastes.
  const onKeyDown = (e: KeyboardEvent) => {
    if (!picked) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, found.length - 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
      else if (e.key === 'Enter' && found[active]) { e.preventDefault(); pick(found[active]); }
      return;
    }
    if (e.key === 'Enter') { e.preventDefault(); submit(); return; }
    const r = WASTE_REASONS[Number(e.key) - 1];
    if (r && !(e.target instanceof HTMLInputElement)) { e.preventDefault(); setReason(r.id); }
  };

  const name = (id: string) => items.find((i) => i.id === id);

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="sheet waste" role="dialog" aria-modal="true" aria-label="Waste" onKeyDown={onKeyDown}>
        <div className="sheet__body">
          <div className="sheet__title">
            <h1>Waste</h1>
            <span>Thrown away, not sold. Stock goes down through the recipes.</span>
          </div>

          {!picked ? (
            <section className="group">
              <div className="chips" role="group" aria-label="Kind">
                {(['Finished', 'Semi-processed', 'Raw'] as const).map((g) => (
                  <button key={g} type="button" className="chip" aria-pressed={group === g} onClick={() => setGroup(group === g ? null : g)}>
                    {g === 'Raw' ? 'Raw materials' : g}
                  </button>
                ))}
              </div>
              <input
                className="note"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="What was thrown away? Pizza, dough, flour, cheese…"
                aria-label="Find an item"
                autoFocus
              />
              <ul className="waste__list" role="listbox" aria-label="Items">
                {found.map((c, i) => (
                  <li key={c.key}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={i === active}
                      className="waste__row"
                      onClick={() => pick(c)}
                    >
                      <span>{c.name}</span>
                      <span className="waste__group">{leftOf(c) !== null ? `${leftOf(c)} made today` : c.group}</span>
                    </button>
                  </li>
                ))}
                {found.length === 0 && (
                  <li className="waste__none">{group === 'Finished' && left.size === 0 ? 'No dish made today yet' : 'Nothing called that'}</li>
                )}
              </ul>
            </section>
          ) : (
            <>
              <section className="group">
                <h2>{picked.group}</h2>
                <div className="waste__picked">
                  <span className="waste__name">{picked.name}</span>
                  <button type="button" className="linkbtn" onClick={() => { setPicked(null); setReason(null); }}>Change</button>
                </div>
              </section>

              <section className="group">
                <h2>How much</h2>
                <label className="waste__qty">
                  <NumberInput
                    ref={qtyRef}
                    className="note"
                    value={qty}
                    onText={setQty}
                    aria-label={`How much, in ${picked.unit}`}
                  />
                  <span>{picked.unit}</span>
                </label>
              </section>

              <section className="group">
                <h2>Why</h2>
                <div className="chips">
                  {WASTE_REASONS.map((r, i) => (
                    <button key={r.id} type="button" className="chip" aria-pressed={reason === r.id} onClick={() => setReason(r.id)}>
                      <kbd>{i + 1}</kbd>{r.label}
                    </button>
                  ))}
                </div>
                {reason === 'other' && (
                  <input
                    className="note"
                    type="text"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="What happened"
                    aria-label="What happened"
                    maxLength={200}
                    autoFocus
                  />
                )}
              </section>

              <section className="group" aria-label="Takes from stock">
                <h2>Takes from stock</h2>
                {takes.length > 0 ? (
                  <ul className="waste__takes">
                    {takes.map((t) => {
                      const item = name(t.inventoryId);
                      return (
                        <li key={t.inventoryId}>
                          <span>{item?.name ?? t.inventoryId}</span>
                          <span className="num">{item ? formatQuantity(t.qtyBaseUnits, item.baseUnit) : t.qtyBaseUnits}</span>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className="waste__none">
                    {amount > 0 ? 'Nothing: no recipe for it yet. It is still recorded as waste.' : 'Enter how much'}
                  </p>
                )}
              </section>
            </>
          )}
        </div>

        <div className="sheet__foot">
          <button type="button" className="cta cta--danger" disabled={Boolean(problem)} onClick={submit}>
            {picked && !problem ? 'Waste' : problem}
          </button>
        </div>
      </div>
    </>
  );
}
