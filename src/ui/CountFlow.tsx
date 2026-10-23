import { useEffect, useState, type FormEvent } from 'react';
import {
  checkUnitName, countedBase, gapOf, reasonText, reasonsFor, unitsOf, type CountEntry, type DueCount, type GapReason, type Tier,
} from '../domain/counting.ts';
import { formatQuantity } from '../domain/quantity.ts';
import { fmt } from '../domain/money.ts';
import { MAX_NOTE } from '../domain/gapReview.ts';
import { learnUnit, recordCount, useStockSettings, type InventoryRow } from '../services/inventoryStore.ts';
import { isManagerPhone } from '../services/pairing.ts';
import { keepPhoto, newPhotoId, shrinkPhoto } from '../services/photos.ts';
import { NumberInput } from './NumberInput.tsx';

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
const number = (raw: string): number | null => (/^\d+(\.\d{1,3})?$/.test(raw.trim()) ? Number(raw.trim()) : null);

interface Done { name: string; gapCents: number; big: boolean; undo: () => void; index: number }

export function CountFlow({ due, rows, onClose, photoRequired = isManagerPhone() }: {
  due: DueCount[]; rows: InventoryRow[]; onClose: () => void;
  /** A big gap needs a shelf photo (the manager's phone). */
  photoRequired?: boolean;
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
    <div className="inv-modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <section className="inv-modal count" role="dialog" aria-modal="true" aria-label="Count">
        <button type="button" className="count__close" aria-label="Stop counting" onClick={onClose}>×</button>
        {last && (
          <p className="count__saved" role="status">
            {last.name}: {last.big ? `gap of Rs ${fmt(Math.abs(last.gapCents))} saved` : 'matches'}.
            <button type="button" className="linkbtn" onClick={() => {
              last.undo(); setResults(results.slice(0, -1)); setIndex(last.index); setLast(null);
            }}>Undo</button>
          </p>
        )}
        {row ? (
          <CountItem
            key={`${row.id}-${index}`} row={row} due={current} position={`${index + 1} of ${due.length}`} photoRequired={photoRequired}
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

/**
 * One item's count. Also used inside the item's own sheet (SCRUM-97: `embedded`, no
 * header of its own and no Skip), so counting one item never leaves that item.
 */
export function CountItem({ row, due, position, photoRequired, onSaved, onSkip, embedded = false }: {
  row: InventoryRow; due: DueCount; position: string; photoRequired: boolean;
  onSaved: (gapCents: number, big: boolean, undo: () => void) => void; onSkip?: () => void;
  embedded?: boolean;
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
  /** The reason is chosen; on the phone the shelf photo comes next. */
  const [proof, setProof] = useState<{ reason: GapReason; note: string | null; photo: string | null; busy: boolean } | null>(null);
  /** "Other" needs a note saying what happened: the note, while it is being written. */
  const [other, setOther] = useState<string | null>(null);
  const settings = useStockSettings();
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
    const gap = gapOf(row.onHandBaseUnits, counted, row, settings);
    if (row.counted && gap.big) { setWhy({ counted, entries: typed }); return; }
    onSaved(gap.valueCents, false, recordCount(row, typed, counted, null, due.tier));
  };

  const saveWith = (reason: GapReason, photo: string | null = null, note: string | null = null) => {
    const gap = gapOf(row.onHandBaseUnits, why!.counted, row, settings);
    let photoId: string | null = null;
    if (photo) { photoId = newPhotoId(); keepPhoto(photoId, photo); }
    onSaved(gap.valueCents, true, recordCount(row, why!.entries, why!.counted, reason, due.tier, photoId, note));
  };
  const choose = (reason: GapReason, note: string | null = null) => (photoRequired ? setProof({ reason, note, photo: null, busy: false }) : saveWith(reason, null, note));

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
      <span className="count__pos num">{position} · {TIER_LABEL[due.tier]}{due.state === 'overdue' ? ' · overdue' : due.state === 'never' ? ' · first count' : ''}</span>
      <h2 className="count__name">{row.name}</h2>
    </header>
  );

  if (why && proof) {
    const gap = gapOf(row.onHandBaseUnits, why.counted, row, settings);
    return (
      <div className="count__why">
        {head}
        <p className={`count__gap count__gap--${gap.delta < 0 ? 'short' : 'over'} num`}>
          {formatQuantity(Math.abs(gap.delta), row.baseUnit)} {gap.delta < 0 ? 'short' : 'more than expected'} · {reasonText(proof.reason, proof.note)}
        </p>
        <p className="count__hint">A photo of the shelf, so the owner sees what you saw.</p>
        {proof.photo && <img className="count__photo" src={`data:image/jpeg;base64,${proof.photo}`} alt={`Shelf photo of ${row.name}`} />}
        <label className={proof.photo ? 'chip count__camera' : 'cta count__camera'} aria-busy={proof.busy}>
          {proof.busy ? 'Getting the photo…' : proof.photo ? 'Take again' : 'Take a photo'}
          <input className="sr-only" type="file" accept="image/*" capture="environment" aria-label="Shelf photo"
            onChange={(e) => { void took(e.target.files?.[0]); e.target.value = ''; }} />
        </label>
        {error && <p className="inv-modal__error" role="alert">{error}</p>}
        <div className="inv-modal__actions">
          <button type="button" className="inv-modal__cancel" onClick={() => setProof(null)}>Back</button>
          <button type="button" className="insight__action" disabled={!proof.photo}
            onClick={() => saveWith(proof.reason, proof.photo, proof.note)}>Save</button>
        </div>
      </div>
    );
  }

  if (why) {
    const gap = gapOf(row.onHandBaseUnits, why.counted, row, settings);
    return (
      <div className="count__why">
        {head}
        <p className={`count__gap count__gap--${gap.delta < 0 ? 'short' : 'over'} num`}>
          {formatQuantity(Math.abs(gap.delta), row.baseUnit)} {gap.delta < 0 ? 'short' : 'more than expected'} · Rs {fmt(Math.abs(gap.valueCents))}
        </p>
        <p className="count__hint">You counted {formatQuantity(why.counted, row.baseUnit)}; sales and deliveries say {formatQuantity(Math.max(0, row.onHandBaseUnits), row.baseUnit)}. Why?</p>
        {other === null ? (
          <div className="chips" role="group" aria-label="Why">
            {reasonsFor(gap.delta).map((r) => (
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
        <button type="button" className="linkbtn" onClick={() => { setWhy(null); setOther(null); }}>Count again</button>
      </div>
    );
  }

  return (
    <form className="count__item" onSubmit={next} aria-label={`Count ${row.name}`}>
      {head}

      <div className="count__row">
        <label className="count__field">
          <span>Full packs</span>
          <NumberInput autoFocus value={packs} placeholder="0"
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
          <NumberInput value={amount} placeholder="0"
            onText={(text) => { setAmount(text); setFraction(null); setError(''); }} />
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
        {onSkip && <button type="button" className="inv-modal__cancel" onClick={onSkip}>Skip</button>}
        <button type="submit" className="insight__action">Next</button>
      </div>
    </form>
  );
}
