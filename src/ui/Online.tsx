import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  DECLINE_REASONS, DELIVER_IN_MINUTES, DELIVERY_DECLINE_REASONS, pinLink, READY_IN_MINUTES, type OnlineOrder,
} from '../domain/online.ts';
import { fmt } from '../domain/money.ts';
import { onlineOrders, type OnlineState } from '../services/onlineClient.ts';
import { chime } from './chime.ts';
import { describe } from './ShorthandBar.tsx';

/**
 * Online orders at the counter (cheesybeez.com). Serves the cashier: a customer at home
 * has ordered for pickup or delivery and waits to hear back. What they need next: see the
 * order, accept it with a time (it goes straight to the kitchen) or decline it with a reason;
 * for a delivery, tap Out as the rider leaves (the bill for the bag prints), then Charge the
 * cash he brings back as for any order.
 */
export const useOnline = (): OnlineState => useSyncExternalStore(onlineOrders.subscribe, onlineOrders.get);

const REMIND_MS = 30_000;

/** One quiet key beside the Kitchen key. New orders chime, and again every 30 s until someone looks. */
export function OnlineChip({ state, onOpen, looking }: { state: OnlineState; onOpen: () => void; looking: boolean }) {
  const fresh = state.orders.filter((o) => o.status === 'new');
  const heard = useRef(new Set<string>());
  useEffect(() => {
    const unheard = fresh.some((o) => !heard.current.has(o.id));
    fresh.forEach((o) => heard.current.add(o.id));
    if (unheard) chime();
    if (!fresh.length || looking) return;
    const t = setInterval(chime, REMIND_MS);
    return () => clearInterval(t);
  }, [fresh.map((o) => o.id).join(), looking]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!state.available) return null;
  const label = !state.open ? 'Online orders: off' : fresh.length ? `Online orders: ${fresh.length} new` : 'Online orders: on';
  return (
    <button type="button" className={`corner__key ochip${fresh.length ? ' ochip--new' : ''}`} onClick={onOpen} aria-label={label}>
      <span className={`ochip__dot ochip__dot--${!state.open ? 'off' : state.connected ? 'on' : 'warn'}`} aria-hidden />
      <span aria-hidden>Online{fresh.length > 0 && <span className="num"> · {fresh.length} new</span>}{!state.open && ' · off'}</span>
    </button>
  );
}

const ago = (at: number, now: number) => {
  const m = Math.max(0, Math.floor((now - at) / 60_000));
  return m < 1 ? 'just now' : `${m} min ago`;
};
const clock = (at: number) => new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

function NewOrder({ order, onAccept, onDecline }: {
  order: OnlineOrder; onAccept: (minutes: number) => void; onDecline: (reason: string) => void;
}) {
  const [declining, setDeclining] = useState(false);
  const delivery = order.kind === 'delivery';
  return (
    <article className="online__order" aria-label={`${delivery ? 'Delivery' : 'Online'} order from ${order.name}`}>
      <header className="online__who">
        {delivery && <span className="online__kind">Delivery</span>}
        <b>{order.name}</b>
        <span className="num">{order.phone}</span>
        <span>{ago(order.createdAt, Date.now())}</span>
        <b className="num online__total">{fmt(order.total)}</b>
      </header>
      {delivery && <Address order={order} />}
      <ul className="online__lines">
        {order.lines.map((l, i) => <li key={i}>{describe(l)}</li>)}
        {delivery && (
          <li className="online__fee">
            <span>Delivery{order.distanceKm !== null && <span className="num"> {order.distanceKm} km</span>}</span>
            <span className="num">· {fmt(order.deliveryFee)}</span>
          </li>
        )}
      </ul>
      {order.note && <p className="online__note">“{order.note}”</p>}
      {declining ? (
        <div className="chips" role="group" aria-label="Why decline">
          {(delivery ? DELIVERY_DECLINE_REASONS : DECLINE_REASONS).map((r) => (
            <button key={r} type="button" className="chip chip--danger" onClick={() => onDecline(r)}>{r}</button>
          ))}
          <button type="button" className="linkbtn" onClick={() => setDeclining(false)}>Back</button>
        </div>
      ) : (
        <div className="chips" role="group" aria-label="Accept: ready in">
          <span className="online__ask">Ready in</span>
          {(delivery ? DELIVER_IN_MINUTES : READY_IN_MINUTES).map((m) => (
            <button key={m} type="button" className="chip chip--solid num" onClick={() => onAccept(m)}>{m} min</button>
          ))}
          <button type="button" className="linkbtn linkbtn--danger" onClick={() => setDeclining(true)}>Decline</button>
        </div>
      )}
    </article>
  );
}

