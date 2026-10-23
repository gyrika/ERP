import { useEffect, useState, type FormEvent } from 'react';
import type { Actor } from '../domain/auth.ts';
import { fmt, parseLKR } from '../domain/money.ts';
import { checkStockSetting, STOCK_DEFAULTS, type StockSettings } from '../domain/stockSettings.ts';
import { setStockSetting } from '../services/inventoryStore.ts';
import { OwnerPin } from './OwnerPin.tsx';

/**
 * Stock rules: the owner's numbers behind counts, usage, ordering and receiving, in plain
 * words. Anyone can read them; changing needs the owner's PIN. Each change is audited and
 * has an Undo. The rules read these numbers from stockSettings.ts, never their own.
 */
interface Field {
  key: keyof StockSettings;
  label: string;
  /** What the number is counted in, as shown after the box. */
  unit: string;
  /** Stored value → what is typed. */
  show: (v: number) => string;
  /** What is typed → stored value, or null when it is not a number. */
  read: (text: string) => number | null;
}
const whole = (text: string): number | null => (/^\d+$/.test(text.trim()) ? Number(text.trim()) : null);
const FIELDS: Field[] = [
  { key: 'countGapShare', label: 'A count needs a reason when it is more than', unit: '% of what was expected', show: (v) => String(Math.round(v * 1000) / 10), read: (t) => { const n = Number(t.trim()); return t.trim() !== '' && Number.isFinite(n) ? n / 100 : null; } },
  { key: 'countGapCents', label: '…or worth more than', unit: 'Rs', show: (v) => fmt(v), read: parseLKR },
  { key: 'usageDays', label: 'Daily use is worked out from the last', unit: 'days of sales', show: String, read: whole },
  { key: 'defaultLeadDays', label: 'A supplier with no history takes', unit: 'days to deliver', show: String, read: whole },
  { key: 'leadSamples', label: 'Delivery time is the average of the last', unit: 'deliveries', show: String, read: whole },
  { key: 'spareDays', label: 'Order when stock lasts no longer than delivery time plus', unit: 'spare days', show: String, read: whole },
  { key: 'orderDays', label: 'An order covers delivery time plus', unit: 'days of use', show: String, read: whole },
  { key: 'grnUndoHours', label: 'A GRN can be undone for', unit: 'hours', show: String, read: whole },
];

export function StockRulesSheet({ settings, onClose, onDone }: {
  settings: StockSettings;
  onClose: () => void;
  onDone: (message: string, undo: () => void) => void;
}) {
  const [asking, setAsking] = useState(false);
  const [owner, setOwner] = useState<Actor | null>(null);
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [error, setError] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !asking) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, asking]);

  const save = (event: FormEvent) => {
    event.preventDefault();
    if (!owner) return;
    // Check every box first, so a wrong number never leaves half the changes saved.
    const changes: { f: Field; value: number }[] = [];
    for (const f of FIELDS) {
      const text = typed[f.key];
      if (text === undefined || text.trim() === f.show(settings[f.key])) continue;
      const value = f.read(text);
      const where = `${f.label} … ${f.unit}`;
      if (value === null) return setError(`${where}: type it as digits, like 14.`);
      const why = checkStockSetting(f.key, value);
      if (why) return setError(`${where}: ${why}`);
      changes.push({ f, value });
    }
    if (changes.length === 0) return setError('Nothing was changed.');
    const undos = changes.map(({ f, value }) => setStockSetting(f.key, value, settings[f.key], owner)).filter((r): r is () => void => typeof r === 'function');
    onDone(`Stock rules changed (${undos.length}).`, () => undos.forEach((u) => u()));
    onClose();
  };

  return (
    <div className="inv-modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget && !asking) onClose(); }}>
      <form className="inv-modal rules" role="dialog" aria-modal="true" aria-labelledby="rules-title" onSubmit={save}>
        <button type="button" className="count__close" aria-label="Close" onClick={onClose}>×</button>
        <h2 id="rules-title">Stock rules</h2>
        <p className="delivery__hint">The numbers the counts, orders and deliveries use. Only the owner can change them.</p>
        <ul className="rules__list">
          {FIELDS.map((f) => (
            <li key={f.key}>
              <label>
                <span>{f.label}</span>
                <span className="rules__value">
                  <input className="inv-modal__input num" inputMode="decimal" aria-label={`${f.label} ${f.unit}`} readOnly={!owner}
                    value={typed[f.key] ?? f.show(settings[f.key])}
                    onChange={(e) => { setTyped({ ...typed, [f.key]: e.target.value }); setError(''); }} />
                  <small>{f.unit}{STOCK_DEFAULTS[f.key] !== settings[f.key] ? ` · usual ${f.show(STOCK_DEFAULTS[f.key])}` : ''}</small>
                </span>
              </label>
            </li>
          ))}
        </ul>
        {asking && <OwnerPin onOpen={(who) => { setOwner(who); setAsking(false); }} onCancel={() => setAsking(false)} refusal="Only the owner changes the stock rules." />}
        {error && <p className="inv-modal__error" role="alert">{error}</p>}
        <div className="inv-modal__actions">
          <button type="button" className="inv-modal__cancel" onClick={onClose}>Close</button>
          {owner
            ? <button type="submit" className="insight__action">Save rules</button>
            : <button type="button" className="insight__action" disabled={asking} onClick={() => setAsking(true)}>Change (owner)</button>}
        </div>
      </form>
    </div>
  );
}
