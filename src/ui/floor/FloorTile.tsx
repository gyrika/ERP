import type { ReactNode } from 'react';
import { elapsedLabel } from '../../domain/kitchen.ts';
import type { FloorTable, TableState } from '../../domain/tables.ts';
import './floor.css';

/**
 * One table on a floor: its number, state colour and how long it has been so. The Register's
 * floor (F1, SCRUM-168) and the owner's Computer vision page (#vision, SCRUM-174) share it.
 */

/** State words. Sinhala and Tamil stay empty until the owner gives them. */
export const WORD: Record<TableState, { en: string; si: string; ta: string }> = {
  free: { en: 'Free', si: '', ta: '' },
  occupied: { en: 'Occupied', si: '', ta: '' },
  needs_cleaning: { en: 'Needs cleaning', si: '', ta: '' },
  reserved: { en: 'Reserved', si: '', ta: '' },
};

/** Tiles in the first row: how far Up and Down move. */
export const columns = (grid: HTMLElement | null): number => {
  const tiles = grid ? [...grid.children] as HTMLElement[] : [];
  if (!tiles.length) return 1;
  return Math.max(1, tiles.filter((t) => t.offsetTop === tiles[0].offsetTop).length);
};

export function FloorTile({ t, now, selected, onPick, children }: {
  t: FloorTable; now: number; selected: boolean; onPick: () => void;
  /** More about the table, under its time (the owner's day numbers). */
  children?: ReactNode;
}) {
  const time = elapsedLabel(now - t.since);
  const word = t.noCamera ? `${WORD[t.state].en.toLowerCase()} (camera off)` : WORD[t.state].en.toLowerCase();
  return (
    <button type="button" role="option" aria-selected={selected} tabIndex={selected ? 0 : -1}
      aria-label={`Table ${t.label}, ${word}, ${time}`}
      className={`floor__tile floor__tile--${t.noCamera ? 'nocam' : t.state}`} onClick={onPick}>
      <span className="floor__num">{t.label}</span>
      <span className="floor__state">{WORD[t.state].en}{t.noCamera && ' · no camera'}</span>
      <span className="floor__time num">{time}</span>
      {children}
    </button>
  );
}
