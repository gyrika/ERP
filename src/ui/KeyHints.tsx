import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * Hold Alt: every key on the screen shows (SCRUM-245). For a new cashier with no training time,
 * the keys are learnt by looking, never from a list on the wall, and they cost no room on screen.
 *
 * While Alt is held, `<html data-keys="on">` is set, and the stylesheet:
 *  - shows every `<kbd>` hidden for room (a narrow screen) and the corner's More keys;
 * elements marked `data-keyhint="1"` get a badge with that key (the menu tabs: Alt+1…9), and the
 * screen's keys with no button (like Ctrl+Z) show as one line over the element marked
 * `data-keyarea` (the menu), never over the order or its primary action.
 * Letting go hides it all. Nothing is clickable in it and nothing takes focus.
 */

/** Held this long before anything shows, so a quick Alt+1 never flashes the screen. */
export const SHOW_AFTER_MS = 200;

interface Badge { key: string; text: string; top: number; left: number }

const badges = (): Badge[] =>
  [...document.querySelectorAll<HTMLElement>('[data-keyhint]')].flatMap((el, i) => {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || r.bottom < 0 || r.top > innerHeight) return [];
    return [{ key: `${i}-${el.dataset.keyhint}`, text: el.dataset.keyhint!, top: r.top - 8, left: r.right - 10 }];
  });

export function useAltKeys(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const hide = () => { clearTimeout(timer); timer = undefined; setOn(false); };
    const down = (e: KeyboardEvent) => {
      if (e.key !== 'Alt') return;
      // Alone, Alt would move the browser's focus to its own menu: the counter keeps it.
      e.preventDefault();
      if (e.repeat || timer) return;
      timer = setTimeout(() => setOn(true), SHOW_AFTER_MS);
    };
    const up = (e: KeyboardEvent) => {
      if (e.key !== 'Alt') return;
      e.preventDefault();
      hide();
    };
    const away = () => { if (document.hidden) hide(); };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', hide); // Alt+Tab away: the keyup never comes
    document.addEventListener('visibilitychange', away);
    return () => {
      hide();
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', hide);
      document.removeEventListener('visibilitychange', away);
    };
  }, []);
  useEffect(() => {
    const root = document.documentElement;
    if (on) root.dataset.keys = 'on'; else delete root.dataset.keys;
  }, [on]);
  return on;
}

/** Where the line of keys goes: across the top of the `data-keyarea` element, under its tabs. */
const legendPlace = (): { top: number; left: number; width: number } | null => {
  const r = document.querySelector('[data-keyarea]')?.getBoundingClientRect();
  return r && r.width ? { top: r.top + 72, left: r.left + 16, width: r.width - 32 } : null;
};

export type KeyLegendItems = readonly (readonly [key: string, what: string])[];

/** Mounted once per screen: holds the Alt state and, while it is held, draws the badges and the screen's other keys. */
export function KeyHints({ legend = [] }: { legend?: KeyLegendItems }) {
  const on = useAltKeys();
  const [seen, setSeen] = useState<{ list: Badge[]; place: ReturnType<typeof legendPlace> }>({ list: [], place: null });
  // Measured after the stylesheet has shown what was hidden (next frame).
  useEffect(() => {
    if (!on) { setSeen({ list: [], place: null }); return; }
    const f = requestAnimationFrame(() => setSeen({ list: badges(), place: legendPlace() }));
    return () => cancelAnimationFrame(f);
  }, [on]);
  if (!on) return null;
  return createPortal(
    <div className="keyhints" aria-hidden="true">
      {seen.list.map((b) => <kbd key={b.key} className="keyhints__badge" style={{ top: b.top, left: b.left }}>{b.text}</kbd>)}
      {legend.length > 0 && (
        <div className="keylegend" style={seen.place ?? undefined}>
          {legend.map(([k, what]) => <span key={k + what} className="keylegend__item"><kbd>{k}</kbd>{what}</span>)}
        </div>
      )}
    </div>,
    document.body,
  );
}
