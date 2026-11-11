import { useEffect, useState, type FormEvent } from 'react';
import { menuCost, type CostContext } from '../domain/costing.ts';
import { boxFoodCost, checkCombo, comboIdFor, MAX_SLOT_QTY, MAX_SLOTS, separatePrice } from '../domain/combos.ts';
import { comboEntries, menuItems } from '../domain/menu.ts';
import { fmt } from '../domain/money.ts';
import type { Category, Cents, Combo, ComboSlot, MenuItem, SizeId } from '../domain/types.ts';
import { currentCashier } from '../services/auth.ts';
import { appendEvent } from './eventLog.ts';
import { NumberInput } from './NumberInput.tsx';

/**
 * Build a combo (SCRUM-231). Serves a manager or the owner, who thinks of a combo as a box: what
 * goes in it, which dishes the customer may pick instead, one price. The single next thing: see
 * what the shop keeps before it goes on sale. Saving is one audited `menu.combo_set` event with
 * an Undo; the Register's Combos tab shows it at once and one tap sells it.
 */
const SECTIONS: { id: Category; one: string }[] = [
  { id: 'pizza', one: 'Pizza' }, { id: 'burger', one: 'Burger' }, { id: 'pasta', one: 'Pasta' },
];

/** "3600" → cents, whole rupees only. */
const toCents = (text: string): Cents | null => {
  const t = text.replace(/[,\s]/g, '');
  return /^\d{1,6}$/.test(t) ? Number(t) * 100 : null;
};

export const saveCombo = (comboId: string, before: Combo | null, after: Combo | null) =>
  appendEvent({ type: 'menu.combo_set', at: Date.now(), orderNumber: 0, actor: currentCashier(), itemId: comboId, before, after });

/** A slot being edited: its options as on/extra/off, and the one extra amount its dearer picks cost. */
interface SlotDraft {
  category: Category;
  qty: number;
  size?: SizeId;
  usual: string;
  /** Item id → 'in' (in the price) or 'more' (costs `extra` more). Missing: not offered. */
  picks: Record<string, 'in' | 'more'>;
  extra: string;
}

const offered = (category: Category, size: SizeId | undefined) =>
  menuItems().filter((m) => m.category === category && !m.hidden && !m.removed && (!m.variants || m.variants.some((v) => v.id === size)));

const defaultSize = (m: MenuItem): SizeId | undefined => (m.variants ? (m.variants.find((v) => v.id === 'M') ?? m.variants[0]).id : undefined);

const toDraft = (s: ComboSlot): SlotDraft => {
  const usual = menuItems().find((m) => m.id === s.usual);
  const extras = Object.values(s.options).filter((v) => v > 0);
  return {
    category: usual?.category ?? 'pizza', qty: s.qty, size: s.size, usual: s.usual,
    picks: Object.fromEntries(Object.entries(s.options).map(([id, v]) => [id, v > 0 ? 'more' : 'in'])),
    extra: extras.length ? String(extras[0] / 100) : '',
  };
};

const toSlot = (d: SlotDraft): ComboSlot | string => {
  const extra = toCents(d.extra);
  const more = Object.values(d.picks).includes('more');
  if (more && (extra === null || extra === 0)) return 'Say how much more the dearer picks cost.';
  return {
    qty: d.qty, ...(d.size ? { size: d.size } : {}), usual: d.usual,
    options: Object.fromEntries(Object.entries(d.picks).map(([id, p]) => [id, p === 'more' ? extra! : 0])),
  };
};

