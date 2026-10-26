import { useCallback, useEffect, useRef, useState } from 'react';
import {
  cookTimeMs, elapsedLabel, needsAttention, queue, ticketLines, urgency, type KitchenTicket, type LineView,
} from '../domain/kitchen.ts';
import { chime, useSoundBlocked } from './chime.ts';
import { recordKitchen, recordRemake, REMAKE_REASONS, remakeName, useKitchenTickets, type RemakeReason } from './kitchenStore.ts';
import type { OrderLine } from '../domain/types.ts';
import { SyncSign } from './SyncSign.tsx';
import { prepAmount } from '../domain/prep.ts';

/**
 * Kitchen display. Serves the cook: knows the menu, hands busy, standing back
 * from the screen. The only question it answers is "what do I make next?":
 * one column, oldest first, colour = how long it has waited. Each ticket has
 * one button that is its next step: Start, then Done. The two taps time the
 * cooking (cookLog in the domain) for later analysis.
 * It is the kitchen's ONLY channel (no printed tickets), so arrivals, changes
 * and cancellations chime and flash until someone taps the ticket.
 * Prep tickets (SCRUM-136: a semi-processed item sent from low stock) queue after the
 * customers' orders, labelled PREP on a quieter card; Done on one is the batch made.
 * A dish that went in the bin (burnt, dropped, made wrong) gets Remake on its line (SCRUM-177):
 * one tap and a reason records the waste, and the line stays on the ticket to make again.
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
  // The last Start or Done, for Undo.
  const [last, setLast] = useState<{ id: string; number: number; label: string; step: 'started' | 'done' } | null>(null);
  /** The line whose Remake reasons are open, and the last Remake, for its Undo (SCRUM-177). */
  const [remaking, setRemaking] = useState<string | null>(null);
  const [remade, setRemade] = useState<{ key: number; label: string; undo: () => void } | null>(null);
  const remake = (t: KitchenTicket, line: OrderLine, reason: RemakeReason) => {
    const undo = recordRemake(t, line, reason);
    setRemaking(null);
    setRemade({ key: Date.now(), label: `${remakeName(line)}: remake · ${REMAKE_REASONS.find((r) => r.id === reason)?.label}`, undo });
  };
  useEffect(() => {
    if (remade === null) return;
    const t = setTimeout(() => setRemade(null), 6000);
    return () => clearTimeout(t);
  }, [remade]);
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

  /** Start a waiting ticket; finish a started one. */
  const step = (t: KitchenTicket) => {
    const started = t.startedAt === undefined;
    recordKitchen(started ? 'kitchen.started' : 'kitchen.bumped', t);
    setLast({ id: t.id, number: t.number, label: t.prep ? `Prep ${t.prep.name}` : String(t.number), step: started ? 'started' : 'done' });
    if (navigator.vibrate) navigator.vibrate(8);
  };

  const undo = useCallback(() => {
    if (last === null) return;
    recordKitchen(last.step === 'started' ? 'kitchen.unstarted' : 'kitchen.unbumped', last);
    setLast(null);
  }, [last]);

  useEffect(() => {
    if (last === null) return;
    const t = setTimeout(() => setLast(null), 6000);
    return () => clearTimeout(t);
  }, [last]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'Escape' && onBack) { e.preventDefault(); onBack(); return; }
      // Space = the oldest ticket's next step (Start, then Done). A focused button keeps Space for itself.
      if (e.key === ' ' && !(e.target instanceof HTMLButtonElement)) {
        e.preventDefault();
        const next = open[0];
        if (next) step(next);
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
          if (t.prep) return <PrepTicket key={t.id} t={t} prep={t.prep} elapsed={elapsed} onStep={() => step(t)} />;
          const name = `Order ${t.number}${t.addOn ? ', added items' : ''}${t.changed ? ', changed' : ''}`;
          const alerting = needsAttention(t);
          return (
            <article
              key={t.id}
              className={`ticket ticket--${urgency(elapsed, cookTimeMs(t))}${alerting ? ' ticket--alert' : ''}`}
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
                {t.startedAt !== undefined && <span className="ticket__tag">Cooking</span>}
                {/* Neutral, like Added: on the kitchen screen colour means urgency only. */}
                {t.online && !t.addOn && (
                  <span className="ticket__tag">
                    Online · pickup {new Date(t.online.pickupBy).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                  </span>
                )}
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
                    {l.status !== 'cancelled' && (() => {
                      // Remake (SCRUM-177): this one went in the bin; it is waste, and is made again.
                      const line = t.lines.find((x) => x.id === l.key)!;
                      return (
                        <span className="ticket__remake">
                          {l.remade ? <span className="ticket__tag">Remake ×{l.remade}</span> : null}
                          {remaking === l.key ? (
                            <span className="ticket__reasons" role="group" aria-label={`Why remake ${l.name}?`}>
                              {REMAKE_REASONS.map((r) => (
                                <button key={r.id} type="button" className="ticket__reason" onClick={() => remake(t, line, r.id)}>{r.label}</button>
                              ))}
                              <button type="button" className="ticket__reason ticket__reason--quiet" onClick={() => setRemaking(null)}>Cancel</button>
                            </span>
                          ) : (
                            <button type="button" className="ticket__remake-btn" aria-label={`Remake ${l.name}`} onClick={() => setRemaking(l.key)}>Remake</button>
                          )}
                        </span>
                      );
                    })()}
                  </li>
                ))}
              </ul>
              {t.startedAt === undefined ? (
                <button type="button" className="ticket__start" aria-label={`Start: ${name}`} onClick={() => step(t)}>
                  Start
                </button>
              ) : (
                <button type="button" className="ticket__done" aria-label={`Done: ${name}`} onClick={() => step(t)}>
                  Done
                </button>
              )}
            </article>
          );
        })}
      </main>

      {remade !== null && (
        <div className="toast" role="status" key={remade.key}>
          <span>{remade.label}</span>
          <button type="button" onClick={() => { remade.undo(); setRemade(null); }}>Undo</button>
        </div>
      )}
      {last !== null && remade === null && (
        <div className="toast" role="status" key={`${last.id}-${last.step}`}>
          <span className="num">{last.label} {last.step}</span>
          <button type="button" onClick={undo}>Undo</button>
        </div>
      )}
    </div>
  );
}

