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
  answerWith, buildFlow, connectProblem, focusOptions, holderOf, layout, lineFor, lineNode, newStage, resourcesOf, soldUnits, viewOf,
  type FlowView, type Holder,
} from '../../domain/visualFlow.ts';
import { cartShortages, discardDrafts, publishDrafts, recipesViewed, saveDraft, sendPlan, useCatalog, useFlowData, usePurchases } from '../../services/inventoryStore.ts';
import { itemStockOf, needsAttention, type ItemStock } from '../../domain/itemStock.ts';
import { andList, planNotice, planProduction } from '../../domain/production.ts';
import { batchShare, prepAmount } from '../../domain/prep.ts';
import { ReleaseNotices } from '../ProductionNotices.tsx';
import { CommandPalette } from '../CommandPalette.tsx';
import { useMenu } from '../menuStore.ts';
import { OwnerNav } from '../OwnerNav.tsx';
import { useOwner } from '../RecipeLines.tsx';
import { FlowPanel, type PanelActions, type Selection } from './FlowPanel.tsx';
import { EDGE_TYPES, NODE_TYPES, nodeShare, stockAmount, type CanvasView, type Place, type VfEdge, type VfNode, type Worth } from './FlowParts.tsx';
import { activeWarehouses, homeOf, livesIn, shownSplit, type Warehouses } from '../../domain/warehouses.ts';
import { setHome } from '../../services/inventoryStore.ts';
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
 * Every change is a draft at once, with Undo; Publish makes the drafts his recipes (one new version
 * each), so what was made before keeps the recipe it was made with. The recipes are his alone, like
 * the Recipes screen: anyone else sees a line saying so, and each opening is in the audit trail.
 */
