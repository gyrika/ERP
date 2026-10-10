import { useEffect, useRef, useState } from 'react';
import { fmt, unitPrice } from '../domain/money.ts';
import type { LineSpec, MenuItem, OrderLine, SizeId } from '../domain/types.ts';

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
  onSubmit: (spec: LineSpec, reason: string) => void;
  onRemove?: (reason: string) => void;
  onClose: () => void;
}

const REASONS = ['Customer changed mind', 'Wrong item entered', 'Out of stock'];

const toggle = (list: string[], id: string): string[] =>
  list.includes(id) ? list.filter((x) => x !== id) : [...list, id];

/** Modifiers appear only after the item is chosen: big chips, nothing preselected but the size. */
export function ExtrasSheet({ item, line, size, manager = false, onSubmit, onRemove, onClose }: Props) {
  const [sz, setSz] = useState<SizeId | undefined>(
    line?.size ?? size ?? (item.variants ? (item.variants.find((v) => v.id === 'M') ?? item.variants[0]).id : undefined),
  );
  const [adds, setAdds] = useState<string[]>(line?.adds ?? []);
  const [outs, setOuts] = useState<string[]>(line?.outs ?? []);
  const [note, setNote] = useState(line?.note ?? '');
  const [noteOpen, setNoteOpen] = useState(Boolean(line?.note));
  const [qty, setQty] = useState(line?.qty ?? 1);
  const [reasonPick, setReasonPick] = useState<string | null>(null);
  const [otherReason, setOtherReason] = useState('');
  const [needReason, setNeedReason] = useState(false);
  const submitRef = useRef<HTMLButtonElement>(null);
  const reasonRef = useRef<HTMLDivElement>(null);

  const unit = unitPrice(item, { size: sz, adds });
  const total = unit * qty;
  const variant = item.variants?.find((v) => v.id === sz);
  const editing = Boolean(line);

  useEffect(() => { submitRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const spec = (): LineSpec => ({ itemId: item.id, qty, size: sz, adds, outs, ...(note.trim() ? { note: note.trim() } : {}) });
  const reason = reasonPick === 'Other' ? otherReason.trim() : (reasonPick ?? '');
  const sameAsLine = (s: LineSpec) =>
    line !== undefined && s.qty === line.qty && s.size === line.size && (s.note ?? '') === (line.note ?? '') &&
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
            <h1>{item.name.en}</h1>
            <span className="num">{variant ? `${variant.label} · ` : ''}{fmt(unitPrice(item, { size: sz, adds: [] }))}</span>
            {editing && onRemove && (
              <button
                type="button"
                className={`linkbtn${manager ? ' linkbtn--danger' : ''}`}
                onClick={() => withReason(() => onRemove(reason))}
              >
                {manager ? 'Cancel item' : 'Remove'}
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

          {item.variants && item.variants.length > 1 && (
            <section className="group">
              <h2>Size</h2>
              <div className="chips">
                {item.variants.map((v) => (
                  <button key={v.id} type="button" className="chip num" aria-pressed={sz === v.id} onClick={() => setSz(v.id)}>
                    {v.label}{v.hint ? ` ${v.hint}` : ''} · {fmt(v.price)}
                  </button>
                ))}
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
              {item.leaveOut.map((o) => (
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
          <div className="stepper">
            <button type="button" aria-label="Decrease quantity" onClick={() => setQty(Math.max(1, qty - 1))}>−</button>
            <span className="num" aria-live="polite">{qty}</span>
            <button type="button" aria-label="Increase quantity" onClick={() => setQty(qty + 1)}>+</button>
          </div>
          <button ref={submitRef} type="button" className="cta num" disabled={unchanged} onClick={submit}>
            {manager ? 'Save change' : editing ? 'Update' : 'Add'} · {fmt(total)}
          </button>
        </div>
      </div>
    </>
  );
}
