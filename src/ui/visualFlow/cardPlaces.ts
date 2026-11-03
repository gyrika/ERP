/**
 * Where the owner dragged Visual Flow's cards, per item in focus: saved on this screen as he drags,
 * so the drawing he arranged is there again after the PC is turned off. A convenience only, like
 * the panel's folds: storage blocked or full, the cards fall back to the drawn layout.
 */
export type Places = Record<string, { x: number; y: number }>;

const KEY = 'vf-cards';

const readAll = (): Record<string, Places> => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}') as unknown;
    return v && typeof v === 'object' ? (v as Record<string, Places>) : {};
  } catch { return {}; }
};

/** The cards he moved for this item; the rest keep the drawn layout. */
export const cardPlaces = (focus: string): Places => readAll()[focus] ?? {};

/** Saves where the cards of this item are; none moved, the item is left out. */
export const saveCardPlaces = (focus: string, places: Places): void => {
  const all = readAll();
  if (Object.keys(places).length) all[focus] = places;
  else delete all[focus];
  try { localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* a convenience only */ }
};
