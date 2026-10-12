import { useCallback, useEffect, useRef, useState } from 'react';
import {
  elapsedLabel, needsAttention, queue, ticketLines, urgency, type LineView,
} from '../domain/kitchen.ts';
import { chime, useSoundBlocked } from './chime.ts';
import { recordKitchen, useKitchenTickets } from './kitchenStore.ts';
import { SyncSign } from './SyncSign.tsx';

/**
 * Kitchen display. Serves the cook: knows the menu, hands busy, standing back
 * from the screen. The only question it answers is "what do I make next?":
 * one column, oldest first, colour = how long it has waited, one tap Done.
 * It is the kitchen's ONLY channel (no printed tickets), so arrivals, changes
 * and cancellations chime and flash until someone taps the ticket.
 */

export const useNow = (everyMs: number): number => {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
};

/** The kitchen is always true black, whatever the device theme. */
const useDarkTheme = () => {
  useEffect(() => {
    const root = document.documentElement;
    const before = root.dataset.theme;
    root.dataset.theme = 'dark';
    return () => { if (before) root.dataset.theme = before; else delete root.dataset.theme; };
  }, []);
};

/** A kitchen screen that sleeps mid-rush is useless: keep it awake where supported. */
const useWakeLock = () => {
  useEffect(() => {
    let lock: WakeLockSentinel | null = null;
    let live = true;
    const request = () => {
      if (document.visibilityState !== 'visible' || !('wakeLock' in navigator)) return;
      navigator.wakeLock.request('screen').then((l) => { if (live) lock = l; else void l.release(); }, () => {});
    };
    request();
    document.addEventListener('visibilitychange', request);
    return () => {
      live = false;
      document.removeEventListener('visibilitychange', request);
      void lock?.release();
    };
  }, []);
};

/** One item. `struck` = the version that no longer applies, in red. */
function LineBody({ v, struck = false, showQty = false }: { v: LineView; struck?: boolean; showQty?: boolean }) {
  const qty = (showQty || v.qty > 1) && <b className="num">{v.qty} × </b>;
  if (struck) {
    return (
      <s className="ticket__struck">
        <span className="ticket__name">{qty}{v.name}</span>
        {v.detail && <span className="ticket__detail">{v.detail}</span>}
      </s>
    );
  }
  return (
    <>
      <span className="ticket__name">{qty}{v.name}</span>
      {v.detail && <span className="ticket__detail">{v.detail}</span>}
      {v.outs.length > 0 && <span className="ticket__outs">{v.outs.join(' · ')}</span>}
      {v.note && <span className="ticket__note">“{v.note}”</span>}
    </>
  );
}

/**
 * `onBack`: shown when the Kitchen shares the counter PC with the Register (F2 flips).
 * `onSwitch`: a kitchen login on the counter switches user here (F4).
 */
export function Kitchen({ onBack, onSwitch }: { onBack?: () => void; onSwitch?: () => void } = {}) {
  const tickets = useKitchenTickets();
  const now = useNow(1000);
  const [done, setDone] = useState<{ id: string; number: number } | null>(null); // last bumped, for Undo
  const soundBlocked = useSoundBlocked();
  const lastAlert = useRef(0);
  useDarkTheme();
  useWakeLock();

  const open = queue(tickets);

  // Every arrival, change or cancellation chimes once; the ticket keeps flashing until tapped.
  const latestAlert = Math.max(0, ...open.filter(needsAttention).map((t) => t.alertAt));
  useEffect(() => {
    if (latestAlert > lastAlert.current) chime();
    lastAlert.current = Math.max(lastAlert.current, latestAlert);
  }, [latestAlert]);

  const markDone = (id: string, number: number) => {
    recordKitchen('kitchen.bumped', { id, number });
    setDone({ id, number });
    if (navigator.vibrate) navigator.vibrate(8);
  };

  const undo = useCallback(() => {
    if (done === null) return;
    recordKitchen('kitchen.unbumped', done);
    setDone(null);
  }, [done]);

  useEffect(() => {
    if (done === null) return;
    const t = setTimeout(() => setDone(null), 6000);
    return () => clearTimeout(t);
  }, [done]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'Escape' && onBack) { e.preventDefault(); onBack(); return; }
      // Space = the oldest ticket is done. A focused button keeps Space for itself.
      if (e.key === ' ' && !(e.target instanceof HTMLButtonElement)) {
        e.preventDefault();
        const next = open[0];
        if (next) markDone(next.id, next.number);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div className="kitchen">
      <header className="kitchen__head">
        <h1>Kitchen</h1>
        <span className="kitchen__right">
          <SyncSign />
          <time className="kitchen__clock num">
            {new Date(now).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
          </time>
          {onBack && (
            <button type="button" className="corner__key" onClick={onBack}>Register <kbd>F2</kbd></button>
          )}
          {onSwitch && (
            <button type="button" className="corner__key" onClick={onSwitch}>Switch user <kbd>F4</kbd></button>
          )}
        </span>
      </header>

      {soundBlocked && (
        // Browsers block sound until the page is tapped once; the tap itself turns it on.
        <button type="button" className="kitchen__sound">Sound is off · tap to turn on</button>
      )}

      <main className="kitchen__list" aria-label="Orders to make">
        {open.length === 0 && <p className="kitchen__empty">No orders waiting</p>}
        {open.map((t) => {
          const elapsed = now - t.firedAt;
          const name = `Order ${t.number}${t.addOn ? ', added items' : ''}${t.changed ? ', changed' : ''}`;
          const alerting = needsAttention(t);
          return (
            <article
              key={t.id}
              className={`ticket ticket--${urgency(elapsed)}${alerting ? ' ticket--alert' : ''}`}
              aria-label={name}
            >
              {alerting && (
                // The whole card is the tap target: hands are busy, aim is rough.
                <button
                  type="button"
                  className="ticket__ack"
                  aria-label={`Seen: ${name}`}
                  onClick={() => recordKitchen('kitchen.seen', t)}
                />
              )}
              <div className="ticket__meta">
                <span className="ticket__no num">{t.number}</span>
                {t.changed && <span className="ticket__tag ticket__tag--changed">Changed</span>}
                {t.addOn && <span className="ticket__tag">Added</span>}
                <span className="ticket__time num" aria-label={`Waiting ${elapsedLabel(elapsed)}`}>
                  {elapsedLabel(elapsed)}
                </span>
              </div>
              <ul className="ticket__items">
                {ticketLines(t).map((l) => (
                  <li key={l.key}>
                    {l.status === 'cancelled' && (
                      <>
                        <LineBody v={l} struck showQty />
                        <span className="ticket__cancelled">Cancelled</span>
                      </>
                    )}
                    {l.status === 'changed' && l.was && (
                      <>
                        <span className="sr-only">Changed from</span>
                        <LineBody v={l.was} struck showQty />
                        <span className="sr-only">to</span>
                        <span className="ticket__now"><LineBody v={l} showQty /></span>
                      </>
                    )}
                    {l.status === 'ok' && <LineBody v={l} />}
                  </li>
                ))}
              </ul>
              <button type="button" className="ticket__done" aria-label={`Done: ${name}`} onClick={() => markDone(t.id, t.number)}>
                Done
              </button>
            </article>
          );
        })}
      </main>

      {done !== null && (
        <div className="toast" role="status" key={done.id}>
          <span className="num">{done.number} done</span>
          <button type="button" onClick={undo}>Undo</button>
        </div>
      )}
    </div>
  );
}
