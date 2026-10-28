import {
  Background, Controls, ReactFlow, ReactFlowProvider, useReactFlow, type Connection, type EdgeChange, type NodeChange,
} from '@xyflow/react';
import '@xyflow/react/dist/base.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Actor } from '../../domain/auth.ts';
import { RATES_QUESTION, resourcesQuestion, type Answer } from '../../domain/costing.ts';
import { menuItems } from '../../domain/menu.ts';
import { prepItems } from '../../domain/prep.ts';
import { publishPlan, withDrafts } from '../../domain/recipeDrafts.ts';
import type { Rates, ResourceLine } from '../../domain/resources.ts';
import {
  answerWith, buildFlow, COL_W, connectProblem, flowSentence, focusOptions, foldSmall, holderOf, layout, lineFor, lineNode, newStage, pathOf,
  resourcesOf, ROW_H, SMALL_ID, soldUnits, viewOf, type FlowView, type Holder,
} from '../../domain/visualFlow.ts';
import { cartShortages, discardDrafts, publishDrafts, recipesViewed, saveDraft, sendPlan, useCatalog, useFlowData, usePurchases } from '../../services/inventoryStore.ts';
import { itemStockOf, needsAttention, type ItemStock } from '../../domain/itemStock.ts';
import { andList, planNotice, planProduction } from '../../domain/production.ts';
import { prepAmount } from '../../domain/prep.ts';
import { ReleaseNotices } from '../ProductionNotices.tsx';
import { CommandPalette } from '../CommandPalette.tsx';
import { useMenu } from '../menuStore.ts';
import { OwnerNav } from '../OwnerNav.tsx';
import { useOwner } from '../RecipeLines.tsx';
import { FlowPanel, type PanelActions, type Selection } from './FlowPanel.tsx';
import {
  EDGE_TYPES, MIN_ZOOM, NODE_TYPES, nodeShare, rs, stockAmount,
  type CanvasEdge, type CanvasNode, type CanvasView, type Place, type VfEdge, type VfNode, type WhAddNode, type WhEdge, type WhNode, type Worth,
} from './FlowParts.tsx';
import { TypeOut } from '../TypeOut.tsx';
import { activeWarehouses, byWarehouse, homeOf, livesIn, shownSplit, type StockEntry, type Warehouse, type Warehouses } from '../../domain/warehouses.ts';
import { nextWarehouseName, warehouseColumn } from '../../domain/warehouseColumn.ts';
import { addWarehouse, editWarehouse, setHome, setKitchenSide, stockEntries } from '../../services/inventoryStore.ts';
import { PlaceSheet } from '../WarehousesView.tsx';
import { valuationOf } from '../../domain/valuation.ts';
import './visualFlow.css';

/**
 * Visual Flow (sidebar › Things). Serves the owner, who knows his kitchen by heart but has never
 * seen it drawn: what he needs next is to see how one dish is made and where its money goes, and
 * to change it where he sees it. One item in focus at a time (a dish, an extra, or a batch), drawn
 * from his recipes as they stand: what is bought on the left, flowing through what his kitchen
 * makes, into the dish on the right. Three views of the same drawing: Material (how much),
 * Cost (what it costs, lines as thick as the money) and Financial (what it earns); and Stock
 * (SCRUM-163): what each card holds in money now, the same values as Items.
 *
 * The answer comes first, in words, on a black screen above the drawing ("Mozzarella Blend is
 * 71% of what a Margherita Large costs"); the drawing is the evidence. The few inputs that make
 * most of the cost are cards, the rest one card; each card sits beside what it feeds, the
 * amounts are on the cards (none on the lines), and tapping a card lights its path to the dish.
 *
 * Every change is a draft at once, with Undo; Publish makes the drafts his recipes (one new version
 * each), so what was made before keeps the recipe it was made with. The recipes are his alone, like
 * the Recipes screen: anyone else sees a line saying so, and each opening is in the audit trail.
 */
export default function VisualFlowView({ onRegister }: { onRegister?: () => void }) {
  const owner = useOwner();
  useEffect(() => { if (owner) recipesViewed(owner); }, [owner]);
  // The drawing keeps the whole screen: the shop's list is a drawer, opened from the strip (or Ctrl K).
  const [nav, setNav] = useState(false);
  return (
    <div className="owner vf-page">
      <OwnerNav current="flow" onRegister={onRegister} drawer={owner ? nav : undefined} onDrawer={setNav} />
      {owner
        ? <ReactFlowProvider><Studio owner={owner} onMenu={() => setNav(true)} /></ReactFlowProvider>
        : <main className="owner__main" aria-label="Visual Flow"><p className="vf-muted">Only the owner sees the recipes.</p></main>}
    </div>
  );
}

/** Fitting leaves room at the top for the strip and the sentence that float over the drawing. */
const FIT = { top: '128px', right: '32px', bottom: '32px', left: '32px' } as const;

/** The drawing's point, typed over the top of the canvas when the item or view changes, then out of the way. */
function Said({ text }: { text: string }) {
  const [gone, setGone] = useState(false);
  useEffect(() => { const t = setTimeout(() => setGone(true), 6000); return () => clearTimeout(t); }, []);
  return (
    <div className={`vf-say${gone ? ' vf-say--gone' : ''}`} aria-live="polite">
      <TypeOut text={text} className="vf-say__text" />
    </div>
  );
}

