import { cookTimeMs, elapsedLabel, queue, urgency, type KitchenTicket } from '../domain/kitchen.ts';
import { useNow } from './Kitchen.tsx';

/**
 * While the kitchen has no screen of its own, the Register shows one quiet key:
 * how many orders the kitchen has to make and how long the oldest has waited. The dot takes
 * the kitchen's urgency colour, so the cashier knows when to look (F2).
 * Its own clock, so the Register itself does not re-render every second.
 */
export function KitchenChip({ tickets, onOpen }: { tickets: KitchenTicket[]; onOpen: () => void }) {
  const now = useNow(1000);
  // Customers' orders only: prep tickets (SCRUM-136) never hurry the counter.
  const open = queue(tickets).filter((t) => !t.prep);
  const oldest = open[0];
  const waited = oldest ? now - oldest.firedAt : 0;
  const label = oldest
    ? `Kitchen: ${open.length} to make, oldest waiting ${elapsedLabel(waited)}`
    : 'Kitchen: nothing to make';
  return (
    <button type="button" className="corner__key kchip" onClick={onOpen} aria-label={label}>
      {oldest && <span className={`kchip__dot kchip__dot--${urgency(waited, cookTimeMs(oldest))}`} aria-hidden />}
      <span aria-hidden>
        Kitchen
        {oldest && <span className="num"> · {open.length} · {elapsedLabel(waited)}</span>}
      </span>
      <kbd>F2</kbd>
    </button>
  );
}
