import { useSyncExternalStore } from 'react';
import { menuState, menuVersion, setMenuState, subscribeMenu } from '../domain/menu.ts';
import { menuStateFromEvents } from '../domain/menuEdits.ts';
import { readAll, subscribeEvents } from './eventLog.ts';

/**
 * Keeps this screen's menu in step with the shop's menu events (from the event log, which
 * keeps them for good), and re-checks "sold out until morning" every minute.
 */
let started = false;
const refresh = () => setMenuState(menuStateFromEvents(readAll().filter((e) => e.type.startsWith('menu.'))));

const start = () => {
  if (started) return;
  started = true;
  refresh();
  subscribeEvents(refresh);
  // Sold-out items come back by themselves in the morning.
  setInterval(() => { if (Object.keys(menuState().soldOut).length) refresh(); }, 60_000);
};

/** Re-renders when the menu changes. Any screen showing items or prices calls it. */
export const useMenu = (): number => {
  start();
  return useSyncExternalStore(subscribeMenu, menuVersion);
};