const VIEWS: { id: CanvasView; label: string }[] = [
  { id: 'material', label: 'Material' },
  { id: 'cost', label: 'Cost' },
  { id: 'financial', label: 'Financial' },
  { id: 'stock', label: 'Stock' },
  { id: 'warehouse', label: 'Warehouse' },
];
/**
 * What the drawing picks out; the rest is drawn faintly, so the flow stays whole. One filter at
 * a time; in the Warehouse view a tapped warehouse picks out what is kept there (SCRUM-188).
 */
type Filter = 'all' | 'attention' | 'out' | 'raw' | 'semi' | 'finished';
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'attention', label: 'Low' },
  { id: 'out', label: 'Out' },
  { id: 'raw', label: 'Raw' },
  { id: 'semi', label: 'Semi-processed' },
  { id: 'finished', label: 'Finished' },
];
const DEFAULT_FOCUS = 'recipe:margherita:L';
const TOAST_MS = 6000;

/** A change and its Undo; next: one more step it offers (put what is short in the cart). */
interface Toast { id: number; text: string; undo?: () => void; next?: { label: string; run: () => void } }

/** #flow/<focus>: a dish's flow can be linked to (and survives a reload). */
const focusFromHash = () => (location.hash.startsWith('#flow/') ? decodeURIComponent(location.hash.slice('#flow/'.length)) : null);

