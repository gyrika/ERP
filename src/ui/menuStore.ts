import { useSyncExternalStore } from 'react';
import { menuState, menuVersion, setMenuState, subscribeMenu } from '../domain/menu.ts';
import { menuStateFromEvents } from '../domain/menuEdits.ts';
import { readAll, subscribeEvents } from './eventLog.ts';

let started = false;
const refresh = () => setMenuState(menuStateFromEvents(readAll().filter((event) => event.type.startsWith('menu.'))));

const start = () => {
  if (started) return;
  started = true;
  refresh();
  subscribeEvents(refresh);
  setInterval(() => {
    if (Object.keys(menuState().soldOut).length) refresh();
  }, 60_000);
};

export const useMenu = (): number => {
  start();
  return useSyncExternalStore(subscribeMenu, menuVersion);
};
