import { useCallback, useEffect, useRef, useState } from 'react';
import { elapsedLabel } from '../../domain/kitchen.ts';
import type { FloorTable, TableState } from '../../domain/tables.ts';
import { useNow } from '../Kitchen.tsx';
import { setTable, undoTable, useFloor } from '../tablesStore.ts';
import './floor.css';

/** State words. Sinhala and Tamil stay empty until the owner gives them. */
const WORD: Record<TableState, { en: string; si: string; ta: string }> = {
  free: { en: 'Free', si: '', ta: '' },
  occupied: { en: 'Occupied', si: '', ta: '' },
  needs_cleaning: { en: 'Needs cleaning', si: '', ta: '' },
  reserved: { en: 'Reserved', si: '', ta: '' },
};

/** What a cashier can do to a table in each state: at most two keys, never a menu. */
const ACTIONS: Record<TableState, { key: string; label: string; to: TableState }[]> = {
  free: [{ key: 'O', label: 'Seated', to: 'occupied' }, { key: 'R', label: 'Reserved', to: 'reserved' }],
  occupied: [{ key: 'C', label: 'Cleaned', to: 'free' }],
  needs_cleaning: [{ key: 'C', label: 'Cleaned', to: 'free' }],
  reserved: [{ key: 'O', label: 'Seated', to: 'occupied' }, { key: 'F', label: 'Free', to: 'free' }],
};
const KEYS: Record<string, TableState> = { c: 'free', f: 'free', r: 'reserved', o: 'occupied' };

/** Tiles in the first row: how far Up and Down move. */
const columns = (grid: HTMLElement | null): number => {
  const tiles = grid ? [...grid.children] as HTMLElement[] : [];
  if (!tiles.length) return 1;
  return Math.max(1, tiles.filter((t) => t.offsetTop === tiles[0].offsetTop).length);
};

/**
 * The floor (SCRUM-168). Mind: the cashier, customer waiting, hands busy. They know the room;
 * they need which table is free, and to mark one cleaned in one key. One tile per table by
 * number, coloured by its state, with how long it has been so. Arrows pick a table; C cleaned,
 * F free, R reserved, O seated; Ctrl+Z undoes. F1 or Esc goes back to the Register (Root).
 * Every change is a `table.state_set` event; Undo is `table.state_set_undone`.
 */
export default function FloorView({ onBack }: { onBack: () => void }) {
  const { tables } = useFloor();
  const now = useNow(1000);
  const [picked, setPicked] = useState(0);
  const [undos, setUndos] = useState<{ tableId: string; eventId: string }[]>([]);
  const grid = useRef<HTMLDivElement>(null);
  const at = Math.min(picked, Math.max(0, tables.length - 1));
  const table: FloorTable | undefined = tables[at];

  const change = useCallback((to: TableState) => {
    if (!table || table.state === to) return;
    const eventId = setTable(table, to);
    setUndos((u) => [...u, { tableId: table.id, eventId }]);
  }, [table]);
  const undo = useCallback(() => {
    const last = undos[undos.length - 1];
    if (!last) return;
    undoTable(last.tableId, last.eventId);
    setUndos(undos.slice(0, -1));
  }, [undos]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && e.target.closest('input, textarea, select, [role="dialog"]')) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns(grid.current), ArrowDown: columns(grid.current) }[e.key];
      if (step !== undefined) {
        e.preventDefault();
        setPicked(Math.min(tables.length - 1, Math.max(0, at + step)));
        return;
      }
      const to = KEYS[e.key.toLowerCase()];
      if (to) { e.preventDefault(); change(to); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [at, tables.length, change, undo]);

  // The picked tile keeps the focus, so arrows and Tab agree.
  useEffect(() => {
    const el = grid.current?.children[at] as HTMLElement | undefined;
    if (el && grid.current?.contains(document.activeElement)) el.focus();
  }, [at]);

  return (
    <main className="floor" aria-label="Tables">
      <header className="floor__head">
        <h1>Tables</h1>
        <span className="floor__keys">
          {undos.length > 0 && <button type="button" className="corner__key" onClick={undo}>Undo <kbd>Ctrl Z</kbd></button>}
          <button type="button" className="corner__key" onClick={onBack}>Register <kbd>F1</kbd></button>
        </span>
      </header>
      <div className="floor__grid" ref={grid} role="listbox" aria-label="Tables by number" aria-orientation="horizontal">
        {tables.map((t, i) => {
          const time = elapsedLabel(now - t.since);
          const word = t.noCamera ? `${WORD[t.state].en.toLowerCase()} (camera off)` : WORD[t.state].en.toLowerCase();
          return (
            <button key={t.id} type="button" role="option" aria-selected={i === at} tabIndex={i === at ? 0 : -1}
              aria-label={`Table ${t.label}, ${word}, ${time}`}
              className={`floor__tile floor__tile--${t.noCamera ? 'nocam' : t.state}`} onClick={() => setPicked(i)}>
              <span className="floor__num">{t.label}</span>
              <span className="floor__state">{WORD[t.state].en}{t.noCamera && ' · no camera'}</span>
              <span className="floor__time num">{time}</span>
            </button>
          );
        })}
      </div>
      {table && (
        <div className="floor__actions" aria-label={`Table ${table.label}`} role="group">
          <span className="floor__picked">Table {table.label}</span>
          {ACTIONS[table.state].map((a) => (
            <button key={a.key} type="button" className="chip floor__action" onClick={() => change(a.to)}>
              {a.label} <kbd>{a.key}</kbd>
            </button>
          ))}
        </div>
      )}
      {!tables.length && <p className="floor__empty">No tables yet.</p>}
    </main>
  );
}
