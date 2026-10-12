import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { managesStock, seesTakings } from '../domain/auth.ts';
import { usesLogin } from '../services/auth.ts';
import { isCloudSite, isKitchenDevice, ownerToken, syncToken } from '../services/pairing.ts';
import { isDemo } from './storage.ts';
import { lock, signedIn, subscribeAuth } from '../services/serverAuth.ts';
import { App } from './App.tsx';
import { InventoryView } from './InventoryView.tsx';
import { Kitchen } from './Kitchen.tsx';
import { LockScreen } from './LockScreen.tsx';
import { OwnerView } from './OwnerView.tsx';
import { OwnerWelcome } from './OwnerWelcome.tsx';
import { ReceiptPreview } from './ReceiptPreview.tsx';
import { SetupWizard } from './SetupWizard.tsx';
import { SupplierView } from './SupplierView.tsx';

const KITCHEN = '#kitchen';
/** "A few quiet minutes" (SCRUM-40): long enough not to nag mid-service. */
export const IDLE_LOCK_MS = 5 * 60_000;

/** Locks the screen after a quiet spell. Any key or tap counts as activity. */
function useIdleLock(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    let t = setTimeout(lock, IDLE_LOCK_MS);
    const awake = () => { clearTimeout(t); t = setTimeout(lock, IDLE_LOCK_MS); };
    window.addEventListener('keydown', awake, true);
    window.addEventListener('pointerdown', awake, true);
    return () => {
      clearTimeout(t);
      window.removeEventListener('keydown', awake, true);
      window.removeEventListener('pointerdown', awake, true);
    };
  }, [enabled]);
}

/**
 * Is this shop set up, and may this device set it up? Asked of the shop server
 * in the real build only; development and tests keep the fake staff.
 * 'remote' = a tablet or phone that has not scanned its QR code yet.
 */
type SetupCheck = 'checking' | 'none' | 'new' | 'done' | 'remote';
const checksSetup = () =>
  !isDemo() && !isCloudSite() && (import.meta.env.PROD || import.meta.env.VITE_SETUP_CHECK === '1');

function useSetupCheck(): SetupCheck {
  const [check, setCheck] = useState<SetupCheck>(checksSetup() ? 'checking' : 'none');
  useEffect(() => {
    if (!checksSetup()) return;
    fetch('/api/v1/setup', { signal: AbortSignal.timeout(10_000) }).then(
      async (r) => {
        if (r.status === 403) setCheck('remote');
        else if (!r.ok) setCheck('none');
        else setCheck(((await r.json()) as { done: boolean }).done ? 'done' : 'new');
      },
      () => setCheck('none'), // no shop server here (development)
    );
  }, []);
  return check;
}

/** A tablet or phone that is not connected yet: say so, never show a register. */
function NotConnected() {
  return (
    <main className="lock" aria-label="Not connected">
      <div className="lock__card owner-welcome">
        <span className="brand">CheesyBeez</span>
        <h1 className="lock__title">This device is not connected yet</h1>
        <p>On the shop PC: Manager mode → Ctrl+K → Shop setup → Devices, then scan the QR code with this device.</p>
      </div>
    </main>
  );
}

/**
 * Which screen this device shows, and to whom.
 * - A kitchen device (paired as kitchen) shows the Kitchen only, with no login.
 * - On the counter, staff log in with their PIN (SCRUM-40); F4 switches user,
 *   and the screen locks itself when quiet. A kitchen login sees the Kitchen only.
 * - Until the kitchen has its own screen, F2 (or the Kitchen key) flips the
 *   counter between Register and Kitchen. The Kitchen stays visible while the
 *   screen is locked; only going back to the Register needs a PIN.
 * Development and the demo have no login (fake staff), as before.
 */
export function Root() {
  const [hash, setHash] = useState(location.hash);
  /** Came here from the Register, so the Kitchen offers a way back. */
  const [fromRegister, setFromRegister] = useState(false);
  const needsLogin = usesLogin();
  const staff = useSyncExternalStore(subscribeAuth, signedIn);
  const kitchenOnly = isKitchenDevice() || staff?.role === 'kitchen';
  const setup = useSetupCheck();
  useIdleLock(needsLogin && staff !== null);

  useEffect(() => {
    const onHash = () => setHash(location.hash);
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const inKitchen = hash === KITCHEN;
  const show = useCallback((kitchen: boolean) => {
    // replaceState: flipping all day must not fill the browser history.
    history.replaceState(null, '', kitchen ? KITCHEN : location.pathname + location.search);
    setHash(kitchen ? KITCHEN : '');
    if (kitchen) setFromRegister(true);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F2' && !kitchenOnly) { e.preventDefault(); show(!inKitchen); }
      if (e.key === 'F4' && needsLogin && staff) { e.preventDefault(); lock(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [inKitchen, show, kitchenOnly, needsLogin, staff]);

  // The cloud site is the owner's phone page and nothing else (the demo for examiners too).
  if (isCloudSite()) return ownerToken() || isDemo() ? <OwnerView phone /> : <OwnerWelcome />;
  if (setup === 'checking') return <div className="setup" aria-busy="true" />;
  if (setup === 'new') return <SetupWizard mode="first" />;
  if (setup === 'remote' && !syncToken()) return <NotConnected />;
  if (setup === 'done' && !syncToken()) return <SetupWizard mode="connect" />;
  // Staff, printer and devices later: the owner, with their PIN (the server checks it too).
  if (hash === '#setup' && (!needsLogin || staff?.role === 'owner' || staff?.role === 'manager')) {
    return <SetupWizard mode="manage" onClose={() => show(false)} />;
  }
  if (hash === '#receipt') return <ReceiptPreview />; // setup page, not a cashier screen
  if (kitchenOnly) return <Kitchen onSwitch={staff ? lock : undefined} />;
  if (inKitchen) return <Kitchen onBack={fromRegister || needsLogin ? () => show(false) : undefined} />;
  if (needsLogin && !staff) return <LockScreen />;
  // Managers and owners only (SCRUM-41); anyone else typing the address gets the Register.
  // The server refuses a cashier's stock events anyway.
  const mayManageStock = !needsLogin || (staff !== null && managesStock(staff.role));
  // The Owner view shows the takings: owners and managers only (SCRUM-41).
  if (hash === '#owner' && (!needsLogin || (staff !== null && seesTakings(staff.role)))) return <OwnerView />;
  if (hash === '#inventory' && mayManageStock) return <InventoryView />;
  if (hash === '#suppliers' && mayManageStock) return <SupplierView />;
  return <App onKitchen={() => show(true)} onSwitch={needsLogin ? lock : undefined} canManageStock={mayManageStock} />;
}
