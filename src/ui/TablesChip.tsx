import { useEffect, useRef, useState } from 'react';
import { floorSummary, newlyDirty, type FloorTable } from '../domain/tables.ts';
import { useFloor } from './tablesStore.ts';

/**
 * The cashier's quiet key to the floor (SCRUM-168), beside the Kitchen chip: how many tables
 * are free. It turns red while any table needs cleaning (the owner, 2026-10-26). F1 opens the
 * floor. No layout yet: no chip.
 */
export default function TablesChip({ onOpen }: { onOpen: () => void }) {
  const { tables } = useFloor();
  if (!tables.length) return null;
  const { free, dirty, tone } = floorSummary(tables);
  const label = `Tables: ${free} of ${tables.length} free${dirty ? `, ${dirty} to clean` : ''}`;
  return (
    <button type="button" className={`corner__key kchip${tone ? ` kchip--${tone}` : ''}`} onClick={onOpen} aria-label={label}>
      {tone && <span className={`kchip__dot kchip__dot--${tone}`} aria-hidden />}
      <span aria-hidden>
        Tables <span className="num"> · {dirty ? `${dirty} to clean` : `${free} free`}</span>
      </span>
      <kbd>F1</kbd>
    </button>
  );
}

/** How long the cleaning note stays: the owner's 5 seconds. */
export const NOTE_MS = 5000;

const said = (dirty: FloorTable[]): string => {
  const names = dirty.map((t) => t.label);
  return names.length === 1 ? `Table ${names[0]} needs cleaning`
    : `Tables ${names.slice(0, -1).join(', ')} and ${names.at(-1)} need cleaning`;
};

/**
 * "Table N needs cleaning", for 5 s, when a table comes to need it. The owner's one exception to
 * "no banners" (2026-10-26): it takes no key, no focus and no tap, sits where the Undo toast does
 * (above it when both show), and goes by itself. Tables already dirty when it mounts say nothing.
 */
export function CleaningNote() {
  const { tables } = useFloor();
  const before = useRef(tables);
  const [note, setNote] = useState<{ id: number; text: string } | null>(null);
  useEffect(() => {
    const dirty = newlyDirty(before.current, tables);
    before.current = tables;
    if (dirty.length) setNote({ id: Date.now(), text: said(dirty) });
  }, [tables]);
  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), NOTE_MS);
    return () => clearTimeout(t);
  }, [note]);
  if (!note) return null;
  return (
    <div className="toast toast--note" role="status" aria-live="polite" key={note.id}>
      <span className="kchip__dot kchip__dot--bad" aria-hidden />
      <span>{note.text}</span>
    </div>
  );
}
