import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import {
  checkUnitName, countedBase, gapOf, isBigGap, reasonText, reasonsFor, unitsOf, type CountEntry, type DueCount, type GapReason, type Tier,
} from '../domain/counting.ts';
import { formatQuantity } from '../domain/quantity.ts';
import { fmt } from '../domain/money.ts';
import { MAX_NOTE } from '../domain/gapReview.ts';
import { learnUnit, recordCount, recordSemiCount, useStockSettings, useWarehouseStock, type InventoryRow } from '../services/inventoryStore.ts';
import { PREP_STOCK } from '../domain/prep.ts';
import { isManagerPhone } from '../services/pairing.ts';
import { keepPhoto, newPhotoId, shrinkPhoto } from '../services/photos.ts';
import { NumberInput } from './NumberInput.tsx';
import { activeWarehouses, homeOf, placedIn, roundsByWarehouse, type StockEntry } from '../domain/warehouses.ts';

/**
 * Count day (SCRUM-89). Serves the manager in front of the shelf: one item per
 * screen, they type only what is left, in whatever is in their hand (packs, an
 * opened pack by eye or weighed, a tray). They never see what the app expects
 * until they have counted (a blind count), so the number is theirs. A match is
 * saved at once; a gap beyond the allowance asks why before the item is done.
 * Stop any time (×, Esc or a tap outside): what is saved stays saved.
 * On the manager's phone a big gap also needs a photo of the shelf (SCRUM-94): the
 * camera opens straight away, the photo is shrunk on the phone and kept until the
 * cloud has it. (The counter PC has no camera, so it asks only for the reason.)
 */
const FRACTIONS = [{ v: 0.25, label: '¼' }, { v: 0.5, label: '½' }, { v: 0.75, label: '¾' }];
const TIER_LABEL: Record<Tier, string> = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' };
/** What the measured amount is called: weighed (g), measured (ml), or counted loose (pcs, sheets). */
const MEASURED: Record<string, string> = { g: 'Weighed', ml: 'Measured' };
/** The unit last used to measure an item, on this device only (a convenience: nothing breaks without it). */
const lastUnitKey = (itemId: string) => `cb.count.unit.${itemId}`;
const readLastUnit = (itemId: string): string | null => { try { return localStorage.getItem(lastUnitKey(itemId)); } catch { return null; } };
const keepLastUnit = (itemId: string, unit: string) => { try { localStorage.setItem(lastUnitKey(itemId), unit); } catch { /* private window */ } };
const number = (raw: string): number | null => (/^\d+(\.\d{1,3})?$/.test(raw.trim()) ? Number(raw.trim()) : null);

interface Done { name: string; gapCents: number; big: boolean; undo: () => void; index: number }
type Round = { id: string; name: string; items: DueCount[] };

/**
 * Counting goes warehouse by warehouse (SCRUM-186): the manager says which one they are standing
 * in and counts only what is kept there; then the next. Asked only when the items to count live
 * in more than one warehouse. An item kept in two is counted in each.
 */
