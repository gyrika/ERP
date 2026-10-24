import {
  addonOf, addonQuestion, batchMakes, batchQuestion, checkPrepName, exactLineCost, grossQty, KITCHEN_LINE, kitchenLine, makesLoop,
  newPrepId, ownPrepOf, prepOf, prepQuestion, RATES_QUESTION, recipeOf, recipeQuestion, recipeUnit, resourcesQuestion, sizesOf,
  sourceOf, STOCK_LINE, type Answer, type CostContext,
} from './costing.ts';
import type { Draft } from './recipeDrafts.ts';
import { PREPS, PRODUCTS, type BookLine } from './recipeBook.ts';
import { FREE_INGREDIENTS } from './recipeMap.ts';
import { prepItems, prepKey } from './prep.ts';
import { RESOURCE_LABEL, RESOURCE_UNIT, resourceCost, type Rates, type ResourceKind, type ResourceLine } from './resources.ts';
import type { Cents, MenuItem } from './types.ts';

/**
 * Visual Flow: how one finished item is made, as a graph the owner can read and change. Raw
 * items flow through his semi-processed items (culture → dough batch → dough ball) into the
 * dish; his resources (electricity, labour, equipment, other costs) flow into the stage that
 * uses them. Pure, like costing.ts: his answers in, nodes and edges out, every amount per ONE
 * of the item in focus. Costs are his food costs (costing.ts, the same numbers as the Recipes
 * screen) plus the resources; nothing is estimated, a gap stays a gap.
 *
 * Node ids: `recipe:<item>:<size>` and `addon:<extra>` (a dish or extra, by its recipe question),
 * `semi:<key>` (a batch, prep.ts keys), `product:<name>` (a recipe of his sheet used inside
 * another), `stock:<inventory id>` (a price-list item), `ingredient:<name>` (one of his
 * ingredients not on the price list yet), `free:<name>` (water), `res:<kind>`, and in the
 * Financial view `revenue` and `profit`.
 */
export type FlowView = 'material' | 'cost' | 'financial';
export type NodeKind = 'raw' | 'semi' | 'finished' | 'resource' | 'revenue' | 'profit';

export interface FlowNode {
  id: string;
  kind: NodeKind;
  name: string;
  /** Column: 0 for what is bought, one more than its deepest input for what is made. */
  level: number;
  /** How much one focus item takes of it, in `unit` (base units for a price-list item). */
  qty: number;
  unit: string;
  /** What it adds to one focus item, unrounded cents (materials and the resources below it). */
  cents: number;
  /** Its share of the focus item's whole cost (0..1). */
  share: number;
  /** The questions that would complete its cost. */
  missing: string[];
  /** A recipe of his (a dish, an extra, a batch): where it is saved and whether it can change here. */
  recipe: { question: string; editable: boolean; makes: { qty: number; unit: string } | null; draft: boolean } | null;
  /** Edges into it, before any collapsing. */
  inputs: number;
  collapsed: boolean;
}

export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  kind: 'line' | 'resource' | 'money';
  /** Which line of the target's recipe (or resource line) this is. */
  index: number;
  line: BookLine | null;
  resource: ResourceLine | null;
  /** Per focus item, in `unit`. */
  qty: number;
  unit: string;
  cents: number;
  /** Something below it has no price or no batch size yet. */
  partial: boolean;
}

export interface Breakdown { materials: number; electricity: number; labour: number; overhead: number; total: number }

export interface FlowGraph {
  focus: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  breakdown: Breakdown;
  /** Every gap, his recipes' and the rates'. */
  missing: string[];
  complete: boolean;
  /** A dish or extra: its menu price; null for a batch. */
  priceCents: Cents | null;
  /** Sold over the last SALES_DAYS (dishes only). */
  sold: number;
}

export const SALES_DAYS = 28;
const MAX_DEPTH = 8; // as in costing.ts

export interface FlowInput {
  focus: string;
  ctx: CostContext;
  menu: readonly MenuItem[];
  /** Units sold over the last SALES_DAYS, for the Financial view (soldUnits). */
  sold?: number;
  collapsed?: ReadonlySet<string>;
  /** The questions with an open draft, to mark their recipes. */
  drafts?: ReadonlyMap<string, Draft>;
}

// ----- what a node is -----

