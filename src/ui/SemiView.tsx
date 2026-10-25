import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { Actor } from '../domain/auth.ts';
import { batchEdit, batchQuestion, checkAnswer, kitchenLine, linesCost, makesLoop, ownPrepOf, prepQuestion, waitingOn, type Answer, type CostContext } from '../domain/costing.ts';
import type { BookLine } from '../domain/recipeBook.ts';
import { menuItems } from '../domain/menu.ts';
import { fmt } from '../domain/money.ts';
import { daysAgo } from '../domain/itemStory.ts';
import { batchShare, madeFrom, prepAmount, prepKey, prepStatus, type PrepStatus } from '../domain/prep.ts';
import { answerQuestion, cartShortages, sendPlan, setMakeBelow, useCostContext, useInventory, usePreps, usePurchases, useStock, type PrepRow } from '../services/inventoryStore.ts';
import { andList, planNotice } from '../domain/production.ts';
import { ReleaseNotices } from './ProductionNotices.tsx';
import { currentCashier } from '../services/auth.ts';
import { useMenu } from './menuStore.ts';
import { ItemsTabs } from './ItemsTabs.tsx';
import { OwnerNav } from './OwnerNav.tsx';
import { NumberInput } from './NumberInput.tsx';
import { useOwner } from './RecipeLines.tsx';
import { amountText, entriesOf, INSIDE_ITSELF, lineName, PrepEditor, type BatchAnswer, type PrepAnswer } from './RecipesView.tsx';
import { Chain, LinesInPlace } from './ChainEditor.tsx';

/**
 * Items › Semi-processed: what the kitchen makes for the dishes (dough, sauces, the cheese blend),
 * laid out like Raw materials (SCRUM-136): one row per item with what is on hand, Low and Out
 * the same way, a tap opens its sheet. Everyone who sees Items sees them, with no PIN; the owner
 * adds and changes what goes in them (the server checks it is the owner). Running low, an item
 * is sent to the kitchen ("Send to kitchen", like "+ Cart" for raw items): a PREP ticket the cook
 * Starts and marks Done. Done is the batch made: from its first batch on the item has a stock of
 * its own, the batch takes its raw items and a sale takes the item.
 */
const STATUS_LABELS: Record<PrepStatus, string> = {
  out: 'Out',
  low: 'Make more',
  ok: 'In stock',
  unknown: 'Not made yet',
};

/** The last change, with its Undo; cart: puts what production waits for into the suppliers' carts. */
type Done = { message: string; undo: () => void; cart?: () => Done };

/**
 * Sends `qty` of an item to the kitchen with what it is made from (production.ts): what is missing
 * goes first, the item follows by itself. One hook for the list and the sheet.
 */
const useSendToKitchen = () => {
  const { plan } = useStock();
  const { items, suppliers } = useInventory();
  const purchases = usePurchases();
  return (p: Pick<PrepRow, 'key' | 'unit'>, qty: number): Done | string => {
    const made = plan(p.key, qty, p.unit);
    if (made.problem) return made.problem;
    const undo = sendPlan(made);
    const buy = made.buy;
    const done: Done = { message: planNotice(made, prepAmount), undo };
    if (buy.size) {
      done.cart = () => {
        const added = cartShortages(buy, items, purchases, new Set(suppliers.map((x) => x.id)));
        const names = [...buy.keys()].map((id) => items.find((i) => i.id === id)?.name ?? id);
        return { message: added.suppliers.length ? `${andList(names)}: added to the cart. The batch goes to the kitchen once it is received.` : `${andList(names)}: no active supplier to order from.`, undo: added.undo };
      };
    }
    return done;
  };
};

/** What uses an item: the semi-processed items made from it, and how many dish recipes. */
type Uses = { dishes: number; semis: PrepRow[] };

/** "In 10inch Dough Ball and 12inch Dough Ball", "In 4 recipes", "In no recipe yet". */
const usesText = ({ dishes, semis }: Uses) => {
  const parts = [
    ...(semis.length === 0 ? [] : semis.length <= 2 ? [semis.map((p) => p.name).join(' and ')] : [`${semis.length} semi-processed items`]),
    ...(dishes ? [`${dishes} ${dishes === 1 ? 'recipe' : 'recipes'}`] : []),
  ];
  return parts.length ? `In ${parts.join(' and ')}` : 'In no recipe yet';
};

