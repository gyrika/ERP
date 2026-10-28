import { BaseEdge, getBezierPath, Handle, Position, type Edge, type EdgeProps, type Node, type NodeProps } from '@xyflow/react';
import type { CSSProperties, ReactNode } from 'react';
import { fmt } from '../../domain/money.ts';
import type { ItemStock } from '../../domain/itemStock.ts';
import { andList } from '../../domain/production.ts';
import { batchShare, prepAmount } from '../../domain/prep.ts';
import type { Answer } from '../../domain/costing.ts';
import { formatQuantity } from '../../domain/quantity.ts';
import type { BaseUnit } from '../../domain/inventoryData.ts';
import type { FlowEdge, FlowNode, FlowView } from '../../domain/visualFlow.ts';

/**
 * What the canvas draws: one card per thing, one line per flow. A card says what it is, its
 * name, and the one number the view is about (how much, what it costs, what it earns); the
 * lines carry no labels, only their thickness. Colour stays quiet: the accent marks the item in
 * focus, amber marks a gap (no price, no batch size).
 */
export const KIND_LABEL: Record<FlowNode['kind'], string> = {
  raw: 'Raw', semi: 'Semi-processed', finished: 'Finished', resource: 'Resource', revenue: 'Revenue', profit: 'Profit', small: 'The rest',
};

/** The card's smallest text is 14px; the drawing never zooms out to where it would be smaller. */
export const MIN_ZOOM = 1;

export const rs = (cents: number) => `Rs ${fmt(Math.round(cents))}`;
export const amount = (qty: number, unit: string) => `${Number(qty.toFixed(qty < 10 ? 3 : 1)).toLocaleString('en-US')} ${unit}`;
export const pct = (share: number) => `${Math.round(share * 100)}%`;

/**
 * The canvas's views: the drawing's own three, Stock (SCRUM-163), the money on the shelves
 * behind this item, and Warehouse (SCRUM-184), where each ingredient is kept; both drawn on the
 * Material drawing.
 */
export type CanvasView = FlowView | 'stock' | 'warehouse';

/** A card's place (Warehouse view): its home, and how its stock is split, by warehouse index for the shade. */
export type Place = { home: string; homeIndex: number; split: { id: string; name: string; index: number; qty: number }[] };

/** A card's stock value: cents null when not known; share of the value behind the item in focus. */
export type Worth = { cents: number | null; share: number };

export type NodeData = {
  node: FlowNode;
  view: CanvasView;
  focus: boolean;
  /** The item in focus, by name ("Margherita Large"). */
  focusName: string;
  /** Takes new ingredients (a recipe that can change here). */
  takes: boolean;
  onToggle: (id: string) => void;
  /** Its stock, from the same ledger as Items; null: a resource or money. */
  stock: ItemStock | null;
  /** Left out by the filter: drawn faintly, so the flow stays whole. */
  dim: boolean;
  /** Off the path of the card tapped. */
  faded: boolean;
  /** Its amount as a share of a batch ("1/12 batch"), when it is one. */
  share: string | null;
  /** Its stock value, in the Stock view; the item in focus carries the total behind it. */
  worth?: Worth;
  /** Where it is kept, in the Warehouse view; missing: not stock (a dish, a resource). */
  place?: Place;
};
export type VfNode = Node<NodeData, 'vf'>;

/**
 * A semi-processed item taken as part of a batch counted in batches reads as that share,
 * "1/12 batch", never "0.083 pcs"; null: read the amount as it is.
 */
export const nodeShare = (n: Pick<FlowNode, 'id' | 'qty' | 'unit'>, answers: ReadonlyMap<string, Answer>): string | null =>
  n.id.startsWith('semi:') ? batchShare({ name: n.id.slice('semi:'.length), qty: n.qty, unit: n.unit }, answers) : null;

/**
 * The Stock view's number: what it holds in money. A finished dish is made to order, so the
 * item in focus shows the stock behind it (not added to the shop's total: Items has that).
 */
