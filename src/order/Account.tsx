import { useCallback, useEffect, useRef, useState } from 'react';
import { reorderable, type Account, type PastOrder } from '../domain/accounts.ts';
import { fmt } from '../domain/money.ts';
import { normalisePhone, type OnlineLine } from '../domain/online.ts';
import { accountApi } from './api.ts';

/**
 * The customer's account on cheesybeez.com (cloud/src/accounts.ts). Who: a regular at home, who
 * knows what they like and where they live. The one next thing: order again in one tap, or have
 * their address already there. So the sheet leads with their orders; details and addresses fill
 * themselves from orders, and stay editable below. Shown only once the cloud has accounts on.
 */
export interface AccountState {
  /** Google sign-in's client id; null = accounts off (or not known yet). */
  google: string | null;
  account: Account | null;
  set: (a: Account | null) => void;
  refresh: () => void;
}

export function useAccount(): AccountState {
  const [google, setGoogle] = useState<string | null>(null);
  const [account, set] = useState<Account | null>(null);
  const refresh = useCallback(() => {
    accountApi.me().then((r) => { setGoogle(r.google); set(r.account); }, () => { /* offline: the page works without it */ });
  }, []);
  useEffect(refresh, [refresh]);
  return { google, account, set, refresh };
}

// ----- Google's own button (Google Identity Services), loaded only when someone is about to sign in -----

interface Gis {
  accounts: { id: {
    initialize(o: { client_id: string; callback: (r: { credential: string }) => void; ux_mode?: 'popup'; use_fedcm_for_button?: boolean }): void;
    renderButton(el: HTMLElement, o: Record<string, unknown>): void;
  } };
}
let gis: Promise<Gis> | null = null;
const loadGis = (): Promise<Gis> => {
  const w = window as unknown as { google?: Gis };
  if (w.google?.accounts) return Promise.resolve(w.google);
  gis ??= new Promise<Gis>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = () => (w.google ? resolve(w.google) : reject(new Error('no google')));
    s.onerror = () => { gis = null; reject(new Error('Google sign-in did not load')); };
    document.head.appendChild(s);
  });
  return gis;
};

function GoogleButton({ clientId, onSignedIn }: { clientId: string; onSignedIn: (a: Account) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    loadGis().then((g) => {
      if (!live || !box.current) return;
      g.accounts.id.initialize({
        client_id: clientId, ux_mode: 'popup', use_fedcm_for_button: true,
        callback: (r) => {
          setBusy(true);
          setError('');
          accountApi.google(r.credential).then((x) => onSignedIn(x.account), (e: unknown) => {
            setBusy(false);
            setError(e instanceof Error ? e.message : String(e));
          });
        },
      });
      g.accounts.id.renderButton(box.current, { theme: 'outline', size: 'large', shape: 'pill', text: 'continue_with', width: 280 });
    }, () => { if (live) setError("Google sign-in didn't load. Check your connection and try again."); });
    return () => { live = false; };
  }, [clientId, onSignedIn]);
  return (
    <div className="o-acct__google">
      <div ref={box} aria-busy={busy} />
      {busy && <p className="o-muted" role="status">Signing you in…</p>}
      {error && <p className="o-error" role="alert">{error}</p>}
    </div>
  );
}

/** 0771234567 → "077 123 4567" */
const phoneText = (p: string) => `${p.slice(0, 3)} ${p.slice(3, 6)} ${p.slice(6)}`;

/** "Kasun Perera" → "KP"; nothing known → a quiet person mark. */
const initials = (name: string) => name.split(' ').filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');

/** The header's way in: "Sign in", or the customer's initials once signed in. Nothing while accounts are off. */
export function AccountButton({ state, onOpen }: { state: AccountState; onOpen: () => void }) {
  if (!state.google) return null;
  if (!state.account) return <button type="button" className="o-link o-acct-in" onClick={onOpen}>Sign in</button>;
  const name = state.account.profile.name;
  return (
    <button type="button" className="o-acct-me" onClick={onOpen} aria-label={name ? `Your account, ${name}` : 'Your account'}>
      {initials(name) || (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" />
        </svg>
      )}
    </button>
  );
}

/** A past order may hold a dish the owner has since taken off the menu: it is still listed, by what it was. */
const safely = (describe: (l: OnlineLine) => string, l: OnlineLine): string => {
  try { return describe(l); } catch { return `${l.qty > 1 ? `${l.qty} × ` : ''}a dish no longer on the menu`; }
};

const day = (at: number) => new Date(at).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

function PastOrderRow({ o, describe, onAgain }: { o: PastOrder; describe: (l: OnlineLine) => string; onAgain: (lines: OnlineLine[]) => void }) {
  const again = reorderable(o.lines);
  return (
    <li className="o-acct__order">
      <div className="o-acct__order-top">
        <span>{day(o.createdAt)} · {o.kind === 'delivery' ? 'Delivery' : 'Pickup'}</span>
        <span className="num">Rs {fmt(o.total)}</span>
      </div>
      <p>{o.lines.map((l) => safely(describe, l)).join(', ')}</p>
      <button type="button" className="o-btn o-acct__again" disabled={!again.length} onClick={() => onAgain(again)}>
        {again.length ? (again.length < o.lines.length ? 'Order again (what is on today)' : 'Order again') : 'Not on the menu today'}
      </button>
    </li>
  );
}

