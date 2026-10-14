import { useEffect, useState, type FormEvent } from 'react';
import {
  checkUnitName, countedBase, gapOf, reasonsFor, unitsOf, type CountEntry, type DueCount, type GapReason, type Tier,
} from '../domain/counting.ts';
import { formatQuantity } from '../domain/quantity.ts';
import { fmt } from '../domain/money.ts';
import { learnUnit, recordCount, type InventoryRow } from '../services/inventoryStore.ts';

/**
 * Count day (SCRUM-89). Serves the manager in front of the shelf: one item per
 * screen, they type only what is left, in whatever is in their hand (packs, an
 * opened pack by eye or weighed, a tray). They never see what the app expects
 * until they have counted (a blind count), so the number is theirs. A match is
 * saved at once; a gap beyond the allowance asks why before the item is done.
 */
const FRACTIONS = [{ v: 0.25, label: '¼' }, { v: 0.5, label: '½' }, { v: 0.75, label: '¾' }];
const TIER_LABEL: Record<Tier, string> = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' };
const number = (raw: string): number | null => (/^\d+(\.\d{1,3})?$/.test(raw.trim()) ? Number(raw.trim()) : null);

interface Done { name: string; gapCents: number; big: boolean; undo: () => void; index: number }

export function CountFlow({ due, rows, onClose }: {
  due: DueCount[]; rows: InventoryRow[]; onClose: () => void;
}) {
  const [index, setIndex] = useState(0);
  const [last, setLast] = useState<Done | null>(null);
  const [results, setResults] = useState<{ big: boolean; cents: number }[]>([]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const current = due[index];
  const row = current && rows.find((r) => r.id === current.id);
  const short = results.filter((r) => r.cents < 0).reduce((s, r) => s + r.cents, 0);

  return (
    <div className="inv-modal-backdrop">
      <section className="inv-modal count" role="dialog" aria-modal="true" aria-label="Count">
        {last && (
          <p className="count__saved" role="status">
            {last.name}: {last.big ? `gap of Rs ${fmt(Math.abs(last.gapCents))} saved` : 'matches'}.
            <button type="button" className="linkbtn" onClick={() => {
              last.undo(); setResults(results.slice(0, -1)); setIndex(last.index); setLast(null);
            }}>Undo</button>
          </p>
        )}
        {row ? (
          <Item
            key={`${row.id}-${index}`} row={row} due={current} position={`${index + 1} of ${due.length}`}
            onSaved={(gapCents, big, undo) => {
              setResults([...results, { big, cents: gapCents }]);
              setLast({ name: row.name, gapCents, big, undo, index });
              setIndex(index + 1);
            }}
            onSkip={() => { setLast(null); setIndex(index + 1); }}
          />
        ) : (
          <div className="count__done">
            <h2>All counted</h2>
            <p>
              {results.length} {results.length === 1 ? 'item' : 'items'} counted
              {results.some((r) => r.big) ? `, ${results.filter((r) => r.big).length} with a gap` : ', no gaps'}
              {short < 0 ? ` · Rs ${fmt(-short)} short in all` : ''}.
            </p>
            <button type="button" className="insight__action" autoFocus onClick={onClose}>Close</button>
          </div>
        )}
      </section>
    </div>
  );
}

function Item({ row, due, position, onSaved, onSkip }: {
  row: InventoryRow; due: DueCount; position: string;
  onSaved: (gapCents: number, big: boolean, undo: () => void) => void; onSkip: () => void;
}) {
  const units = unitsOf(row);
  const loose = units.filter((u) => !u.id.startsWith('unit:') && u.id !== 'pack');
  const [packs, setPacks] = useState('');
  const [packUnit, setPackUnit] = useState('pack');
  const [fraction, setFraction] = useState<number | null>(null);
  const [amount, setAmount] = useState('');
  const [looseUnit, setLooseUnit] = useState(loose[loose.length - 1].id); // g, ml, pcs
  const [newUnit, setNewUnit] = useState<{ name: string; base: string } | null>(null);
  const [why, setWhy] = useState<{ counted: number; entries: CountEntry[] } | null>(null);
  const [error, setError] = useState('');

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
    if (!typed || !touched) return setError('Type what is on the shelf. Nothing there? Type 0 packs.');
    const counted = total!;
    const gap = gapOf(row.onHandBaseUnits, counted, row);
    if (row.counted && gap.big) { setWhy({ counted, entries: typed }); return; }
    onSaved(gap.valueCents, false, recordCount(row, typed, counted, null, due.tier));
  };

  const saveWith = (reason: GapReason) => {
    const gap = gapOf(row.onHandBaseUnits, why!.counted, row);
    onSaved(gap.valueCents, true, recordCount(row, why!.entries, why!.counted, reason, due.tier));
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

  const head = (
    <header className="count__head">
      <span className="count__pos num">{position} · {TIER_LABEL[due.tier]}{due.state === 'overdue' ? ' · overdue' : due.state === 'never' ? ' · first count' : ''}</span>
      <h2 className="count__name">{row.name}</h2>
    </header>
  );

  if (why) {
    const gap = gapOf(row.onHandBaseUnits, why.counted, row);
    return (
      <div className="count__why">
        {head}
        <p className={`count__gap count__gap--${gap.delta < 0 ? 'short' : 'over'} num`}>
          {formatQuantity(Math.abs(gap.delta), row.baseUnit)} {gap.delta < 0 ? 'short' : 'more than expected'} · Rs {fmt(Math.abs(gap.valueCents))}
        </p>
        <p className="count__hint">You counted {formatQuantity(why.counted, row.baseUnit)}; sales and deliveries say {formatQuantity(Math.max(0, row.onHandBaseUnits), row.baseUnit)}. Why?</p>
        <div className="chips" role="group" aria-label="Why">
          {reasonsFor(gap.delta).map((r) => (
            <button key={r.id} type="button" className="chip" onClick={() => saveWith(r.id)}>{r.label}</button>
          ))}
        </div>
        <button type="button" className="linkbtn" onClick={() => setWhy(null)}>Count again</button>
      </div>
    );
  }

  return (
    <form className="count__item" onSubmit={next} aria-label={`Count ${row.name}`}>
      {head}

      <div className="count__row">
        <label className="count__field">
          <span>Full packs</span>
          <input className="num" inputMode="decimal" autoFocus value={packs} placeholder="0"
            onChange={(e) => { setPacks(e.target.value); setError(''); }} />
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
            <input className="num" inputMode="decimal" value={newUnit.base} onChange={(e) => { setNewUnit({ ...newUnit, base: e.target.value }); setError(''); }} />
          </label>
          <button type="button" className="chip" onClick={addUnit}>Save unit</button>
        </div>
      )}

      <div className="count__row">
        <span className="count__label">Opened pack</span>
        <div className="chips" role="group" aria-label="Opened pack, by eye">
          {FRACTIONS.map((f) => (
            <button key={f.v} type="button" className="chip" aria-pressed={fraction === f.v}
              onClick={() => { setFraction(fraction === f.v ? null : f.v); setAmount(''); setError(''); }}>{f.label}</button>
          ))}
        </div>
        <span className="count__or">or</span>
        <label className="count__field count__field--inline">
          <span className="sr-only">Opened pack, weighed</span>
          <input className="num" inputMode="decimal" value={amount} placeholder="0"
            onChange={(e) => { setAmount(e.target.value); setFraction(null); setError(''); }} />
        </label>
        <div className="chips" role="group" aria-label="Weighed in">
          {loose.map((u) => (
            <button key={u.id} type="button" className="chip" aria-pressed={looseUnit === u.id} onClick={() => setLooseUnit(u.id)}>{u.label}</button>
          ))}
        </div>
      </div>

      <p className="count__total num" aria-live="polite">
        {total !== null && touched ? `= ${formatQuantity(total, row.baseUnit)}` : ' '}
        {packs.trim() && packUnitInfo.id !== 'pack' ? ` (${packUnitInfo.label})` : ''}
      </p>
      {error && <p className="inv-modal__error" role="alert">{error}</p>}
      <div className="inv-modal__actions">
        <button type="button" className="inv-modal__cancel" onClick={onSkip}>Skip</button>
        <button type="submit" className="insight__action">Next</button>
      </div>
    </form>
  );
}
