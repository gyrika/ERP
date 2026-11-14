import { useCallback, useEffect, useRef, useState } from 'react';
import { formatLkMobile, toLkMobile } from '../domain/phone.ts';
import { api, remembered } from './api.ts';
import { isOrderAppHost } from './pwa.ts';

/**
 * "Get offers on this phone" (CRM): the customer allows notifications and gives their mobile number,
 * so the shop's campaigns (and "we miss you") reach them. Free: Web Push, through the CheesyBeez
 * app (a TWA of this site) or the browser. One tap stops it. The number goes to the shop PC through
 * the cloud, which forgets it as soon as the shop has it.
 */
const supported = () => typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const isIphone = () => typeof navigator !== 'undefined' && /iPhone|iPad|iPod/.test(navigator.userAgent);
const keyBytes = (b64url: string) => {
  const s = atob(b64url.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(b64url.length / 4) * 4, '='));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};

type State = { at: 'off' } | { at: 'asking' } | { at: 'working' } | { at: 'on'; phone: string } | { at: 'blocked' };

/** Came from the QR code on a receipt (receipt.ts OFFERS_URL): straight to the sign-up, already open. */
const fromReceipt = () => typeof location !== 'undefined' && location.hash === '#offers';

export function Offers() {
  const [state, setState] = useState<State>(() => {
    const o = remembered.offers();
    return o ? { at: 'on', phone: o.phone } : fromReceipt() ? { at: 'asking' } : { at: 'off' };
  });
  // The section appears once the shop's push key has loaded; bring it into view then, once.
  const scrolled = useRef(false);
  const here = useCallback((el: HTMLElement | null) => {
    if (!el || scrolled.current || !fromReceipt()) return;
    scrolled.current = true;
    el.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
  }, []);
  const [phone, setPhone] = useState(() => remembered.me().phone);
  const [error, setError] = useState('');
  const [key, setKey] = useState<string | null>(null);

  useEffect(() => {
    if (!supported() || !isOrderAppHost()) return;
    api.pushKey().then((r) => setKey(r.key), () => setKey(null));
  }, []);

  if (!isOrderAppHost()) return null;
  if (!supported()) {
    // iPhones take notifications only from the app added to the Home Screen.
    return isIphone() ? (
      <section className="o-offers o-wrap" aria-label="Offers">
        <p><b>Offers on your iPhone:</b> tap Share, then “Add to Home Screen”, and open CheesyBeez from there.</p>
      </section>
    ) : null;
  }
  if (!key && state.at !== 'on') return null; // the shop has not set up offers yet

  const turnOn = async () => {
    setError('');
    const check = toLkMobile(phone);
    if (!('phone' in check)) { setError('Type your mobile number, like 077 123 4567.'); return; }
    setState({ at: 'working' });
    try {
      if (await Notification.requestPermission() !== 'granted') { setState({ at: 'blocked' }); return; }
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key!) });
      await api.subscribe(check.phone, sub.toJSON());
      remembered.setOffers({ phone: check.phone });
      setState({ at: 'on', phone: check.phone });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not work. Please try again.');
      setState({ at: 'asking' });
    }
  };

  const turnOff = async () => {
    setError('');
    setState({ at: 'working' });
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await api.unsubscribe(sub.endpoint);
        await sub.unsubscribe();
      }
    } catch { /* stopped on this phone anyway: the shop forgets it when the next message cannot be delivered */ }
    remembered.setOffers(null);
    setState({ at: 'off' });
  };

  return (
    <section className="o-offers o-wrap" aria-label="Offers" id="offers" ref={here}>
      {state.at === 'on' ? (
        <>
          <p><b>Offers are on</b> for {formatLkMobile(state.phone)}. We send a few, never spam.</p>
          <button type="button" className="o-link" onClick={() => void turnOff()}>Stop offers</button>
        </>
      ) : state.at === 'blocked' ? (
        <p>Notifications are blocked for CheesyBeez on this phone. Allow them in the phone’s settings, then try again.</p>
      ) : state.at === 'off' ? (
        <>
          <p><b>Get our offers on this phone.</b> A few a month, no SMS, stop any time.</p>
          <button type="button" className="o-primary" onClick={() => setState({ at: 'asking' })}>Get offers</button>
        </>
      ) : (
        <form className="o-offers__form" onSubmit={(e) => { e.preventDefault(); void turnOn(); }}>
          <label>
            <span>Your mobile number</span>
            <input type="tel" inputMode="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="077 123 4567" />
          </label>
          <button type="submit" className="o-primary" disabled={state.at === 'working'}>{state.at === 'working' ? 'Turning on…' : 'Turn on offers'}</button>
        </form>
      )}
      {error && <p className="o-offers__error" role="alert">{error}</p>}
    </section>
  );
}
