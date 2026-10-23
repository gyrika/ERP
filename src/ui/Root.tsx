import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { managesStock, seesTakings } from '../domain/auth.ts';
import { usesLogin } from '../services/auth.ts';
import { loadMe } from '../services/managerPhone.ts';
import { adminShop, fleetShop, isCloudSite, isKitchenDevice, isManagerPhone, ownerToken, syncToken } from '../services/pairing.ts';
import { isDemo } from './storage.ts';
import { lock, signedIn, subscribeAuth } from '../services/serverAuth.ts';
import { App } from './App.tsx';
import { InventoryView } from './InventoryView.tsx';
import { Kitchen } from './Kitchen.tsx';
import { LockScreen } from './LockScreen.tsx';
import { ManagerView } from './ManagerView.tsx';
import { MenuView } from './MenuView.tsx';
import { useMenu } from './menuStore.ts';
import type { Section } from './OwnerNav.tsx';
import { OwnerShell } from './OwnerShell.tsx';
import { OwnerView } from './OwnerView.tsx';
import { OwnerWelcome } from './OwnerWelcome.tsx';
import { ShopsView } from './ShopsView.tsx';
import { ReceiptPreview } from './ReceiptPreview.tsx';
import { RecipesView } from './RecipesView.tsx';
import { SetupWizard } from './SetupWizard.tsx';
import { SupplierView } from './SupplierView.tsx';

const KITCHEN = '#kitchen';
const OWNER = '#owner';

/** Changing screens cross-fades (view transitions, 200 ms in styles.css) where the browser can; instant elsewhere. */
const withTransition = (change: () => void) => {
  const d = document as Document & { startViewTransition?: (cb: () => void) => unknown };
  if (d.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches) d.startViewTransition(() => flushSync(change));
  else change();
};
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
 *   counter between Register and Kitchen; F3 flips to the Owner view and back
 *   (owners and managers). The Kitchen stays visible while the
 *   screen is locked; only going back to the Register needs a PIN.
 * Development and the demo have no login (fake staff), as before.
 */