/** Where the rider goes: the address as typed, and the customer's shared location when there is one. */
function Address({ order }: { order: OnlineOrder }) {
  return (
    <p className="online__address">
      {order.address}
      {order.pin && <> · <a href={pinLink(order.pin)} target="_blank" rel="noopener noreferrer">Map</a></>}
    </p>
  );
}

/** One accepted order: when it is ready, and for a delivery, Out as the rider leaves and the cash to come. */
function Going({ order, onOut }: { order: OnlineOrder; onOut: () => void }) {
  const delivery = order.kind === 'delivery';
  const when = order.status === 'out' ? `On the way · collect ${fmt(order.total)}`
    : order.status === 'ready' ? (delivery ? 'Ready for the rider' : 'Ready for pickup')
      : `Ready by ${order.readyBy ? clock(order.readyBy) : '…'}`;
  return (
    <li>
      <b className="num">{order.orderNumber}</b> {order.name}
      {delivery && <span className="online__kind">Delivery</span>}
      <span>{when}</span>
      {delivery && order.status !== 'out' && (
        <button type="button" className="chip chip--solid" onClick={onOut} aria-label={`Order ${order.orderNumber}: out with the rider`}>Out</button>
      )}
    </li>
  );
}

export function OnlineSheet({ state, onAccept, onOut, onClose }: {
  state: OnlineState;
  /** Puts the order in the kitchen and tells the customer. Returns why not, or null. */
  onAccept: (order: OnlineOrder, minutes: number) => Promise<string | null>;
  /** The rider is leaving with a delivery: tells the customer and prints the bill for the bag. Returns why not, or null. */
  onOut: (order: OnlineOrder) => Promise<string | null>;
  onClose: () => void;
}) {
  const [error, setError] = useState('');
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const fresh = state.orders.filter((o) => o.status === 'new');
  const going = state.orders.filter((o) => o.status === 'accepted' || o.status === 'ready' || o.status === 'out');
  const act = async (p: Promise<string | null>) => setError((await p) ?? '');

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="sheet" role="dialog" aria-modal="true" aria-label="Online orders">
        <div className="sheet__body">
          <div className="sheet__title">
            <h1>Online orders</h1>
            {/* One toggle that names the current state: Online (customers can order) or Offline. */}
            <button
              type="button" role="switch" className="online__switch" aria-checked={state.open}
              aria-label="Take online orders" onClick={() => void onlineOrders.setOpen(!state.open)}
            >
              <span className="online__state" aria-hidden>{state.open ? 'Online' : 'Offline'}</span>
              <span className="online__track" aria-hidden><span className="online__knob" /></span>
            </button>
          </div>
          {state.open && !state.connected && (
            <p className="online__warn" role="status">No internet at the shop: customers cannot order until it is back.</p>
          )}
          {error && <p className="reason-msg" role="alert">{error}</p>}

          <section className="group" aria-label="New">
            <h2>New</h2>
            {fresh.length ? fresh.map((o) => (
              <NewOrder
                key={o.id} order={o}
                onAccept={(m) => void act(onAccept(o, m))}
                onDecline={(reason) => void act(onlineOrders.answer(o.id, { status: 'declined', reason }))}
              />
            )) : <p className="online__empty">{state.open ? 'Nothing new. Orders from cheesybeez.com chime here.' : 'Switch on “Taking orders” to let customers order online.'}</p>}
          </section>

          {going.length > 0 && (
            <section className="group" aria-label="Accepted">
              <h2>Accepted</h2>
              <ul className="online__going">
                {going.map((o) => <Going key={o.id} order={o} onOut={() => void act(onOut(o))} />)}
              </ul>
            </section>
          )}
        </div>
        <div className="sheet__foot" />
      </div>
    </>
  );
}
