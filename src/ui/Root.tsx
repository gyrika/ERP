import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { managesStock } from '../domain/auth.ts';
import { usesLogin } from '../services/auth.ts';
import { isKitchenDevice } from '../services/pairing.ts';
import { lock, signedIn, subscribeAuth } from '../services/serverAuth.ts';
import { App } from './App.tsx';
import { InventoryView } from './InventoryView.tsx';
import { Kitchen } from './Kitchen.tsx';
import { LockScreen } from './LockScreen.tsx';
import { ReceiptPreview } from './ReceiptPreview.tsx';
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

  if (hash === '#receipt') return <ReceiptPreview />; // setup page, not a cashier screen
  if (kitchenOnly) return <Kitchen onSwitch={staff ? lock : undefined} />;
  if (inKitchen) return <Kitchen onBack={fromRegister || needsLogin ? () => show(false) : undefined} />;
  if (needsLogin && !staff) return <LockScreen />;
  // Managers and owners only (SCRUM-41); anyone else typing the address gets the Register.
  // The server refuses a cashier's stock events anyway.
  const mayManageStock = !needsLogin || (staff !== null && managesStock(staff.role));
  if (hash === '#inventory' && mayManageStock) return <InventoryView />;
  if (hash === '#suppliers' && mayManageStock) return <SupplierView />;
  return <App onKitchen={() => show(true)} onSwitch={needsLogin ? lock : undefined} />;
}
