import { useMemo, useState } from 'react';
import type { Actor } from '../domain/auth.ts';
import { fmt } from '../domain/money.ts';
import { prepAmount } from '../domain/prep.ts';
import { formatQuantity } from '../domain/quantity.ts';
import type { BaseUnit } from '../domain/inventoryData.ts';
import { activeWarehouses, checkWarehouseName, homeOf, type PlacedItem, type StockEntry, type Warehouses } from '../domain/warehouses.ts';
import { addWarehouse, editWarehouse, moveStock, setHome, setKitchenSide, useWarehouseStock } from '../services/inventoryStore.ts';
import { FlowSheet } from './flow/FlowSheet.tsx';
import { ItemsTabs } from './ItemsTabs.tsx';
import { NumberInput } from './NumberInput.tsx';
import { OwnerNav } from './OwnerNav.tsx';
import { OwnerPin } from './OwnerPin.tsx';

/**
 * Items › Warehouses (SCRUM-184): every raw and semi-processed item in the warehouse it is kept
 * in. Each warehouse lists what it holds and what it is worth; every item also shows in its home
 * when none is there, so each ingredient has its place. Tapping an item sets its home or moves
 * some of it (managers; one tap, Undo). Adding, renaming and archiving warehouses, and which one
 * is next to the kitchen, is the owner's (his PIN, then one Save).
 *
 * Sales take next to the kitchen first, then the item's home, then the rest (warehouses.ts), so
 * the counter never picks a warehouse.
 */
type Done = { message: string; undo: () => void };

export const amountOf = (e: Pick<StockEntry, 'kind' | 'unit'>, qty: number): string =>
  e.kind === 'raw' ? formatQuantity(qty, e.unit as BaseUnit) : prepAmount(qty, e.unit);

const amountText = (i: PlacedItem): string => {
  if (i.qty === null) return i.kind === 'raw' ? 'Not counted' : 'Not made yet';
  return i.qty > 0 ? amountOf(i, i.qty) : 'None here';
};