export default function VisualFlowView({ onRegister }: { onRegister?: () => void }) {
  const owner = useOwner();
  useEffect(() => { if (owner) recipesViewed(owner); }, [owner]);
  return (
    <div className="owner vf-page">
      <OwnerNav current="flow" onRegister={onRegister} />
      {owner
        ? <ReactFlowProvider><Studio owner={owner} /></ReactFlowProvider>
        : <main className="owner__main" aria-label="Visual Flow"><p className="vf-muted">Only the owner sees the recipes.</p></main>}
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
 * a time, and on top of it one warehouse at a time (SCRUM-187): "Low" in "Warehouse 2".
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

function Studio({ owner }: { owner: Actor }) {
  useMenu();
  const menu = menuItems();
  const { ctx: published, drafts, events, stock } = useFlowData();
  const purchases = usePurchases();
  const { suppliers } = useCatalog();
  const [filter, setFilter] = useState<Filter>('all');
  /** One warehouse, on top of the filter; null: every warehouse. */
  const [room, setRoom] = useState<string | null>(null);
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
  const positions = useMemo(() => layout(graph), [graph]);
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
    return { worths: m, behind: known.length ? total : null };
  }, [valuation, graph.nodes, current]);
  // ----- warehouses (SCRUM-184): each ingredient's home and where its stock is -----
  const places = useMemo(() => {
    const w = stock.warehouses;
    const index = (id: string) => Math.max(0, w.list.findIndex((x) => x.id === id));
    const nameOf = (id: string) => w.list.find((x) => x.id === id)?.name ?? id;
    const m = new Map<string, Place>();
    for (const n of graph.nodes) {
      if (n.kind !== 'raw' && n.kind !== 'semi') continue;
      const st = stocks.get(n.id);
      const home = homeOf(w, n.id);
      const split = st?.known ? shownSplit(w, stock.places, n.id, st.onHand).map((x) => ({ ...x, name: nameOf(x.id), index: index(x.id) })) : [];
      m.set(n.id, { home: nameOf(home), homeIndex: index(home), split });
    }
    return m;
  }, [graph.nodes, stocks, stock.warehouses, stock.places]);
  const matches = useCallback((id: string, kind: string) => {
    const st = stocks.get(id);
    // In a warehouse: its home is there, or some of it is (a dish or a resource is in none).
    if (room && !((kind === 'raw' || kind === 'semi') && livesIn(stock.warehouses, stock.places, id, st?.known ? st.onHand : null).includes(room))) return false;
    if (filter === 'all') return true;
    if (filter === 'attention') return !!st && needsAttention(st);
    if (filter === 'out') return st?.status === 'out';
    return kind === filter;
  }, [filter, room, stocks, stock.warehouses, stock.places]);
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
  const nodes: VfNode[] = useMemo(() => graph.nodes.map((n) => ({
    id: n.id, type: 'vf', position: moved[n.id] ?? positions.get(n.id) ?? { x: 0, y: 0 }, measured: sizes[n.id],
    selected: sel?.kind === 'node' && sel.id === n.id, deletable: false,
    data: {
      node: n, view, focus: n.id === current, focusName,
      takes: !!n.recipe?.editable, onToggle: actions.toggle,
      // The item in focus stays bright: what it needs is what the filter is about.
      stock: stocks.get(n.id) ?? null, dim: n.id !== current && !matches(n.id, n.kind), share: nodeShare(n, answers),
      worth: view !== 'stock' ? undefined : n.id === current ? { cents: behind, share: 0 } : worths.get(n.id),
      place: view === 'warehouse' && n.id !== current ? places.get(n.id) : undefined,
    },
  })), [graph.nodes, moved, positions, sizes, sel, view, current, focusName, actions.toggle, stocks, matches, answers, worths, behind, places]);
  const edges: VfEdge[] = useMemo(() => graph.edges.map((e) => ({
    id: e.id, source: e.source, target: e.target, type: 'vf', selected: sel?.kind === 'edge' && sel.id === e.id,
    deletable: e.kind !== 'money',
    data: {
      edge: e, view, total: graph.breakdown.total, onSelect: (id: string) => setSel({ kind: 'edge', id }),
      share: e.line ? batchShare({ ...e.line, qty: e.qty }, answers) : null,
    },
  })), [graph.edges, graph.breakdown.total, sel, view, answers]);

  const onNodesChange = useCallback((changes: NodeChange<VfNode>[]) => {
    // Kept: where he drags a card to, and each card's size; selection is ours (sel), the rest is drawn from the graph.
    const drag = changes.flatMap((c) => (c.type === 'position' && c.position ? [[c.id, c.position] as const] : []));
    if (drag.length) setMoved((m) => ({ ...m, ...Object.fromEntries(drag) }));
    const sized = changes.flatMap((c) => (c.type === 'dimensions' && c.dimensions ? [[c.id, c.dimensions] as const] : []));
    if (sized.length) setSizes((m) => ({ ...m, ...Object.fromEntries(sized) }));
  }, []);
  const onEdgesChange = useCallback((changes: EdgeChange<VfEdge>[]) => {
    const gone = changes.flatMap((c) => (c.type === 'remove' ? [c.id] : []));
    if (gone.length) removeEdges(gone);
  }, [removeEdges]);

  // Fit the drawing when the item, the view or what is folded changes (not on every edit: he keeps
  // his place). The first drawing is fitted by React Flow itself (fitView); later ones a moment
  // after the change, once cards it added (Revenue, Profit) have been measured.
  const fitKey = `${current}|${view}|${[...collapsed].join(',')}`;
  const fitted = useRef(fitKey);
  useEffect(() => {
    if (fitted.current === fitKey) return;
    fitted.current = fitKey;
    const t = setTimeout(() => void flow.fitView({ duration: 200, padding: 0.12 }), 60);
    return () => clearTimeout(t);
  }, [fitKey, flow]);

  // Keys: 1 2 3 4 the views, F fits, Esc lets go, Ctrl+Z undoes, Ctrl+P publishes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest('input, textarea, select, [role="dialog"]')) return;
      if (e.ctrlKey && e.key.toLowerCase() === 'z' && toast?.undo) { e.preventDefault(); toast.undo(); setToast(null); return; }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const v = VIEWS[Number(e.key) - 1];
      if (v) { setView(v.id); return; }
      if (e.key.toLowerCase() === 'f') void flow.fitView({ duration: 200, padding: 0.15 });
      if (e.key === 'Escape' && sel) { e.preventDefault(); setSel(null); } // lets go first; the next Esc goes back
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toast, flow, sel]);

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
      <header className="vf-bar">
        <button type="button" className="vf-focus" onClick={() => setPicking('focus')} aria-label={`Showing ${focusName}. Choose another item`}>
          <span className="vf-focus__name">{focusName || 'Choose an item'}</span>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
        </button>
        <div className="vf-views" role="group" aria-label="View">
          {VIEWS.map((v, i) => (
            <button key={v.id} type="button" className="pill" aria-pressed={view === v.id} onClick={() => setView(v.id)} title={`${v.label} (${i + 1})`}>{v.label}</button>
          ))}
        </div>
        <div className="chips chips--tight vf-filter" role="group" aria-label="Show">
          {FILTERS.map((f) => (
            <button key={f.id} type="button" className="chip" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>{f.label}</button>
          ))}
        </div>
        {activeWarehouses(stock.warehouses).length > 1 && (
          <div className="chips chips--tight vf-filter" role="group" aria-label="Warehouse">
            {activeWarehouses(stock.warehouses).map((w) => (
              <button key={w.id} type="button" className="chip" aria-pressed={room === w.id} onClick={() => setRoom(room === w.id ? null : w.id)}>{w.name}</button>
            ))}
          </div>
        )}
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
      <div className="vf-body">
        <div className="vf-canvas">
          <ReactFlow
            nodes={nodes} edges={edges} nodeTypes={NODE_TYPES} edgeTypes={EDGE_TYPES}
            onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
            onNodeClick={(_, n) => setSel({ kind: 'node', id: n.id })}
            onEdgeClick={(_, e) => setSel({ kind: 'edge', id: e.id })}
            onPaneClick={() => setSel(null)}
            onConnect={(c: Connection) => c.source && c.target && connect(c.source, c.target)}
            isValidConnection={(c) => !!c.source && !!c.target && c.source !== c.target
              && connectProblem(holderOf(c.target, answers, menu), lineFor(c.source, ctx), answers) === null}
            connectionRadius={32} minZoom={0.2} maxZoom={2} fitView fitViewOptions={{ padding: 0.12 }} proOptions={{ hideAttribution: true }}
            deleteKeyCode={['Delete', 'Backspace']} nodesConnectable elementsSelectable
            aria-label={`How ${focusName} is made`}
          >
            <Background gap={24} size={1} />
            <Controls showInteractive={false} position="bottom-right" />
          </ReactFlow>
          {view === 'warehouse' && (
            <WarehouseOverlay warehouses={stock.warehouses} selected={sel?.kind === 'node' ? sel.id : null} place={sel?.kind === 'node' ? places.get(sel.id) : undefined}
              stock={sel?.kind === 'node' ? stocks.get(sel.id) ?? null : null} name={sel?.kind === 'node' ? nameOf(sel.id) : ''} say={say} />
          )}
          {graph.nodes.length <= 1 && (
            <p className="vf-empty">No recipe yet. Choose it on the right: add an ingredient, or drag one in.</p>
          )}
        </div>
        <FlowPanel
          graph={graph} view={drawn} worths={worths} behind={behind} sel={sel} ctx={ctx} menu={menu} events={events} drafts={drafts} plan={plan}
          focusName={focusName} actions={actions} stocks={stocks} makesOf={(key) => prepItems(published.answers).find((p) => p.key === key)?.makes ?? null} sent={sent}
          ordering={ordering} buying={buying}
        />
      </div>
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
 * The Warehouse view's key (SCRUM-184): each warehouse's shade, and for the card picked, where it
 * is and its home, one tap to change. Moving stock is on Items › Warehouses.
 */
