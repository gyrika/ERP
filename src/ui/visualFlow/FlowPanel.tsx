import { useEffect, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { gapName, MAX_WASTE, RATES_QUESTION, UNITS, type Answer, type CostContext } from '../../domain/costing.ts';
import type { BookLine } from '../../domain/recipeBook.ts';
import { versionsOf, type Draft, type PublishStep } from '../../domain/recipeDrafts.ts';
import { RESOURCE_KINDS, RESOURCE_LABEL, RESOURCE_UNIT, type Rates, type ResourceKind, type ResourceLine } from '../../domain/resources.ts';
import type { MenuItem } from '../../domain/types.ts';
import {
  holderOf, lineNode, moneyOf, ratesOf, resourcesOf, SALES_DAYS, SMALL_ID, type FlowEdge, type FlowGraph, type FlowNode, type FlowView, type Holder,
  type SmallGroup,
} from '../../domain/visualFlow.ts';
import { NumberInput } from '../NumberInput.tsx';
import { lineName } from '../RecipesView.tsx';
import { amount, KIND_LABEL, nodeShare, pct, rs, stockAmount, stockLine, stockNote } from './FlowParts.tsx';
import { needsAttention, type ItemStock } from '../../domain/itemStock.ts';
import { batchShare, prepAmount } from '../../domain/prep.ts';
import { TypeOut } from '../TypeOut.tsx';
import { ItemOrder } from '../OrderSheet.tsx';
import type { InventoryRow } from '../../domain/inventory.ts';
import type { Supplier } from '../../domain/inventoryData.ts';
import type { PurchaseState } from '../../domain/purchaseOrders.ts';

/**
 * The side panel: what the selected card or line is, in plain words, and the one place to change
 * it. Every change is saved as a draft at once (no Save button, no dialog), with an Undo in the
 * toast; nothing counts until Publish. Nothing selected: the item in focus.
 */
export type Selection = { kind: 'node' | 'edge'; id: string } | null;

export interface PanelActions {
  setLines: (h: Holder, lines: BookLine[], text: string, makes?: Holder['makes']) => void;
  setResources: (h: Holder, lines: ResourceLine[], text: string) => void;
  setRates: (rates: Rates) => void;
  addStage: (h: Holder, name: string) => string | null;
  pickIngredient: (h: Holder) => void;
  /** Sends batches of a semi-processed item with what it is made from (production.ts). */
  sendToKitchen: (key: string, batches: number) => void;
  /** Opens a raw material's order step (supplier, price, packs) on its card's panel. */
  order: (nodeId: string) => void;
  select: (s: Selection) => void;
  toggle: (id: string) => void;
}

interface Props {
  graph: FlowGraph;
  view: FlowView;
  sel: Selection;
  ctx: CostContext;
  menu: readonly MenuItem[];
  events: readonly { type: string }[];
  drafts: ReadonlyMap<string, Draft>;
  plan: readonly PublishStep[];
  focusName: string;
  actions: PanelActions;
  /** Each card's stock, from the same ledger as Items. */
  stocks: ReadonlyMap<string, ItemStock>;
  /** Each card's stock value and unit cost (SCRUM-163); the item in focus: the stock behind it. */
  worths: ReadonlyMap<string, { cents: number | null; unitCents: number | null; unit: string }>;
  /** The stock value behind the item in focus; null: none of it is known. */
  behind: number | null;
  /** What one batch of a semi-processed item makes; null: not known. */
  makesOf: (key: string) => { qty: number; unit: string } | null;
  /** The last Send to kitchen from the panel: its card and what it said. */
  sent: { id: string; text: string; at: number } | null;
  /** The raw material whose order step is open, by card id. */
  ordering: string | null;
  /** What the order step needs: the price list with stock, the active suppliers, their carts and orders. */
  buying: { items: InventoryRow[]; suppliers: Supplier[]; purchases: PurchaseState };
  /** The inputs folded into one card on the canvas; null: none are. */
  small: SmallGroup | null;
  /** The panel slides in over the drawing only while something on it is picked. */
  open: boolean;
  onClose: () => void;
  /** The drawing's point in one sentence, repeated on top of the panel. */
  said: string;
}

const dateText = (at: number) => new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

/** "v3 · 12 Oct 2026 by Anton", "Draft, not published yet", "From your recipe sheet". */
const versionText = (question: string, events: Props['events'], drafts: Props['drafts']): string => {
  const versions = versionsOf(events, question);
  const last = versions.at(-1);
  const draft = drafts.has(question) ? ' · draft open' : '';
  if (last) return `v${last.n} · ${dateText(last.at)} by ${last.by}${draft}`;
  return drafts.has(question) ? 'Draft, not published yet' : 'From your recipe sheet';
};

/** A number box that saves when it is left or Enter is pressed. */
function Num({ value, unit, decimals = 3, label, onSave }: { value: number; unit?: string; decimals?: number; label: string; onSave: (n: number) => void }) {
  const [text, setText] = useState(String(Number(value.toFixed(decimals))));
  const [was, setWas] = useState(value);
  if (was !== value) { setWas(value); setText(String(Number(value.toFixed(decimals)))); }
  const save = () => {
    const n = Number(text);
    if (text.trim() && Number.isFinite(n) && n !== value) onSave(n);
    else setText(String(Number(value.toFixed(decimals))));
  };
  return (
    <NumberInput
      className="vf-num" aria-label={label} value={text} onText={setText} decimals={decimals} unit={unit}
      onBlur={save} onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter') { e.preventDefault(); save(); } }}
    />
  );
}

export function FlowPanel(p: Props) {
  const { graph, sel } = p;
  const node = sel?.kind === 'node' ? graph.nodes.find((n) => n.id === sel.id) : undefined;
  const edge = sel?.kind === 'edge' ? graph.edges.find((e) => e.id === sel.id) : undefined;
  const shown = node ?? (edge || sel?.id === SMALL_ID ? undefined : graph.nodes.find((n) => n.id === graph.focus));
  // The item in focus picked: its figures and what needs a look (the list nothing picked used to show).
  const whole = (!node && !edge) || node?.id === graph.focus;
  return (
    <aside className={`vf-panel${p.open ? ' vf-panel--open' : ''}`} aria-label="Details" aria-hidden={!p.open} inert={!p.open}>
      <button type="button" className="vf-x vf-panel__close" onClick={p.onClose} aria-label="Close details">×</button>
      {p.said && <p className="vf-panel__said">{p.said}</p>}
      {sel?.kind === 'node' && sel.id === SMALL_ID && p.small ? <SmallDetails {...p} small={p.small} />
        : edge ? <EdgeDetails {...p} edge={edge} /> : shown ? <NodeDetails {...p} node={shown} /> : <p className="vf-muted">Choose something to make.</p>}
      {whole && <Attention {...p} />}
      {p.plan.length > 0 && <DraftList {...p} />}
    </aside>
  );
}

function Figures({ node: n, graph, view, focusName, ctx }: Props & { node: FlowNode }) {
  const focus = n.id === graph.focus;
  const money = moneyOf(graph);
  const b = graph.breakdown;
  if (focus && view === 'cost') {
    return (
      <dl className="vf-figures">
        <dt>Materials</dt><dd className="num">{rs(b.materials)}</dd>
        <dt>Electricity</dt><dd className="num">{rs(b.electricity)}</dd>
        <dt>Labour</dt><dd className="num">{rs(b.labour)}</dd>
        <dt>Overhead</dt><dd className="num">{rs(b.overhead)}</dd>
        <dt className="vf-figures__total">Costs to make</dt><dd className="vf-figures__total num">{rs(b.total)}</dd>
      </dl>
    );
  }
  if ((focus || n.kind === 'revenue' || n.kind === 'profit') && view === 'financial' && money) {
    const sold = graph.sold;
    return (
      <dl className="vf-figures">
        <dt>Price</dt><dd className="num">{rs(money.revenue)}</dd>
        <dt>Costs to make</dt><dd className="num">{rs(money.cost)}</dd>
        <dt className="vf-figures__total">Profit each</dt>
        <dd className="vf-figures__total num">{rs(money.profit)}{money.margin === null ? '' : ` · ${pct(money.margin)}`}</dd>
        {sold > 0 && <>
          <dt>Last {SALES_DAYS} days</dt><dd className="num">{amount(sold, 'sold')}</dd>
          <dt>Revenue</dt><dd className="num">{rs(money.revenue * sold)}</dd>
          <dt>Production cost</dt><dd className="num">{rs(money.cost * sold)}</dd>
          <dt className="vf-figures__total">Profit</dt><dd className="vf-figures__total num">{rs(money.profit * sold)}</dd>
        </>}
      </dl>
    );
  }
  if (focus) return null;
  return (
    <dl className="vf-figures">
      <dt>Each {focusName} takes</dt><dd className="num">{n.kind === 'resource' && n.unit === 'Rs' ? rs(n.qty * 100) : nodeShare(n, ctx.answers) ?? amount(n.qty, n.unit)}</dd>
      <dt>Adds to its cost</dt><dd className="num">{rs(n.cents)} · {pct(n.share)}</dd>
    </dl>
  );
}

function Gaps({ missing, menu }: { missing: readonly string[]; menu: readonly MenuItem[] }) {
  if (!missing.length) return null;
  const names = [...new Set(missing)].map((q) => (q === RATES_QUESTION ? 'the shop\'s rates' : gapName(q, menu)));
  return <p className="vf-gaps"><span className="vf-node__gap" aria-hidden="true" />Cost so far: waiting on {names.slice(0, 3).join(', ')}{names.length > 3 ? ` and ${names.length - 3} more` : ''}.</p>;
}

function NodeDetails(p: Props & { node: FlowNode }) {
  const { node: n, ctx, menu, events, drafts, actions } = p;
  const h = n.recipe ? holderOf(n.id, ctx.answers, menu) : null;
  const item = n.id.startsWith('stock:') ? ctx.items.find((i) => `stock:${i.id}` === n.id) : undefined;
  return (
    <>
      <header className="vf-panel__head">
        <span className={`vf-tag vf-tag--${n.kind}`}>{KIND_LABEL[n.kind]}</span>
        <h2 className="vf-panel__title">{n.name}</h2>
        {n.recipe?.question && <p className="vf-muted">{versionText(n.recipe.question, events, drafts)}</p>}
      </header>
      <Figures {...p} node={n} />
      <StockDetails {...p} node={n} />
      <Gaps missing={n.missing} menu={menu} />
      {item && (
        <p className="vf-muted">
          {item.workingPriceCents > 0 ? `${rs(item.workingPriceCents)} for ${amount(item.packQty, item.baseUnit)}, the latest price.` : 'No price yet: enter it under Items › Raw materials.'}
        </p>
      )}
      {n.kind === 'resource' && <RatesEditor {...p} />}
      {h && !h.editable && <p className="vf-muted">A recipe from your sheet used inside another: it changes in your sheet.</p>}
      {h?.editable && <RecipeEditor {...p} h={h} node={n} />}
      {n.recipe && n.id !== p.graph.focus && n.inputs > 0 && (
        <button type="button" className="linkbtn" onClick={() => actions.toggle(n.id)}>{n.collapsed ? 'Show what goes into it' : 'Hide what goes into it'}</button>
      )}
    </>
  );
}

const STATUS_TEXT: Record<ItemStock['status'], string> = { out: 'Out of stock', low: 'Low', unsure: 'Check the shelf', ok: 'In stock', unknown: 'Not known yet' };

/** The one action that fits: a raw material is ordered, a semi-processed item is made; a dish is made to order. */
function StockAction({ node, st, actions, makesOf, ordering, buying }: Props & { node: FlowNode; st: ItemStock }) {
  const [batches, setBatches] = useState('1');
  if (st.kind === 'raw') {
    // Who it comes from, at what price, how many packs: the same step as Items › Order.
    const row = buying.items.find((r) => `stock:${r.id}` === node.id);
    if (row && ordering === node.id) return <ItemOrder item={row} items={buying.items} suppliers={buying.suppliers} purchases={buying.purchases} />;
    return <button type="button" className="vf-add vf-add--go" onClick={() => actions.order(node.id)}>Order from supplier</button>;
  }
  if (st.kind !== 'semi') return null;
  const key = node.id.slice('semi:'.length);
  const makes = makesOf(key);
  if (!makes) return <p className="vf-muted">Say what one batch makes to send it to the kitchen.</p>;
  const n = Number(batches);
  return (
    <form className="vf-send" onSubmit={(e) => { e.preventDefault(); if (n > 0) actions.sendToKitchen(key, n); }}>
      <NumberInput className="vf-num" aria-label={`Batches of ${node.name}`} value={batches} onText={setBatches} decimals={1} unit={n === 1 ? 'batch' : 'batches'} />
      <button type="submit" className="vf-add vf-add--go" disabled={!(n > 0)}>Send to kitchen</button>
      {n > 0 && <p className="vf-muted">= {prepAmount(n * makes.qty, makes.unit)}</p>}
    </form>
  );
}

/** A unit cost as it is bought and used: a kg, a L, each. */
const unitCostText = (cents: number, unit: string): string =>
  unit === 'g' ? `${rs(cents * 1000)} a kg` : unit === 'ml' ? `${rs(cents * 1000)} a L` : unit === 'pcs' ? `${rs(cents)} each` : `${rs(cents)} a ${unit}`;

/** On hand, held, free, in the kitchen, waiting: the same figures as Items. */
function StockDetails(p: Props & { node: FlowNode }) {
  const st = p.stocks.get(p.node.id);
  const worth = p.worths.get(p.node.id);
  if (!st) return null;
  const note = stockNote(st);
  // What is going on with it, in one short message: the last send from here, else its state.
  const sent = p.sent?.id === p.node.id ? p.sent : null;
  const said = sent ? sent.text : [
    st.kind === 'finished'
      ? (st.canMake !== null ? `${stockLine(st)} now. Dishes are made to order, from the Register.` : 'Not known: its recipe takes nothing counted yet.')
      : !st.known ? (st.kind === 'raw' ? 'Not counted yet. Count it under Items.' : 'None made yet. Its first batch starts its stock.') : '',
    note ? `${note}.${st.waiting > 0 ? ' It goes to the kitchen by itself when ready.' : ''}` : '',
  ].filter(Boolean).join('\n');
  return (
    <section className="vf-section" aria-label="Stock">
      <h3 className="vf-section__title">Stock · <span className={`vf-stock__status--${st.status}`}>{STATUS_TEXT[st.status]}</span></h3>
      {st.kind !== 'finished' && st.known && (
        <dl className="vf-figures">
          <dt>On hand</dt><dd className="num">{stockAmount(st, st.onHand)}</dd>
          {st.reserved > 0 && <><dt>Held for the kitchen</dt><dd className="num">{stockAmount(st, st.reserved)}</dd></>}
          <dt>Free to use</dt><dd className="num">{stockAmount(st, st.available)}</dd>
          {st.inKitchen > 0 && <><dt>Being made</dt><dd className="num">{stockAmount(st, st.inKitchen)}</dd></>}
          {st.waiting > 0 && <><dt>Waiting</dt><dd className="num">{stockAmount(st, st.waiting)}</dd></>}
          {worth?.unitCents != null && <><dt>Unit cost</dt><dd className="num">{unitCostText(worth.unitCents, worth.unit)}</dd></>}
          {worth?.cents != null && <><dt className="vf-figures__total">Value</dt><dd className="vf-figures__total num">{rs(worth.cents)}</dd></>}
        </dl>
      )}
      {p.node.id === p.graph.focus && p.behind !== null && (
        <dl className="vf-figures">
          <dt>Stock behind it</dt><dd className="num">{rs(p.behind)}</dd>
        </dl>
      )}
      {st.kind === 'raw' && <a className="linkbtn vf-history" href={`#items/item/${encodeURIComponent(p.node.id.slice('stock:'.length))}`}>History</a>}
      {said && (
        <div className={`vf-screen${!sent && (st.status === 'out' || st.short > 0) ? ' vf-screen--alert' : ''}`} role="status">
          <TypeOut key={sent?.at ?? 0} text={said} className="vf-screen__text" />
        </div>
      )}
      <StockAction {...p} st={st} />
    </section>
  );
}

/** The folded card: its items, biggest first, each one tap from its own panel. */
function SmallDetails({ small, focusName, view, actions, ctx }: Props & { small: SmallGroup }) {
  return (
    <>
      <header className="vf-panel__head">
        <span className="vf-tag">{KIND_LABEL.small}</span>
        <h2 className="vf-panel__title">{small.nodes.length} small items</h2>
        <p className="vf-muted">{rs(small.cents)}, {pct(small.share)} of what {focusName} costs: drawn as one card, so the big ones stand out.</p>
      </header>
      <ul className="vf-lines" aria-label="Small items">
        {small.nodes.map((n) => (
          <li key={n.id} className="vf-line">
            <button type="button" className="vf-line__open" onClick={() => actions.select({ kind: 'node', id: n.id })}>
              <span className="vf-line__name">{n.name}</span>
              <span className="vf-line__qty num">{view === 'material' ? nodeShare(n, ctx.answers) ?? amount(n.qty, n.unit) : rs(n.cents)}</span>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

/** Nothing selected: what in this flow needs a look, out first, each with its one action. */
function Attention(p: Props) {
  const rows = p.graph.nodes
    .map((n) => ({ n, st: p.stocks.get(n.id) }))
    .filter((x): x is { n: FlowNode; st: ItemStock } => !!x.st && x.n.id !== p.graph.focus && needsAttention(x.st))
    .sort((a, b) => Number(b.st.status === 'out') - Number(a.st.status === 'out'));
  if (!rows.length) return null;
  return (
    <section className="vf-section" aria-label="Needs attention">
      <h3 className="vf-section__title">Needs attention</h3>
      <ul className="vf-attention">
        {rows.map(({ n, st }) => (
          <li key={n.id} className="vf-attention__row">
            <button type="button" className="vf-line__open" onClick={() => p.actions.select({ kind: 'node', id: n.id })}>
              <span className="vf-attention__name">{n.name}<span className="vf-attention__note">{stockNote(st) ?? stockLine(st)}</span></span>
            </button>
            {st.kind === 'raw' && <button type="button" className="vf-add" onClick={() => p.actions.order(n.id)}>Order</button>}
            {st.kind === 'semi' && st.waiting === 0 && st.inKitchen === 0 && p.makesOf(n.id.slice('semi:'.length)) && (
              <button type="button" className="vf-add" onClick={() => p.actions.sendToKitchen(n.id.slice('semi:'.length), 1)}>Make 1 batch</button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Which lists are folded away; remembered on this screen only, and closed until opened. */
const FOLD_KEY = 'vf-folds';
const readFolds = (): Record<string, boolean> => {
  try { return JSON.parse(localStorage.getItem(FOLD_KEY) ?? '{}') as Record<string, boolean>; } catch { return {}; }
};
let foldState = readFolds();
const foldListeners = new Set<() => void>();
/** foldState holds which lists are open. */
const folded = (id: string) => foldState[id] !== true;
const toggleFold = (id: string) => {
  foldState = { ...foldState, [id]: folded(id) };
  try { localStorage.setItem(FOLD_KEY, JSON.stringify(foldState)); } catch { /* a convenience only */ }
  foldListeners.forEach((f) => f());
};

/** Whether a list is folded away, kept in step on every panel that shows it. */
const useFolded = (id: string): boolean => {
  const [, rerender] = useState(0);
  useEffect(() => { const f = () => rerender((n) => n + 1); foldListeners.add(f); return () => { foldListeners.delete(f); }; }, []);
  return folded(id);
};

/** A list's title that shows or hides it: "What goes in · 6". */
function FoldTitle({ id, count, open, children }: { id: string; count: number; open: boolean; children: ReactNode }) {
  return (
    <h3 className="vf-section__title">
      <button type="button" className="vf-fold" aria-expanded={open} onClick={() => toggleFold(id)}>
        <span>{children}{count > 0 ? ` · ${count}` : ''}</span>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
      </button>
    </h3>
  );
}

function RecipeEditor({ h, node, ctx, actions }: Props & { h: Holder; node: FlowNode }) {
  const [stage, setStage] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const isBatch = !h.question.startsWith('recipe:') && !h.question.startsWith('addon:');
  const resources = resourcesOf(h.key, ctx.answers);
  const linesFolded = useFolded('ingredients');
  const resourcesFolded = useFolded('resources');
  const addStage = (e: FormEvent) => {
    e.preventDefault();
    const why = actions.addStage(h, stage ?? '');
    setProblem(why);
    if (!why) setStage(null);
  };
  const addResource = (kind: ResourceKind) => {
    const line: ResourceLine = kind === 'other' ? { kind, cents: 0 } : { kind, qty: kind === 'electricity' ? 1 : 10 };
    actions.setResources(h, [...resources, line], `Added ${RESOURCE_LABEL[kind].toLowerCase()} to ${h.name}`);
  };
  return (
    <>
      {isBatch && (
        <section className="vf-section">
          <h3 className="vf-section__title">One batch makes</h3>
          <div className="vf-row">
            <Num
              label={`How much one batch of ${h.name} makes`} value={h.makes?.qty ?? 0} unit={h.makes?.unit ?? node.unit}
              onSave={(qty) => actions.setLines(h, [...h.lines], `${h.name} makes ${qty}`, { qty, unit: h.makes?.unit ?? node.unit })}
            />
          </div>
        </section>
      )}
      <section className="vf-section">
        <FoldTitle id="ingredients" count={h.lines.length} open={!linesFolded}>What goes in{isBatch ? ', per batch' : ''}</FoldTitle>
        {linesFolded ? null : (
          <>
            {h.lines.length === 0 && <p className="vf-muted">Nothing yet. Drag a line from an item into it, or add one.</p>}
            <ul className="vf-lines">
              {h.lines.map((l, i) => (
                <li key={`${l.name}-${i}`} className="vf-line">
                  <button type="button" className="vf-line__open" onClick={() => actions.select({ kind: 'edge', id: `${lineNode(l.name, ctx.answers)}>${node.id}#${i}` })}>
                    <span className="vf-line__name">{lineName(l.name, ctx)}</span>
                    <span className="vf-line__qty num">{batchShare(l, ctx.answers) ?? amount(l.qty, l.unit)}{l.waste ? ` · ${pct(l.waste)} waste` : ''}</span>
                  </button>
                  <button type="button" className="vf-x" aria-label={`Take ${lineName(l.name, ctx)} out`}
                    onClick={() => actions.setLines(h, h.lines.filter((_, j) => j !== i), `Took ${lineName(l.name, ctx)} out of ${h.name}`)}>×</button>
                </li>
              ))}
            </ul>
          </>
        )}
        <div className="vf-actions">
          <button type="button" className="vf-add" onClick={() => actions.pickIngredient(h)}>Add an ingredient</button>
          {stage === null && <button type="button" className="vf-add" onClick={() => { setStage(''); setProblem(null); }}>Add a stage</button>}
        </div>
        {stage !== null && (
          <form className="vf-stage" onSubmit={addStage}>
            <input className="vf-text" autoFocus aria-label="The new stage's name" placeholder="Its name, e.g. Garlic Oil" value={stage} maxLength={60}
              onChange={(e) => setStage(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setStage(null); } }} />
            <button type="submit" className="vf-add vf-add--go">Add</button>
            {problem && <p className="vf-problem" role="alert">{problem}</p>}
          </form>
        )}
      </section>
      <section className="vf-section">
        <FoldTitle id="resources" count={resources.length} open={!resourcesFolded}>Also takes{isBatch ? ', per batch' : ''}</FoldTitle>
        <ul className="vf-lines" hidden={resourcesFolded}>
          {resources.map((r, i) => (
            <li key={i} className="vf-line">
              <button type="button" className="vf-line__open" onClick={() => actions.select({ kind: 'edge', id: `res:${r.kind}>${node.id}#${i}` })}>
                <span className="vf-line__name">{r.label || RESOURCE_LABEL[r.kind]}</span>
                <span className="vf-line__qty num">{r.kind === 'other' ? rs(r.cents) : amount(r.qty, RESOURCE_UNIT[r.kind])}</span>
              </button>
              <button type="button" className="vf-x" aria-label={`Take ${r.label || RESOURCE_LABEL[r.kind]} out`}
                onClick={() => actions.setResources(h, resources.filter((_, j) => j !== i), `Took ${(r.label || RESOURCE_LABEL[r.kind]).toLowerCase()} out of ${h.name}`)}>×</button>
            </li>
          ))}
        </ul>
        <div className="vf-actions">
          {RESOURCE_KINDS.map((k) => <button key={k} type="button" className="vf-add" onClick={() => addResource(k)}>+ {RESOURCE_LABEL[k]}</button>)}
        </div>
      </section>
    </>
  );
}

function EdgeDetails(p: Props & { edge: FlowEdge }) {
  const { edge: e, graph, ctx, menu, actions, view } = p;
  const from = graph.nodes.find((n) => n.id === e.source);
  const to = graph.nodes.find((n) => n.id === e.target);
  const h = to?.recipe ? holderOf(to.id, ctx.answers, menu) : null;
  const head = (
    <header className="vf-panel__head">
      <span className="vf-tag">{e.kind === 'resource' ? 'Resource' : e.kind === 'money' ? 'Money' : 'Ingredient'}</span>
      <h2 className="vf-panel__title">{from?.name ?? ''} → {to?.name ?? ''}</h2>
    </header>
  );
  const flows = (
    <dl className="vf-figures">
      <dt>Each {p.focusName} takes</dt><dd className="num">{e.unit === 'Rs' ? rs(e.qty * 100) : (e.line && batchShare({ ...e.line, qty: e.qty }, ctx.answers)) ?? amount(e.qty, e.unit)}</dd>
      <dt>Costs</dt><dd className="num">{rs(e.cents)}</dd>
    </dl>
  );
  if (e.kind === 'money') return <>{head}{view === 'financial' && <Figures {...p} node={graph.nodes.find((n) => n.id === 'profit')!} />}</>;
  if (!h?.editable) return <>{head}{flows}<p className="vf-muted">A recipe from your sheet: it changes in your sheet.</p></>;

  if (e.kind === 'resource' && e.resource) {
    const lines = resourcesOf(h.key, ctx.answers);
    const r = lines[e.index];
    if (!r) return head;
    const put = (next: ResourceLine, text: string) => actions.setResources(h, lines.map((x, i) => (i === e.index ? next : x)), text);
    return (
      <>
        {head}
        <section className="vf-section">
          <label className="vf-field">
            <span>What it is</span>
            <input className="vf-text" defaultValue={r.label ?? ''} key={`${e.id}-${r.label ?? ''}`} maxLength={40} placeholder={RESOURCE_LABEL[r.kind]}
              onBlur={(ev) => { const label = ev.target.value.trim(); if (label !== (r.label ?? '')) put({ ...r, label: label || undefined }, `Named it ${label || RESOURCE_LABEL[r.kind]}`); }} />
          </label>
          <label className="vf-field">
            <span>{r.kind === 'other' ? 'Costs, per batch' : `How much, per ${h.question.startsWith('recipe:') ? 'dish' : 'batch'}`}</span>
            {r.kind === 'other'
              ? <Num label="What it costs" value={r.cents / 100} unit="Rs" decimals={2} onSave={(n) => put({ ...r, cents: Math.round(n * 100) }, `${r.label || 'Other costs'} at Rs ${n}`)} />
              : <Num label="How much it takes" value={r.qty} unit={RESOURCE_UNIT[r.kind]} onSave={(n) => n > 0 && put({ ...r, qty: n }, `${r.label || RESOURCE_LABEL[r.kind]} at ${n} ${RESOURCE_UNIT[r.kind]}`)} />}
          </label>
        </section>
        {flows}
        <Gaps missing={e.partial ? [RATES_QUESTION] : []} menu={menu} />
        <button type="button" className="linkbtn linkbtn--danger"
          onClick={() => { actions.setResources(h, lines.filter((_, i) => i !== e.index), `Took ${(r.label || RESOURCE_LABEL[r.kind]).toLowerCase()} out`); actions.select({ kind: 'node', id: to!.id }); }}>Take it out</button>
      </>
    );
  }

  const line = h.lines[e.index];
  if (!line) return head;
  const put = (next: BookLine, text: string) => actions.setLines(h, h.lines.map((x, i) => (i === e.index ? next : x)), text);
  const name = lineName(line.name, ctx);
  return (
    <>
      {head}
      <section className="vf-section">
        <label className="vf-field">
          <span>Amount{h.question.startsWith('recipe:') || h.question.startsWith('addon:') ? '' : ', per batch'}</span>
          <div className="vf-row">
            <Num label={`How much ${name}`} value={line.qty} onSave={(n) => n > 0 && put({ ...line, qty: n }, `${name} at ${n} ${line.unit}`)} />
            <select className="vf-select" aria-label="Unit" value={line.unit} onChange={(ev) => put({ ...line, unit: ev.target.value }, `${name} in ${ev.target.value}`)}>
              {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
            </select>
          </div>
        </label>
        <label className="vf-field">
          <span>Wastage</span>
          <Num label={`How much of ${name} is lost`} value={(line.waste ?? 0) * 100} unit="%" decimals={1}
            onSave={(n) => { if (n >= 0 && n <= MAX_WASTE * 100) put({ ...line, waste: n > 0 ? n / 100 : undefined }, `${name} at ${n}% wastage`); }} />
        </label>
        {line.waste ? <p className="vf-muted">With {pct(line.waste)} lost, it takes {amount(line.qty / (1 - line.waste), line.unit)} to end with {amount(line.qty, line.unit)}.</p> : null}
      </section>
      {flows}
      <Gaps missing={e.partial ? to?.missing ?? [] : []} menu={menu} />
      <button type="button" className="linkbtn linkbtn--danger"
        onClick={() => { actions.setLines(h, h.lines.filter((_, i) => i !== e.index), `Took ${name} out of ${h.name}`); actions.select({ kind: 'node', id: to!.id }); }}>Take it out</button>
    </>
  );
}

function RatesEditor({ ctx, actions }: Props) {
  const rates = ratesOf(ctx.answers) ?? { electricity: 0, labour: 0, equipment: 0 };
  const put = (k: keyof Rates, rupees: number) => actions.setRates({ ...rates, [k]: Math.round(rupees * 100) });
  return (
    <section className="vf-section">
      <h3 className="vf-section__title">The shop's rates</h3>
      <p className="vf-muted">Set once; every recipe uses them.</p>
      <label className="vf-field"><span>Electricity, per kWh</span><Num label="Electricity rate" value={rates.electricity / 100} unit="Rs" decimals={2} onSave={(n) => put('electricity', n)} /></label>
      <label className="vf-field"><span>Labour, per hour</span><Num label="Labour rate" value={rates.labour / 100} unit="Rs" decimals={2} onSave={(n) => put('labour', n)} /></label>
      <label className="vf-field"><span>Equipment, per hour</span><Num label="Equipment rate" value={rates.equipment / 100} unit="Rs" decimals={2} onSave={(n) => put('equipment', n)} /></label>
    </section>
  );
}

const questionTitle = (q: string, ctx: CostContext, menu: readonly MenuItem[]): string => {
  if (q === RATES_QUESTION) return 'The shop\'s rates';
  if (q.startsWith('resources:')) {
    const key = q.slice('resources:'.length);
    const id = key.startsWith('recipe:') || key.startsWith('addon:') ? key : `semi:${key}`;
    return `${holderOf(id, ctx.answers, menu)?.name ?? key}: what else it takes`;
  }
  if (q.startsWith('batch:')) return q.slice('batch:'.length);
  if (q.startsWith('prep:')) {
    const a: Answer | undefined = ctx.answers.get(q);
    return a?.kind === 'prep' ? a.name : 'A new stage';
  }
  return holderOf(q, ctx.answers, menu)?.name ?? q;
};

function DraftList({ plan, ctx, menu }: Props) {
  return (
    <section className="vf-section vf-drafts" aria-label="In draft">
      <h3 className="vf-section__title">In draft</h3>
      <ul className="vf-lines">
        {plan.map((s) => (
          <li key={s.question} className="vf-draft">
            <span className="vf-line__name">{questionTitle(s.question, ctx, menu)}</span>
            {s.problem ? <span className="vf-problem">{s.problem}</span> : <span className="vf-muted">{s.before ? 'Changed' : 'New'}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}