/** The node a recipe line names. */
export const lineNode = (name: string, answers: ReadonlyMap<string, Answer>): string => {
  if (FREE_INGREDIENTS.has(name)) return `free:${name}`;
  const key = prepKey(name, answers);
  if (key) return `semi:${key}`;
  if (PRODUCTS[name]) return `product:${name}`;
  const source = sourceOf(name, answers);
  if (source) return `stock:${source.inventoryId}`;
  return `ingredient:${name}`;
};

const after = (id: string) => id.slice(id.indexOf(':') + 1);

export interface Holder {
  /** Where its recipe is saved: a recipe, addon, batch or prep question. */
  question: string;
  /** Its key for resourcesQuestion. */
  key: string;
  name: string;
  lines: readonly BookLine[];
  /** One batch's output; a dish makes one. Null: not known yet. */
  makes: { qty: number; unit: string } | null;
  editable: boolean;
}

const sizeLabel = (item: MenuItem, size: string) => item.variants?.find((v) => v.id === size)?.label ?? '';

/** A recipe node's recipe: a dish, an extra, a batch, or a sheet product (which only reads). */
export const holderOf = (id: string, answers: ReadonlyMap<string, Answer>, menu: readonly MenuItem[]): Holder | null => {
  if (id.startsWith('recipe:')) {
    const [itemId, size] = after(id).split(':');
    const item = menu.find((m) => m.id === itemId);
    const label = item ? sizeLabel(item, size) : '';
    return {
      question: id, key: id, name: `${item?.name.en ?? itemId}${label ? ` ${label}` : ''}`,
      lines: recipeOf(itemId, size, answers)?.lines ?? [], makes: { qty: 1, unit: 'pcs' }, editable: true,
    };
  }
  if (id.startsWith('addon:')) {
    const extraId = after(id);
    const extra = menu.flatMap((m) => m.adds).find((a) => a.id === extraId);
    return {
      question: id, key: id, name: `Extra ${(extra?.label ?? extraId).toLowerCase()}`,
      lines: addonOf(extraId, answers)?.lines ?? [], makes: { qty: 1, unit: 'pcs' }, editable: true,
    };
  }
  if (id.startsWith('semi:')) {
    const key = after(id);
    const prep = prepOf(key, answers);
    if (!prep) return null;
    const own = key.startsWith(KITCHEN_LINE) ? ownPrepOf(key, answers) : null;
    const unit = own?.makes.unit ?? recipeUnit(key) ?? prep.makes?.unit ?? 'pcs';
    return {
      question: own ? prepQuestion(own.id) : batchQuestion(key), key, name: own?.name ?? key,
      lines: prep.lines, makes: batchMakes(key, unit, answers), editable: true,
    };
  }
  if (id.startsWith('product:')) {
    const name = after(id);
    return PRODUCTS[name] ? { question: '', key: '', name, lines: PRODUCTS[name], makes: { qty: 1, unit: 'pcs' }, editable: false } : null;
  }
  return null;
};

const rawName = (id: string, ctx: CostContext): string => {
  if (id.startsWith('stock:')) return ctx.items.find((i) => i.id === after(id))?.name ?? 'An item no longer in stock';
  return after(id);
};

const rawUnit = (id: string, line: BookLine, ctx: CostContext): string =>
  id.startsWith('stock:') ? ctx.items.find((i) => i.id === after(id))?.baseUnit ?? line.unit : line.unit;

export const ratesOf = (answers: ReadonlyMap<string, Answer>): Rates | null => {
  const a = answers.get(RATES_QUESTION);
  return a?.kind === 'rates' ? a.rates : null;
};

export const resourcesOf = (key: string, answers: ReadonlyMap<string, Answer>): ResourceLine[] => {
  const a = answers.get(resourcesQuestion(key));
  return a?.kind === 'resources' ? a.lines : [];
};

// ----- the graph -----