function SlotEditor({ d, onChange, onRemove }: { d: SlotDraft; onChange: (d: SlotDraft) => void; onRemove: () => void }) {
  const dishes = offered(d.category, d.size);
  const choice = Object.keys(d.picks).length > 1;
  const sizes = menuItems().find((m) => m.id === d.usual)?.variants ?? [];
  const cycle = (id: string) => {
    if (id === d.usual) return; // the usual is always in the price
    const now = d.picks[id];
    const picks = { ...d.picks };
    if (!now) picks[id] = 'in'; else if (now === 'in') picks[id] = 'more'; else delete picks[id];
    onChange({ ...d, picks });
  };
  const setSize = (size: SizeId) => {
    // Picks without that size drop off.
    const fit = new Set(offered(d.category, size).map((m) => m.id));
    onChange({ ...d, size, picks: Object.fromEntries(Object.entries(d.picks).filter(([id]) => fit.has(id))) });
  };
  return (
    <section className="group comboed__slot" aria-label={`${SECTIONS.find((s) => s.id === d.category)!.one} slot`}>
      <div className="comboed__slothead">
        <h2>{SECTIONS.find((s) => s.id === d.category)!.one}{d.size ? ` · ${sizes.find((v) => v.id === d.size)?.label ?? d.size}` : ''}</h2>
        <div className="stepper" role="group" aria-label="How many">
          <button type="button" aria-label="One less" onClick={() => onChange({ ...d, qty: Math.max(1, d.qty - 1) })}>−</button>
          <span className="num" aria-live="polite">{d.qty}</span>
          <button type="button" aria-label="One more" onClick={() => onChange({ ...d, qty: Math.min(MAX_SLOT_QTY, d.qty + 1) })}>+</button>
        </div>
        <button type="button" className="linkbtn" onClick={onRemove}>Take out</button>
      </div>
      <div className="chips" role="group" aria-label="Kind of slot">
        <button type="button" className="chip" aria-pressed={!choice} onClick={() => onChange({ ...d, picks: { [d.usual]: 'in' } })}>Always one dish</button>
        <button type="button" className="chip" aria-pressed={choice}
          onClick={() => onChange({ ...d, picks: Object.fromEntries(dishes.map((m) => [m.id, d.picks[m.id] ?? 'in'])) })}>Customer picks</button>
      </div>
      {sizes.length > 1 && (
        <div className="chips" role="group" aria-label="Size">
          {sizes.map((v) => <button key={v.id} type="button" className="chip" aria-pressed={d.size === v.id} onClick={() => setSize(v.id)}>{v.label}</button>)}
        </div>
      )}
      {!choice ? (
        <div className="chips" role="group" aria-label="Which dish">
          {dishes.map((m) => (
            <button key={m.id} type="button" className="chip" aria-pressed={d.usual === m.id}
              onClick={() => onChange({ ...d, usual: m.id, picks: { [m.id]: 'in' } })}>{m.name.en}</button>
          ))}
        </div>
      ) : (
        <>
          <p className="comboed__hint">Tap a dish: in the price → costs more → not offered. The usual is what one tap on the Register gives.</p>
          <div className="chips" role="group" aria-label="Which dishes the customer can pick">
            {dishes.map((m) => {
              const p = d.picks[m.id];
              return (
                <button key={m.id} type="button" className={`chip comboed__pick comboed__pick--${p ?? 'off'}`} onClick={() => cycle(m.id)}
                  aria-label={`${m.name.en}: ${p === 'in' ? 'in the price' : p === 'more' ? 'costs more' : 'not offered'}`}>
                  {m.name.en}{p === 'more' && <b> +{d.extra || '?'}</b>}{m.id === d.usual && <span className="comboed__usual">Usual</span>}
                </button>
              );
            })}
          </div>
          <div className="comboed__row">
            <label className="comboed__usualpick">Usual pick
              <select value={d.usual} onChange={(e) => onChange({ ...d, usual: e.target.value, picks: { ...d.picks, [e.target.value]: 'in' } })}>
                {dishes.filter((m) => d.picks[m.id] === 'in').map((m) => <option key={m.id} value={m.id}>{m.name.en}</option>)}
              </select>
            </label>
            {Object.values(d.picks).includes('more') && (
              <label className="comboed__usualpick">Dearer picks cost more by
                <NumberInput decimals={0} unit="Rs" value={d.extra} onText={(extra) => onChange({ ...d, extra })} aria-label="How much more the dearer picks cost" />
              </label>
            )}
          </div>
        </>
      )}
    </section>
  );
}

