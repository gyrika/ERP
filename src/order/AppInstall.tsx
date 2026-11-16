import { useState } from 'react';
import { standalone, useInstall } from '../services/ownerApp.ts';

/**
 * Came from the QR code on the bill (receipt.ts APP_URL, SCRUM-257): how to put CheesyBeez on this
 * phone's home screen, first thing on the page. One button where the browser offers it (Android),
 * the two taps where it does not (iPhone), the menu where neither (other browsers). Nothing once
 * the app is on the phone. × hides it and takes #app off the address.
 */
export const fromBill = () => typeof location !== 'undefined' && location.hash === '#app';

export function AppInstall() {
  const install = useInstall();
  const [open, setOpen] = useState(fromBill);
  if (!open || standalone()) return null;
  const close = () => {
    setOpen(false);
    history.replaceState(history.state, '', location.pathname + location.search);
  };
  return (
    <section className="o-app" aria-label="Get the CheesyBeez app">
      <div className="o-wrap o-app__in">
        <img className="o-app__icon" src="/icons/icon-192.png" alt="" width={56} height={56} />
        <div className="o-app__text">
          <h2>Get the CheesyBeez app</h2>
          {install.kind === 'button' && <p>One tap, no app store. Your next order is on your home screen.</p>}
          {install.kind === 'iphone' && (
            <ol className="o-app__steps">
              <li>Tap <b>Share</b> at the bottom of the screen</li>
              <li>Tap <b>Add to Home Screen</b></li>
            </ol>
          )}
          {install.kind === 'none' && <p>Open your browser&apos;s menu <b>⋮</b> and tap <b>Install app</b> or <b>Add to Home screen</b>.</p>}
        </div>
        {install.kind === 'button' && <button type="button" className="o-app__go" onClick={install.install}>Install app</button>}
        <button type="button" className="o-app__close" aria-label="Close" onClick={close}>×</button>
      </div>
    </section>
  );
}