export function SemiView({ onRegister }: { onRegister?: () => void }) {
  useMenu();
  const ctx = useCostContext();
  const preps = usePreps();
  const entries = useMemo(() => entriesOf(menuItems(), ctx), [ctx]);
  const owner = useOwner();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'low' | 'out'>('all');
  /** The item whose sheet is open; '' : a new one being written. */
  const [open, setOpen] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const [error, setError] = useState('');
  const send = useSendToKitchen();
  const now = Date.now();

  // Used by a dish (by its key, or by the name his sheet uses for it), and by the items made from it.
  const usesOf = (p: PrepRow): Uses => ({
    dishes: entries.filter((e) => e.recipe?.lines.some((l) => l.name === p.key || l.name === p.name)).length,
    semis: madeFrom(p.key, preps, ctx.answers) as PrepRow[],
  });
  const FILTERS = [['all', 'All'], ['low', 'Low'], ['out', 'Out']] as const;
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return preps.filter((p) => {
      const status = prepStatus(p);
      if (filter === 'low' && status !== 'low') return false;
      if (filter === 'out' && status !== 'out') return false;
      return !q || [p.name, ...p.lines.map((l) => lineName(l.name, ctx))].some((t) => t.toLowerCase().includes(q));
    });
  }, [preps, query, filter, ctx]);
  const item = open ? preps.find((p) => p.key === open) ?? null : null;

  const toKitchen = (p: PrepRow) => {
    const result = send(p, p.makes!.qty);
    if (typeof result === 'string') { setError(result); setDone(null); return; }
    setError('');
    setDone(result);
  };

  return (
    <div className="inv-page">
      <OwnerNav current="items" onRegister={onRegister} />
      <div className="inv-page__head">
        <h1 className="supplier-heading">Items</h1>
        <div className="inv-page__actions">
          {owner && <button type="button" className="inv-page__secondary" onClick={() => { setOpen(''); setDone(null); }}>+ New semi-processed item</button>}
        </div>
      </div>

      <ItemsTabs current="semi" />

      <ReleaseNotices />
      {error && <div className="inv-notice inv-notice--error" role="alert">{error}</div>}
      {done && (
        <div className="inv-notice" role="status">
          {done.message}
          <button type="button" onClick={() => { done.undo(); setDone(null); }}>Undo</button>
          {done.cart && <button type="button" onClick={() => setDone(done.cart!())}>Add to cart</button>}
        </div>
      )}

      <label className="inv-search">
        <span className="sr-only">Search semi-processed items</span>
        <input
          className="inv-modal__input" type="search" value={query} placeholder="Search item or what goes in it"
          name="semi-search" autoComplete="off" spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') setQuery(''); }}
        />
      </label>
      <div className="chips chips--tight inv-filters" role="group" aria-label="Show">
        {FILTERS.map(([id, label]) => (
          <button key={id} type="button" className="chip" aria-pressed={filter === id} onClick={() => setFilter(id)}>{label}</button>
        ))}
      </div>

      <main className="inv-rows" aria-label="Semi-processed">
        {shown.length === 0 && <p className="inv-empty">{query.trim() ? `Nothing matches “${query.trim()}”.` : 'Nothing here. Everything is fine, or choose All.'}</p>}
        {shown.map((p) => {
          const status = prepStatus(p);
          const cost = linesCost(p.lines, ctx);
          const uses = usesOf(p);
          return (
            <article key={p.key} className="inv-row"
              onClick={(e) => { if (!(e.target as HTMLElement).closest('button, a')) setOpen(p.key); }}>
              <div className="inv-row__main">
                <h2 className="inv-row__name">
                  <button type="button" className="inv-row__open" onClick={() => setOpen(p.key)}>{p.name}</button>
                </h2>
                <div className="inv-row__sub">
                  <span>{usesText(uses)}</span>
                  <span className="inv-row__counted"> · {p.lastMadeAt === null ? 'never made' : `made ${daysAgo(p.lastMadeAt, now)}`}</span>
                </div>
              </div>
              <div className="inv-row__quantity" aria-label="On hand and batch size">
                <span className={`inv-row__status inv-row__status--${status}`}>{STATUS_LABELS[status]}</span>
                {p.tracked && <strong>{prepAmount(p.onHand, p.unit)}</strong>}
                {p.reserved > 0 && <span className="inv-row__lasts">{prepAmount(p.reserved, p.unit)} held for the kitchen</span>}
                <span className="inv-row__lasts">
                  {p.makes ? `${prepAmount(p.makes.qty, p.makes.unit)} a batch` : 'Batch size not known yet'}
                  {cost.complete ? ` · Rs ${fmt(cost.cents)}` : ''}
                </span>
              </div>
              <div className="inv-row__actions">
                {p.inKitchen > 0 && <span className="inv-row__onorder">In the kitchen · {prepAmount(p.inKitchen, p.unit)}</span>}
                {p.waiting > 0 && <span className="inv-row__onorder inv-row__onorder--wait">Waiting for {andList(p.waitingFor)} · {prepAmount(p.waiting, p.unit)}</span>}
                {p.inKitchen === 0 && p.waiting === 0 && (status === 'low' || status === 'out') && p.makes && (
                  <button type="button" className="inv-row__cart inv-row__cart--add" aria-label={`Send ${p.name} to the kitchen`} onClick={() => toKitchen(p)}>Send to kitchen</button>
                )}
              </div>
            </article>
          );
        })}
      </main>

      {open !== null && (open === '' || item) && (
        <PrepSheet
          key={open} item={item} items={preps} ctx={ctx} owner={owner} uses={item ? usesOf(item) : { dishes: 0, semis: [] }}
          onClose={() => setOpen(null)} onOpen={setOpen}
          onDone={(d, close) => { setDone(d); if (close) setOpen(null); }}
          onSaved={(question, answer, name, created) => {
            const undo = answerQuestion(question, answer, ctx.answers.get(question) ?? null, owner ?? undefined);
            setDone({ message: answer.kind === 'prep' && created ? `${name}: saved. Your recipes can use it now.` : `${name}: saved.`, undo });
            // A new item opens on its own sheet; an edited one stays open.
            setOpen(answer.kind === 'prep' ? kitchenLine(question.slice('prep:'.length)) : open);
          }}
        />
      )}
    </div>
  );
}