/** Sold units of a dish (whole items; a half and half counts half to each), over the last SALES_DAYS. */
export const soldUnits = (events: readonly { type: string }[], focus: string, now: number): number => {
  if (!focus.startsWith('recipe:')) return 0;
  const [itemId, size] = after(focus).split(':');
  const since = now - SALES_DAYS * 86_400_000;
  const tickets = new Map<string, number>();
  let n = 0;
  type Line = { itemId: string; size?: string; qty: number; half?: string };
  const count = (l: Line) => ((l.size ?? '') !== size ? 0 : (l.itemId === itemId ? (l.half ? 0.5 : 1) : 0) + (l.half === itemId ? 0.5 : 0)) * l.qty;
  for (const e of events as ({ type: string; at: number; ticketId?: string; lines?: Line[]; before?: Line })[]) {
    if (e.at < since) continue;
    if (e.type === 'order.sent' && e.lines) {
      const k = e.lines.reduce((s, l) => s + count(l), 0);
      tickets.set(e.ticketId ?? '', k);
      n += k;
    } else if (e.type === 'order.send_undone') n -= tickets.get(e.ticketId ?? '') ?? 0;
    else if (e.type === 'order.item_cancelled' && e.before) n -= count(e.before);
  }
  return Math.max(0, n);
};

const priceOf = (focus: string, menu: readonly MenuItem[]): Cents | null => {
  if (focus.startsWith('recipe:')) {
    const [itemId, size] = after(focus).split(':');
    const item = menu.find((m) => m.id === itemId);
    if (!item) return null;
    return item.variants?.find((v) => v.id === size)?.price ?? item.price ?? null;
  }
  if (focus.startsWith('addon:')) return menu.flatMap((m) => m.adds).find((a) => a.id === after(focus))?.price ?? null;
  return null;
};