export function WarehousesView({ onRegister }: { onRegister?: () => void }) {
  const { warehouses, rows, entries, splitOf } = useWarehouseStock();
  const [only, setOnly] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [done, setDone] = useState<Done | null>(null);
  /** Warehouses showing the items kept there with none in them (folded away at first). */
  const [unfolded, setUnfolded] = useState<Set<string>>(() => new Set());
  const shown = only ? rows.filter((r) => r.id === only) : rows;
  const entry = entries.find((e) => e.key === open) ?? null;

  return (
    <div className="inv-page">
      <OwnerNav current="items" onRegister={onRegister} />
      <div className="inv-page__head">
        <h1 className="supplier-heading">Items</h1>
        <div className="inv-page__actions">
          <button type="button" className="inv-page__secondary" onClick={() => setEditing(true)}>Edit warehouses</button>
        </div>
      </div>
      <ItemsTabs current="warehouses" />
      {done && (
        <div className="inv-notice" role="status">
          {done.message}
          <button type="button" onClick={() => { done.undo(); setDone(null); }}>Undo</button>
        </div>
      )}
      <div className="chips chips--tight inv-filters" role="group" aria-label="Show">
        <button type="button" className="chip" aria-pressed={only === null} onClick={() => setOnly(null)}>All</button>
        {rows.map((r) => (
          <button key={r.id} type="button" className="chip" aria-pressed={only === r.id} onClick={() => setOnly(r.id)}>{r.name}</button>
        ))}
      </div>
      <main className="inv-rows wh-list" aria-label="Warehouses">
        {shown.map((w) => {
          const held = w.items.filter((i) => (i.qty ?? 0) > 0).length;
          const rest = w.items.length - held;
          const showAll = unfolded.has(w.id) || only === w.id;
          const list = showAll ? w.items : w.items.slice(0, held);
          return (
            <section key={w.id} className="wh" aria-label={w.name}>
              <header className="wh__head">
                <h2 className="wh__name">{w.name}</h2>
                {w.kitchenSide && <span className="wh__tag">Next to the kitchen</span>}
                {w.archived && <span className="wh__tag">Archived</span>}
                <span className="wh__sum num">{held} {held === 1 ? 'item' : 'items'} · Rs {fmt(w.cents)}</span>
              </header>
              {w.items.length === 0 && <p className="inv-empty">Nothing kept here yet. Set an item's home here, or move stock in.</p>}
              <ul className="wh__items">
                {list.map((i) => (
                  <li key={i.key}>
                    <button type="button" className={`wh-item${(i.qty ?? 0) > 0 ? '' : ' wh-item--none'}`} onClick={() => setOpen(i.key)}
                      aria-label={`${i.name}: ${amountText(i)}${i.home ? ', kept here' : ''}`}>
                      <span className="wh-item__name">
                        {i.name}
                        {i.kind === 'semi' && <span className="wh-item__kind">Semi</span>}
                        {!i.home && <span className="wh-item__home">Home: {warehouses.list.find((x) => x.id === homeOf(warehouses, i.key))?.name}</span>}
                      </span>
                      <span className="wh-item__qty num">{amountText(i)}</span>
                      <span className="wh-item__value num">{i.cents ? `Rs ${fmt(i.cents)}` : ''}</span>
                    </button>
                  </li>
                ))}
              </ul>
              {rest > 0 && !showAll && (
                <button type="button" className="linkbtn wh__more" onClick={() => setUnfolded(new Set([...unfolded, w.id]))}>
                  {rest} more kept here, none in stock or not counted
                </button>
              )}
            </section>
          );
        })}
      </main>
      {entry && <PlaceSheet key={entry.key} entry={entry} warehouses={warehouses} split={splitOf(entry.key)} onClose={() => setOpen(null)} onDone={setDone} />}
      {editing && <EditWarehouses warehouses={warehouses} onClose={() => setEditing(false)} onDone={setDone} />}
    </div>
  );
}

/** One item: where it is, its home (one tap), and a move from one warehouse to another. */
export function PlaceSheet({ entry, warehouses, split, onClose, onDone }: {
  entry: StockEntry;
  warehouses: Warehouses;
  split: { id: string; qty: number }[];
  onClose: () => void;
  onDone: (d: Done) => void;
}) {
  const nameOf = (id: string) => warehouses.list.find((x) => x.id === id)?.name ?? id;
  const home = homeOf(warehouses, entry.key);
  const open = activeWarehouses(warehouses);
  const [from, setFrom] = useState(split[0]?.id ?? home);
  const [to, setTo] = useState(open.find((x) => x.id !== (split[0]?.id ?? home))?.id ?? '');
  const [qty, setQty] = useState('');
  const [error, setError] = useState('');
  const has = split.find((s) => s.id === from)?.qty ?? 0;
  // Weighed items are moved in kg and L, as they are carried; the record keeps base units.
  const per = entry.kind === 'raw' && (entry.unit === 'g' || entry.unit === 'ml') ? 1000 : 1;
  const typedUnit = per === 1 ? entry.unit : entry.unit === 'g' ? 'kg' : 'L';

  const toHome = (id: string) => {
    if (id === home) return;
    const undo = setHome(warehouses, entry.key, id);
    onDone({ message: `${entry.name}: kept in ${nameOf(id)}.`, undo });
  };
  const move = () => {
    const amount = Math.round(Number(qty) * per * 1000) / 1000;
    const result = moveStock(warehouses, entry.key, from, to, amount);
    if (typeof result === 'string') return setError(result);
    onDone({ message: `${entry.name}: ${amountOf(entry, amount)} moved from ${nameOf(from)} to ${nameOf(to)}.`, undo: result });
    onClose();
  };

  return (
    <FlowSheet title={entry.name} sub={entry.kind === 'raw' ? 'Raw material' : 'Semi-processed'} onClose={onClose} error={error}
      primary={split.length ? { label: 'Move', onClick: move, disabled: !qty || !to } : undefined}>
      <section className="flow__list" aria-label="Where it is">
        <p className="flow-hint">Where it is</p>
        {split.length === 0 && <p className="flow-card__line">{entry.total === null ? (entry.kind === 'raw' ? 'Not counted yet.' : 'Not made yet.') : 'None in stock.'}</p>}
        {split.length > 0 && <SplitBar entry={entry} split={split} warehouses={warehouses} />}
      </section>
      <section className="flow__list" aria-label="Home">
        <p className="flow-hint">Kept in (deliveries and batches go here)</p>
        <div className="chips chips--tight" role="group" aria-label="Home warehouse">
          {open.map((x) => (
            <button key={x.id} type="button" className="chip" aria-pressed={x.id === home} onClick={() => toHome(x.id)}>{x.name}</button>
          ))}
        </div>
      </section>
      {split.length > 0 && (
        <section className="flow__list" aria-label="Move">
          <p className="flow-hint">Move</p>
          <div className="chips chips--tight" role="group" aria-label="From">
            {split.map((s) => (
              <button key={s.id} type="button" className="chip" aria-pressed={s.id === from}
                onClick={() => { setFrom(s.id); if (to === s.id) setTo(open.find((x) => x.id !== s.id)?.id ?? ''); setError(''); }}>
                From {nameOf(s.id)}
              </button>
            ))}
          </div>
          <div className="chips chips--tight" role="group" aria-label="To">
            {open.filter((x) => x.id !== from).map((x) => (
              <button key={x.id} type="button" className="chip" aria-pressed={x.id === to} onClick={() => { setTo(x.id); setError(''); }}>To {x.name}</button>
            ))}
          </div>
          <div className="wh-move">
            <NumberInput className="inv-modal__input" value={qty} unit={typedUnit} aria-label={`How much, in ${typedUnit}`}
              onText={(t) => { setQty(t); setError(''); }} placeholder={`Up to ${amountOf(entry, has)}`} />
            <button type="button" className="linkbtn" onClick={() => setQty(String(Math.round((has / per) * 1000) / 1000))}>All of it</button>
          </div>
        </section>
      )}
    </FlowSheet>
  );
}

/** Each warehouse's share of an item, as one bar with its amounts underneath. */
export function SplitBar({ entry, split, warehouses }: { entry: Pick<StockEntry, 'kind' | 'unit'>; split: { id: string; qty: number }[]; warehouses: Warehouses }) {
  const total = split.reduce((a, s) => a + s.qty, 0) || 1;
  const index = (id: string) => warehouses.list.findIndex((x) => x.id === id);
  return (
    <div className="wh-split">
      <div className="wh-split__bar" aria-hidden="true">
        {split.map((s) => <span key={s.id} className={`wh-seg wh-seg--${index(s.id) % 4}`} style={{ flexGrow: s.qty / total }} />)}
      </div>
      <ul className="wh-split__legend">
        {split.map((s) => (
          <li key={s.id}><span className={`wh-dot wh-seg--${index(s.id) % 4}`} aria-hidden="true" />{warehouses.list[index(s.id)]?.name} <span className="num">{amountOf(entry, s.qty)}</span></li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The owner's: names, archive, which one is next to the kitchen, and new ones. Changes wait for
 * one Save, and one Undo takes them all back.
 */
function EditWarehouses({ warehouses, onClose, onDone }: { warehouses: Warehouses; onClose: () => void; onDone: (d: Done) => void }) {
  const [owner, setOwner] = useState<Actor | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [archived, setArchived] = useState<Record<string, boolean>>({});
  const [kitchen, setKitchen] = useState(warehouses.kitchenSide);
  const [added, setAdded] = useState<string[]>([]);
  const [error, setError] = useState('');
  const final = useMemo(() => warehouses.list.map((x) => ({ ...x, name: (names[x.id] ?? x.name).trim(), archived: archived[x.id] ?? x.archived })), [warehouses, names, archived]);

  const save = () => {
    if (!owner) return;
    const all = [...final.filter((x) => !x.archived).map((x) => x.name), ...added.map((n) => n.trim())];
    for (const n of all) { const why = checkWarehouseName(n); if (why) return setError(why); }
    if (new Set(all.map((n) => n.toLowerCase())).size !== all.length) return setError('Two warehouses have the same name.');
    if (final.find((x) => x.id === kitchen)?.archived) return setError('The warehouse next to the kitchen cannot be archived. Pick another one for the kitchen first.');
    const changed = final.filter((x) => { const was = warehouses.list.find((y) => y.id === x.id)!; return was.name !== x.name || was.archived !== x.archived; });
    if (!changed.length && !added.length && kitchen === warehouses.kitchenSide) return setError('Nothing was changed.');
    // Checked against the list as it will be, so swapping two names is allowed.
    const after: Warehouses = { ...warehouses, list: final, kitchenSide: kitchen };
    const undos: (() => void)[] = [];
    for (const n of added) { const r = addWarehouse(after, n, owner); if (typeof r === 'function') undos.push(r); }
    if (kitchen !== warehouses.kitchenSide) undos.push(setKitchenSide(warehouses, kitchen, owner));
    for (const x of changed) {
      const r = editWarehouse({ ...after, list: warehouses.list.map((y) => ({ ...y, name: y.id === x.id ? y.name : final.find((f) => f.id === y.id)!.name })) }, x.id, { name: x.name, archived: x.archived }, owner);
      if (typeof r === 'function') undos.push(r);
    }
    onDone({ message: 'Warehouses saved.', undo: () => undos.reverse().forEach((u) => u()) });
    onClose();
  };

  return (
    <FlowSheet title="Warehouses" onClose={onClose} error={error} keys={!!owner}
      primary={owner ? { label: 'Save warehouses', onClick: save } : undefined}>
      <p className="flow-hint">Where stock is kept. Sales take from the one next to the kitchen first. Only the owner changes them.</p>
      {!owner && <OwnerPin onOpen={setOwner} onCancel={onClose} refusal="Only the owner changes the warehouses." />}
      {owner && (
        <section className="flow__list" aria-label="Warehouses">
          {final.map((x) => (
            <div key={x.id} className={`flow-card flow-card--item wh-edit${x.archived ? ' wh-edit--archived' : ''}`}>
              <label className="wh-edit__name">
                <span className="sr-only">Name</span>
                <input className="inv-modal__input" value={names[x.id] ?? warehouses.list.find((y) => y.id === x.id)!.name} maxLength={40}
                  aria-label={`Name of ${x.name}`} disabled={x.archived}
                  onChange={(e) => { setNames({ ...names, [x.id]: e.target.value }); setError(''); }} />
              </label>
              <div className="chips chips--tight">
                <button type="button" className="chip" aria-pressed={kitchen === x.id} disabled={x.archived} onClick={() => setKitchen(x.id)}>Next to the kitchen</button>
                <button type="button" className="chip" aria-pressed={x.archived} onClick={() => { setArchived({ ...archived, [x.id]: !x.archived }); setError(''); }}>
                  {x.archived ? 'Archived' : 'Archive'}
                </button>
              </div>
            </div>
          ))}
          {added.map((n, i) => (
            <div key={i} className="flow-card flow-card--item wh-edit">
              <label className="wh-edit__name">
                <span className="sr-only">New warehouse name</span>
                <input className="inv-modal__input" value={n} maxLength={40} autoFocus aria-label="New warehouse name" placeholder="Name"
                  onChange={(e) => { setAdded(added.map((m, j) => (j === i ? e.target.value : m))); setError(''); }} />
              </label>
              <button type="button" className="linkbtn" onClick={() => setAdded(added.filter((_, j) => j !== i))}>Remove</button>
            </div>
          ))}
          <button type="button" className="chip chip--solid" onClick={() => setAdded([...added, `Warehouse ${warehouses.list.length + added.length + 1}`])}>+ Add warehouse</button>
        </section>
      )}
    </FlowSheet>
  );
}
