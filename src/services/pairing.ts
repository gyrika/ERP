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

/**
 * The cloud build (`npm run build:cloud`, served by the cloud Worker) holds only
 * the Owner view: nobody on the internet reaches a register there.
 */
export const isCloudSite = (): boolean => import.meta.env.VITE_SITE === 'cloud';

/** The setup wizard made this screen the counter (no link to open: the shop PC pairs itself). */
export const pairAsCounter = (token: string, shopId: string): void => {
  set(TOKEN, token);
  set(KIND, 'counter');
  set(SHOP, shopId);
};