export const buildFlow = ({ focus, ctx, menu, sold = 0, collapsed = new Set(), drafts = new Map() }: FlowInput): FlowGraph => {
  const { answers } = ctx;
  const rates = ratesOf(answers);
  const nodes = new Map<string, FlowNode>();
  const edges = new Map<string, FlowEdge>();
  const missing = new Set<string>();
  let unrated = false;

  const node = (id: string, kind: NodeKind, name: string, unit: string): FlowNode => {
    let n = nodes.get(id);
    if (!n) {
      n = { id, kind, name, level: 0, qty: 0, unit, cents: 0, share: 0, missing: [], recipe: null, inputs: 0, collapsed: collapsed.has(id) };
      nodes.set(id, n);
    }
    return n;
  };
  const edge = (e: Omit<FlowEdge, 'qty' | 'cents' | 'partial'>, qty: number, cents: number, partial: boolean) => {
    const was = edges.get(e.id);
    if (was) { was.qty += qty; was.cents += cents; was.partial ||= partial; return; }
    edges.set(e.id, { ...e, qty, cents, partial });
  };

  const holderNode = (id: string, h: Holder): FlowNode => {
    const kind: NodeKind = id === focus && !id.startsWith('semi:') ? 'finished' : id.startsWith('recipe:') || id.startsWith('addon:') ? 'finished' : 'semi';
    const n = node(id, kind, h.name, h.makes?.unit ?? 'pcs');
    n.recipe ??= {
      question: h.question, editable: h.editable, makes: h.makes,
      draft: drafts.has(h.question) || (h.key !== '' && drafts.has(resourcesQuestion(h.key))),
    };
    return n;
  };

  /**
   * One use of a recipe: `times` of its output per focus item. Returns the resources' cents
   * this use adds (its own and those below it), so each edge can carry its whole cost.
   */
  const visit = (id: string, h: Holder, times: number, depth: number): number => {
    if (depth > MAX_DEPTH) return 0;
    const self = holderNode(id, h);
    // A batch's lines are per batch: `times` of output is times / makes batches.
    const batches = id === focus ? 1 : h.makes && h.makes.qty > 0 ? times / h.makes.qty : 0;
    let resourcesBelow = 0;
    h.lines.forEach((line, i) => {
      const child = lineNode(line.name, answers);
      const used = grossQty(line) * (id === focus ? 1 : batches);
      const material = exactLineCost(line, ctx);
      material.missing.forEach((q) => missing.add(q));
      const childHolder = holderOf(child, answers, menu);
      let below = 0;
      let unit = line.unit;
      let qty = used;
      if (childHolder) {
        holderNode(child, childHolder);
        below = visit(child, childHolder, used, depth + 1);
      } else {
        const raw = node(child, 'raw', rawName(child, ctx), rawUnit(child, line, ctx));
        const per = child.startsWith('stock:') ? sourceOf(line.name, answers)?.per ?? 1 : 1;
        unit = raw.unit;
        qty = used * per;
        raw.qty += qty;
        raw.cents += material.cents * (id === focus ? 1 : batches);
        raw.missing = [...new Set([...raw.missing, ...material.missing])];
      }
      const cents = material.cents * (id === focus ? 1 : batches) + below;
      if (childHolder) {
        const c = nodes.get(child)!;
        c.qty += used; c.cents += cents; c.unit = line.unit;
        c.missing = [...new Set([...c.missing, ...material.missing])];
      }
      edge({ id: `${child}>${id}#${i}`, source: child, target: id, kind: 'line', index: i, line, resource: null, unit }, qty, cents, material.missing.length > 0);
      resourcesBelow += below;
    });
    // What making it takes besides ingredients, per batch (a dish: per dish).
    const own = h.key ? resourcesOf(h.key, answers) : [];
    const runs = id === focus ? 1 : batches;
    own.forEach((r, i) => {
      const { byKind, unrated: u } = resourceCost([r], rates);
      unrated ||= u;
      const cents = byKind[r.kind] * runs;
      const res = node(`res:${r.kind}`, 'resource', RESOURCE_LABEL[r.kind], RESOURCE_UNIT[r.kind]);
      const qty = (r.kind === 'other' ? r.cents / 100 : r.qty) * runs;
      res.qty += qty;
      res.cents += cents;
      edge({ id: `res:${r.kind}>${id}#${i}`, source: res.id, target: id, kind: 'resource', index: i, line: null, resource: r, unit: res.unit }, qty, cents, u);
      resourcesBelow += cents;
    });
    void self;
    return resourcesBelow;
  };

  const root = holderOf(focus, answers, menu);
  if (root) {
    visit(focus, root, 1, 0);
    if (!root.lines.length && focus.startsWith('recipe:')) missing.add(focus);
  }
  if (unrated) missing.add(RATES_QUESTION);

  // Totals, from what flows in.
  const all = [...nodes.values()];
  const kindCents = (k: ResourceKind) => nodes.get(`res:${k}`)?.cents ?? 0;
  const materials = all.filter((n) => n.kind === 'raw').reduce((s, n) => s + n.cents, 0);
  const breakdown: Breakdown = {
    materials, electricity: kindCents('electricity'), labour: kindCents('labour'), overhead: kindCents('equipment') + kindCents('other'), total: 0,
  };
  breakdown.total = breakdown.materials + breakdown.electricity + breakdown.labour + breakdown.overhead;
  const top = nodes.get(focus);
  if (top) { top.cents = breakdown.total; top.qty = 1; top.missing = [...missing]; }
  for (const n of all) n.share = breakdown.total > 0 ? Math.min(1, n.cents / breakdown.total) : 0;
  for (const e of edges.values()) nodes.get(e.target)!.inputs++;

  // Columns: what is bought on the left, each made thing right of its deepest input.
  const level = new Map<string, number>();
  const into = new Map<string, string[]>();
  for (const e of edges.values()) into.set(e.target, [...(into.get(e.target) ?? []), e.source]);
  const depthOf = (id: string, guard = 0): number => {
    if (level.has(id)) return level.get(id)!;
    const ins = into.get(id) ?? [];
    const l = ins.length && guard < 20 ? 1 + Math.max(...ins.map((s) => depthOf(s, guard + 1))) : nodes.get(id)?.recipe ? 1 : 0;
    level.set(id, l);
    return l;
  };
  for (const n of all) if (n.recipe) n.level = depthOf(n.id);
  // What is bought (and each resource) sits just left of the first stage that uses it: beside where
  // it goes, and no one column holding every raw item.
  const outsOf = new Map<string, string[]>();
  for (const e of edges.values()) outsOf.set(e.source, [...(outsOf.get(e.source) ?? []), e.target]);
  for (const n of all) {
    if (n.recipe) continue;
    const users = (outsOf.get(n.id) ?? []).map((t) => nodes.get(t)!.level);
    n.level = users.length ? Math.max(0, Math.min(...users) - 1) : 0;
  }

  // Collapsing a made thing hides what only flows through it.
  const shown = new Set<string>([focus]);
  const queue = [focus];
  while (queue.length) {
    const id = queue.shift()!;
    if (nodes.get(id)?.collapsed && id !== focus) continue;
    for (const s of into.get(id) ?? []) if (!shown.has(s)) { shown.add(s); queue.push(s); }
  }
  const priceCents = priceOf(focus, menu);
  const visibleNodes = all.filter((n) => shown.has(n.id));
  const visibleEdges = [...edges.values()].filter((e) => shown.has(e.source) && shown.has(e.target) && !(nodes.get(e.target)!.collapsed && e.target !== focus));

  return {
    focus, nodes: visibleNodes, edges: visibleEdges, breakdown, missing: [...missing], complete: missing.size === 0, priceCents, sold,
  };
};

