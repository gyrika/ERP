import { useState } from 'react';
import type { Actor } from '../domain/auth.ts';
import { fmt, parseLKR } from '../domain/money.ts';
import { checkStockSetting, STOCK_DEFAULTS, type StockSettings } from '../domain/stockSettings.ts';
import { setStockSetting, useStockSettings } from '../services/inventoryStore.ts';
import { BigStepper } from './flow/BigStepper.tsx';
import { DoneStep } from './flow/DoneStep.tsx';
import { FlowSheet } from './flow/FlowSheet.tsx';
import { OwnerPin } from './OwnerPin.tsx';

/**
 * Stock rules: the owner's numbers behind counts, ordering and receiving, in plain words, as
 * three cards with a big stepper for each number. Anyone can read them; changing needs the
 * owner's PIN, then one Save; a tick says it is done. Each change is audited and has an Undo.
 * The rules read these numbers from stockSettings.ts, never their own.
 */
interface Field {
  key: keyof StockSettings;
  label: string;
  /** What the number is counted in, as shown under it. */
  unit: string;
  /** How much one tap of − or + changes it, in the stored unit. */
  step: number;
  /** Stored value → what is typed. */
  show: (v: number) => string;
  /** What is typed → stored value, or null when it is not a number. */
  read: (text: string) => number | null;
}
const whole = (text: string): number | null => (/^\d+$/.test(text.trim()) ? Number(text.trim()) : null);
const FIELDS: Record<keyof StockSettings, Field> = {
  countGapShare: { key: 'countGapShare', label: 'A count needs a reason when it is more than', unit: '% of what was expected', step: 0.01, show: (v) => String(Math.round(v * 1000) / 10), read: (t) => { const n = Number(t.trim()); return t.trim() !== '' && Number.isFinite(n) ? n / 100 : null; } },
  countGapCents: { key: 'countGapCents', label: '…or worth more than', unit: 'Rs', step: 50_000, show: (v) => fmt(v), read: parseLKR },
  usageDays: { key: 'usageDays', label: 'Daily use is worked out from the last', unit: 'days of sales', step: 1, show: String, read: whole },
  defaultLeadDays: { key: 'defaultLeadDays', label: 'A supplier with no history takes', unit: 'days to deliver', step: 1, show: String, read: whole },
  leadSamples: { key: 'leadSamples', label: 'Delivery time is the average of the last', unit: 'deliveries', step: 1, show: String, read: whole },
  spareDays: { key: 'spareDays', label: 'Order when stock lasts no longer than delivery time plus', unit: 'spare days', step: 1, show: String, read: whole },
  orderDays: { key: 'orderDays', label: 'An order covers delivery time plus', unit: 'days of use', step: 1, show: String, read: whole },
  grnUndoHours: { key: 'grnUndoHours', label: 'A GRN can be undone for', unit: 'hours', step: 6, show: String, read: whole },
};
const GROUPS: { name: string; keys: (keyof StockSettings)[] }[] = [
  { name: 'Counts', keys: ['countGapShare', 'countGapCents'] },
  { name: 'Ordering', keys: ['usageDays', 'defaultLeadDays', 'leadSamples', 'spareDays', 'orderDays'] },
  { name: 'Receiving', keys: ['grnUndoHours'] },
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
  const [saved, setSaved] = useState<number | null>(null);

  const textOf = (f: Field) => typed[f.key] ?? f.show(settings[f.key]);
  const bump = (f: Field, by: 1 | -1) => {
    const now = f.read(textOf(f)) ?? settings[f.key];
    const next = Math.max(0, Math.round((now + by * f.step) * 1000) / 1000);
    setTyped({ ...typed, [f.key]: f.show(f.key === 'countGapCents' ? Math.round(next) : next) });
    setError('');
  };

  const save = () => {
    if (!owner) return;
    // Check every box first, so a wrong number never leaves half the changes saved.
    const changes: { f: Field; value: number }[] = [];
    for (const f of Object.values(FIELDS)) {
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
    setSaved(undos.length);
  };

  if (saved !== null) {
    return (
      <FlowSheet title="Stock rules" onClose={onClose} primary={{ label: 'Done', onClick: onClose }}>
        <DoneStep title="Rules saved" line={`${saved} ${saved === 1 ? 'number' : 'numbers'} changed. Undo is on the Inventory screen.`} />
      </FlowSheet>
    );
  }

  return (
    <FlowSheet title="Stock rules" onClose={onClose} error={error} keys={!asking}
      primary={owner ? { label: 'Save rules', onClick: save } : { label: 'Change (owner)', onClick: () => setAsking(true), disabled: asking }}>
      <p className="flow-hint">The numbers the counts, orders and deliveries use. Only the owner can change them.</p>
      {asking && !owner && <OwnerPin onOpen={(who) => { setOwner(who); setAsking(false); }} onCancel={() => setAsking(false)} refusal="Only the owner changes the stock rules." />}
      {GROUPS.map((g) => (
        <section key={g.name} className="flow__list" aria-label={g.name}>
          <p className="flow-hint">{g.name}</p>
          {g.keys.map((k) => {
            const f = FIELDS[k];
            return (
              <div key={k} className={`flow-card flow-card--item${settings[k] !== STOCK_DEFAULTS[k] ? ' flow-card--warn' : ''}`}>
                <span className="flow-card__text">
                  <span className="flow-card__name">{f.label}</span>
                  {settings[k] !== STOCK_DEFAULTS[k] && <span className="flow-card__line">Usual: {f.show(STOCK_DEFAULTS[k])} {f.unit}</span>}
                </span>
                <BigStepper compact readOnly={!owner} value={textOf(f)} unit={f.unit} label={`${f.label} ${f.unit}`}
                  lessLabel={`One less: ${f.label}`} moreLabel={`One more: ${f.label}`}
                  onText={(text) => { setTyped({ ...typed, [k]: text }); setError(''); }} onBump={(by) => bump(f, by)} />
              </div>
            );
          })}
        </section>
      ))}
    </FlowSheet>
  );
}

/**
 * Settings › Stock rules: the owner's numbers behind counts, orders and deliveries
 * (stockSettings.ts). It checks the owner's PIN itself, so it opens even while the rest of
 * Settings waits for the shop server.
 */
export function StockRulesEntry() {
  const settings = useStockSettings();
  const [open, setOpen] = useState(false);
  const [said, setSaid] = useState<{ message: string; undo: () => void } | null>(null);
  return (
    <section className="setup__rules" aria-label="Stock rules">
      <div>
        <h2>Stock rules</h2>
        <p>When a count needs a reason, how far back daily use looks, how much an order covers.</p>
      </div>
      <button type="button" className="chip chip--solid" onClick={() => setOpen(true)}>Stock rules</button>
      {said && (
        <p className="setup__rules-said" role="status">
          {said.message}
          <button type="button" className="linkbtn" onClick={() => { said.undo(); setSaid(null); }}>Undo</button>
        </p>
      )}
      {open && <StockRulesSheet settings={settings} onClose={() => setOpen(false)} onDone={(message, undo) => setSaid({ message, undo })} />}
    </section>
  );
}