export const worthValue = (n: FlowNode, focus: boolean, worth: Worth | undefined, stock: ItemStock | null): string => {
  if (focus) return worth?.cents != null ? `${rs(worth.cents)} behind it` : 'No stock behind it yet';
  if (n.kind === 'small') return worth?.cents != null ? `${rs(worth.cents)} · ${pct(worth.share)}` : 'Not counted';
  if (n.kind === 'finished') return 'Made to order';
  if (n.kind !== 'raw' && n.kind !== 'semi') return 'Not stock';
  if (worth?.cents != null) return `${rs(worth.cents)} · ${pct(worth.share)}`;
  return stock && !stock.known ? (n.kind === 'raw' ? 'Not counted' : 'None made') : 'No cost yet';
};

/** The Warehouse view's line: where it is kept. */
export const placeValue = (n: FlowNode, place: Place | undefined): ReactNode => {
  if (n.kind === 'finished') return 'Made to order';
  if (n.kind === 'small') return 'Tap to see where';
  if (!place) return 'Not stock';
  return <><span className={`wh-dot wh-seg--${place.homeIndex % 4}`} aria-hidden="true" />{place.home}</>;
};

/** The card's one number, for this view. */
export const nodeValue = (n: FlowNode, view: FlowView, focus: boolean, share: string | null = null): string => {
  if (n.kind === 'revenue') return `${rs(n.cents)} each`;
  if (n.kind === 'profit') return rs(n.cents);
  if (n.kind === 'small') return view === 'material' ? rs(n.cents) : `${rs(n.cents)} · ${pct(n.share)}`;
  if (view === 'material') {
    if (focus) return n.kind === 'semi' ? 'One batch' : 'One';
    if (n.kind === 'resource') return n.unit === 'Rs' ? rs(n.qty * 100) : amount(n.qty, n.unit);
    return share ?? amount(n.qty, n.unit);
  }
  return focus ? rs(n.cents) : `${rs(n.cents)} · ${pct(n.share)}`;
};

/** An amount of an item in its own unit: kg and L for a price-list item, as Items shows it. */
export const stockAmount = (s: ItemStock, qty: number): string =>
  s.kind === 'raw' ? formatQuantity(qty, s.unit as BaseUnit) : prepAmount(qty, s.unit || 'pcs');

/** The card's stock line: "12 kg on hand · 2 kg held", "Can make 8", "Not counted yet". */
export const stockLine = (s: ItemStock): string => {
  if (s.kind === 'finished') return s.canMake === null ? 'Stock not known' : `Can make ${s.canMake}`;
  if (!s.known) return s.kind === 'raw' ? 'Not counted yet' : 'None made yet';
  return `${stockAmount(s, s.onHand)} on hand${s.reserved > 0 ? ` · ${stockAmount(s, s.reserved)} held` : ''}`;
};

/** What is happening to it: waiting, in the kitchen, short. */
export const stockNote = (s: ItemStock): string | null => {
  if (s.waiting > 0) return `Waiting for ${andList(s.waitingFor)}`;
  if (s.inKitchen > 0) return `In the kitchen · ${stockAmount(s, s.inKitchen)}`;
  if (s.short > 0) return `Short ${stockAmount(s, s.short)} for the kitchen`;
  if (s.status === 'out') return s.kind === 'finished' ? 'None can be made' : 'Out of stock';
  if (s.status === 'low') return s.kind === 'raw' ? `Low · order ${s.orderPacks} ${s.orderPacks === 1 ? 'pack' : 'packs'}` : 'Low · make more';
  return null;
};