// ----- the Financial view's two extra nodes -----

export interface Money { revenue: Cents; cost: Cents; profit: Cents; margin: number | null }

/** One item's money, rounded once to whole cents: price, its whole cost, what it earns. */
export const moneyOf = (g: FlowGraph): Money | null => {
  if (g.priceCents === null) return null;
  const cost = Math.round(g.breakdown.total);
  return { revenue: g.priceCents, cost, profit: g.priceCents - cost, margin: g.priceCents > 0 ? (g.priceCents - cost) / g.priceCents : null };
};

/** The graph for one view: the Financial view adds revenue and profit to the right of the item. */
export const viewOf = (g: FlowGraph, view: FlowView): FlowGraph => {
  const money = moneyOf(g);
  if (view !== 'financial' || !money) return g;
  const top = g.nodes.find((n) => n.id === g.focus);
  const lvl = (top?.level ?? 1) + 1;
  const extra: FlowNode[] = [
    { id: 'revenue', kind: 'revenue', name: 'Revenue', level: top?.level ?? 1, qty: g.sold, unit: 'sold', cents: money.revenue, share: 0, missing: [], recipe: null, inputs: 0, collapsed: false },
    { id: 'profit', kind: 'profit', name: 'Profit', level: lvl, qty: g.sold, unit: 'sold', cents: money.profit, share: 0, missing: g.missing, recipe: null, inputs: 2, collapsed: false },
  ];
  const money_ = (id: string, source: string, cents: number): FlowEdge =>
    ({ id, source, target: 'profit', kind: 'money', index: 0, line: null, resource: null, qty: 0, unit: 'Rs', cents, partial: id === 'cost>profit' && !g.complete });
  return { ...g, nodes: [...g.nodes, ...extra], edges: [...g.edges, money_('revenue>profit', 'revenue', money.revenue), money_('cost>profit', g.focus, -money.cost)] };
};

// ----- where things sit -----

export const COL_W = 300;
export const ROW_H = 96;

/**
 * Positions for the canvas: columns by level, and in each column the nodes in the order of
 * what they flow into (fewer crossing lines), centred on the item in focus.
 */
export const layout = (g: FlowGraph): Map<string, { x: number; y: number }> => {
  const pos = new Map<string, { x: number; y: number }>();
  const cols = new Map<number, FlowNode[]>();
  for (const n of g.nodes) cols.set(n.level, [...(cols.get(n.level) ?? []), n]);
  const outs = new Map<string, string[]>();
  for (const e of g.edges) outs.set(e.source, [...(outs.get(e.source) ?? []), e.target]);
  const levels = [...cols.keys()].sort((a, b) => b - a);
  for (const l of levels) {
    const col = cols.get(l)!;
    const centre = (n: FlowNode) => {
      const ys = (outs.get(n.id) ?? []).map((t) => pos.get(t)?.y).filter((y): y is number => y !== undefined);
      return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : 0;
    };
    // Revenue sits above the item; resources at the foot of the first column.
    const rank = (n: FlowNode) => (n.kind === 'revenue' ? -1e9 : n.kind === 'resource' ? 1e9 + n.name.charCodeAt(0) : centre(n));
    col.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
    const top = -((col.length - 1) * ROW_H) / 2;
    col.forEach((n, i) => pos.set(n.id, { x: l * COL_W, y: top + i * ROW_H }));
  }
  return pos;
};

// ----- choosing what to look at -----

export interface FocusOption { id: string; label: string; group: string }

/** Every dish and size, every extra, every batch: what the canvas can show. */
export const focusOptions = (menu: readonly MenuItem[], answers: ReadonlyMap<string, Answer>): FocusOption[] => {
  const out: FocusOption[] = [];
  const group: Record<string, string> = { pizza: 'Pizza', burger: 'Burgers', pasta: 'Pasta' };
  for (const item of menu) {
    if (item.hidden || item.removed) continue;
    for (const size of sizesOf(item)) {
      const label = sizeLabel(item, size);
      out.push({ id: recipeQuestion(item.id, size), label: `${item.name.en}${label ? ` ${label}` : ''}`, group: group[item.category] ?? item.category });
    }
  }
  const extras = new Map<string, string>();
  for (const item of menu) for (const a of item.adds) if (!extras.has(a.id)) extras.set(a.id, a.label);
  for (const [id, label] of extras) out.push({ id: addonQuestion(id), label: `Extra ${label.toLowerCase()}`, group: 'Extras' });
  for (const p of prepItems(answers)) out.push({ id: `semi:${p.key}`, label: p.name, group: 'Semi-processed' });
  return out;
};