export function CountFlow({ due, rows, onClose, photoRequired = isManagerPhone() }: {
  due: DueCount[]; rows: InventoryRow[]; onClose: () => void;
  /** A big gap needs a shelf photo (the manager's phone). */
  photoRequired?: boolean;
}) {
  const { warehouses, places, entries } = useWarehouseStock();
  /** A semi-processed item's stock entry (SCRUM-228: its due id is prep:<key>). */
  const semiOf = (id: string) => (id.startsWith(PREP_STOCK) ? entries.find((x) => x.key === `semi:${id.slice(PREP_STOCK.length)}`) ?? null : null);
  // Fixed when counting starts, so the list never shifts while it is being counted.
  const [rounds] = useState<Round[]>(() => roundsByWarehouse(warehouses, places, due.map((d) => {
    const semi = semiOf(d.id);
    if (semi) return { ...d, key: semi.key, total: semi.total };
    const row = rows.find((r) => r.id === d.id);
    return { ...d, key: `stock:${d.id}`, total: row?.counted ? row.onHandBaseUnits : null };
  })));
  const [where, setWhere] = useState<string | null>(() => (rounds.length === 1 ? rounds[0].id : null));
  const [index, setIndex] = useState(0);
  const [last, setLast] = useState<Done | null>(null);
  const [results, setResults] = useState<{ big: boolean; cents: number }[]>([]);
  /** What was counted where in this round ("wh-1:inv-0001"), so the next warehouse offers only what is left. */
  const [counted, setCounted] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const round = rounds.find((r) => r.id === where) ?? null;
  const list = round ? round.items : due;
  const current = list[index];
  const row = current && rows.find((r) => r.id === current.id);
  const semi = current ? semiOf(current.id) : null;
  const saved = (name: string, id: string) => (gapCents: number, big: boolean, undo: () => void) => {
    setResults([...results, { big, cents: gapCents }]);
    setLast({ name, gapCents, big, undo, index });
    if (where) setCounted((c) => new Set(c).add(`${where}:${id}`));
    setIndex(index + 1);
  };
  const short = results.filter((r) => r.cents < 0).reduce((s, r) => s + r.cents, 0);
  const left = (r: Round) => r.items.filter((i) => !counted.has(`${r.id}:${i.id}`)).length;
  const others = rounds.filter((r) => r.id !== where && left(r) > 0);
  const start = (id: string) => { setWhere(id); setIndex(0); setLast(null); };

  return (
    <div className="inv-modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <section className="inv-modal count" role="dialog" aria-modal="true" aria-label="Count">
        <button type="button" className="count__close" aria-label="Stop counting" onClick={onClose}>×</button>
        {last && (
          <p className="count__saved" role="status">
            {last.name}: {last.big ? `gap of Rs ${fmt(Math.abs(last.gapCents))} saved` : 'matches'}.
            <button type="button" className="linkbtn" onClick={() => {
              last.undo(); setResults(results.slice(0, -1)); setIndex(last.index); setLast(null);
              if (where) setCounted((c) => { const n = new Set(c); n.delete(`${where}:${list[last.index]?.id}`); return n; });
            }}>Undo</button>
          </p>
        )}
        {rounds.length > 1 && where === null ? (
          <div className="count__where">
            <h2>Which warehouse are you in?</h2>
            <p className="count__hint">Count what is on the shelves there; then the next one.</p>
            <div className="count__rooms" role="group" aria-label="Which warehouse">
              {rounds.map((r) => (
                <button key={r.id} type="button" className="flow-card count__room" onClick={() => start(r.id)}>
                  <span className="flow-card__name">{r.name}</span>
                  <span className="flow-card__line num">{r.items.length} to count</span>
                </button>
              ))}
            </div>
          </div>
        ) : semi ? (
          <CountSemi
            key={`${where}-${semi.key}-${index}`} entry={semi} due={current} position={`${index + 1} of ${list.length}`} photoRequired={photoRequired}
            warehouseId={where ?? undefined} onSaved={saved(semi.name, current.id)}
            onSkip={() => { setLast(null); setIndex(index + 1); }}
          />
        ) : row ? (
          <CountItem
            key={`${where}-${row.id}-${index}`} row={row} due={current} position={`${index + 1} of ${list.length}`} photoRequired={photoRequired}
            warehouseId={where ?? undefined} onSaved={saved(row.name, row.id)}
            onSkip={() => { setLast(null); setIndex(index + 1); }}
          />
        ) : (
          <div className="count__done">
            <h2>{round && rounds.length > 1 ? `${round.name} counted` : 'All counted'}</h2>
            <p>
              {results.length} {results.length === 1 ? 'item' : 'items'} counted
              {results.some((r) => r.big) ? `, ${results.filter((r) => r.big).length} with a gap` : ', no gaps'}
              {short < 0 ? ` · Rs ${fmt(-short)} short in all` : ''}.
            </p>
            {others.length > 0 && (
              <div className="count__rooms" role="group" aria-label="Count the next warehouse">
                {others.map((r) => (
                  <button key={r.id} type="button" className="flow-card count__room" onClick={() => start(r.id)}>
                    <span className="flow-card__name">Count {r.name}</span>
                    <span className="flow-card__line num">{left(r)} to count</span>
                  </button>
                ))}
              </div>
            )}
            <button type="button" className={others.length ? 'linkbtn' : 'insight__action'} autoFocus={!others.length} onClick={onClose}>{others.length ? 'Stop for now' : 'Close'}</button>
          </div>
        )}
      </section>
    </div>
  );
}

/**
 * One item's count. Also used inside the item's own sheet (SCRUM-97: `embedded`, no
 * header of its own and no Skip), so counting one item never leaves that item.
 */
