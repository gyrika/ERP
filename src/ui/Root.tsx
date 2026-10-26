import { lazy, Suspense, useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactElement } from 'react';
import { flushSync } from 'react-dom';
import { managesStock, seesTakings } from '../domain/auth.ts';
import { voicePages } from '../domain/voicePages.ts';
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
import { OwnerView } from './OwnerView.tsx';
import { OwnerWelcome } from './OwnerWelcome.tsx';
import { ShopsView } from './ShopsView.tsx';
import { ReceiptPreview } from './ReceiptPreview.tsx';
import { RecipesView } from './RecipesView.tsx';
import { SemiView } from './SemiView.tsx';
import { SetupWizard } from './SetupWizard.tsx';
import { SupplierView } from './SupplierView.tsx';
import { OrderView, ReceiveView } from './WorkViews.tsx';
import { useVoice, VoiceNote } from './VoiceKey.tsx';
import { navData, navigate, onNavigate, startNav, useBackKeys } from './nav.ts';

/** Visual Flow carries its own drawing library: loaded when it is opened, so the Register stays light. */
const VisualFlowView = lazy(() => import('./visualFlow/VisualFlowView.tsx'));
/** The floor (SCRUM-168): loaded when it is opened, so the Register does not grow. */
const FloorView = lazy(() => import('./floor/FloorView.tsx'));

const KITCHEN = '#kitchen';
const OWNER = '#owner';
const TABLES = '#tables';

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
 *   (owners and managers); F1 flips to the floor of tables and back, once the shop has a
 *   table layout (SCRUM-168). The Kitchen stays visible while the
 *   screen is locked; only going back to the Register needs a PIN.
 * Development and the demo have no login (fake staff), as before.
 */