/**
 * A prep ticket: what to make for the dishes (dough, sauce), not a customer's order. Labelled
 * PREP where an order has its number, on a quieter card with a dashed edge; it has no cook time,
 * so its edge stays neutral (colour on this screen means a customer is waiting). Start, then Done.
 */
function PrepTicket({ t, prep, elapsed, onStep }: {
  t: KitchenTicket; prep: NonNullable<KitchenTicket['prep']>; elapsed: number; onStep: () => void;
}) {
  const name = `Prep: ${prep.name}`;
  const alerting = needsAttention(t);
  return (
    <article className={`ticket ticket--prep${alerting ? ' ticket--alert' : ''}`} aria-label={name}>
      {alerting && <button type="button" className="ticket__ack" aria-label={`Seen: ${name}`} onClick={() => recordKitchen('kitchen.seen', t)} />}
      <div className="ticket__meta">
        <span className="ticket__prep">Prep</span>
        {t.startedAt !== undefined && <span className="ticket__tag">Making</span>}
        <span className="ticket__time num" aria-label={`Waiting ${elapsedLabel(elapsed)}`}>{elapsedLabel(elapsed)}</span>
      </div>
      <ul className="ticket__items">
        <li>
          <span className="ticket__name">{prep.name}</span>
          <span className="ticket__detail num">Make {prepAmount(prep.qty, prep.unit)}</span>
        </li>
      </ul>
      {t.startedAt === undefined
        ? <button type="button" className="ticket__start" aria-label={`Start: ${name}`} onClick={onStep}>Start</button>
        : <button type="button" className="ticket__done" aria-label={`Done: ${name}`} onClick={onStep}>Done</button>}
    </article>
  );
}