export function CountItem({ row, due, position, photoRequired, onSaved, onSkip, embedded = false, warehouseId }: {
  row: InventoryRow; due: DueCount; position: string; photoRequired: boolean;
  onSaved: (gapCents: number, big: boolean, undo: () => void) => void; onSkip?: () => void;
  embedded?: boolean;
  /** The warehouse being counted (a count round); without it the item's own sheet asks, its home first. */
  warehouseId?: string;
}) {
  const units = unitsOf(row);
  const loose = units.filter((u) => !u.id.startsWith('unit:') && u.id !== 'pack');
  const [packs, setPacks] = useState('');
  const [packUnit, setPackUnit] = useState('pack');
  const [fraction, setFraction] = useState<number | null>(null);
  const [amount, setAmount] = useState('');
  // g, ml, pcs; the one this device last measured this item in, if it still applies.
  const [looseUnit, setLooseUnit] = useState(() => {
    const last = readLastUnit(row.id);
    return loose.some((u) => u.id === last) ? last! : loose[loose.length - 1].id;
  });
  const measured = MEASURED[row.baseUnit] ?? 'Counted loose';
  const [newUnit, setNewUnit] = useState<{ name: string; base: string } | null>(null);
  const [why, setWhy] = useState<{ counted: number; entries: CountEntry[] } | null>(null);
  const settings = useStockSettings();
  const [error, setError] = useState('');
  // Every count is of one warehouse (SCRUM-186): what is on that shelf, compared with what is placed there.
  const { warehouses, places } = useWarehouseStock();
  const key = `stock:${row.id}`;
  const [picked, setPicked] = useState(() => homeOf(warehouses, key));
  const where = warehouseId ?? picked;
  const whereName = warehouses.list.find((x) => x.id === where)?.name ?? '';
  const expected = placedIn(warehouses, places, key, row.onHandBaseUnits, where);
  const counting = { warehouseId: where, expected };
  const pickable = activeWarehouses(warehouses);

  const packUnitInfo = units.find((u) => u.id === packUnit)!;
  const entries = (): CountEntry[] | null => {
    const p = packs.trim() === '' ? 0 : number(packs);
    const a = amount.trim() === '' ? 0 : number(amount);
    if (p === null || a === null) return null;
    return [
      ...(p > 0 ? [{ unit: packUnit, qty: p }] : []),
      ...(fraction ? [{ unit: 'pack', qty: fraction }] : []),
      ...(a > 0 ? [{ unit: looseUnit, qty: a }] : []),
    ];
  };
  const typed = entries();
  const total = typed ? countedBase(typed, units) : null;
  const touched = packs.trim() !== '' || amount.trim() !== '' || fraction !== null;

  const next = (event: FormEvent) => {
    event.preventDefault();
    if (!typed || !touched) return setError('Type what is on the shelf. Nothing there? Type 0.');
    if (amount.trim() !== '') keepLastUnit(row.id, looseUnit);
    const counted = total!;
    const gap = gapOf(expected, counted, row, settings);
    if (row.counted && gap.big) { setWhy({ counted, entries: typed }); return; }
    onSaved(gap.valueCents, false, recordCount(row, typed, counted, null, due.tier, null, null, counting));
  };

  const saveWith = (reason: GapReason, photo: string | null, note: string | null) => {
    const gap = gapOf(expected, why!.counted, row, settings);
    let photoId: string | null = null;
    if (photo) { photoId = newPhotoId(); keepPhoto(photoId, photo); }
    onSaved(gap.valueCents, true, recordCount(row, why!.entries, why!.counted, reason, due.tier, photoId, note, counting));
  };

  const addUnit = () => {
    const name = newUnit!.name.trim();
    const wrong = checkUnitName(name, row);
    if (wrong) return setError(wrong);
    const base = number(newUnit!.base);
    if (!base) return setError(`Type how many ${row.baseUnit} one ${name} holds.`);
    learnUnit(row.id, name, base);
    setPackUnit(`unit:${name}`);
    setNewUnit(null);
    setError('');
  };

  const head = embedded ? null : (
    <header className="count__head">
      <span className="count__pos num">{position} · {TIER_LABEL[due.tier]}{due.state === 'overdue' ? ' · overdue' : due.state === 'never' ? ' · first count' : ''}{warehouseId ? ` · in ${whereName}` : ''}</span>
      <h2 className="count__name">{row.name}</h2>
    </header>
  );

  if (why) {
    const gap = gapOf(expected, why.counted, row, settings);
    return (
      <GapWhy head={head} name={row.name} delta={gap.delta} valueCents={gap.valueCents} unit={row.baseUnit} photoRequired={photoRequired}
        hint={`You counted ${formatQuantity(why.counted, row.baseUnit)}; sales and deliveries say ${formatQuantity(Math.max(0, expected), row.baseUnit)} in ${whereName}. Why?`}
        onSave={saveWith} onAgain={() => setWhy(null)} />
    );
  }

  return (
    <form className="count__item" onSubmit={next} aria-label={`Count ${row.name}`}>
      {head}

      {warehouseId === undefined && pickable.length > 1 && (
        <div className="count__row">
          <span className="count__label">Counting in</span>
          <div className="chips" role="group" aria-label="Which warehouse">
            {pickable.map((x) => (
              <button key={x.id} type="button" className="chip" aria-pressed={where === x.id} onClick={() => { setPicked(x.id); setError(''); }}>{x.name}</button>
            ))}
          </div>
        </div>
      )}

      {/* Most counts are measured (SCRUM-227): the scale's number first, big, and focused. */}
      <div className="count__row count__measure">
        <label className="count__field count__field--main">
          <span>{measured}</span>
          <NumberInput autoFocus value={amount} placeholder="0"
            onText={(text) => { setAmount(text); setFraction(null); setError(''); }} />
        </label>
        <div className="chips" role="group" aria-label={`${measured} in`}>
          {loose.map((u) => (
            <button key={u.id} type="button" className="chip" aria-pressed={looseUnit === u.id} onClick={() => setLooseUnit(u.id)}>{u.label}</button>
          ))}
        </div>
      </div>

      <div className="count__packs">
        <span className="count__label">Or count packs</span>
        <div className="count__row">
          <label className="count__field">
            <span>Full packs</span>
            <NumberInput value={packs} placeholder="0"
              onText={(text) => { setPacks(text); setError(''); }} />
          </label>
          <div className="chips" role="group" aria-label="Counted in">
            {units.filter((u) => u.id === 'pack' || u.id.startsWith('unit:')).map((u) => (
              <button key={u.id} type="button" className="chip" aria-pressed={packUnit === u.id} onClick={() => setPackUnit(u.id)}>{u.label}</button>
            ))}
            <button type="button" className="chip" aria-expanded={newUnit !== null} onClick={() => setNewUnit(newUnit ? null : { name: '', base: '' })}>Other unit…</button>
          </div>
        </div>

        {newUnit && (
          <div className="count__newunit">
            <label className="count__field"><span>Unit name</span>
              <input value={newUnit.name} placeholder="Tray" autoFocus onChange={(e) => { setNewUnit({ ...newUnit, name: e.target.value }); setError(''); }} />
            </label>
            <label className="count__field"><span>One {newUnit.name.trim() || 'of it'} holds ({row.baseUnit})</span>
              <NumberInput value={newUnit.base} onText={(text) => { setNewUnit({ ...newUnit, base: text }); setError(''); }} />
            </label>
            <button type="button" className="chip" onClick={addUnit}>Save unit</button>
          </div>
        )}

        <div className="count__row">
          <span className="count__label">Opened pack, by eye</span>
          <div className="chips" role="group" aria-label="Opened pack, by eye">
            {FRACTIONS.map((f) => (
              <button key={f.v} type="button" className="chip" aria-pressed={fraction === f.v}
                onClick={() => { setFraction(fraction === f.v ? null : f.v); setAmount(''); setError(''); }}>{f.label}</button>
            ))}
          </div>
        </div>
      </div>

      <p className="count__total num" aria-live="polite">
        {total !== null && touched ? `= ${formatQuantity(total, row.baseUnit)}` : ' '}
        {packs.trim() && packUnitInfo.id !== 'pack' ? ` (${packUnitInfo.label})` : ''}
      </p>
      {error && <p className="inv-modal__error" role="alert">{error}</p>}
      <div className="inv-modal__actions">
        {onSkip && <button type="button" className="inv-modal__cancel" onClick={onSkip}>Skip</button>}
        <button type="submit" className="insight__action">Next</button>
      </div>
    </form>
  );
}