export function Root() {
  useMenu();
  const [hash, setHash] = useState(() => { startNav(); return location.hash; });
  /** Came here from the Register, so the Kitchen offers a way back. */
  const [fromRegister, setFromRegister] = useState(false);
  /** Suppliers found for one ingredient: kept in the place's history entry, so Back and Forward keep it. */
  const [filterIngredientId, setFilterIngredientId] = useState<string | null>(() => navData()?.ingredient ?? null);
  const needsLogin = usesLogin();
  const staff = useSyncExternalStore(subscribeAuth, signedIn);
  const kitchenOnly = isKitchenDevice() || staff?.role === 'kitchen';
  const setup = useSetupCheck();
  useIdleLock(needsLogin && staff !== null);

  useEffect(() => onNavigate(() => {
    setHash(location.hash);
    setFilterIngredientId(navData()?.ingredient ?? null);
  }), []);

  const inKitchen = hash === KITCHEN;
  /** The Owner view shows the takings: owners and managers only (SCRUM-41). */
  const seesOwner = !kitchenOnly && (!needsLogin || (staff !== null && seesTakings(staff.role)));
  /** The floor: whoever works the counter (a kitchen login records no table changes). */
  const seesFloor = !kitchenOnly && !isManagerPhone() && !isCloudSite() && (!needsLogin || staff !== null);
  // Every move is one step (nav.ts), the Register too, so Back is always "where I just was".
  const go = useCallback((to: string) => withTransition(() => {
    navigate(to);
    if (to === KITCHEN) setFromRegister(true);
  }), []);
  const show = useCallback((kitchen: boolean) => go(kitchen ? KITCHEN : ''), [go]);
  const findSupplier = useCallback((ingredientId: string) => withTransition(() => {
    navigate('#suppliers', { ingredient: ingredientId });
  }), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && e.target.closest('[role="dialog"]')) return;
      if (e.key === 'F2' && !kitchenOnly) { e.preventDefault(); show(!inKitchen); }
      if (e.key === 'F3' && seesOwner) { e.preventDefault(); go(hash === OWNER ? '' : OWNER); }
      if (e.key === 'F4' && needsLogin && staff) { e.preventDefault(); lock(); }
      if (e.key === 'F1' && seesFloor) {
        e.preventDefault(); // F1 is the browser's help page otherwise
        if (hash === TABLES) go('');
        // The floor's fold is loaded with the floor, not with the Register.
        else void import('./tablesStore.ts').then(({ hasFloor }) => { if (hasFloor()) go(TABLES); });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hash, inKitchen, show, go, seesOwner, seesFloor, kitchenOnly, needsLogin, staff]);

  // Opening a page by voice (SCRUM-145): only the pages this person could open anyway.
  const mayManageStock = !needsLogin || (staff !== null && managesStock(staff.role));
  const isOwnerHere = !needsLogin || staff?.role === 'owner';
  const pages = useMemo(() => voicePages({
    seesOwner, managesStock: mayManageStock, owner: isOwnerHere, setup: !needsLogin || staff?.role === 'owner' || staff?.role === 'manager',
  }), [seesOwner, mayManageStock, isOwnerHere, needsLogin, staff]);
  const voiceOn = !isManagerPhone() && !isCloudSite() && (setup === 'none' || setup === 'done') && !kitchenOnly && (!needsLogin || staff !== null);
  const voice = useVoice(voiceOn ? pages : [], hash, go);

  const screen = renderScreen();
  // Back (Esc, the mouse's back button, Alt+←) may leave a place, never the Register, the lock,
  // setup or a kitchen screen with no Register to go back to.
  const atPlace = hash !== '' && !kitchenOnly && !isCloudSite() && (setup === 'none' || setup === 'done')
    && screen.type !== App && screen.type !== LockScreen && screen.type !== NotConnected
    && !(screen.type === SetupWizard && hash !== '#setup') && !(inKitchen && !fromRegister && !needsLogin);
  useBackKeys(atPlace);
  return voiceOn ? <>{screen}<VoiceNote voice={voice.voice} onBack={voice.back} /></> : screen;

  function renderScreen(): ReactElement {
  // The cloud site is the owner's phone page and nothing else (the demo for examiners too).
  // A manager's phone app (SCRUM-94): the counts and the stock, nothing else.
  if (isManagerPhone()) return <ManagerPhone hash={hash} />;
  if (isCloudSite()) return ownerToken() || isDemo() || adminShop() ? <OwnerView phone /> : <OwnerWelcome />;
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
  // Managers and owners only (SCRUM-41, mayManageStock); anyone else typing the address gets the
  // Register. The server refuses a cashier's stock events anyway.
  if (hash === OWNER && seesOwner) return <OwnerView onBack={() => go('')} />;
  // The developer's Shops screen (only answers on the developer's laptop: server/fleet.ts).
  if (hash === '#shops' && seesOwner) return <ShopsView onBack={() => go('')} />;
  if (fleetShop() && seesOwner) return <OwnerView key={hash} shop={fleetShop()!} onBack={() => go('#shops')} />;
  // The shop's day (Shop Day Navigation): Receive, Order and Count are places of their own;
  // Items holds raw materials, semi-processed and finished items. The older addresses
  // (#inventory, #manager, #menu, #recipes) still open the same places.
  if (hash === '#receive' && mayManageStock) return <ReceiveView onRegister={() => go('')} />;
  // #order/suppliers: ordering by supplier, a place of its own. #order/<supplier id> opens that supplier's cart.
  if (hash === '#order/suppliers' && mayManageStock) return <OrderView key={hash} bySupplier onRegister={() => go('')} />;
  if ((hash === '#order' || hash.startsWith('#order/')) && mayManageStock) {
    return <OrderView key={hash} supplierId={hash.startsWith('#order/') ? decodeURIComponent(hash.slice('#order/'.length)) : undefined} onRegister={() => go('')} />;
  }
  if ((hash === '#count' || hash === '#manager') && mayManageStock) return <ManagerView onRegister={() => go('')} />;
  // #items/low: opened to order (Orders' Order by item), out and low first.
  if ((hash === '#items' || hash === '#items/raw' || hash === '#items/low' || hash === '#inventory') && mayManageStock) {
    return <InventoryView onFindSupplier={findSupplier} onRegister={() => go('')} lowFirst={hash === '#items/low'} />;
  }
  // #items/item/<id>: one raw material's sheet, on its History (Visual Flow's Stock view links here).
  if (hash.startsWith('#items/item/') && mayManageStock) {
    return <InventoryView key={hash} onFindSupplier={findSupplier} onRegister={() => go('')} openId={decodeURIComponent(hash.slice('#items/item/'.length))} />;
  }
  // The owner changes the menu; managers can mark items sold out during service.
  if ((hash === '#items/finished' || hash === '#menu') && (!needsLogin || (staff !== null && seesTakings(staff.role)))) {
    return <MenuView owner={isOwnerHere} onBack={() => go('')} />;
  }
  // Recipes are the owner's alone, opened with his PIN on the screen itself: a dish's recipe from
  // the dish (#items/recipe/<id>), all of them (#items/recipe, or the old #recipes), and what the kitchen makes.
  // Semi-processed items are items, not recipes: no PIN; the owner changes them.
  if (hash === '#items/semi' && mayManageStock) return <SemiView onRegister={() => go('')} />;
  if ((hash === '#items/recipe' || hash === '#recipes') && isOwnerHere) return <RecipesView onRegister={() => go('')} />;
  if (hash.startsWith('#items/recipe/') && isOwnerHere) {
    return <RecipesView key={hash} focus={decodeURIComponent(hash.slice('#items/recipe/'.length))} onRegister={() => go('')} />;
  }
  // How each dish is made, drawn (the owner's, like the recipes): #flow, or #flow/<item> for one item.
  if ((hash === '#flow' || hash.startsWith('#flow/')) && seesOwner) {
    return <Suspense fallback={<div className="owner" aria-busy="true" />}><VisualFlowView key={hash} onRegister={() => go('')} /></Suspense>;
  }
  if (hash === TABLES && seesFloor) {
    return <Suspense fallback={<div className="floor" aria-busy="true" />}><FloorView onBack={() => go('')} /></Suspense>;
  }
  if ((hash === '#suppliers' || hash === '#items/suppliers') && mayManageStock) {
    return <SupplierView filterIngredientId={filterIngredientId} onRegister={() => go('')} />;
  }
  return (
    <App onKitchen={() => show(true)} onTables={seesFloor ? () => go(TABLES) : undefined} onOwner={needsLogin && seesOwner ? () => go(OWNER) : undefined}
      onSwitch={needsLogin ? lock : undefined} canManageStock={mayManageStock}
      onVoice={voiceOn ? { start: () => void voice.start(), stop: voice.stop } : undefined} />
  );
  }
}

/** The manager's phone app: who it belongs to comes from the cloud once, then the counts. */
function ManagerPhone({ hash }: { hash: string }) {
  const [me, setMe] = useState<'loading' | 'ready' | string>('loading');
  useEffect(() => { loadMe().then(() => setMe('ready'), (e: unknown) => setMe(e instanceof Error ? e.message : String(e))); }, []);
  if (me === 'loading') return <div className="setup" aria-busy="true" />;
  if (me !== 'ready') return <main className="setup"><p className="setup__error" role="alert">{me}</p></main>;
  // Count, Receive and the stock (Items): what a manager does away from the counter.
  if (hash === '#receive') return <ReceiveView />;
  return hash === '#items' || hash === '#inventory' ? <InventoryView /> : <ManagerView />;
}
