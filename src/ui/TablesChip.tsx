import { floorSummary } from '../domain/tables.ts';
import { useNow } from './Kitchen.tsx';
import { useFloor } from './tablesStore.ts';

/**
 * The cashier's quiet key to the floor (SCRUM-168), beside the Kitchen chip: how many tables
 * are free, and a dot in the colour of the most urgent one (a table to clean). F1 opens the floor.
 * No layout yet: no chip.
 */
export default function TablesChip({ onOpen }: { onOpen: () => void }) {
  const { tables, cleanAlertS } = useFloor();
  const now = useNow(1000);
  if (!tables.length) return null;
  const { free, tone } = floorSummary(tables, now, cleanAlertS);
  const dirty = tables.filter((t) => t.state === 'needs_cleaning').length;
  const label = `Tables: ${free} of ${tables.length} free${dirty ? `, ${dirty} to clean` : ''}`;
  return (
    <button type="button" className="corner__key kchip" onClick={onOpen} aria-label={label}>
      {tone && <span className={`kchip__dot kchip__dot--${tone}`} aria-hidden />}
      <span aria-hidden>
        Tables <span className="num"> · {free} free</span>
      </span>
      <kbd>F1</kbd>
    </button>
  );
}
