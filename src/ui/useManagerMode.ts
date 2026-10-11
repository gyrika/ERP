import { useCallback, useEffect, useRef, useState } from 'react';
import type { Actor } from '../domain/auth.ts';
import { clunk } from './sound.ts';

/** Manager mode ends after this long with no key press or tap. Never stay in it by accident. */
export const MANAGER_IDLE_MS = 10_000;

/**
 * Manager mode session: who unlocked it, and the idle timer that ends it.
 * Any key press or tap anywhere resets the timer. `onEnd` runs however the
 * session ends (Esc, Exit, idle), so callers can close what belongs to it.
 */
export function useManagerMode(onEnd: () => void) {
  const [manager, setManager] = useState<Actor | null>(null);
  const active = useRef<Actor | null>(null);
  const endRef = useRef(onEnd);
  endRef.current = onEnd;

  const exit = useCallback(() => {
    if (!active.current) return;
    active.current = null;
    setManager(null);
    endRef.current();
  }, []);

  const enter = useCallback((actor: Actor) => {
    active.current = actor;
    setManager(actor);
    clunk(); // with the unlock motion; plays even with reduced motion (only the spring is swapped)
  }, []);

  useEffect(() => {
    if (!manager) return;
    let timer = setTimeout(exit, MANAGER_IDLE_MS);
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(exit, MANAGER_IDLE_MS);
    };
    window.addEventListener('keydown', reset, true);
    window.addEventListener('pointerdown', reset, true);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('keydown', reset, true);
      window.removeEventListener('pointerdown', reset, true);
    };
  }, [manager, exit]);

  return { manager, enter, exit };
}