// ----- changing a recipe on the canvas -----

/** The answer that saves a recipe with these lines (and this batch size, for a batch). */
export const answerWith = (h: Holder, lines: BookLine[], makes = h.makes, answers: ReadonlyMap<string, Answer> = new Map()): Answer => {
  if (h.question.startsWith('recipe:') || h.question.startsWith('addon:')) return { kind: 'own', lines };
  const out = makes ?? { qty: 0, unit: recipeUnit(h.key) ?? 'pcs' };
  if (h.question.startsWith('prep:')) {
    const own = ownPrepOf(h.key, answers);
    return { kind: 'prep', name: own?.name ?? h.name, makes: out, lines };
  }
  return { kind: 'batch', makes: out, lines };
};

/** The recipe line a node becomes when it is connected into a recipe, in the unit it is used in. */
export const lineFor = (sourceId: string, ctx: CostContext): BookLine | null => {
  if (sourceId.startsWith('stock:')) {
    const item = ctx.items.find((i) => i.id === after(sourceId));
    return item ? { name: `${STOCK_LINE}${item.id}`, qty: 1, unit: item.baseUnit } : null;
  }
  if (sourceId.startsWith('semi:')) {
    const key = after(sourceId);
    const own = key.startsWith(KITCHEN_LINE) ? ownPrepOf(key, ctx.answers) : null;
    const unit = own?.makes.unit ?? recipeUnit(key) ?? PREPS[key]?.makes?.unit ?? 'pcs';
    return { name: key, qty: unit === 'pcs' ? 1 : 100, unit };
  }
  if (sourceId.startsWith('free:') || sourceId.startsWith('ingredient:')) {
    const name = after(sourceId);
    return { name, qty: 1, unit: recipeUnit(name) ?? 'g' };
  }
  return null;
};

const madeOf = (name: string) => name.startsWith(STOCK_LINE) || name in PREPS || name.startsWith(KITCHEN_LINE);

/** Why this line cannot go into that recipe; null: it can. */
export const connectProblem = (h: Holder | null, line: BookLine | null, answers: ReadonlyMap<string, Answer>): string | null => {
  if (!h || !h.editable) return 'That recipe is from your sheet and can\'t change here.';
  if (!line) return 'That can\'t go into a recipe.';
  if (h.question.startsWith('batch:') && !madeOf(line.name) && !(PREPS[h.key]?.lines.some((l) => l.name === line.name))) {
    return 'Choose it from your stock or what your kitchen makes.';
  }
  if (h.question.startsWith('prep:') && !madeOf(line.name)) return 'Choose it from your stock or what your kitchen makes.';
  const trial = answerWith(h, [...h.lines, line], h.makes ?? { qty: 1, unit: recipeUnit(h.key) ?? 'pcs' }, answers);
  if (makesLoop(h.question, trial, answers)) return 'That is made from this one, so it can\'t go in it.';
  return null;
};

/**
 * A new stage of his own (a semi-processed item) inside a recipe: the item, with nothing in it
 * yet, and the recipe with one of it added. Two drafts; null when the name can't be used.
 */
export const newStage = (name: string, parent: Holder, answers: ReadonlyMap<string, Answer>): { drafts: [string, Answer][]; problem: null } | { drafts: null; problem: string } => {
  const problem = checkPrepName(name.trim());
  if (problem) return { drafts: null, problem };
  if (!parent.editable) return { drafts: null, problem: 'That recipe is from your sheet and can\'t change here.' };
  const id = newPrepId();
  const stage: Answer = { kind: 'prep', name: name.trim(), makes: { qty: 1, unit: 'pcs' }, lines: [] };
  const line: BookLine = { name: kitchenLine(id), qty: 1, unit: 'pcs' };
  return { drafts: [[prepQuestion(id), stage], [parent.question, answerWith(parent, [...parent.lines, line], parent.makes, answers)]], problem: null };
};
