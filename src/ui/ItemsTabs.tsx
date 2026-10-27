import { useState } from 'react';
import { fmt } from '../domain/money.ts';
import type { ValueKind } from '../domain/valuation.ts';
import { isManagerPhone } from '../services/pairing.ts';
import { useValuation, useValueTrend } from '../services/inventoryStore.ts';

/**
 * Items: everything the shop holds, in the order the food goes: raw materials (bought from
 * suppliers), semi-processed (made in the kitchen), finished (on the menu, each with its recipe).
 * One place instead of Stock, Recipes, Menu and Suppliers. Semi-processed items are items, not
 * recipes: everyone sees them, with no PIN. Only the finished items' recipes are the owner's.
 *
 * On top, the money on the shelves (SCRUM-163): the stock value, its last 30 days, and each
 * tab's share. Finished items are made to order, so their value is in the other two.
 * Warehouses (SCRUM-184) is the raw and semi-processed items again, by where they are kept.
 */
export type ItemsTab = ValueKind | 'warehouses';

const TABS: { id: ItemsTab; label: string; href: string }[] = [
  { id: 'raw', label: 'Raw materials', href: '#items' },
  { id: 'semi', label: 'Semi-processed', href: '#items/semi' },
  { id: 'finished', label: 'Finished', href: '#items/finished' },
  // Where the raw and semi-processed items are kept (SCRUM-184).
  { id: 'warehouses', label: 'Warehouses', href: '#items/warehouses' },
];

export function ItemsTabs({ current }: { current: ItemsTab }) {
  const valuation = useValuation();
  // The manager's phone has the stock only.
  if (isManagerPhone()) return null;
  return (
    <div className="items-head">
      <StockValue total={valuation.total} notCounted={valuation.notCounted} noCost={valuation.noCost} current={current} />
      <nav className="items-tabs" aria-label="Items">
        {TABS.map((t) => (
          <a key={t.id} href={t.href} className="pill" aria-current={t.id === current ? 'page' : undefined}>
            {t.label}
            {t.id !== 'warehouses' && <span className="items-tabs__value num">Rs {fmt(valuation.byKind[t.id])}</span>}
          </a>
        ))}
      </nav>
    </div>
  );
}

const dayLabel = (t: number) => new Date(t).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

/** "Stock value Rs 84,200" and its last 30 days; pointing at a day shows that day's value. */
function StockValue({ total, notCounted, noCost, current }: { total: number; notCounted: number; noCost: number; current: ItemsTab }) {
  const trend = useValueTrend();
  const [at, setAt] = useState<number | null>(null);
  const point = trend && at !== null ? trend[at] : null;
  const left = [notCounted && `${notCounted} not counted`, noCost && `${noCost} without a cost`].filter(Boolean).join(', ');
  return (
    <section className="stock-value" aria-label="Stock value">
      <div className="stock-value__figure">
        <span className="stock-value__label">{point ? dayLabel(point.at) : 'Stock value'}</span>
        <strong className="stock-value__total num">Rs {fmt(point ? point.cents : total)}</strong>
        <span className="stock-value__note">
          {current === 'finished'
            ? 'Finished items are made to order: their value is in the raw and semi-processed items.'
            : left ? `${left}: not in the total.` : 'On hand × unit cost.'}
        </span>
      </div>
      {trend ? <Sparkline points={trend} onPoint={setAt} /> : <div className="stock-value__spark skeleton" aria-hidden="true" />}
    </section>
  );
}

const W = 240;
const H = 56;
const PAD = 5; // room for the end dot

/** One line, one series: the value at each day's end. */
function Sparkline({ points, onPoint }: { points: { at: number; cents: number }[]; onPoint: (i: number | null) => void }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(...points.map((p) => p.cents));
  const min = Math.min(...points.map((p) => p.cents));
  const span = max - min || 1;
  const x = (i: number) => PAD + (i / Math.max(1, points.length - 1)) * (W - 2 * PAD);
  const y = (c: number) => (max === min ? H / 2 : PAD + (1 - (c - min) / span) * (H - 2 * PAD));
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.cents).toFixed(1)}`).join('');
  const show = (i: number | null) => { setHover(i); onPoint(i); };
  const last = points.length - 1;
  const mark = hover ?? last;
  return (
    <svg className="stock-value__spark" viewBox={`0 0 ${W} ${H}`} role="img"
      aria-label={`Last ${points.length} days: from Rs ${fmt(points[0].cents)} to Rs ${fmt(points[last].cents)}`}
      onPointerLeave={() => show(null)}>
      {hover !== null && <line className="stock-value__cross" x1={x(hover)} x2={x(hover)} y1={0} y2={H} />}
      <path className="stock-value__line" d={d} />
      <circle className="stock-value__dot" cx={x(mark)} cy={y(points[mark].cents)} r={4} />
      {points.map((p, i) => (
        <rect key={p.at} x={x(i) - W / points.length / 2} y={0} width={W / points.length} height={H} fill="transparent"
          onPointerEnter={() => show(i)} />
      ))}
    </svg>
  );
}
