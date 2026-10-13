import type { StockStatus } from '../services/inventoryStore.ts';

const LABELS: Record<StockStatus, string> = {
  out: 'Out of stock',
  low: 'Low stock',
  ok: 'In stock',
  unknown: 'Not counted yet',
};

export function StatusDot({ status, size = 'md' }: { status: StockStatus; size?: 'md' | 'lg' }) {
  return (
    <span
      role="img"
      aria-label={LABELS[status]}
      title={LABELS[status]}
      className={`dot dot--${status} ${size === 'lg' ? 'dot--lg' : ''}`.trim()}
    />
  );
}
