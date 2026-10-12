import { useCallback, useEffect, useState } from 'react';
import { App } from './App.tsx';
import { Kitchen } from './Kitchen.tsx';

const KITCHEN = '#kitchen';

/**
 * One app, one view at a time. A kitchen device bookmarks /#kitchen. Until the
 * kitchen has its own screen, the counter PC shows both: F2 (or the Kitchen
 * key) flips the whole screen between Register and Kitchen, in the same tab.
 * The order and the tickets are stored, so flipping loses nothing.
 */
export function Root() {
  const [hash, setHash] = useState(location.hash);
  /** Came here from the Register, so the Kitchen offers a way back. */
  const [fromRegister, setFromRegister] = useState(false);

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
      if (e.key !== 'F2') return;
      e.preventDefault();
      show(!inKitchen);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [inKitchen, show]);

  return inKitchen
    ? <Kitchen onBack={fromRegister ? () => show(false) : undefined} />
    : <App onKitchen={() => show(true)} />;
}