export function ComboEditor({ comboId, combo, ctx, onSaved, onClose }: {
  comboId: string | null; combo: Combo | null; ctx: CostContext;
  onSaved: (message: string, undo: () => void) => void; onClose: () => void;
}) {
  const [name, setName] = useState(combo?.name.en ?? '');
  const [price, setPrice] = useState(combo ? String(combo.price / 100) : '');
  const [slots, setSlots] = useState<SlotDraft[]>(() => combo?.slots.map(toDraft) ?? []);
  const [hidden, setHidden] = useState(Boolean(combo?.hidden));
  const [error, setError] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const addSlot = (category: Category) => {
    const first = menuItems().find((m) => m.category === category && !m.hidden && !m.removed);
    if (!first || slots.length >= MAX_SLOTS) return;
    setSlots([...slots, { category, qty: 1, size: defaultSize(first), usual: first.id, picks: { [first.id]: 'in' }, extra: '' }]);
  };

  const build = (): Combo | string => {
    const built: ComboSlot[] = [];
    for (const d of slots) {
      const s = toSlot(d);
      if (typeof s === 'string') return s;
      built.push(s);
    }
    const cents = toCents(price);
    if (cents === null) return 'The price is whole rupees, like 3600.';
    const c: Combo = { name: { ...combo?.name, en: name.trim() }, price: cents, slots: built, ...(hidden ? { hidden: true } : {}) };
    const bad = checkCombo(c, menuItems());
    return bad ? `${bad[0].toUpperCase()}${bad.slice(1)}.` : c;
  };

  // The picture beside the price: what the usual box costs bought alone, and what the shop keeps.
  const draft = build();
  const live = typeof draft === 'string' ? null : draft;
  const alone = live ? separatePrice(live, menuItems()) : 0;
  const food = live ? boxFoodCost(live, (id, size) => menuCost(id, size, ctx)) : null;
  const keep = live && food?.complete ? live.price - food.cents : null;

  const save = (e: FormEvent) => {
    e.preventDefault();
    if (typeof draft === 'string') { setError(draft); return; }
    const id = comboId ?? comboIdFor(draft.name.en, new Set(comboEntries().map((x) => x.id)));
    saveCombo(id, combo, draft);
    onSaved(`Saved ${draft.name.en}${draft.hidden ? ' (off the Register)' : ''}`, () => saveCombo(id, draft, combo));
  };

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <form className="sheet menued comboed" role="dialog" aria-modal="true" aria-label={combo ? `Change ${combo.name.en}` : 'New combo'} onSubmit={save}>
        <div className="sheet__body">
          <div className="sheet__title">
            <h1>{combo ? combo.name.en : 'New combo'}</h1>
            {combo && comboId && (
              <button type="button" className="linkbtn linkbtn--danger" onClick={() => {
                saveCombo(comboId, combo, null);
                onSaved(`Deleted ${combo.name.en}`, () => saveCombo(comboId, null, combo));
              }}>Delete</button>
            )}
          </div>

          <div className="menued__grid">
            <label>Name<input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} required placeholder="e.g. Family Box" /></label>
            <label>Box price<NumberInput decimals={0} unit="Rs" value={price} onText={setPrice} aria-label="Box price" /></label>
          </div>

          {slots.map((d, i) => (
            <SlotEditor key={i} d={d} onChange={(n) => setSlots(slots.map((x, j) => (j === i ? n : x)))} onRemove={() => setSlots(slots.filter((_, j) => j !== i))} />
          ))}

          <section className="group">
            <h2>{slots.length ? 'Put more in the box' : 'Put dishes in the box'}</h2>
            <div className="chips">
              {SECTIONS.map((s) => (
                <button key={s.id} type="button" className="chip chip--solid" disabled={slots.length >= MAX_SLOTS} onClick={() => addSlot(s.id)}>+ {s.one}</button>
              ))}
            </div>
            <p className="comboed__hint">Drinks are not on the menu yet, so they cannot go in a box.</p>
          </section>

          {live && (
            <section className="group comboed__money" aria-label="What the box earns">
              <div className="comboed__bars" role="img"
                aria-label={`Bought separately ${fmt(alone)}. Box price ${fmt(live.price)}.${keep !== null ? ` Food cost ${fmt(food!.cents)}, the shop keeps ${fmt(keep)}.` : ''}`}>
                <span className="comboed__barlabel num">Bought separately <b>{fmt(alone)}</b></span>
                <span className="comboed__bar"><span style={{ width: '100%' }} className="comboed__bar--alone" /></span>
                <span className="comboed__barlabel num">Box price <b>{fmt(live.price)}</b></span>
                <span className="comboed__bar">
                  {keep !== null ? (
                    <>
                      <span className="comboed__bar--cost" style={{ width: `${Math.min(100, (food!.cents / Math.max(alone, live.price)) * 100)}%` }} />
                      <span className="comboed__bar--keep" style={{ width: `${Math.max(0, (keep / Math.max(alone, live.price)) * 100)}%` }} />
                    </>
                  ) : <span className="comboed__bar--price" style={{ width: `${Math.min(100, (live.price / Math.max(alone, live.price)) * 100)}%` }} />}
                </span>
              </div>
              {keep !== null
                ? <p className={`comboed__keep num${keep < 0 ? ' comboed__keep--loss' : ''}`}>{keep < 0 ? `The box loses Rs ${fmt(-keep)}` : `The shop keeps Rs ${fmt(keep)} a box`}</p>
                : <p className="comboed__hint">What the shop keeps shows once every dish in the box has a costed recipe.</p>}
              <p className="comboed__hint num">
                {alone > live.price ? `The customer saves Rs ${fmt(alone - live.price)} on the usual box.` : 'The box costs no less than its dishes bought alone.'}
              </p>
            </section>
          )}

          {combo && (
            <label className="menued__check">
              <input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} />
              Take it off the Register <span>(kept, so it can come back; old orders keep it)</span>
            </label>
          )}
          {error && <p className="reason-msg" role="alert">{error}</p>}
        </div>
        <div className="sheet__foot menued__foot">
          <button type="button" className="linkbtn" onClick={onClose}>Cancel</button>
          <button type="submit" className="cta">{combo ? 'Save' : 'Put on the menu'}</button>
        </div>
      </form>
    </>
  );
}
