import { useEffect, useState, type FormEvent } from 'react';
import { freshStartOf, type ShopEvent } from '../domain/freshStart.ts';
import { setupClient } from '../services/setupClient.ts';
import { addEvents, readStored, subscribeEvents } from './eventLog.ts';

/**
 * Settings › Test data (owner's PIN, the shop PC): the first real day after testing. One time,
 * one button, then Undo; no confirmation (freshStart.ts says what is kept and what is left out).
 * The time starts at now; set it earlier when counting already began, and those counts stay.
 */
const pad = (n: number) => String(n).padStart(2, '0');
/** A moment as the time field shows it (this PC's own clock and zone). */
const fieldValue = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const spoken = (ms: number): string =>
  new Date(ms).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true });

/** The cut-off in force, and the one before it (what Undo goes back to). */
const readCutOffs = () => {
  const events = readStored();
  const marks = events.filter((e): e is ShopEvent => e.type === 'shop.started_fresh');
  return { now: freshStartOf(events)?.before ?? null, before: marks.length > 1 ? marks[marks.length - 2].before : 0 };
};

export function TestDataTab({ ownerPin }: { ownerPin?: string }) {
  const [cut, setCut] = useState(readCutOffs);
  useEffect(() => subscribeEvents(() => setCut(readCutOffs())), []);
  const [time, setTime] = useState(() => fieldValue(Date.now()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const send = async (before: number) => {
    setError('');
    setBusy(true);
    try {
      addEvents((await setupClient.startFresh(before, ownerPin)).events);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    setBusy(false);
  };
  const clear = (e: FormEvent) => {
    e.preventDefault();
    const at = new Date(time).getTime();
    if (Number.isNaN(at)) { setError('Pick a time.'); return; }
    // A time a moment ahead (the minute not over yet) means now.
    void send(Math.min(at, Date.now()));
  };

  return (
    <div className="setup__form">
      <p className="setup__lead">
        Before the first real day: everything sold, cooked, counted, ordered, received or thrown away before this time was testing,
        and stops counting. The menu, recipes, items, suppliers, warehouses, staff and cameras stay as they are.
      </p>
      {cut.now !== null && (
        <p className="setup__done" role="status">
          Test data before <b>{spoken(cut.now)}</b> is cleared.{' '}
          <button type="button" className="linkbtn" disabled={busy} onClick={() => void send(cut.before)}>Undo</button>
        </p>
      )}
      <form className="setup__add" onSubmit={clear} aria-label="Clear test data">
        <label className="setup__field"><span>Everything before</span>
          <input type="datetime-local" value={time} max={fieldValue(Date.now())} onChange={(e) => setTime(e.target.value)} /></label>
        <button type="submit" className="chip chip--solid" disabled={busy || !time}>Clear test data</button>
      </form>
      <p className="setup__lead">Counting already started? Pick a time before the first count: those counts stay and set the stock.</p>
      {error && <p className="setup__error" role="alert">{error}</p>}
    </div>
  );
}