export function FlowCard({ id, data, selected }: NodeProps<VfNode>) {
  const { node: n, view, focus, takes, onToggle, stock, dim, faded, share, worth, place } = data;
  const folds = n.recipe !== null && !focus && n.inputs > 0;
  const gap = n.missing.length > 0;
  // Being made or waiting is in hand (blue); red only when it is short and nothing is coming.
  const alert = !stock ? null
    : stock.waiting > 0 || stock.inKitchen > 0 ? 'wait'
      : stock.status === 'out' || stock.short > 0 ? 'out' : stock.status === 'low' ? 'low' : null;
  const note = stock && stockNote(stock);
  return (
    <div
      className={`vf-node vf-node--${n.kind}${focus ? ' vf-node--focus' : ''}${selected ? ' vf-node--on' : ''}${gap ? ' vf-node--gap' : ''}${alert ? ` vf-node--${alert}` : ''}${dim ? ' vf-node--dim' : ''}${faded ? ' vf-node--faded' : ''}`}
      style={{ '--share': view === 'material' || view === 'warehouse' ? 0 : view === 'stock' ? (focus ? 0 : worth?.share ?? 0) : n.share } as CSSProperties}
    >
      {(takes || n.kind === 'profit') && <Handle type="target" position={Position.Left} className="vf-handle" isConnectable={takes} />}
      <div className="vf-node__top">
        <span className="vf-node__kind">{KIND_LABEL[n.kind]}</span>
        {n.recipe?.draft && <span className="vf-node__draft">Draft</span>}
        {gap && <span className="vf-node__gap" title="Waiting on a price or a batch size" aria-label="Waiting on a price or a batch size" />}
      </div>
      <div className="vf-node__name">{n.name}</div>
      <div className="vf-node__value num">
        {view === 'warehouse' ? placeValue(n, place) : view === 'stock' ? worthValue(n, focus, worth, stock) : nodeValue(n, view, focus, share)}
        {n.kind === 'profit' && n.qty > 0 && <span className="vf-node__sub"> · {amount(n.qty, 'sold')} in 28 days</span>}
      </div>
      {view === 'warehouse' && place && place.split.length > 0 && (
        <div className="vf-place" aria-label={place.split.map((x) => `${x.name} ${stock ? stockAmount(stock, x.qty) : x.qty}`).join(', ')}>
          {place.split.map((x) => <span key={x.id} className={`wh-seg wh-seg--${x.index % 4}`} style={{ flexGrow: x.qty }} />)}
        </div>
      )}
      {stock && <div className="vf-node__stock num">{stockLine(stock)}</div>}
      {note && <div className={`vf-node__alert${alert ? ` vf-node__alert--${alert}` : ''}`}>{note}</div>}
      {folds && (
        <button
          type="button" className="vf-node__fold nodrag"
          aria-label={n.collapsed ? `Show what goes into ${n.name}` : `Hide what goes into ${n.name}`}
          aria-expanded={!n.collapsed}
          onClick={(e) => { e.stopPropagation(); onToggle(id); }}
        >{n.collapsed ? `+${n.inputs}` : '−'}</button>
      )}
      {n.kind !== 'profit' && <Handle type="source" position={Position.Right} className={`vf-handle${n.kind === 'small' ? ' vf-handle--quiet' : ''}`} isConnectable={n.kind === 'raw' || n.kind === 'semi'} />}
    </div>
  );
}

/** faded: off the path of the card tapped. */
export type EdgeData = { edge: FlowEdge; view: CanvasView; total: number; faded: boolean };
export type VfEdge = Edge<EdgeData, 'vf'>;

export function FlowLine({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected, markerEnd }: EdgeProps<VfEdge>) {
  const [path] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  if (!data) return null;
  const { edge: e, view, total, faded } = data;
  // In money views a line is as thick as what flows along it, like a river.
  const share = view === 'material' || view === 'stock' || view === 'warehouse' || total <= 0 ? 0 : Math.min(1, Math.abs(e.cents) / total);
  const width = 1.5 + share * 9;
  return (
    <BaseEdge
      id={id} path={path} markerEnd={markerEnd}
      className={`vf-edge vf-edge--${e.kind}${selected ? ' vf-edge--on' : ''}${e.partial ? ' vf-edge--partial' : ''}${faded ? ' vf-edge--faded' : ''}`}
      style={{ strokeWidth: selected ? width + 1.5 : width }}
      interactionWidth={24}
    />
  );
}

export const NODE_TYPES = { vf: FlowCard };
export const EDGE_TYPES = { vf: FlowLine };
