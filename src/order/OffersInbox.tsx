import { useCallback, useEffect, useState } from 'react';
import { formatLkMobile } from '../domain/phone.ts';
import { remembered } from './api.ts';
import { OFFERS_CHANGED, stopOffers } from './Offers.tsx';
import { markSeen, onOfferMessage, readOffers, seenAt, unseenCount, type Offer } from './offersInbox.ts';

/**
 * The offers inbox (CRM): a bell at the top of cheesybeez.com, and the offers this phone received
 * under it, newest first. Who: a customer who signed up from the receipt's QR code, coming back
 * to find "that offer". The one next thing: read it, then order. Shown only on a phone that has
 * offers on (or still has some kept); a tapped notification opens it (#inbox).
 */
const when = (at: number, now = Date.now()): string => {
  const d = new Date(at);
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  if (new Date(now).toDateString() === d.toDateString()) return `Today, ${time}`;
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
};

const BellIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
  </svg>
);

export function OffersBell() {
  const [on, setOn] = useState(() => remembered.offers());
  const [list, setList] = useState<Offer[]>([]);
  const [open, setOpen] = useState(() => typeof location !== 'undefined' && location.hash === '#inbox');
  // What was new when the list opened stays marked "New" while it is open.
  const [seen, setSeen] = useState(seenAt);

  const load = useCallback(() => { void readOffers().then(setList); }, []);
  useEffect(() => {
    load();
    return onOfferMessage((kind) => { load(); if (kind === 'open') setOpen(true); });
  }, [load]);
  useEffect(() => {
    const follow = () => setOn(remembered.offers());
    window.addEventListener(OFFERS_CHANGED, follow);
    return () => window.removeEventListener(OFFERS_CHANGED, follow);
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    const now = Date.now();
    markSeen(now);
    setSeen(now);
    if (location.hash === '#inbox') history.replaceState(history.state, '', location.pathname + location.search);
  }, []);
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [open, close]);

  if (!on && !list.length) return null;
  const fresh = unseenCount(list, seen);

  return (
    <>
      <button type="button" className="o-bell" onClick={() => setOpen(true)} aria-label={fresh ? `Your offers, ${fresh} new` : 'Your offers'}>
        <BellIcon />
        {fresh > 0 && <span className="o-bell__n num" aria-hidden="true">{fresh}</span>}
      </button>
      {open && (
        <>
          <div className="o-scrim" onClick={close} />
          <div className="o-sheet o-inbox" role="dialog" aria-modal="true" aria-label="Your offers">
            <button type="button" className="o-sheet__close" onClick={close} aria-label="Close">×</button>
            <h2 className="o-sheet__title">Your offers</h2>
            {list.length === 0 ? (
              <p className="o-inbox__empty">Your offers show here as they arrive.</p>
            ) : (
              <ul className="o-inbox__list">
                {list.map((o) => (
                  <li key={o.id} className="o-inbox__item">
                    <div className="o-inbox__top">
                      <b>{o.title}</b>
                      {o.at > seen && <span className="o-inbox__new">New</span>}
                    </div>
                    {o.body && <p>{o.body}</p>}
                    <span className="o-inbox__when">{when(o.at)}</span>
                  </li>
                ))}
              </ul>
            )}
            <button type="button" className="o-primary o-primary--wide o-inbox__order" onClick={close}>Order now</button>
            {on && (
              <p className="o-inbox__foot">
                Offers on {formatLkMobile(on.phone)} · <button type="button" className="o-link" onClick={() => { void stopOffers(); }}>Stop offers</button>
              </p>
            )}
          </div>
        </>
      )}
    </>
  );
}