/**
 * Why a count differs (a big gap): Spoiled, Spilled, Wrong entry or Other (with a note); on the
 * manager's phone a shelf photo next. Shared by raw items and semi-processed ones.
 */
function GapWhy({ head, name, delta, valueCents, unit, hint, photoRequired, onSave, onAgain }: {
  head: ReactNode; name: string; delta: number; valueCents: number; unit: string; hint: string; photoRequired: boolean;
  onSave: (reason: GapReason, photo: string | null, note: string | null) => void; onAgain: () => void;
}) {
  /** The reason is chosen; on the phone the shelf photo comes next. */
  const [proof, setProof] = useState<{ reason: GapReason; note: string | null; photo: string | null; busy: boolean } | null>(null);
  /** "Other" needs a note saying what happened: the note, while it is being written. */
  const [other, setOther] = useState<string | null>(null);
  const [error, setError] = useState('');
  const amount = formatAmount(Math.abs(delta), unit);
  const choose = (reason: GapReason, note: string | null = null) => (photoRequired ? setProof({ reason, note, photo: null, busy: false }) : onSave(reason, null, note));
  const took = async (file: File | undefined) => {
    if (!file || !proof) return;
    setProof({ ...proof, busy: true });
    setError('');
    try {
      setProof({ ...proof, photo: await shrinkPhoto(file), busy: false });
    } catch {
      setProof({ ...proof, busy: false });
      setError('That photo could not be read. Take it again.');
    }
  };

  if (proof) {
    return (
      <div className="count__why">
        {head}
        <p className={`count__gap count__gap--${delta < 0 ? 'short' : 'over'} num`}>
          {amount} {delta < 0 ? 'short' : 'more than expected'} · {reasonText(proof.reason, proof.note)}
        </p>
        <p className="count__hint">A photo of the shelf, so the owner sees what you saw.</p>
        {proof.photo && <img className="count__photo" src={`data:image/jpeg;base64,${proof.photo}`} alt={`Shelf photo of ${name}`} />}
        <label className={proof.photo ? 'chip count__camera' : 'cta count__camera'} aria-busy={proof.busy}>
          {proof.busy ? 'Getting the photo…' : proof.photo ? 'Take again' : 'Take a photo'}
          <input className="sr-only" type="file" accept="image/*" capture="environment" aria-label="Shelf photo"
            onChange={(e) => { void took(e.target.files?.[0]); e.target.value = ''; }} />
        </label>
        {error && <p className="inv-modal__error" role="alert">{error}</p>}
        <div className="inv-modal__actions">
          <button type="button" className="inv-modal__cancel" onClick={() => setProof(null)}>Back</button>
          <button type="button" className="insight__action" disabled={!proof.photo}
            onClick={() => onSave(proof.reason, proof.photo, proof.note)}>Save</button>
        </div>
      </div>
    );
  }

  return (
    <div className="count__why">
      {head}
      <p className={`count__gap count__gap--${delta < 0 ? 'short' : 'over'} num`}>
        {amount} {delta < 0 ? 'short' : 'more than expected'} · Rs {fmt(Math.abs(valueCents))}
      </p>
      <p className="count__hint">{hint}</p>
      {other === null ? (
        <div className="chips" role="group" aria-label="Why">
          {reasonsFor(delta).map((r) => (
            <button key={r.id} type="button" className="chip" onClick={() => (r.id === 'other' ? setOther('') : choose(r.id))}>{r.label}</button>
          ))}
        </div>
      ) : (
        <div className="count__other">
          <label className="inv-modal__field"><span>What happened?</span>
            <textarea className="inv-modal__input" rows={2} maxLength={MAX_NOTE} autoFocus value={other} aria-label="What happened"
              onChange={(e) => setOther(e.target.value)} />
          </label>
          <div className="inv-modal__actions">
            <button type="button" className="inv-modal__cancel" onClick={() => setOther(null)}>Back</button>
            <button type="button" className="insight__action" disabled={!other.trim()} onClick={() => choose('other', other.trim())}>Save</button>
          </div>
        </div>
      )}
      <button type="button" className="linkbtn" onClick={onAgain}>Count again</button>
    </div>
  );
}

