import { storageKey } from './storage.ts';

/**
 * Does this counter show the Kitchen view (the Kitchen key and screen, Send to kitchen)?
 * Off by default (2026-11-16): the staff learn the counter first and the kitchen comes back
 * once they are at home with it. Off, payment sends the order with it, so the sale, stock and
 * reports work exactly as before; nothing waits for a Send that has no button.
 * A paired kitchen device or a kitchen login still shows the Kitchen.
 */
const KEY = () => storageKey('kitchenScreen');

export const kitchenScreenOn = (): boolean => {
  try { return localStorage.getItem(KEY()) === '1'; } catch { return false; }
};

export const setKitchenScreen = (on: boolean): void => {
  try {
    if (on) localStorage.setItem(KEY(), '1'); else localStorage.removeItem(KEY());
  } catch { /* private mode: this visit only */ }
};