function Studio({ owner, onMenu }: { owner: Actor; onMenu: () => void }) {
  useMenu();
  const menu = menuItems();
  const { ctx: published, drafts, events, stock } = useFlowData();
  const purchases = usePurchases();
  const { suppliers } = useCatalog();
  const [filter, setFilter] = useState<Filter>('all');
  /** The warehouse tapped in the Warehouse view's column (SCRUM-188): its panel opens and what is kept there stands out. */
  const [pickedWh, setPickedWh] = useState<string | null>(null);
  /** A warehouse just added, by name: picked once it is on the list, so the owner can type its name. */
  const [newWh, setNewWh] = useState<string | null>(null);
  /** The stock card whose Move sheet is open (Warehouse view). */
  const [moving, setMoving] = useState<string | null>(null);
  /** The last Send to kitchen, typed out on that card's panel. */
  const [sent, setSent] = useState<{ id: string; text: string; at: number } | null>(null);
  /** The raw material whose order step is open on its panel. */
  const [ordering, setOrdering] = useState<string | null>(null);
  // What the canvas shows: his recipes with his drafts on top.
  const answers = useMemo(() => withDrafts(published.answers, drafts), [published.answers, drafts]);
  const ctx = useMemo(() => ({ items: published.items, answers }), [published.items, answers]);
  const options = useMemo(() => focusOptions(menu, answers), [menu, answers]);
  const [focus, setFocusState] = useState(() => focusFromHash() ?? DEFAULT_FOCUS);
  const [view, setView] = useState<CanvasView>('material');
  // Stock and Warehouse are drawn on the Material drawing: how much goes in, and what each card holds and where.
  const drawn: FlowView = view === 'stock' || view === 'warehouse' ? 'material' : view;
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [sel, setSel] = useState<Selection>(null);
  const [moved, setMoved] = useState<Record<string, { x: number; y: number }>>({});
  /** Each card's measured size: the cards are drawn from the graph, so React Flow's own measure is kept here. */
  const [sizes, setSizes] = useState<Record<string, { width: number; height: number }>>({});
  const [toast, setToast] = useState<Toast | null>(null);
  const [picking, setPicking] = useState<'focus' | Holder | null>(null);
  /** The filter chips, opened from the strip's Filter button. */
  const [filtering, setFiltering] = useState(false);
  const flow = useReactFlow();

  const known = options.some((o) => o.id === focus);
  const current = known ? focus : options[0]?.id ?? DEFAULT_FOCUS;
  const focusName = options.find((o) => o.id === current)?.label ?? '';

  const setFocus = useCallback((id: string) => {
    setFocusState(id);
    setSel(null);
    setMoved({});
    setCollapsed(new Set());
    // The same place drawn for another item: its history entry (and its depth for Back) stays.
    history.replaceState(history.state, '', `#flow/${encodeURIComponent(id)}`);
  }, []);

  const sold = useMemo(() => soldUnits(events, current, Date.now()), [events, current]);
  const graph = useMemo(
    () => viewOf(buildFlow({ focus: current, ctx, menu, sold, collapsed, drafts }), drawn),
    [current, ctx, menu, sold, collapsed, drafts, drawn],
  );
  // The canvas draws the biggest inputs and folds the rest into one card; the panel keeps them all.
  // Not in the Warehouse view: every raw item there takes its warehouse's line.
  const { graph: drawing, small } = useMemo(() => (view === 'warehouse' ? { graph, small: null } : foldSmall(graph)), [graph, view]);
  const positions = useMemo(() => {
    const heights = new Map(drawing.nodes.flatMap((n) => (sizes[n.id] ? [[n.id, sizes[n.id].height] as const] : [])));
    return layout(drawing, heights);
  }, [drawing, sizes]);
  const plan = useMemo(() => publishPlan(published.answers, drafts), [published.answers, drafts]);
  const blocked = plan.find((s) => s.problem);

  const say = useCallback((text: string, undo?: () => void, next?: Toast['next']) => setToast({ id: Date.now(), text, undo, next }), []);

  // ----- stock: the same ledger as Items, on every card -----
  const stocks = useMemo(() => {
    const m = new Map<string, ItemStock>();
    for (const n of graph.nodes) { const st = itemStockOf(n.id, stock); if (st) m.set(n.id, st); }
    return m;
  }, [graph.nodes, stock]);
  // Stock value: his published recipes, as Items counts it. Each card's share is of the stock
  // behind the item in focus. Cheese is behind every pizza, so these are never added across
  // dishes: the shop's total is on Items.
  const valuation = useMemo(() => valuationOf(stock, published.answers), [stock, published.answers]);
  const { worths, behind } = useMemo(() => {
    const byId = new Map(valuation.items.map((v) => [v.id, v]));
    const known = graph.nodes.flatMap((n) => (n.id !== current && byId.get(n.id)?.cents != null ? [byId.get(n.id)!.cents!] : []));
    const total = known.reduce((sum, c) => sum + c, 0);
    const m = new Map<string, Worth & { unitCents: number | null; unit: string }>();
    for (const n of graph.nodes) {
      const v = byId.get(n.id);
      if (v) m.set(n.id, { cents: v.cents, share: total > 0 && v.cents !== null ? v.cents / total : 0, unitCents: v.unitCents, unit: v.unit });
    }
    // The folded card holds what its items hold.
    if (small) {
      const held = small.nodes.flatMap((n) => (byId.get(n.id)?.cents != null ? [byId.get(n.id)!.cents!] : []));
      const cents = held.length ? held.reduce((sum, c) => sum + c, 0) : null;
      m.set(SMALL_ID, { cents, share: total > 0 && cents !== null ? cents / total : 0, unitCents: null, unit: '' });
    }
    return { worths: m, behind: known.length ? total : null };
  }, [valuation, graph.nodes, current, small]);
  // ----- warehouses (SCRUM-184): each ingredient's home and where its stock is -----
  const places = useMemo(() => {
    const w = stock.warehouses;
    const index = (id: string) => Math.max(0, w.list.findIndex((x) => x.id === id));
    const nameOf = (id: string) => w.list.find((x) => x.id === id)?.name ?? id;
    const m = new Map<string, Place>();
    for (const n of graph.nodes) {
      // Price-list items and batches are kept somewhere; water from the tap is not.
      if (!n.id.startsWith('stock:') && !n.id.startsWith('semi:')) continue;
      const st = stocks.get(n.id);
      const home = homeOf(w, n.id);
      const split = st?.known ? shownSplit(w, stock.places, n.id, st.onHand).map((x) => ({ ...x, name: nameOf(x.id), index: index(x.id) })) : [];
      m.set(n.id, { home: nameOf(home), homeIndex: index(home), split });
    }
    return m;
  }, [graph.nodes, stocks, stock.warehouses, stock.places]);
  const room = view === 'warehouse' ? pickedWh : null;
  const matches = useCallback((id: string, kind: string): boolean => {
    if (id === SMALL_ID) return !!small?.nodes.some((n) => matches(n.id, n.kind));
    const st = stocks.get(id);
    // In a warehouse: its home is there, or some of it is (a dish or a resource is in none).
    if (room && !((kind === 'raw' || kind === 'semi') && livesIn(stock.warehouses, stock.places, id, st?.known ? st.onHand : null).includes(room))) return false;
    if (filter === 'all') return true;
    if (filter === 'attention') return !!st && needsAttention(st);
    if (filter === 'out') return st?.status === 'out';
    return kind === filter;
  }, [filter, room, stocks, stock.warehouses, stock.places, small]);
  // The Warehouse view's column (SCRUM-188): the warehouses left of the raw items, a line to each,
  // stacked by the tallest raw card as drawn (a split bar and a stock line make them taller than a row).
  const rowH = useMemo(() => Math.max(ROW_H, ...drawing.nodes.filter((n) => n.kind === 'raw').map((n) => (sizes[n.id]?.height ?? 0) + 16)), [drawing.nodes, sizes]);
  const column = useMemo(() => {
    if (view !== 'warehouse') return null;
    const xs = drawing.nodes.map((n) => positions.get(n.id)?.x ?? 0);
    const minX = xs.length ? Math.min(...xs) : 0;
    // Price-list items only: water from the tap is in no warehouse.
    const raw = drawing.nodes.filter((n) => n.kind === 'raw' && n.id.startsWith('stock:'));
    // The raw items gather in the first column, or a new one left of it when a batch sits there too.
    const rawX = drawing.nodes.every((n) => n.kind === 'raw' || (positions.get(n.id)?.x ?? 0) !== minX) ? minX : minX - COL_W;
    const col = warehouseColumn(stock.warehouses, stock.places, raw.map((n) => {
      const st = stocks.get(n.id);
      return { id: n.id, total: st?.known ? st.onHand : null, y: positions.get(n.id)?.y ?? 0 };
    }), rowH);
    // Water from the tap and the like: in the same column, under the warehouses' blocks, with no line.
    drawing.nodes.filter((n) => n.kind === 'raw' && !n.id.startsWith('stock:')).forEach((n, i) => col.itemY.set(n.id, col.addY + i * rowH));
    return { ...col, rawX, whX: rawX - COL_W };
  }, [view, drawing.nodes, positions, stock.warehouses, stock.places, stocks, rowH]);
  const entries = useMemo<StockEntry[]>(() => (view === 'warehouse' ? stockEntries(stock, published.answers) : []), [view, stock, published.answers]);
  const inWarehouse = useMemo(() => new Map(byWarehouse(stock.warehouses, stock.places, entries).map((r) => [r.id, r])), [stock.warehouses, stock.places, entries]);
  const nameOf = useCallback((id: string) => graph.nodes.find((n) => n.id === id)?.name
    ?? (id.startsWith('stock:') ? stock.rows.find((r) => `stock:${r.id}` === id)?.name : prepItems(published.answers).find((p) => `semi:${p.key}` === id)?.name)
    ?? id.slice(id.indexOf(':') + 1), [graph.nodes, stock.rows, published.answers]);
  const active = useMemo(() => new Set(suppliers.map((x) => x.id)), [suppliers]);
  const buying = useMemo(() => ({ items: stock.rows, suppliers, purchases }), [stock.rows, suppliers, purchases]);

  /** Puts base units of price-list items into their suppliers' carts; says what happened. */
  const toCart = useCallback((buy: ReadonlyMap<string, number>) => {
    const added = cartShortages(buy, stock.rows, purchases, active);
    const names = andList([...buy.keys()].map((id) => nameOf(`stock:${id}`)));
    say(added.suppliers.length ? `${names}: added to the cart. Nothing is in stock until it is received.` : `${names}: no active supplier to order from.`, added.undo);
  }, [stock.rows, purchases, active, nameOf, say]);
  /** An item kept in another warehouse from now on (a line dragged, a number pressed, a chip tapped). */
  const keepIn = useCallback((itemId: string, warehouseId: string) => {
    const to = stock.warehouses.list.find((x) => x.id === warehouseId);
    if (!to || to.archived || homeOf(stock.warehouses, itemId) === warehouseId) return;
    say(`${nameOf(itemId)}: kept in ${to.name}`, setHome(stock.warehouses, itemId, warehouseId, owner));
  }, [stock.warehouses, nameOf, say, owner]);
  const addOne = useCallback(() => {
    const name = nextWarehouseName(stock.warehouses);
    const undo = addWarehouse(stock.warehouses, name, owner);
    if (typeof undo === 'string') { say(undo); return; }
    say(`${name} added: type its own name`, undo);
    setNewWh(name);
  }, [stock.warehouses, owner, say]);
  useEffect(() => {
    const made = newWh ? stock.warehouses.list.find((x) => !x.archived && x.name === newWh) : null;
    if (!made) return;
    setNewWh(null);
    setSel(null);
    setPickedWh(made.id);
  }, [newWh, stock.warehouses]);
  // A card picked lets go of the warehouse, and the other way round.
  useEffect(() => { if (sel) setPickedWh(null); }, [sel]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(t);
  }, [toast]);

  // ----- changes: each one a draft, with its Undo -----
  const draft = useCallback((question: string, after: Answer | null, text: string) => {
    const undo = saveDraft(question, after, drafts.get(question)?.answer ?? null, owner);
    say(text, undo);
  }, [drafts, owner, say]);

  const actions: PanelActions = useMemo(() => ({
    setLines: (h, lines, text, makes) => draft(h.question, answerWith(h, lines, makes ?? h.makes, answers), text),
    setResources: (h, lines: ResourceLine[], text) => draft(resourcesQuestion(h.key), { kind: 'resources', lines }, text),
    setRates: (rates: Rates) => draft(RATES_QUESTION, { kind: 'rates', rates }, 'Rates changed'),
    addStage: (h, name) => {
      const made = newStage(name, h, answers);
      if (!made.drafts) return made.problem;
      const undos = made.drafts.map(([q, a]) => saveDraft(q, a, drafts.get(q)?.answer ?? null, owner));
      say(`Added ${name.trim()} into ${h.name}`, () => undos.reverse().forEach((u) => u()));
      return null;
    },
    pickIngredient: (h) => setPicking(h),
    sendToKitchen: (key, batches) => {
      const item = prepItems(published.answers).find((p) => p.key === key);
      if (!item?.makes) { say(`${item?.name ?? 'It'}: say what one batch makes first.`); return; }
      const plan = planProduction({ key, name: item.name, qty: batches * item.makes.qty, unit: item.makes.unit }, stock.ledger, nameOf);
      if (plan.problem) { say(plan.problem); return; }
      const undo = sendPlan(plan, owner);
      const text = planNotice(plan, prepAmount);
      // Told on the item's own panel when it is open there; the toast keeps the Undo.
      const open = sel ? sel.kind === 'node' && sel.id === `semi:${key}` : current === `semi:${key}`;
      setSent({ id: `semi:${key}`, text, at: Date.now() });
      say(open ? `${item.name}: sent` : text, () => { undo(); setSent(null); }, plan.buy.size ? { label: 'Add to cart', run: () => toCart(plan.buy) } : undefined);
    },
    order: (nodeId) => { setSel({ kind: 'node', id: nodeId }); setOrdering(nodeId); },
    select: setSel,
    toggle: (id) => setCollapsed((c) => { const n = new Set(c); if (n.has(id)) n.delete(id); else n.add(id); return n; }),
  }), [draft, answers, drafts, owner, say, published.answers, stock, nameOf, toCart, sel, current]);

  /** Put `sourceId` into the recipe `targetId`, or say why it can't go there. */
  const connect = useCallback((sourceId: string, targetId: string) => {
    const h = holderOf(targetId, answers, menu);
    const line = lineFor(sourceId, ctx);
    const problem = sourceId === targetId ? 'It can\'t go inside itself.' : connectProblem(h, line, answers);
    if (problem || !h || !line) { say(problem ?? 'That can\'t go there.'); return; }
    const already = h.lines.findIndex((l) => lineNode(l.name, answers) === sourceId);
    if (already >= 0) { setSel({ kind: 'edge', id: `${sourceId}>${targetId}#${already}` }); return; }
    const name = graph.nodes.find((n) => n.id === sourceId)?.name ?? 'It';
    actions.setLines(h, [...h.lines, line], `${name} goes into ${h.name}: type how much`);
    setSel({ kind: 'edge', id: `${sourceId}>${targetId}#${h.lines.length}` });
  }, [answers, menu, ctx, graph.nodes, actions, say]);

  const removeEdges = useCallback((ids: string[]) => {
    for (const id of ids) {
      const e = graph.edges.find((x) => x.id === id);
      const h = e && holderOf(e.target, answers, menu);
      if (!e || !h?.editable || e.kind === 'money') continue;
      if (e.kind === 'resource') {
        actions.setResources(h, resourcesOf(h.key, answers).filter((_, i) => i !== e.index), `Took it out of ${h.name}`);
      } else {
        actions.setLines(h, h.lines.filter((_, i) => i !== e.index), `Took ${graph.nodes.find((n) => n.id === e.source)?.name ?? 'it'} out of ${h.name}`);
      }
    }
    setSel(null);
  }, [graph, answers, menu, actions]);

  const publish = () => {
    if (!plan.length || blocked) return;
    const undo = publishDrafts(plan, owner);
    say(`Published ${plan.length === 1 ? '1 change' : `${plan.length} changes`}: costs and stock use it from now on`, undo);
  };
  const discard = () => {
    const undo = discardDrafts([...drafts.values()], owner);
    say('Drafts discarded', undo);
  };

  // ----- the canvas -----
  // A tapped card (or line) lights its path to the dish; the rest fades. A folded item lights its card.
  const onCanvas = (id: string) => (small?.nodes.some((n) => n.id === id) ? SMALL_ID : id);
  const picked = sel?.kind === 'node' ? onCanvas(sel.id) : sel?.kind === 'edge' ? onCanvas(graph.edges.find((e) => e.id === sel.id)?.source ?? '') : null;
  const lit = useMemo(() => (picked && picked !== current ? pathOf(drawing, picked) : null), [drawing, picked, current]);
  const nodes: CanvasNode[] = useMemo(() => [...drawing.nodes.map((n): VfNode => ({
    id: n.id, type: 'vf', measured: sizes[n.id],
    position: moved[n.id] ?? (column?.itemY.has(n.id) ? { x: column.rawX, y: column.itemY.get(n.id)! } : positions.get(n.id)) ?? { x: 0, y: 0 },
    selected: sel?.kind === 'node' && picked === n.id, deletable: false,
    data: {
      node: n, view, focus: n.id === current, focusName,
      takes: !!n.recipe?.editable, onToggle: actions.toggle,
      // The item in focus stays bright: what it needs is what the filter is about.
      stock: stocks.get(n.id) ?? null, dim: n.id !== current && !matches(n.id, n.kind), share: nodeShare(n, answers),
      faded: !!lit && !lit.nodes.has(n.id),
      worth: view !== 'stock' ? undefined : n.id === current ? { cents: behind, share: 0 } : worths.get(n.id),
      place: view === 'warehouse' && n.id !== current ? places.get(n.id) : undefined,
      stored: !!column && n.id.startsWith('stock:') && column.itemY.has(n.id),
    },
  })), ...(column ? [
    ...column.cards.map((c): WhNode => {
      const here = inWarehouse.get(c.id);
      return {
        id: `wh:${c.id}`, type: 'wh', position: moved[`wh:${c.id}`] ?? { x: column.whX, y: c.y }, measured: sizes[`wh:${c.id}`],
        selected: pickedWh === c.id, deletable: false,
        data: { name: c.name, index: c.index, kitchenSide: c.kitchenSide, archived: c.archived, items: here?.items.length ?? 0, cents: here?.cents || null, dim: !!pickedWh && pickedWh !== c.id },
      };
    }),
    { id: 'wh:+', type: 'whAdd', position: { x: column.whX, y: column.addY }, measured: sizes['wh:+'], selectable: false, draggable: false, deletable: false, data: { onAdd: addOne } } satisfies WhAddNode,
  ] : [])], [drawing.nodes, moved, positions, sizes, sel, view, current, focusName, actions.toggle, stocks, matches, answers, worths, behind, places, lit, picked, column, inWarehouse, pickedWh, addOne]);
  const edges: CanvasEdge[] = useMemo(() => [...drawing.edges.map((e): VfEdge => ({
    id: e.id, source: e.source, target: e.target, type: 'vf', selected: sel?.kind === 'edge' && sel.id === e.id,
    deletable: e.kind !== 'money' && e.source !== SMALL_ID,
    data: { edge: e, view, total: graph.breakdown.total, faded: !!lit && !lit.edges.has(e.id) },
  })), ...(column?.links.map((l): WhEdge => {
    const st = stocks.get(l.itemId);
    return {
      id: l.id, source: `wh:${l.warehouseId}`, target: l.itemId, type: 'wh', deletable: false,
      // A home's line is dragged by its warehouse end to another warehouse.
      reconnectable: l.home ? 'source' : false,
      data: { home: l.home, label: st && l.qty ? stockAmount(st, l.qty) : null, onSelect: () => setSel({ kind: 'node', id: l.itemId }) },
    };
  }) ?? [])], [drawing.edges, graph.breakdown.total, sel, view, lit, column, stocks]);
  /** A folded card's line opens the card: its lines are many lines at once. */
  const pick = (kind: 'node' | 'edge', id: string) => setSel(kind === 'edge' && id.startsWith(`${SMALL_ID}>`) ? { kind: 'node', id: SMALL_ID } : { kind, id });

  // The drawing's point, in words.
  const said = view === 'stock'
    ? (behind === null ? `None of what goes into ${focusName} is counted yet.` : `${rs(behind)} of stock is behind ${focusName}.`)
    : flowSentence(graph, drawn, focusName);

  const onNodesChange = useCallback((changes: NodeChange<CanvasNode>[]) => {
    // Kept: where he drags a card to, and each card's size; selection is ours (sel), the rest is drawn from the graph.
    const drag = changes.flatMap((c) => (c.type === 'position' && c.position ? [[c.id, c.position] as const] : []));
    if (drag.length) setMoved((m) => ({ ...m, ...Object.fromEntries(drag) }));
    const sized = changes.flatMap((c) => (c.type === 'dimensions' && c.dimensions ? [[c.id, c.dimensions] as const] : []));
    if (sized.length) setSizes((m) => ({ ...m, ...Object.fromEntries(sized) }));
  }, []);
  const onEdgesChange = useCallback((changes: EdgeChange<CanvasEdge>[]) => {
    const gone = changes.flatMap((c) => (c.type === 'remove' ? [c.id] : []));
    if (gone.length) removeEdges(gone);
  }, [removeEdges]);

  // Fit the drawing when the item, the view or what is folded changes (not on every edit: he keeps
  // his place). The first drawing is fitted by React Flow itself (fitView); later ones a moment
  // after the change, once cards it added (Revenue, Profit) have been measured.
  // Once every card is measured the layout knows their heights: fit that too; the Warehouse view's rows follow them.
  const measured = drawing.nodes.every((n) => sizes[n.id]);
  const fitKey = `${current}|${view}|${[...collapsed].join(',')}|${measured}${view === 'warehouse' ? `|${rowH}` : ''}`;
  const fitted = useRef(fitKey);
  useEffect(() => {
    if (fitted.current === fitKey) return;
    fitted.current = fitKey;
    const t = setTimeout(() => void flow.fitView({ duration: 200, padding: FIT }), 60);
    return () => clearTimeout(t);
  }, [fitKey, flow]);

  // Keys: 1 2 3 4 the views, F fits the whole drawing, + and - zoom, Esc lets go, Ctrl+Z undoes, Ctrl+P publishes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest('input, textarea, select, [role="dialog"]')) return;
      if (e.ctrlKey && e.key.toLowerCase() === 'z' && toast?.undo) { e.preventDefault(); toast.undo(); setToast(null); return; }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      // A stock card picked in the Warehouse view: 1 to 9 keeps it in that warehouse (the views' keys again once it is let go).
      if (view === 'warehouse' && sel?.kind === 'node' && places.has(sel.id) && /^[1-9]$/.test(e.key)) {
        const to = activeWarehouses(stock.warehouses)[Number(e.key) - 1];
        if (to) keepIn(sel.id, to.id);
        return;
      }
      if (e.key === 'Escape' && filtering) { e.preventDefault(); setFiltering(false); return; }
      if (e.key === 'Escape' && pickedWh) { e.preventDefault(); setPickedWh(null); return; }
      const v = VIEWS[Number(e.key) - 1];
      if (v) { setView(v.id); return; }
      if (e.key.toLowerCase() === 'f') void flow.fitView({ duration: 200, padding: FIT });
      if (e.key === '+' || e.key === '=') void flow.zoomIn({ duration: 150 });
      if (e.key === '-') void flow.zoomOut({ duration: 150 });
      if (e.key === 'Escape' && sel) { e.preventDefault(); setSel(null); } // lets go first; the next Esc goes back
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toast, flow, sel, view, places, stock.warehouses, keepIn, pickedWh, filtering]);

  const pickCommands = useMemo(() => {
    if (picking === 'focus') return options.map((o) => ({ id: o.id, label: `${o.group} · ${o.label}`, run: () => setFocus(o.id) }));
    if (!picking) return [];
    // A dish or extra is drawn by its recipe question, a batch as semi:<key>.
    const target = picking.question.startsWith('recipe:') || picking.question.startsWith('addon:') ? picking.question : `semi:${picking.key}`;
    return [
      ...ctx.items.filter((i) => !('archived' in i && i.archived)).map((i) => ({ id: `stock:${i.id}`, label: `Raw · ${i.name}`, run: () => connect(`stock:${i.id}`, target) })),
      ...prepItems(answers).map((p) => ({ id: `semi:${p.key}`, label: `Semi-processed · ${p.name}`, run: () => connect(`semi:${p.key}`, target) })),
    ];
  }, [picking, options, ctx.items, answers, connect, setFocus]);

  return (
    <main className="vf" aria-label="Visual Flow">
      <div className="vf-notices"><ReleaseNotices /></div>
      <div className="vf-body">
        <div className="vf-canvas">
          <ReactFlow
            nodes={nodes} edges={edges} nodeTypes={NODE_TYPES} edgeTypes={EDGE_TYPES}
            onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
            onNodeClick={(_, n) => {
              if (n.type === 'whAdd') return;
              if (n.type === 'wh') { setSel(null); setPickedWh(n.id.slice('wh:'.length)); return; }
              pick('node', n.id);
            }}
            onEdgeClick={(_, e) => (e.type === 'wh' ? setSel({ kind: 'node', id: e.target }) : pick('edge', e.id))}
            onPaneClick={() => { setSel(null); setPickedWh(null); setFiltering(false); }}
            onConnect={(c: Connection) => {
              if (!c.source || !c.target) return;
              if (c.source.startsWith('wh:')) keepIn(c.target, c.source.slice('wh:'.length));
              else connect(c.source, c.target);
            }}
            onReconnect={(old, c) => {
              if (old.type === 'wh' && c.source?.startsWith('wh:') && c.target === old.target) keepIn(old.target, c.source.slice('wh:'.length));
            }}
            edgesReconnectable={false}
            isValidConnection={(c) => {
              if (!c.source || !c.target || c.source === c.target) return false;
              // A warehouse's line goes to a raw card only.
              if (c.source.startsWith('wh:')) return c.target.startsWith('stock:') && !!column?.itemY.has(c.target);
              return connectProblem(holderOf(c.target, answers, menu), lineFor(c.source, ctx), answers) === null;
            }}
            connectionRadius={32} minZoom={MIN_ZOOM} maxZoom={2} fitView fitViewOptions={{ padding: FIT }} proOptions={{ hideAttribution: true }}
            deleteKeyCode={['Delete', 'Backspace']} nodesConnectable elementsSelectable
            aria-label={`How ${focusName} is made`}
          >
            <Background gap={24} size={1} />
            <Controls showInteractive={false} position="bottom-right" />
          </ReactFlow>
          {/* Only the drawing is on screen; the rest comes when asked for: the shop's list (☰), the
              filters (Filter), a card's details (tap it). */}
          <header className="vf-strip">
            <button type="button" className="vf-menu" onClick={onMenu} aria-label="Show the parts of the shop">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                <line x1="4" y1="7" x2="20" y2="7" /><line x1="4" y1="12" x2="20" y2="12" /><line x1="4" y1="17" x2="14" y2="17" />
              </svg>
            </button>
            <button type="button" className="vf-focus" onClick={() => setPicking('focus')} aria-label={`Showing ${focusName}. Choose another item`}>
              <span className="vf-focus__name">{focusName || 'Choose an item'}</span>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
            </button>
            <div className="vf-views" role="group" aria-label="View">
              {VIEWS.map((v, i) => (
                <button key={v.id} type="button" className="pill" aria-pressed={view === v.id} onClick={() => setView(v.id)} title={`${v.label} (${i + 1})`}>{v.label}</button>
              ))}
            </div>
            <div className="vf-filterwrap">
              <button type="button" className="chip vf-filterbtn" aria-expanded={filtering} aria-pressed={filter !== 'all'} onClick={() => setFiltering((o) => !o)}>
                {filter === 'all' ? 'Filter' : `Filter · ${FILTERS.find((f) => f.id === filter)?.label}`}
              </button>
              {filtering && (
                <div className="chips chips--tight vf-filter" role="group" aria-label="Show">
                  {FILTERS.map((f) => (
                    <button key={f.id} type="button" className="chip" aria-pressed={filter === f.id} onClick={() => { setFilter(f.id); setFiltering(false); }}>{f.label}</button>
                  ))}
                </div>
              )}
            </div>
            <div className="vf-publish">
              {plan.length > 0 && (
                <>
                  <button type="button" className="linkbtn vf-discard" onClick={discard}>Discard</button>
                  <button type="button" className="vf-primary" onClick={publish} disabled={!!blocked}
                    title={blocked ? `Not yet: ${blocked.problem}` : undefined}>
                    Publish {plan.length === 1 ? '1 change' : `${plan.length} changes`}
                  </button>
                </>
              )}
            </div>
          </header>
          {said && <Said key={`${current}|${view}|${said}`} text={said} />}
          {view === 'warehouse' && (
            <WarehouseOverlay warehouses={stock.warehouses} owner={owner} picked={stock.warehouses.list.find((x) => x.id === pickedWh) ?? null}
              selected={sel?.kind === 'node' ? sel.id : null} place={sel?.kind === 'node' ? places.get(sel.id) : undefined}
              stock={sel?.kind === 'node' ? stocks.get(sel.id) ?? null : null} name={sel?.kind === 'node' ? nameOf(sel.id) : ''}
              say={say} keepIn={keepIn} onMove={setMoving} />
          )}
          {graph.nodes.length <= 1 && (
            <p className="vf-empty">No recipe yet. Choose it on the right: add an ingredient, or drag one in.</p>
          )}
        </div>
        <FlowPanel
          open={!!sel} onClose={() => setSel(null)} said={said ?? ''}
          graph={graph} view={drawn} worths={worths} behind={behind} sel={sel} ctx={ctx} menu={menu} events={events} drafts={drafts} plan={plan}
          focusName={focusName} actions={actions} stocks={stocks} makesOf={(key) => prepItems(published.answers).find((p) => p.key === key)?.makes ?? null} sent={sent}
          ordering={ordering} buying={buying} small={small}
        />
      </div>
      {moving && entries.some((x) => x.key === moving) && (
        <PlaceSheet entry={entries.find((x) => x.key === moving)!} warehouses={stock.warehouses} split={places.get(moving)?.split ?? []}
          onClose={() => setMoving(null)} onDone={(d) => say(d.message, d.undo)} />
      )}
      {picking && (
        <CommandPalette
          placeholder={picking === 'focus' ? 'Which dish, extra or batch?' : `What goes into ${picking.name}?`}
          commands={pickCommands} onClose={() => setPicking(null)}
        />
      )}
      {toast && (
        <div className="toast" role="status" key={toast.id}>
          <span>{toast.text}</span>
          {toast.undo && <button type="button" onClick={() => { toast.undo!(); setToast(null); }}>Undo</button>}
          {toast.next && <button type="button" onClick={() => { toast.next!.run(); }}>{toast.next.label}</button>}
        </div>
      )}
    </main>
  );
}