export function Root() {
  useMenu();
  const [hash, setHash] = useState(location.hash);
  /** Came here from the Register, so the Kitchen offers a way back. */
  const [fromRegister, setFromRegister] = useState(false);
  const [filterIngredientId, setFilterIngredientId] = useState<string | null>(null);
  const needsLogin = usesLogin();
  const staff = useSyncExternalStore(subscribeAuth, signedIn);
  const kitchenOnly = isKitchenDevice() || staff?.role === 'kitchen';
  const setup = useSetupCheck();
  useIdleLock(needsLogin && staff !== null);

  useEffect(() => {
    const onHash = () => {
      setHash(location.hash);
      setFilterIngredientId(null);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const inKitchen = hash === KITCHEN;
  /** The Owner view shows the takings: owners and managers only (SCRUM-41). */
  const seesOwner = !kitchenOnly && (!needsLogin || (staff !== null && seesTakings(staff.role)));
  const go = useCallback((to: '' | typeof KITCHEN | typeof OWNER | '#shops') => withTransition(() => {
    // replaceState: flipping all day must not fill the browser history.
    history.replaceState(null, '', to || location.pathname + location.search);
    setHash(to);
    setFilterIngredientId(null);
    if (to === KITCHEN) setFromRegister(true);
  }), []);
  const show = useCallback((kitchen: boolean) => go(kitchen ? KITCHEN : ''), [go]);
  const findSupplier = useCallback((ingredientId: string) => withTransition(() => {
    setFilterIngredientId(ingredientId);
    history.replaceState(null, '', '#suppliers');
    setHash('#suppliers');
  }), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && e.target.closest('[role="dialog"]')) return;
      if (e.key === 'F2' && !kitchenOnly) { e.preventDefault(); show(!inKitchen); }
      if (e.key === 'F3' && seesOwner) { e.preventDefault(); go(hash === OWNER ? '' : OWNER); }
      if (e.key === 'F4' && needsLogin && staff) { e.preventDefault(); lock(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hash, inKitchen, show, go, seesOwner, kitchenOnly, needsLogin, staff]);

  /** The owner area: the menu on the left, this tab on the right. */
  const shell = (current: Section, page: ReactNode, back: () => void = () => go('')) => (
    <OwnerShell current={current} onRegister={back} onSwitch={needsLogin && staff ? lock : undefined}>{page}</OwnerShell>
  );

  // The cloud site is the owner's phone page and nothing else (the demo for examiners too).
  // A manager's phone app (SCRUM-94): the counts and the stock, nothing else.
  if (isManagerPhone()) return <ManagerPhone inventory={hash === '#inventory'} />;
  if (isCloudSite()) return ownerToken() || isDemo() || adminShop() ? <OwnerView phone /> : <OwnerWelcome />;
  if (setup === 'checking') return <div className="setup" aria-busy="true" />;
  if (setup === 'new') return <SetupWizard mode="first" />;
  if (setup === 'remote' && !syncToken()) return <NotConnected />;
  if (setup === 'done' && !syncToken()) return <SetupWizard mode="connect" />;
  // Staff, printer and devices later: the owner, with their PIN (the server checks it too).
  if (hash === '#setup' && (!needsLogin || staff?.role === 'owner' || staff?.role === 'manager')) {
    return shell('setup', <SetupWizard mode="manage" />, () => show(false));
  }
  if (hash === '#receipt') return <ReceiptPreview />; // setup page, not a cashier screen
  if (kitchenOnly) return <Kitchen onSwitch={staff ? lock : undefined} />;
  if (inKitchen) return <Kitchen onBack={fromRegister || needsLogin ? () => show(false) : undefined} />;
  if (needsLogin && !staff) return <LockScreen />;
  // Managers and owners only (SCRUM-41); anyone else typing the address gets the Register.
  // The server refuses a cashier's stock events anyway.
  const mayManageStock = !needsLogin || (staff !== null && managesStock(staff.role));
  if (hash === OWNER && seesOwner) return shell('owner', <OwnerView onBack={() => go('')} />);
  // The developer's Shops screen (only answers on the developer's laptop: server/fleet.ts).
  if (hash === '#shops' && seesOwner) return <ShopsView onBack={() => go('')} />;
  if (fleetShop() && seesOwner) return <OwnerView key={hash} shop={fleetShop()!} onBack={() => go('#shops')} />;
  if (hash === '#manager' && mayManageStock) return shell('manager', <ManagerView />);
  if (hash === '#inventory' && mayManageStock) return shell('inventory', <InventoryView onFindSupplier={findSupplier} />);
  // The owner changes the menu; managers can mark items sold out during service.
  if (hash === '#menu' && (!needsLogin || (staff !== null && seesTakings(staff.role)))) {
    return shell('menu', <MenuView owner={!needsLogin || staff?.role === 'owner'} onBack={() => go('')} />);
  }
  // His recipes: the owner's alone, opened with his PIN on the screen itself.
  if (hash === '#recipes' && (!needsLogin || staff?.role === 'owner')) return shell('recipes', <RecipesView />);
  if (hash === '#suppliers' && mayManageStock) {
    return shell('suppliers', <SupplierView filterIngredientId={filterIngredientId} />);
  }
  return (
    <App onKitchen={() => show(true)} onOwner={needsLogin && seesOwner ? () => go(OWNER) : undefined}
      onSwitch={needsLogin ? lock : undefined} canManageStock={mayManageStock} />
  );
}

/** The manager's phone app: who it belongs to comes from the cloud once, then the counts. */
function ManagerPhone({ inventory }: { inventory: boolean }) {
  const [me, setMe] = useState<'loading' | 'ready' | string>('loading');
  useEffect(() => { loadMe().then(() => setMe('ready'), (e: unknown) => setMe(e instanceof Error ? e.message : String(e))); }, []);
  if (me === 'loading') return <div className="setup" aria-busy="true" />;
  if (me !== 'ready') return <main className="setup"><p className="setup__error" role="alert">{me}</p></main>;
  // The same menu as on the counter, with only the phone's two tabs.
  return <OwnerShell current={inventory ? 'inventory' : 'manager'}>{inventory ? <InventoryView /> : <ManagerView />}</OwnerShell>;
}
