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
import { discardDrafts, publishDrafts, recipesViewed, saveDraft, useFlowData } from '../../services/inventoryStore.ts';
import { CommandPalette } from '../CommandPalette.tsx';
import { useMenu } from '../menuStore.ts';
import { OwnerNav } from '../OwnerNav.tsx';
import { useOwner } from '../RecipeLines.tsx';
import { FlowPanel, type PanelActions, type Selection } from './FlowPanel.tsx';
import { EDGE_TYPES, NODE_TYPES, type VfEdge, type VfNode } from './FlowParts.tsx';
import './visualFlow.css';

/**
 * Visual Flow (sidebar › Things). Serves the owner, who knows his kitchen by heart but has never
 * seen it drawn: what he needs next is to see how one dish is made and where its money goes, and
 * to change it where he sees it. One item in focus at a time (a dish, an extra, or a batch), drawn
 * from his recipes as they stand: what is bought on the left, flowing through what his kitchen
 * makes, into the dish on the right. Three views of the same drawing: Material (how much),
 * Cost (what it costs, lines as thick as the money) and Financial (what it earns).
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

const VIEWS: { id: FlowView; label: string }[] = [
  { id: 'material', label: 'Material' },
  { id: 'cost', label: 'Cost' },
  { id: 'financial', label: 'Financial' },
];
const DEFAULT_FOCUS = 'recipe:margherita:L';
const TOAST_MS = 6000;

interface Toast { id: number; text: string; undo?: () => void }

/** #flow/<focus>: a dish's flow can be linked to (and survives a reload). */
const focusFromHash = () => (location.hash.startsWith('#flow/') ? decodeURIComponent(location.hash.slice('#flow/'.length)) : null);

function Studio({ owner }: { owner: Actor }) {
  useMenu();
  const menu = menuItems();
  const { ctx: published, drafts, events } = useFlowData();
  // What the canvas shows: his recipes with his drafts on top.
  const answers = useMemo(() => withDrafts(published.answers, drafts), [published.answers, drafts]);
  const ctx = useMemo(() => ({ items: published.items, answers }), [published.items, answers]);
  const options = useMemo(() => focusOptions(menu, answers), [menu, answers]);
  const [focus, setFocusState] = useState(() => focusFromHash() ?? DEFAULT_FOCUS);
  const [view, setView] = useState<FlowView>('material');
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
    () => viewOf(buildFlow({ focus: current, ctx, menu, sold, collapsed, drafts }), view),
    [current, ctx, menu, sold, collapsed, drafts, view],
  );
  const positions = useMemo(() => layout(graph), [graph]);
  const plan = useMemo(() => publishPlan(published.answers, drafts), [published.answers, drafts]);
  const blocked = plan.find((s) => s.problem);

  const say = useCallback((text: string, undo?: () => void) => setToast({ id: Date.now(), text, undo }), []);
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
    select: setSel,
    toggle: (id) => setCollapsed((c) => { const n = new Set(c); if (n.has(id)) n.delete(id); else n.add(id); return n; }),
  }), [draft, answers, drafts, owner, say]);

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
    },
  })), [graph.nodes, moved, positions, sizes, sel, view, current, focusName, actions.toggle]);
  const edges: VfEdge[] = useMemo(() => graph.edges.map((e) => ({
    id: e.id, source: e.source, target: e.target, type: 'vf', selected: sel?.kind === 'edge' && sel.id === e.id,
    deletable: e.kind !== 'money',
    data: { edge: e, view, total: graph.breakdown.total, onSelect: (id: string) => setSel({ kind: 'edge', id }) },
  })), [graph.edges, graph.breakdown.total, sel, view]);

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

  // Keys: 1 2 3 the views, F fits, Esc lets go, Ctrl+Z undoes, Ctrl+P publishes.
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
          {graph.nodes.length <= 1 && (
            <p className="vf-empty">No recipe yet. Choose it on the right: add an ingredient, or drag one in.</p>
          )}
        </div>
        <FlowPanel
          graph={graph} view={view} sel={sel} ctx={ctx} menu={menu} events={events} drafts={drafts} plan={plan}
          focusName={focusName} actions={actions}
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
        </div>
      )}
    </main>
  );
}