/**
 * The Warehouse view's panel (SCRUM-184, SCRUM-188), top-left on the canvas (the column runs down the left). A warehouse tapped
 * in the column: its name (typed in place), next to the kitchen, archive. A stock card picked: where
 * it is, where it is kept (a chip or its number), and Move. Nothing picked: how the column works.
 */
function WarehouseOverlay({ warehouses, owner, picked, selected, place, stock, name, say, keepIn, onMove }: {
  warehouses: Warehouses; owner: Actor; picked: Warehouse | null;
  selected: string | null; place: Place | undefined; stock: ItemStock | null; name: string;
  say: (text: string, undo?: () => void) => void;
  keepIn: (itemId: string, warehouseId: string) => void;
  onMove: (itemId: string) => void;
}) {
  if (picked) return <aside className="vf-wh" aria-label={picked.name}><WarehousePanel key={picked.id} warehouse={picked} warehouses={warehouses} owner={owner} say={say} /></aside>;
  const home = selected ? homeOf(warehouses, selected) : null;
  return (
    <aside className="vf-wh" aria-label="Warehouses">
      {selected && place ? (
        <div className="vf-wh__item">
          <strong>{name}</strong>
          <span className="vf-wh__where num">
            {place.split.length ? place.split.map((x) => `${x.name} ${stock ? stockAmount(stock, x.qty) : x.qty}`).join(' · ') : 'None in stock'}
          </span>
          <div className="chips chips--tight" role="group" aria-label={`Where ${name} is kept`}>
            {activeWarehouses(warehouses).map((x, i) => (
              <button key={x.id} type="button" className="chip" aria-pressed={x.id === home} aria-keyshortcuts={i < 9 ? String(i + 1) : undefined}
                onClick={() => keepIn(selected, x.id)}>{i < 9 ? `${i + 1} · ` : ''}{x.name}</button>
            ))}
          </div>
          {place.split.length > 0 && <button type="button" className="linkbtn" onClick={() => onMove(selected)}>Move stock</button>}
        </div>
      ) : (
        <span className="vf-wh__keys">Drag a warehouse&apos;s line onto an item to keep it there. Tap a warehouse to rename it.</span>
      )}
    </aside>
  );
}