/**
 * Signed out: one line on why, and Google's button. Signed in: their orders with Order again, then
 * name and mobile, saved addresses, and their data (download, sign out, delete). Deleting asks for a
 * second tap on the same button, never a dialog.
 */
export function AccountSheet({ state, describe, onAgain, onClose }: {
  state: AccountState; describe: (l: OnlineLine) => string; onAgain: (lines: OnlineLine[]) => void; onClose: () => void;
}) {
  const { account, google, set } = state;
  const [name, setName] = useState(account?.profile.name ?? '');
  const [phone, setPhone] = useState(account?.profile.phone ?? '');
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState(false);
  useEffect(() => {
    setName(account?.profile.name ?? '');
    setPhone(account?.profile.phone ? phoneText(account.profile.phone) : '');
  }, [account?.profile.name, account?.profile.phone]);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);

  const act = (p: Promise<unknown>) => { setError(''); p.catch((e: unknown) => setError(e instanceof Error ? e.message : String(e))); };
  const signedIn = useCallback((a: Account) => set(a), [set]);
  const changed = account && (name.trim() !== account.profile.name || (normalisePhone(phone) ?? phone.trim()) !== account.profile.phone);
  const phoneOk = !phone.trim() || normalisePhone(phone) !== null;

  return (
    <>
      <div className="o-scrim" onClick={onClose} />
      <div className="o-sheet o-acct" role="dialog" aria-modal="true" aria-label="Your account">
        <button type="button" className="o-sheet__close" onClick={onClose} aria-label="Close">×</button>
        {!account ? (<>
          <h2 className="o-sheet__title">Sign in</h2>
          <p className="o-sheet__desc">Your details, addresses and past orders, on any phone. Order again in one tap.</p>
          {google && <GoogleButton clientId={google} onSignedIn={signedIn} />}
          <p className="o-muted">You can still order without signing in.</p>
        </>) : (<>
          <h2 className="o-sheet__title">{account.profile.name ? `Hi, ${account.profile.name.split(' ')[0]}` : 'Your account'}</h2>
          {account.profile.email && <p className="o-muted o-acct__email">{account.profile.email}</p>}

          <section aria-label="Your orders">
            <h3 className="o-acct__h">Your orders</h3>
            {account.orders.length === 0
              ? <p className="o-muted">Orders you place while signed in show here.</p>
              : <ul className="o-acct__orders">{account.orders.map((o) => <PastOrderRow key={o.id} o={o} describe={describe} onAgain={onAgain} />)}</ul>}
          </section>

          <section aria-label="Your details">
            <h3 className="o-acct__h">Your details</h3>
            <form className="o-form" onSubmit={(e) => {
              e.preventDefault();
              if (!changed || !phoneOk) return;
              act(accountApi.profile({ name, phone }).then((r) => { set(r.account); setSaved(true); setTimeout(() => setSaved(false), 1800); }));
            }}>
              <label>Your name
                <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="given-name" maxLength={40} />
              </label>
              <label>Phone number
                <input value={phone} onChange={(e) => setPhone(e.target.value)} type="tel" inputMode="tel" autoComplete="tel" placeholder="077 123 4567" />
                {!phoneOk && <span className="o-hint">A Sri Lankan number, like 077 123 4567</span>}
              </label>
              {(changed || saved) && (
                <button type="submit" className="o-btn o-acct__save" disabled={!changed || !phoneOk}>{saved ? 'Saved' : 'Save'}</button>
              )}
            </form>
          </section>

          <section aria-label="Saved addresses">
            <h3 className="o-acct__h">Delivery addresses</h3>
            {account.addresses.length === 0 ? <p className="o-muted">Saved by themselves when you order a delivery.</p> : (
              <ul className="o-acct__addrs">
                {account.addresses.map((a) => (
                  <li key={a.id}>
                    <span>{a.label && <b>{a.label} · </b>}{a.address}{!a.pin && <span className="o-muted"> · no location</span>}</span>
                    <button type="button" className="o-link" aria-label={`Remove ${a.label || a.address}`}
                      onClick={() => act(accountApi.removeAddress(a.id).then((r) => set(r.account)))}>Remove</button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {error && <p className="o-error" role="alert">{error}</p>}
          <div className="o-acct__foot">
            <button type="button" className="o-link" onClick={() => act(accountApi.signOut().then(() => { set(null); onClose(); }))}>Sign out</button>
            <button type="button" className="o-link" onClick={() => act(accountApi.signOut(true).then(() => { set(null); onClose(); }))}>Sign out on all phones</button>
            <a className="o-link" href={accountApi.exportUrl} download>Download my data</a>
            <button type="button" className={`o-link o-acct__delete${deleting ? ' is-armed' : ''}`}
              onClick={() => (deleting ? act(accountApi.remove().then(() => { set(null); onClose(); })) : setDeleting(true))}
              onBlur={() => setDeleting(false)}>
              {deleting ? 'Tap again to delete everything' : 'Delete my account'}
            </button>
          </div>
          {deleting && <p className="o-muted" role="status">This erases your details, addresses and order list for good. Orders already placed stay with the shop, without your name.</p>}
        </>)}
      </div>
    </>
  );
}
