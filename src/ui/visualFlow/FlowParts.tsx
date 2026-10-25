import { BaseEdge, EdgeLabelRenderer, getBezierPath, Handle, Position, type Edge, type EdgeProps, type Node, type NodeProps } from '@xyflow/react';
import type { CSSProperties } from 'react';
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
 * name, and the one number the view is about (how much, what it costs, what it earns). Colour
 * stays quiet: the accent marks the item in focus, amber marks a gap (no price, no batch size).
 */
export const KIND_LABEL: Record<FlowNode['kind'], string> = {
  raw: 'Raw', semi: 'Semi-processed', finished: 'Finished', resource: 'Resource', revenue: 'Revenue', profit: 'Profit',
};

export const rs = (cents: number) => `Rs ${fmt(Math.round(cents))}`;
export const amount = (qty: number, unit: string) => `${Number(qty.toFixed(qty < 10 ? 3 : 1)).toLocaleString('en-US')} ${unit}`;
export const pct = (share: number) => `${Math.round(share * 100)}%`;

export type NodeData = {
  node: FlowNode;
  view: FlowView;
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
  /** Its amount as a share of a batch ("1/12 batch"), when it is one. */
  share: string | null;
};
export type VfNode = Node<NodeData, 'vf'>;

/**
 * A semi-processed item taken as part of a batch counted in batches reads as that share,
 * "1/12 batch", never "0.083 pcs"; null: read the amount as it is.
 */
export const nodeShare = (n: Pick<FlowNode, 'id' | 'qty' | 'unit'>, answers: ReadonlyMap<string, Answer>): string | null =>
  n.id.startsWith('semi:') ? batchShare({ name: n.id.slice('semi:'.length), qty: n.qty, unit: n.unit }, answers) : null;

/** The card's one number, for this view. */
export const nodeValue = (n: FlowNode, view: FlowView, focus: boolean, share: string | null = null): string => {
  if (n.kind === 'revenue') return `${rs(n.cents)} each`;
  if (n.kind === 'profit') return rs(n.cents);
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
  const { node: n, view, focus, takes, onToggle, stock, dim, share } = data;
  const folds = n.recipe !== null && !focus && n.inputs > 0;
  const gap = n.missing.length > 0;
  // Being made or waiting is in hand (blue); red only when it is short and nothing is coming.
  const alert = !stock ? null
    : stock.waiting > 0 || stock.inKitchen > 0 ? 'wait'
      : stock.status === 'out' || stock.short > 0 ? 'out' : stock.status === 'low' ? 'low' : null;
  const note = stock && stockNote(stock);
  return (
    <div
      className={`vf-node vf-node--${n.kind}${focus ? ' vf-node--focus' : ''}${selected ? ' vf-node--on' : ''}${gap ? ' vf-node--gap' : ''}${alert ? ` vf-node--${alert}` : ''}${dim ? ' vf-node--dim' : ''}`}
      style={{ '--share': view === 'material' ? 0 : n.share } as CSSProperties}
    >
      {(takes || n.kind === 'profit') && <Handle type="target" position={Position.Left} className="vf-handle" isConnectable={takes} />}
      <div className="vf-node__top">
        <span className="vf-node__kind">{KIND_LABEL[n.kind]}</span>
        {n.recipe?.draft && <span className="vf-node__draft">Draft</span>}
        {gap && <span className="vf-node__gap" title="Waiting on a price or a batch size" aria-label="Waiting on a price or a batch size" />}
      </div>
      <div className="vf-node__name">{n.name}</div>
      <div className="vf-node__value num">
        {nodeValue(n, view, focus, share)}
        {n.kind === 'profit' && n.qty > 0 && <span className="vf-node__sub"> · {amount(n.qty, 'sold')} in 28 days</span>}
      </div>
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
      {n.kind !== 'profit' && <Handle type="source" position={Position.Right} className="vf-handle" isConnectable={n.kind === 'raw' || n.kind === 'semi'} />}
    </div>
  );
}

/** share: the line as a share of a batch ("1/12 batch"), when it is one. */
export type EdgeData = { edge: FlowEdge; view: FlowView; total: number; onSelect: (id: string) => void; share: string | null };
export type VfEdge = Edge<EdgeData, 'vf'>;

const edgeLabel = (e: FlowEdge, view: FlowView, share: string | null): string => {
  if (e.kind === 'money') return `${e.cents < 0 ? '−' : '+'}${rs(Math.abs(e.cents))}`;
  if (view !== 'material') return rs(e.cents);
  if (e.kind === 'resource') return e.unit === 'Rs' ? rs(e.qty * 100) : amount(e.qty, e.unit);
  const waste = e.line?.waste ? ` · ${pct(e.line.waste)} waste` : '';
  return `${share ?? amount(e.qty, e.unit)}${waste}`;
};

export function FlowLine({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected, markerEnd }: EdgeProps<VfEdge>) {
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  if (!data) return null;
  const { edge: e, view, total } = data;
  // In money views a line is as thick as what flows along it, like a river.
  const share = view === 'material' || total <= 0 ? 0 : Math.min(1, Math.abs(e.cents) / total);
  const width = 1.5 + share * 9;
  return (
    <>
      <BaseEdge
        id={id} path={path} markerEnd={markerEnd}
        className={`vf-edge vf-edge--${e.kind}${selected ? ' vf-edge--on' : ''}${e.partial ? ' vf-edge--partial' : ''}`}
        style={{ strokeWidth: selected ? width + 1.5 : width }}
        interactionWidth={24}
      />
      <EdgeLabelRenderer>
        <button
          type="button"
          className={`vf-chip nodrag nopan${selected ? ' vf-chip--on' : ''}${e.kind === 'money' && e.cents < 0 ? ' vf-chip--neg' : ''}`}
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          onClick={() => data.onSelect(id)}
        >{edgeLabel(e, view, data.share)}</button>
      </EdgeLabelRenderer>
    </>
  );
}

export const NODE_TYPES = { vf: FlowCard };
export const EDGE_TYPES = { vf: FlowLine };