/** One warehouse, the owner's: its name typed in place (Enter or leaving the box saves), next to the kitchen, archive. */
function WarehousePanel({ warehouse, warehouses, owner, say }: { warehouse: Warehouse; warehouses: Warehouses; owner: Actor; say: (text: string, undo?: () => void) => void }) {
  const [name, setName] = useState(warehouse.name);
  const [error, setError] = useState('');
  const kitchenSide = warehouses.kitchenSide === warehouse.id;
  const rename = () => {
    if (name.trim() === warehouse.name) return;
    const r = editWarehouse(warehouses, warehouse.id, { name }, owner);
    if (typeof r === 'string') { setError(r); return; }
    say(`${warehouse.name} is now ${name.trim()}`, r);
  };
  const archive = (archived: boolean) => {
    const r = editWarehouse(warehouses, warehouse.id, { archived }, owner);
    if (typeof r === 'string') { setError(r); return; }
    say(archived ? `${warehouse.name} archived: nothing new goes there` : `${warehouse.name} is back`, r);
  };
  return (
    <div className="vf-wh__item">
      <input className="inv-modal__input vf-wh__name" value={name} maxLength={40} aria-label="Warehouse name" disabled={warehouse.archived}
        autoFocus={/^Warehouse \d+$/.test(warehouse.name)} name="warehouse-name" autoComplete="off" spellCheck={false}
        onChange={(e) => { setName(e.target.value); setError(''); }} onBlur={rename}
        // Enter leaves the box, and leaving it saves (once).
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur(); } }} />
      {error && <p className="vf-wh__error" role="alert">{error}</p>}
      <div className="chips chips--tight">
        {!warehouse.archived && (
          <button type="button" className="chip" aria-pressed={kitchenSide}
            onClick={() => { if (!kitchenSide) say(`${warehouse.name} is next to the kitchen: sales take from it first`, setKitchenSide(warehouses, warehouse.id, owner)); }}>Next to the kitchen</button>
        )}
        <button type="button" className="chip" aria-pressed={warehouse.archived} onClick={() => archive(!warehouse.archived)}>{warehouse.archived ? 'Restore' : 'Archive'}</button>
      </div>
    </div>
  );
}