/** A raw item's amount in its base unit ("1.2 kg"); a semi-processed item's in its own unit ("12 pcs"). */
const formatAmount = (qty: number, unit: string): string =>
  unit === 'g' || unit === 'ml' || unit === 'pcs' || unit === 'sheets' ? formatQuantity(qty, unit) : `${Math.round(qty * 1000) / 1000} ${unit}`;

/** The units a semi-processed item can be typed in, as a share of its own unit: kg and g, L and ml. */
const SEMI_UNITS: Record<string, { id: string; per: number }[]> = {
  kg: [{ id: 'kg', per: 1 }, { id: 'g', per: 0.001 }],
  g: [{ id: 'kg', per: 1000 }, { id: 'g', per: 1 }],
  L: [{ id: 'L', per: 1 }, { id: 'ml', per: 0.001 }],
  ml: [{ id: 'L', per: 1000 }, { id: 'ml', per: 1 }],
};

/**
 * One semi-processed item's count (SCRUM-228): the dough, the sauce. One box in its own unit, the
 * cursor in it; a big gap asks why, valued at its cost per unit. Only items made at least once
 * come here (their stock is tracked); it is counted where it is kept, like a raw item.
 */
function CountSemi({ entry, due, position, photoRequired, warehouseId, onSaved, onSkip }: {
  entry: StockEntry; due: DueCount; position: string; photoRequired: boolean; warehouseId?: string;
  onSaved: (gapCents: number, big: boolean, undo: () => void) => void; onSkip?: () => void;
}) {
  const settings = useStockSettings();
  const { warehouses, places } = useWarehouseStock();
  const where = warehouseId ?? homeOf(warehouses, entry.key);
  const whereName = warehouses.list.find((x) => x.id === where)?.name ?? '';
  const expected = placedIn(warehouses, places, entry.key, entry.total ?? 0, where);
  const units = SEMI_UNITS[entry.unit] ?? [{ id: entry.unit, per: 1 }];
  const [unit, setUnit] = useState(units[0].id);
  const [amount, setAmount] = useState('');
  const [error, setError] = useState('');
  const [why, setWhy] = useState<number | null>(null);
  const typed = number(amount);
  const counted = typed === null ? null : Math.round(typed * units.find((u) => u.id === unit)!.per * 1e6) / 1e6;
  const gapAt = (n: number) => {
    const delta = n - Math.max(0, expected);
    const valueCents = Math.round(delta * (entry.unitCents ?? 0));
    return { delta, valueCents, big: isBigGap(delta, expected, valueCents, settings) };
  };
  const record = (n: number, reason: GapReason | null, photo: string | null = null, note: string | null = null) => {
    let photoId: string | null = null;
    if (photo) { photoId = newPhotoId(); keepPhoto(photoId, photo); }
    const gap = gapAt(n);
    onSaved(gap.valueCents, reason !== null, recordSemiCount(entry.key.slice('semi:'.length), n, expected, gap.valueCents, entry.unit, reason, photoId, note, where));
  };
  const next = (event: FormEvent) => {
    event.preventDefault();
    if (amount.trim() === '' || counted === null) return setError(`Type how much ${entry.name} there is, in ${unit}. None? Type 0.`);
    if (gapAt(counted).big) { setWhy(counted); return; }
    record(counted, null);
  };

  const head = (
    <header className="count__head">
      <span className="count__pos num">{position} · Semi-processed{due.state === 'never' ? ' · first count' : ''}{warehouseId ? ` · in ${whereName}` : ''}</span>
      <h2 className="count__name">{entry.name}</h2>
    </header>
  );

  if (why !== null) {
    const gap = gapAt(why);
    return (
      <GapWhy head={head} name={entry.name} delta={gap.delta} valueCents={gap.valueCents} unit={entry.unit} photoRequired={photoRequired}
        hint={`You counted ${formatAmount(why, entry.unit)}; batches and sales say ${formatAmount(Math.max(0, expected), entry.unit)} in ${whereName}. Why?`}
        onSave={(reason, photo, note) => record(why, reason, photo, note)} onAgain={() => setWhy(null)} />
    );
  }

  return (
    <form className="count__item" onSubmit={next} aria-label={`Count ${entry.name}`}>
      {head}
      <div className="count__row">
        <label className="count__field count__field--main">
          <span>How much is there</span>
          <NumberInput autoFocus value={amount} placeholder="0" onText={(text) => { setAmount(text); setError(''); }} />
        </label>
        <div className="chips" role="group" aria-label="Counted in">
          {units.map((u) => (
            <button key={u.id} type="button" className="chip" aria-pressed={unit === u.id} onClick={() => setUnit(u.id)}>{u.id}</button>
          ))}
        </div>
      </div>
      {error && <p className="inv-modal__error" role="alert">{error}</p>}
      <div className="inv-modal__actions">
        {onSkip && <button type="button" className="inv-modal__cancel" onClick={onSkip}>Skip</button>}
        <button type="submit" className="insight__action">Next</button>
      </div>
    </form>
  );
}
