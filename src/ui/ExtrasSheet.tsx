import { useEffect, useRef, useState } from 'react';
import { canHalve, leaveOutsOf, lineItemName } from '../domain/halves.ts';
import { itemById, menuItems } from '../domain/menu.ts';
import { fmt, unitPrice } from '../domain/money.ts';
import { alonePrice, pickable } from '../domain/combos.ts';
import type { Combo, LineSpec, MenuItem, OrderLine, SizeId } from '../domain/types.ts';

interface Props {
  item: MenuItem;
  /** Present when editing an existing order line. */
  line?: OrderLine;
  /** Default size when adding from the menu. */
  size?: SizeId;
  /**
   * Manager changing a line already sent to the kitchen: a short reason is
   * required, "Remove" becomes "Cancel item", and both go to the event log.
   */
  manager?: boolean;
  /** A dish in a combo box (SCRUM-231): its combo, so the pick can be changed to another of its slot. */
  combo?: Combo;
  onSubmit: (spec: LineSpec, reason: string) => void;
  onRemove?: (reason: string) => void;
  onClose: () => void;
}

const REASONS = ['Customer changed mind', 'Wrong item entered', 'Out of stock'];

const toggle = (list: string[], id: string): string[] =>
  list.includes(id) ? list.filter((x) => x !== id) : [...list, id];

