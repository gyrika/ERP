import { useSyncExternalStore } from 'react';
import type { Section } from './OwnerNav.tsx';

/**
 * The small numbers on the owner menu ("3 to order", "2 to look at"). The pages already
 * work them out from the shop's history; they post them here, so the menu shows them
 * without loading that history a second time. Kept for the session, in memory.
 */
let badges: Partial<Record<Section, number>> = {};
const listeners = new Set<() => void>();

export const setBadge = (section: Section, n: number): void => {
  if ((badges[section] ?? 0) === n) return;
  badges = { ...badges, [section]: n };
  listeners.forEach((l) => l());
};

export const useBadges = (): Partial<Record<Section, number>> =>
  useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => badges);

/** For tests: forget what the pages said. */
export const clearBadges = (): void => { badges = {}; listeners.forEach((l) => l()); };