function WarehouseOverlay({ warehouses, selected, place, stock, name, say }: {
  warehouses: Warehouses; selected: string | null; place: Place | undefined; stock: ItemStock | null; name: string;
  say: (text: string, undo?: () => void) => void;
}) {
  const home = selected ? homeOf(warehouses, selected) : null;
  return (
    <aside className="vf-wh" aria-label="Warehouses">
      <ul className="wh-split__legend">
        {warehouses.list.filter((x) => !x.archived).map((x) => (
          <li key={x.id}><span className={`wh-dot wh-seg--${warehouses.list.indexOf(x) % 4}`} aria-hidden="true" />{x.name}{x.id === warehouses.kitchenSide ? ' · next to the kitchen' : ''}</li>
        ))}
      </ul>
      {selected && place && (
        <div className="vf-wh__item">
          <strong>{name}</strong>
          <span className="vf-wh__where num">
            {place.split.length ? place.split.map((x) => `${x.name} ${stock ? stockAmount(stock, x.qty) : x.qty}`).join(' · ') : 'None in stock'}
          </span>
          <div className="chips chips--tight" role="group" aria-label={`Where ${name} is kept`}>
            {activeWarehouses(warehouses).map((x) => (
              <button key={x.id} type="button" className="chip" aria-pressed={x.id === home}
                onClick={() => { if (x.id !== home) say(`${name}: kept in ${x.name}`, setHome(warehouses, selected, x.id)); }}>{x.name}</button>
            ))}
          </div>
          <a className="linkbtn" href="#items/warehouses">Move stock</a>
        </div>
      )}
    </aside>
  );
}