/** Modifiers appear only after the item is chosen: big chips, nothing preselected but the size. */
export function ExtrasSheet({ item: start, line, size, manager = false, combo, onSubmit, onRemove, onClose }: Props) {
  /** In a box the size and quantity are the box's; only the pick, extras and leave-outs change. */
  const box = line?.box;
  const slot = box && combo?.slots[box.slot];
  const [pickId, setPickId] = useState(start.id);
  const item = pickId === start.id ? start : itemById(pickId);
  const [sz, setSz] = useState<SizeId | undefined>(
    line?.size ?? size ?? (item.variants ? (item.variants.find((v) => v.id === 'M') ?? item.variants[0]).id : undefined),
  );
  const [adds, setAdds] = useState<string[]>(line?.adds ?? []);
  const [outs, setOuts] = useState<string[]>(line?.outs ?? []);
  /** Half-and-half: the other half's item id (pizzas only). */
  const [half, setHalf] = useState<string | undefined>(line?.half);
  const [halvesOpen, setHalvesOpen] = useState(Boolean(line?.half));
  const [note, setNote] = useState(line?.note ?? '');
  const [noteOpen, setNoteOpen] = useState(Boolean(line?.note));
  const [qty, setQty] = useState(line?.qty ?? 1);
  const [reasonPick, setReasonPick] = useState<string | null>(null);
  const [otherReason, setOtherReason] = useState('');
  const [needReason, setNeedReason] = useState(false);
  const submitRef = useRef<HTMLButtonElement>(null);
  const reasonRef = useRef<HTMLDivElement>(null);

  const other = half ? itemById(half) : null;
  const halves = box ? [] : menuItems().filter((m) => canHalve(item, m) && !m.hidden && (!m.soldOut || m.id === half));
  const picks = slot ? pickable(slot, menuItems()).filter((m) => m.id !== start.id).concat(start).sort((a, b) =>
    Object.keys(slot.options).indexOf(a.id) - Object.keys(slot.options).indexOf(b.id)) : [];
  const choose = (m: MenuItem) => {
    // Extras and leave-outs the new pick does not have drop off (as swapPick in combos.ts).
    setPickId(m.id);
    setAdds(adds.filter((id) => m.adds.some((o) => o.id === id)));
    const allowed = leaveOutsOf(m, null).map((o) => o.id);
    setOuts(outs.filter((id) => allowed.includes(id)));
  };
  const boxMark = box && { ...box, extra: slot?.options[item.id] ?? (item.id === start.id ? box.extra : 0), alone: alonePrice(item, { size: sz }) };
  const leaveOut = leaveOutsOf(item, other);
  const title = lineItemName({ itemId: item.id, half });
  const pickHalf = (id: string | undefined) => {
    setHalf(id);
    // A leave-out only the old other half had no longer applies.
    const allowed = leaveOutsOf(item, id ? itemById(id) : null).map((o) => o.id);
    setOuts(outs.filter((o) => allowed.includes(o)));
  };
  const unit = unitPrice(item, { size: sz, adds, half, box: boxMark });
  const total = unit * qty;
  const variant = item.variants?.find((v) => v.id === sz);
  const editing = Boolean(line);

  useEffect(() => { submitRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const spec = (): LineSpec => ({
    itemId: item.id, qty: box ? 1 : qty, size: sz, adds, outs, ...(half ? { half } : {}), ...(note.trim() ? { note: note.trim() } : {}),
    ...(boxMark ? { box: boxMark } : {}),
  });
  const reason = reasonPick === 'Other' ? otherReason.trim() : (reasonPick ?? '');
  const sameAsLine = (s: LineSpec) =>
    line !== undefined && s.itemId === line.itemId && s.qty === line.qty && s.size === line.size && (s.half ?? '') === (line.half ?? '') && (s.note ?? '') === (line.note ?? '') &&
    [...s.adds].sort().join() === [...line.adds].sort().join() && [...s.outs].sort().join() === [...line.outs].sort().join();
  // Manager actions never fail silently: without a reason they say so and point at the reasons.
  const withReason = (act: () => void) => {
    if (manager && !reason) {
      setNeedReason(true);
      (reasonRef.current?.querySelector(reasonPick === 'Other' ? 'input' : 'button') as HTMLElement | null)?.focus();
      return;
    }
    act();
  };
  const unchanged = manager && sameAsLine(spec()); // nothing to save yet
  const submit = () => { if (!unchanged) withReason(() => onSubmit(spec(), reason)); };
  const pickReason = (r: string) => { setReasonPick(r); setNeedReason(false); };

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="sheet" role="dialog" aria-modal="true" aria-label={`${item.name.en} extras`}>
        <div className="sheet__body">
          <div className="sheet__title">
            <h1>{title}</h1>
            <span className="num">
              {box ? `${variant ? `${variant.label} · ` : ''}in the ${box.name}${boxMark!.extra ? ` · +${fmt(boxMark!.extra)}` : ''}`
                : `${variant ? `${variant.label} · ` : ''}${fmt(unitPrice(item, { size: sz, adds: [], half }))}`}
            </span>
            {editing && onRemove && (
              <button
                type="button"
                className={`linkbtn${manager ? ' linkbtn--danger' : ''}`}
                onClick={() => withReason(() => onRemove(reason))}
              >
                {manager ? 'Cancel item' : box ? 'Remove the box' : 'Remove'}
              </button>
            )}
          </div>

          {manager && (
            <section className="group" ref={reasonRef}>
              <h2>Reason</h2>
              <div className="chips">
                {[...REASONS, 'Other'].map((r) => (
                  <button key={r} type="button" className="chip" aria-pressed={reasonPick === r} onClick={() => pickReason(r)}>
                    {r}
                  </button>
                ))}
              </div>
              {reasonPick === 'Other' && (
                <input
                  className="note"
                  value={otherReason}
                  onChange={(e) => { setOtherReason(e.target.value); setNeedReason(false); }}
                  placeholder="Short reason"
                  aria-label="Reason"
                  maxLength={80}
                  autoFocus
                />
              )}
              {needReason && <p className="reason-msg" role="alert">Pick a reason first</p>}
            </section>
          )}

          {picks.length > 1 && (
            <section className="group">
              <h2>Pick</h2>
              <div className="chips">
                {picks.map((m) => (
                  <button key={m.id} type="button" className="chip num" aria-pressed={item.id === m.id} onClick={() => choose(m)}>
                    {m.name.en}{slot!.options[m.id] ? ` · +${fmt(slot!.options[m.id])}` : ''}
                  </button>
                ))}
              </div>
            </section>
          )}

          {!box && item.variants && item.variants.length > 1 && (
            <section className="group">
              <h2>Size</h2>
              <div className="chips">
                {item.variants.map((v) => (
                  <button key={v.id} type="button" className="chip num" aria-pressed={sz === v.id} onClick={() => setSz(v.id)}>
                    {v.label}{v.hint ? ` ${v.hint}` : ''} · {fmt(unitPrice(item, { size: v.id, adds: [], half }))}
                  </button>
                ))}
              </div>
            </section>
          )}

          {halves.length > 0 && (
            <section className="group">
              <h2>Half &amp; half</h2>
              <div className="chips">
                {!halvesOpen ? (
                  <button type="button" className="chip" aria-expanded={false} onClick={() => setHalvesOpen(true)}>Half &amp; half…</button>
                ) : (
                  <>
                    <button type="button" className="chip" aria-pressed={!half} onClick={() => { pickHalf(undefined); setHalvesOpen(false); }}>Whole pizza</button>
                    {halves.map((m) => (
                      <button key={m.id} type="button" className="chip" aria-pressed={half === m.id} onClick={() => pickHalf(half === m.id ? undefined : m.id)}>
                        ½ {m.name.en}
                      </button>
                    ))}
                  </>
                )}
              </div>
            </section>
          )}

          {item.adds.length > 0 && (
            <section className="group">
              <h2>Add</h2>
              <div className="chips">
                {item.adds.map((o) => (
                  <button key={o.id} type="button" className="chip num" aria-pressed={adds.includes(o.id)} onClick={() => setAdds(toggle(adds, o.id))}>
                    {o.label} · {fmt(o.price)}
                  </button>
                ))}
              </div>
            </section>
          )}

          <section className="group">
            <h2>Leave out</h2>
            <div className="chips">
              {leaveOut.map((o) => (
                <button key={o.id} type="button" className="chip" aria-pressed={outs.includes(o.id)} onClick={() => setOuts(toggle(outs, o.id))}>
                  {o.label}
                </button>
              ))}
              <button type="button" className="chip" aria-pressed={noteOpen} onClick={() => setNoteOpen(!noteOpen)}>Note</button>
            </div>
            {noteOpen && (
              <input
                className="note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
                placeholder="e.g. cut in 8"
                aria-label="Note for the kitchen"
                autoFocus
              />
            )}
          </section>
        </div>

        <div className="sheet__foot">
          {!box && <div className="stepper">
            <button type="button" aria-label="Decrease quantity" onClick={() => setQty(Math.max(1, qty - 1))}>−</button>
            <span className="num" aria-live="polite">{qty}</span>
            <button type="button" aria-label="Increase quantity" onClick={() => setQty(qty + 1)}>+</button>
          </div>}
          <button ref={submitRef} type="button" className="cta num" disabled={unchanged} onClick={submit}>
            {manager ? 'Save change' : editing ? 'Update' : 'Add'}
            {/* In a box only what is added on top of the box price means anything to the customer. */}
            {box ? (total > box.share ? ` · +${fmt(total - box.share)}` : '') : ` · ${fmt(total)}`}
          </button>
        </div>
      </div>
    </>
  );
}
