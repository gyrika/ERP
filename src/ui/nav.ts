/**
 * One way to move between the shop's places, so Back always means "where I just was".
 *
 * Every move to a place (the Register included) is one history entry that knows how deep it
 * is; a link (<a href="#items">) or `location.hash = …` is adopted as one too, so the sidebar,
 * the tabs and the palette all count the same. A change inside a place (which recipe is drawn)
 * replaces its entry instead. Back walks one entry; on a place opened directly (a bookmark, a
 * reload with no history) it goes up instead: #items/semi → #items → the Register.
 *
 * Every hand gets the same Back (useBackKeys): Esc, the mouse's back button, Alt+← and the
 * browser's own Back. A layer on top (a sheet, a dialog, the palette) closes first, and in a
 * text box Esc first leaves the box. On the Register they do nothing, so the app is never left
 * by accident.
 */
import { useEffect } from 'react';

/** What a place was opened with (the ingredient Suppliers were found for), kept in its entry. */
export type NavData = Record<string, string>;
type Entry = { cbDepth: number; data?: NavData };

const EVENT = 'cb-nav';
/** Anything drawn on top of a place: Back closes it before it leaves the place. */
const LAYER = '[role="dialog"], [role="alertdialog"], dialog[open]';

const entry = (): Partial<Entry> | null => {
  const s: unknown = history.state;
  return s && typeof s === 'object' ? (s as Partial<Entry>) : null;
};
const url = (to: string) => to || location.pathname + location.search;
const emit = () => window.dispatchEvent(new Event(EVENT));

let depth = 0;

/** Takes the current entry as it is (a reload keeps its depth); one without a depth is a new step, or the first. */
function adopt(fresh: boolean) {
  const d = entry()?.cbDepth;
  if (typeof d === 'number') { depth = d; return; }
  depth = fresh ? depth + 1 : 0;
  history.replaceState({ ...entry(), cbDepth: depth }, '');
}

/** Where history starts for this screen (Root calls it when it mounts). */
export const startNav = () => adopt(false);

/** What the current place was opened with. */
export const navData = (): NavData | undefined => entry()?.data;

/** The place above this one: #items/recipe/x → #items/recipe → #items → the Register (''). */
export const parentOf = (hash: string) => {
  const i = hash.lastIndexOf('/');
  return i > 0 ? hash.slice(0, i) : '';
};

/** Goes to a place: one step, so Back returns here. */
export function navigate(to: string, data?: NavData) {
  if (to === location.hash && !data) return;
  depth += 1;
  history.pushState({ cbDepth: depth, data } satisfies Entry, '', url(to));
  emit();
}

/** Changes the current place in place (no new step). */
export function replace(to: string, data?: NavData) {
  history.replaceState({ cbDepth: depth, data } satisfies Entry, '', url(to));
  emit();
}

/** One step back; on a place opened directly, up to the place above it. */
export function back() {
  if (depth > 0) history.back();
  else if (location.hash) replace(parentOf(location.hash));
}

const RESTART = 'cb-restart';

/** The sidebar's part for the place already open was tapped: the place starts over (GRN Done → the deliveries). */
export const restartHere = () => window.dispatchEvent(new Event(RESTART));

/** Starts this place over when its sidebar part is tapped again. */
export function useRestart(cb: () => void) {
  useEffect(() => {
    window.addEventListener(RESTART, cb);
    return () => window.removeEventListener(RESTART, cb);
  }, [cb]);
}

/** Calls `cb` whenever the place changes, however it changed. */
export function onNavigate(cb: () => void) {
  window.addEventListener(EVENT, cb);
  window.addEventListener('popstate', cb);
  window.addEventListener('hashchange', cb);
  return () => {
    window.removeEventListener(EVENT, cb);
    window.removeEventListener('popstate', cb);
    window.removeEventListener('hashchange', cb);
  };
}

const topLayer = () => {
  const all = document.querySelectorAll<HTMLElement>(LAYER);
  return all.length ? all[all.length - 1] : null;
};
const typing = (t: EventTarget | null): t is HTMLElement => t instanceof HTMLElement
  && (t.isContentEditable || t.matches('textarea, select, input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit])'));

/** Was a layer open when this key went down? A sheet's own Esc may have closed it by the time Back hears the key. */
let layerAtKey = false;

if (typeof window !== 'undefined') {
  adopt(false);
  // Registered first, so every other listener sees the entry already adopted.
  window.addEventListener('popstate', () => adopt(true));
  window.addEventListener('hashchange', () => adopt(true));
  window.addEventListener('keydown', () => { layerAtKey = topLayer() !== null; }, true);
}

/**
 * Back by every hand. `atPlace`: this screen is a place Back may leave (not the Register, the
 * lock screen or a kitchen device). Esc that a screen already used (preventDefault) is left alone.
 */
export function useBackKeys(atPlace: boolean) {
  useEffect(() => {
    const step = () => {
      const layer = topLayer();
      // The layer closes the way it always does on Esc.
      if (layer) layer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      else if (atPlace) back();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); step(); return; }
      if (e.key !== 'Escape' || layerAtKey || !atPlace) return;
      // Decided after every listener has had the key: a screen's own Esc (a step's Back) wins.
      setTimeout(() => {
        if (e.defaultPrevented) return;
        if (typing(e.target)) e.target.blur();
        else back();
      });
    };
    // The mouse's back button (button 3): ours, so it never leaves the app.
    const onMouse = (e: MouseEvent) => {
      if (e.button !== 3) return;
      e.preventDefault();
      if (e.type === 'mouseup') step();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onMouse);
    window.addEventListener('mouseup', onMouse);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onMouse);
      window.removeEventListener('mouseup', onMouse);
    };
  }, [atPlace]);
}
