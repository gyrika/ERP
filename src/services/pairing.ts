import { isDemo } from '../ui/storage.ts';

/**
 * Is this device paired with the server on the counter PC, and as what?
 * A pairing link (`?pair=<token>&shop=<id>&as=kitchen`, printed by `npm run server:device`)
 * is opened once: the app keeps the token, then takes it out of the address bar.
 * The demo never pairs.
 */
const TOKEN = 'cb.sync.token';
const KIND = 'cb.sync.kind';
const SHOP = 'cb.sync.shop';
const OWNER = 'cb.owner.token';
const MANAGER = 'cb.manager.token';

const get = (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } };
const set = (k: string, v: string): void => { try { localStorage.setItem(k, v); } catch { /* blocked */ } };

export const pairFromUrl = (): void => {
  const url = new URL(location.href);
  // The owner's phone: `?owner=<token>` from `npm run device -- --kind owner` (in cloud/).
  const owner = url.searchParams.get('owner');
  if (owner) {
    set(OWNER, owner);
    url.searchParams.delete('owner');
    history.replaceState(null, '', url.pathname + url.search + url.hash);
  }
  // A manager's phone: `?manager=<token>` from Shop setup → Devices (SCRUM-94).
  const manager = url.searchParams.get('manager');
  if (manager) {
    set(MANAGER, manager);
    url.searchParams.delete('manager');
    history.replaceState(null, '', url.pathname + url.search + url.hash);
  }
  const token = url.searchParams.get('pair');
  if (!token) return;
  set(TOKEN, token);
  set(KIND, url.searchParams.get('as') === 'kitchen' ? 'kitchen' : 'counter');
  const shop = url.searchParams.get('shop');
  if (shop) set(SHOP, shop);
  url.searchParams.delete('pair');
  url.searchParams.delete('as');
  url.searchParams.delete('shop');
  history.replaceState(null, '', url.pathname + url.search + url.hash);
};

export const syncToken = (): string | null => (isDemo() ? null : get(TOKEN));

/** The shop the server paired this device with (stamped on every event), if the link said. */
export const pairedShop = (): string | null => get(SHOP);

/** A kitchen device shows the kitchen and nothing else, with no login (the server enforces the same). */
export const isKitchenDevice = (): boolean => syncToken() !== null && get(KIND) === 'kitchen';


/** The owner's phone token for the cloud copy (read-only), if this device has one. */
export const ownerToken = (): string | null => (isDemo() ? null : get(OWNER));

/** A manager's phone app's key (SCRUM-94), if this device has one. */
export const managerToken = (): string | null => (isDemo() ? null : get(MANAGER));

/**
 * The cloud build (`npm run build:cloud`, served by the cloud Worker) holds only
 * the Owner view: nobody on the internet reaches a register there.
 */
export const isCloudSite = (): boolean => import.meta.env.VITE_SITE === 'cloud';

/**
 * The manager's phone app (SCRUM-94): the cloud site opened from a manager's QR code.
 * Manager and Inventory only, signed by the person the phone was made for.
 */
export const isManagerPhone = (): boolean => isCloudSite() && managerToken() !== null;

/** The Shops screen's shop on the developer's laptop (`#shops/<id>`, read through the local server). */
export const fleetShop = (): string | null => /^#shops\/([a-z0-9-]{1,64})$/.exec(location.hash)?.[1] ?? null;

/** The developer's admin view of one shop (`/admin/shop/<id>` in the cloud, behind the admin password). */
export const adminShop = (): string | null =>
  (isCloudSite() ? /^\/admin\/shop\/([a-z0-9-]{1,64})$/.exec(location.pathname)?.[1] : null) ?? null;

/** The setup wizard made this screen the counter (no link to open: the shop PC pairs itself). */
export const pairAsCounter = (token: string, shopId: string): void => {
  set(TOKEN, token);
  set(KIND, 'counter');
  set(SHOP, shopId);
};