/**
 * One semi-processed item, like a raw item's sheet: what is on hand and how fast it goes, one
 * batch (what it makes, what goes in it, its cost), which dishes use it, and "Make more when
 * below". The owner changes what goes in it right here, each change saved with Undo
 * (SCRUM-146); a new item opens straight into writing it.
 */
function PrepSheet({ item, items, ctx, owner, uses, onClose, onOpen, onDone, onSaved }: {
  item: PrepRow | null; items: readonly PrepRow[]; ctx: CostContext; owner: Actor | null; uses: Uses;
  onClose: () => void;
  /** Opens another semi-processed item's sheet: the one a line is made from, or one made from this. */
  onOpen: (key: string) => void;
  onDone: (done: Done, close?: boolean) => void;
  onSaved: (question: string, answer: PrepAnswer | BatchAnswer, name: string, created: boolean) => void;
}) {
  const [editing, setEditing] = useState(item === null);
  /** The last change made here, with its Undo. */
  const [note, setNote] = useState<Done | null>(null);
  /** What one batch cost when the sheet opened, so a change shows what it moved. */
  const [openedCents] = useState(() => (item ? linesCost(item.lines, ctx).cents : 0));
  const canEdit = owner !== null;

  useEffect(() => {
    if (editing) return; // the editor's own Escape cancels it
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, editing]);

  const own = item?.own ? ownPrepOf(item.key, ctx.answers) : null;
  const edited = item && !item.own && batchEdit(item.key, ctx.answers) !== null;
  const cost = item ? linesCost(item.lines, ctx) : null;
  const now = Date.now();
  const title = item?.name ?? 'New semi-processed item';
  // His sheet's batch is saved as his version of it, which needs what one batch makes.
  const inPlace = canEdit && item !== null && (own !== null || item.makes !== null);

  const saveLines = (lines: BookLine[], what: string): string | null => {
    if (!item || !owner) return null;
    const question = own ? prepQuestion(own.id) : batchQuestion(item.key);
    const answer: Answer = own
      ? { kind: 'prep', name: own.name, makes: own.makes, lines }
      : { kind: 'batch', makes: item.makes!, lines };
    const wrong = checkAnswer(question, answer) ?? (makesLoop(question, answer, ctx.answers) ? INSIDE_ITSELF : null);
    if (wrong) return wrong;
    const undo = answerQuestion(question, answer, ctx.answers.get(question) ?? null, owner);
    setNote({ message: `${item.name}: ${what}.`, undo });
    return null;
  };

  return (
    <div className="inv-modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <section className={`inv-modal stock-sheet${editing ? ' semi-sheet--edit' : ''}`} role="dialog" aria-modal="true" aria-labelledby="semi-sheet-title">
        <button type="button" className="count__close" aria-label="Close" onClick={onClose}>×</button>
        <h2 id="semi-sheet-title">{title}</h2>
        {item && !editing && <Chain item={item} items={items} answers={ctx.answers} onOpen={onOpen} />}

        {editing ? (
          <PrepEditor item={own} sheet={item && !item.own ? item.key : undefined} ctx={ctx}
            onCancel={() => (item ? setEditing(false) : onClose())}
            onSave={(question, answer, name) => { onSaved(question, answer, name, item === null); setEditing(false); }} />
        ) : item && cost && (
          <>
            <dl className="story" aria-label={`About ${item.name}`}>
              <div>
                <dt>On hand</dt>
                <dd>
                  {item.tracked
                    ? <><strong className="num">{prepAmount(item.onHand, item.unit)}</strong>
                      {item.usedPerDay > 0 && <span>uses about {prepAmount(item.usedPerDay, item.unit)} a day</span>}
                      {item.lastMadeAt !== null && <span>last made {daysAgo(item.lastMadeAt, now)}</span>}</>
                    : 'Not made yet: send it to the kitchen; once its first batch is Done, sales take from it'}
                </dd>
              </div>
              <div>
                <dt>One batch</dt>
                <dd>
                  <span className="num">{item.makes ? `Makes ${prepAmount(item.makes.qty, item.makes.unit)}` : 'Batch size not known yet'}</span>
                  <span>{cost.complete ? `costs Rs ${fmt(cost.cents)}` : waitingOn(cost.missing, menuItems(), 2)}</span>
                  {cost.complete && cost.cents !== openedCents && (
                    <span className="semi-sheet__was">was Rs {fmt(openedCents)}{uses.dishes > 0 ? ` · ${uses.dishes} ${uses.dishes === 1 ? 'recipe moves' : 'recipes move'} with it` : ''}</span>
                  )}
                </dd>
              </div>
              <div className={inPlace ? 'story__wide' : undefined}>
                <dt>What goes in</dt>
                <dd>
                  {inPlace ? (
                    <LinesInPlace item={item} items={items} ctx={ctx} onOpen={onOpen} onSave={saveLines} />
                  ) : (
                  <ul className="rcard__lines semi-sheet__lines">
                    {item.lines.map((l, i) => {
                      const key = prepKey(l.name, ctx.answers);
                      return (
                        <li key={i}>
                          {key
                            ? <button type="button" className="linkbtn" aria-label={`Open ${lineName(l.name, ctx)}`} onClick={() => onOpen(key)}>{lineName(l.name, ctx)}</button>
                            : <span>{lineName(l.name, ctx)}</span>}
                          <span className="num">{batchShare(l, ctx.answers) ?? amountText(l)}</span>
                        </li>
                      );
                    })}
                  </ul>
                  )}
                </dd>
              </div>
              <div>
                <dt>Used in</dt>
                <dd>
                  {uses.semis.length === 0 && uses.dishes === 0 && 'No recipe uses it yet'}
                  {uses.semis.map((p) => (
                    <button key={p.key} type="button" className="linkbtn" aria-label={`Open ${p.name}`} onClick={() => onOpen(p.key)}>{p.name}</button>
                  ))}
                  {uses.dishes > 0 && <span>{uses.dishes} {uses.dishes === 1 ? 'recipe' : 'recipes'}</span>}
                </dd>
              </div>
              <div>
                <dt>From</dt>
                <dd>{item.own ? 'Added here' : edited ? 'Changed here, from your sheet' : 'From your sheet'}</dd>
              </div>
            </dl>

            {note && (
              <div className="inv-notice semi-sheet__note" role="status">
                {note.message}
                <button type="button" onClick={() => { note.undo(); setNote(null); }}>Undo</button>
              </div>
            )}

            <SendToKitchen item={item} onDone={(d) => onDone(d)} />
            {item.reserved > 0 && <p className="inv-modal__note">{prepAmount(item.reserved, item.unit)} of it is held for batches in the kitchen: {prepAmount(item.onHand - item.reserved, item.unit)} free.</p>}
            {item.waiting > 0 && <p className="inv-modal__note">{prepAmount(item.waiting, item.unit)} waiting for {andList(item.waitingFor)}: it goes to the kitchen by itself once that is ready.</p>}

            <MakeBelow item={item} onDone={(d) => onDone(d)} />

            {canEdit && (
              <div className="rcard__actions">
                <button type="button" className="chip" onClick={() => setEditing(true)}>{own ? 'Change name or batch size' : 'Change batch size'}</button>
                {own && uses.dishes === 0 && uses.semis.length === 0 && (
                  <button type="button" className="linkbtn" onClick={() => {
                    const question = prepQuestion(own.id);
                    const undo = answerQuestion(question, null, ctx.answers.get(question) ?? null);
                    onDone({ message: `${item.name}: deleted.`, undo }, true);
                  }}>Delete</button>
                )}
                {edited && (
                  <button type="button" className="linkbtn" onClick={() => {
                    const question = batchQuestion(item.key);
                    const undo = answerQuestion(question, null, ctx.answers.get(question) ?? null);
                    onDone({ message: `${item.name}: back to your sheet.`, undo });
                  }}>Use your sheet's batch</button>
                )}
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}

/**
 * Sends the item to the kitchen as a PREP ticket: a number of batches (what one batch makes, the
 * owner's recipe), or, where he has not said what a batch makes, the amount to make. With Undo.
 */
function SendToKitchen({ item, onDone }: { item: PrepRow; onDone: (done: Done) => void }) {
  const [typed, setTyped] = useState(item.makes ? '1' : '');
  const [error, setError] = useState('');
  const send = useSendToKitchen();
  const n = Number(typed);
  const qty = item.makes ? n * item.makes.qty : n;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!(n > 0)) return setError(item.makes ? 'Type how many batches, more than 0.' : `Type how much to make, in ${item.unit}.`);
    const result = send(item, qty);
    if (typeof result === 'string') return setError(result);
    onDone(result);
  };

  return (
    <form className="semi-send" onSubmit={submit} aria-label={`Send ${item.name} to the kitchen`}>
      {item.inKitchen > 0 && <p className="inv-modal__note">In the kitchen now: {prepAmount(item.inKitchen, item.unit)}.</p>}
      <label className="inv-modal__field">
        <span>{item.makes ? 'Batches to make' : 'How much to make'}{item.makes && n > 0 ? <small> · {prepAmount(qty, item.unit)}</small> : null}</span>
        <NumberInput className="inv-modal__input" unit={item.makes ? (n === 1 ? 'batch' : 'batches') : item.unit}
          decimals={item.makes ? 1 : item.unit === 'pcs' ? 0 : 1} value={typed} onText={(text) => { setTyped(text); setError(''); }} />
      </label>
      <button type="submit" className="insight__action">Send to kitchen</button>
      {error && <p className="inv-modal__error" role="alert">{error}</p>}
    </form>
  );
}

/**
 * "Make more when below" (SCRUM-136), like "Order when below": Automatic (less than a day's
 * usual use) or an amount, two buttons, never an empty box that means automatic (SCRUM-137).
 * Managers and the owner (the Items screen is theirs); audited, with Undo.
 */
function MakeBelow({ item, onDone }: { item: PrepRow; onDone: (done: Done) => void }) {
  const [edit, setEdit] = useState(false);
  const [mode, setMode] = useState<'auto' | 'number'>(item.makeBelow === null ? 'auto' : 'number');
  const [typed, setTyped] = useState(item.makeBelow === null ? '' : String(item.makeBelow));
  const [error, setError] = useState('');
  const current = item.makeBelow;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const after = mode === 'auto' ? null : Number(typed);
    if (after !== null && !(after > 0)) return setError(`Type an amount in ${item.unit}, more than 0, or choose Automatic.`);
    setEdit(false);
    if (after === current) return;
    const actor = currentCashier();
    const undo = setMakeBelow(item.key, current, after, actor);
    onDone({ message: after === null ? `${item.name}: make more automatically again.` : `${item.name}: make more when below ${prepAmount(after, item.unit)}.`, undo });
  };

  return (
    <div className="receive-unit">
      {!edit && (
        <>
          <span>Make more when below <b>{current === null ? 'automatic' : prepAmount(current, item.unit)}</b>{current === null && <small> · less than a day's usual use</small>}</span>
          <button type="button" className="linkbtn" aria-label="Change make more when below" onClick={() => setEdit(true)}>Change</button>
        </>
      )}
      {edit && (
        <form className="order-below" onSubmit={submit}>
          <div className="chips" role="group" aria-label="When to make more">
            <button type="button" className="chip" aria-pressed={mode === 'auto'} onClick={() => { setMode('auto'); setError(''); }}>Automatic</button>
            <button type="button" className="chip" aria-pressed={mode === 'number'} onClick={() => { setMode('number'); setError(''); }}>Set a number</button>
          </div>
          {mode === 'auto'
            ? <p className="inv-modal__note">The kitchen is told to make more when less than a day's usual use is left.</p>
            : (
              <label className="inv-modal__field">
                <span>Make more when below</span>
                <NumberInput className="inv-modal__input" unit={item.unit} autoFocus value={typed}
                  onText={(text) => { setTyped(text); setError(''); }} />
              </label>
            )}
          <button type="submit" className="insight__action">Save</button>
          {error && <p className="inv-modal__error" role="alert">{error}</p>}
        </form>
      )}
    </div>
  );
}
