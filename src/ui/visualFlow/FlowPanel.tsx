import { useState, type FormEvent, type KeyboardEvent } from 'react';
import { gapName, MAX_WASTE, RATES_QUESTION, UNITS, type Answer, type CostContext } from '../../domain/costing.ts';
import type { BookLine } from '../../domain/recipeBook.ts';
import { versionsOf, type Draft, type PublishStep } from '../../domain/recipeDrafts.ts';
import { RESOURCE_KINDS, RESOURCE_LABEL, RESOURCE_UNIT, type Rates, type ResourceKind, type ResourceLine } from '../../domain/resources.ts';
import type { MenuItem } from '../../domain/types.ts';
import { holderOf, lineNode, moneyOf, ratesOf, resourcesOf, SALES_DAYS, type FlowEdge, type FlowGraph, type FlowNode, type FlowView, type Holder } from '../../domain/visualFlow.ts';
import { NumberInput } from '../NumberInput.tsx';
import { lineName } from '../RecipesView.tsx';
import { amount, KIND_LABEL, pct, rs } from './FlowParts.tsx';

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
  const shown = node ?? (edge ? undefined : graph.nodes.find((n) => n.id === graph.focus));
  return (
    <aside className="vf-panel" aria-label="Details">
      {edge ? <EdgeDetails {...p} edge={edge} /> : shown ? <NodeDetails {...p} node={shown} /> : <p className="vf-muted">Choose something to make.</p>}
      {p.plan.length > 0 && <DraftList {...p} />}
    </aside>
  );
}

function Figures({ node: n, graph, view, focusName }: Props & { node: FlowNode }) {
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
      <dt>Each {focusName} takes</dt><dd className="num">{n.kind === 'resource' && n.unit === 'Rs' ? rs(n.qty * 100) : amount(n.qty, n.unit)}</dd>
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

function RecipeEditor({ h, node, ctx, actions }: Props & { h: Holder; node: FlowNode }) {
  const [stage, setStage] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const isBatch = !h.question.startsWith('recipe:') && !h.question.startsWith('addon:');
  const resources = resourcesOf(h.key, ctx.answers);
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
        <h3 className="vf-section__title">What goes in{isBatch ? ', per batch' : ''}</h3>
        {h.lines.length === 0 && <p className="vf-muted">Nothing yet. Drag a line from an item into it, or add one.</p>}
        <ul className="vf-lines">
          {h.lines.map((l, i) => (
            <li key={`${l.name}-${i}`} className="vf-line">
              <button type="button" className="vf-line__open" onClick={() => actions.select({ kind: 'edge', id: `${lineNode(l.name, ctx.answers)}>${node.id}#${i}` })}>
                <span className="vf-line__name">{lineName(l.name, ctx)}</span>
                <span className="vf-line__qty num">{amount(l.qty, l.unit)}{l.waste ? ` · ${pct(l.waste)} waste` : ''}</span>
              </button>
              <button type="button" className="vf-x" aria-label={`Take ${lineName(l.name, ctx)} out`}
                onClick={() => actions.setLines(h, h.lines.filter((_, j) => j !== i), `Took ${lineName(l.name, ctx)} out of ${h.name}`)}>×</button>
            </li>
          ))}
        </ul>
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
        <h3 className="vf-section__title">Also takes{isBatch ? ', per batch' : ''}</h3>
        <ul className="vf-lines">
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
      <dt>Each {p.focusName} takes</dt><dd className="num">{e.unit === 'Rs' ? rs(e.qty * 100) : amount(e.qty, e.unit)}</dd>
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

