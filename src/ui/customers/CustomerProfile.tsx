import { useEffect, useMemo, useState } from 'react';
import { creditOf } from '../../domain/credit.ts';
import {
  averageBill, favourites, relativeDay, usualLeaveOut, usualTime, usualTimeText, weekStrip, creditSaleIds,
} from '../../domain/crmPage.ts';
import { rhythmOf } from '../../domain/customerInsights.ts';
import {
  customerOrders, DEFAULT_SEGMENT_RULES, paidTotals, purchaseHistory, segmentsOf, statsOf, visitsFromEvents, type Customer, type CustomerSource,
} from '../../domain/customers.ts';
import { fmt } from '../../domain/money.ts';
import { formatLkMobile } from '../../domain/phone.ts';
import { lkDate, nameOf } from '../../domain/salesLedger.ts';
import type { SyncEvent } from '../../domain/sync.ts';
import type { Tender } from '../../domain/types.ts';
import { crmClient } from '../../services/crmClient.ts';
import { startOrderFor } from '../../services/orderFor.ts';
import { VisitLine } from './charts.tsx';
import { CreditPanel } from './CreditPanel.tsx';
import { initials, SEGMENT_LABEL, shortDate } from './CustomerList.tsx';
import type { CrmData, Notice } from './CustomersView.tsx';

/**
 * One customer. Who: the owner or a manager who tapped a name. What they want: this person's rhythm
 * (how often, when next, whether they are drifting), what they buy and how they like it, what they
 * owe, and one tap to start their order. Opting out is one tap and is respected by every campaign
 * (Sri Lanka PDPA). docs/crm-redesign.md.
 */
const SOURCE: Record<CustomerSource, string> = { pos: 'Given at the counter', import: 'From the imported list', manual: 'Added by hand', app: 'Signed up for offers' };
const TENDER: Partial<Record<Tender, string>> = { cash: 'Cash', transfer: 'Bank transfer', card: 'Card', qr: 'QR', comp: 'Free', credit: 'Credit' };
const DAY = 86_400_000;
const TIMELINE_WEEKS = 26;
const BILLS_SHOWN = 10;

/**
 * The name and mobile, corrected in place (a manager or the owner): Save or Enter, Esc to leave.
 * The id stays, so their sales stay theirs; Undo on the notice puts them back.
 */
function EditForm({ c, onDone, onSaved }: { c: Customer; onDone: () => void; onSaved: (n: Notice) => Promise<void> }) {
  const [phone, setPhone] = useState(formatLkMobile(c.phone));
  const [name, setName] = useState(c.name ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const { customer, before } = await crmClient.edit(c.id, phone, name);
      onDone();
      await onSaved({
        message: `Saved ${customer.name ?? formatLkMobile(customer.phone)}.`,
        undo: async () => { await crmClient.edit(before.id, before.phone, before.name ?? ''); },
      });
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); setBusy(false); }
  };
  return (
    <form className="crm-add" aria-label="Change customer" onSubmit={(e) => { e.preventDefault(); void save(); }}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onDone(); } }}>
      <label className="setup__field"><span>Name</span>
        <input autoFocus value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="No name" /></label>
      <label className="setup__field"><span>Mobile</span>
        <input className="num" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="077 123 4567" /></label>
      <button type="submit" className="inv-page__primary" disabled={busy || !phone.trim()}>Save</button>
      <button type="button" className="linkbtn" onClick={onDone}>Cancel</button>
      {error && <p className="setup__error" role="alert">{error}</p>}
    </form>
  );
}

/** The last offer that reached them and when they came in after; said once it is known, nothing while asking. */
function useLastOffer(id: string) {
  const [last, setLast] = useState<{ title: string; at: number; cameAt: number | null } | null>(null);
  useEffect(() => {
    let live = true;
    setLast(null);
    crmClient.messages(id).then((r) => { if (live) setLast(r.last); }, () => { /* the line says what it can without it */ });
    return () => { live = false; };
  }, [id]);
  return last;
}

export function CustomerProfile({ id, data, events, now, isOwner, onChanged, onRemoved, onEdited, onCredit, onRegister }: {
  id: string; data: CrmData | null; events: readonly SyncEvent[]; now: number; isOwner: boolean;
  onChanged: () => Promise<void>; onRemoved: (n: Notice) => Promise<void>; onEdited: (n: Notice) => Promise<void>;
  /** A credit change (credit.ts), said once with its Undo. */
  onCredit: (n: Notice) => void;
  /** Back to the Register (Start an order). */
  onRegister: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [allBills, setAllBills] = useState(false);
  const c = data?.customers.find((x) => x.id === id) ?? null;
  const visits = useMemo(() => visitsFromEvents(events), [events]);
  const history = useMemo(() => purchaseHistory(events, id), [events, id]);
  const orders = useMemo(() => customerOrders(events, id), [events, id]);
  const account = useMemo(() => creditOf(events, id), [events, id]);
  const shopAverage = useMemo(() => averageBill(paidTotals(events).filter((p) => p.at >= now - 90 * DAY)), [events, now]);
  const lastOffer = useLastOffer(id);

  if (!data) return <div className="skeleton crm-import__skeleton" aria-label="Loading customer" />;
  if (!c) return <p className="crm__lead">No such customer. <a href="#customers">Back to the list</a></p>;
  const mine = visits.get(c.id) ?? [];
  const stats = statsOf(c.id, mine);
  const segment = segmentsOf(data.customers, visits, DEFAULT_SEGMENT_RULES, now).get(c.id)!;
  const rhythm = rhythmOf(mine);
  const weeks = weekStrip(mine, now, TIMELINE_WEEKS, creditSaleIds([account]));
  const favs = favourites(orders);
  const leave = usualLeaveOut(orders);
  const when = usualTime(mine);
  const first = c.name?.trim().split(/\s+/)[0] ?? 'this customer';
  const thisMonth = mine.filter((v) => lkDate(v.at).slice(0, 7) === lkDate(now).slice(0, 7)).reduce((s, v) => s + v.total, 0);
  const openBills = new Map(account.bills.filter((b) => b.open > 0).map((b) => [b.saleId, b.open]));
  const offers = c.optedOut ? 'no' : data.withApp.has(c.id) ? 'yes' : 'none';
  const favName = (f: { itemId: string; size?: string }) => {
    const n = nameOf(f.itemId);
    const size = n.size(f.size);
    return `${n.name}${size ? `, ${size}` : ''}`;
  };

  const toggle = async () => {
    setBusy(true);
    setError('');
    try { await crmClient.optOut(c.id, !c.optedOut); await onChanged(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    setBusy(false);
  };

  /** The owner erases a customer (PDPA): at once, with Undo on the list for a few seconds. */
  const remove = async () => {
    setBusy(true);
    setError('');
    try {
      const { removed } = await crmClient.remove(c.id);
      await onRemoved({ message: `Removed ${removed.name ?? formatLkMobile(removed.phone)}.`, undo: async () => { await crmClient.restore(removed); } });
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); setBusy(false); }
  };

  const startOrder = () => { startOrderFor({ id: c.id, name: c.name }); onRegister(); };

  return (
    <article className="crm-profile" aria-label={c.name ?? formatLkMobile(c.phone)}>
      <p><a href="#customers" className="crm-back">← All customers</a></p>
      {editing ? <EditForm key={c.id} c={c} onDone={() => setEditing(false)} onSaved={onEdited} /> : (
        <header className="crm-profile__head">
          <div className="crm-profile__who">
            <span className="crm-avatar crm-avatar--big" aria-hidden="true">{initials(c.name)}</span>
            <div>
              <div className="crm-profile__line">
                <h2>{c.name ?? 'No name'}</h2>
                <span className="crm-chip"><i className={`crm-dot crm-dot--${segment}`} />{SEGMENT_LABEL[segment]}</span>
                {offers === 'yes' && <span className="crm-chip crm-chip--ok">Gets offers</span>}
                {offers === 'no' && <span className="crm-chip">No messages</span>}
              </div>
              <p className="crm__muted crm-profile__meta"><span className="num crm-profile__phone">{formatLkMobile(c.phone)}</span> · {SOURCE[c.source]} · since {shortDate(c.createdAt)}</p>
            </div>
          </div>
          <div className="crm-profile__actions">
            <button type="button" className="inv-page__secondary crm-btn-ghost" onClick={() => setEditing(true)}>Change name or mobile</button>
            <button type="button" className="inv-page__primary" onClick={startOrder}>Start an order →</button>
          </div>
        </header>
      )}

      <section className="crm-card crm-rhythm" aria-label="Rhythm">
        <div className="crm-rhythm__say">
          <span className="crm-label">Rhythm</span>
          {rhythm ? (
            <>
              <b>Comes about every {rhythm.usualDays} {rhythm.usualDays === 1 ? 'day' : 'days'}</b>
              <span>
                Last came {relativeDay(rhythm.lastAt, now).toLowerCase()}.
                {rhythm.nextAt > now ? ` Next likely around ${new Date(rhythm.nextAt).toLocaleDateString('en-GB', { weekday: 'long' })}.` : ''}
                {rhythm.quietFrom > now && segment !== 'inactive' ? ` Not back by ${new Date(rhythm.quietFrom).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}: shows in Gone quiet.` : ''}
              </span>
            </>
          ) : (
            <>
              <b>Too early to tell</b>
              <span>{stats ? `${stats.orders} ${stats.orders === 1 ? 'visit' : 'visits'} so far; a rhythm shows from 3.` : 'Their number has not been given at Charge yet.'}</span>
            </>
          )}
        </div>
        <div className="crm-rhythm__line">
          <VisitLine weeks={weeks} />
          <div className="crm-chart__axis"><span>{TIMELINE_WEEKS} weeks ago</span><span>Now</span></div>
          <div className="crm-rhythm__keys"><span className="crm-key"><i className="crm-vline__dot crm-vline__dot--m" />Paid</span><span className="crm-key"><i className="crm-vline__dot crm-vline__dot--m crm-vline__dot--credit" />On credit</span><span>Bigger dot, bigger bill</span></div>
        </div>
      </section>

      <ul className="crm-tiles" aria-label="This customer">
        <li><span className="crm-label">Orders</span><b className="num">{stats?.orders ?? 0}</b><span>{stats ? `since ${shortDate(stats.firstVisitAt)}` : 'none yet'}</span></li>
        <li><span className="crm-label">Spent</span><b className="num">{stats ? `Rs ${fmt(stats.spent)}` : '–'}</b><span>{thisMonth ? `Rs ${fmt(thisMonth)} this month` : 'nothing this month'}</span></li>
        <li><span className="crm-label">Average bill</span><b className="num">{stats ? `Rs ${fmt(averageBill(mine))}` : '–'}</b><span>{shopAverage ? `shop average Rs ${fmt(shopAverage)}` : ''}</span></li>
        <li><span className="crm-label">Usually</span><b>{when ? usualTimeText(when) : '–'}</b><span>{when ? `${when.n} of ${when.of} visits` : 'no usual time yet'}</span></li>
      </ul>

      <div className="crm-two">
        <section className="crm-card crm-buys" aria-label="What they buy">
          <header className="crm-chart__head"><h2>What {first} buys</h2><span>times ordered</span></header>
          {favs.length === 0 ? <p className="crm__muted">Nothing yet.</p> : (
            <ul className="crm-bars">
              {favs.map((f, i) => (
                <li key={`${f.itemId}|${f.size ?? ''}`}>
                  <span className="crm-bars__name">{favName(f)}</span>
                  <b className="num">{f.n}</b>
                  <span className="crm-bars__track"><i className={i === 0 ? 'crm-bars__fill crm-bars__fill--top' : 'crm-bars__fill'} style={{ width: `${(f.n / favs[0].n) * 100}%` }} /></span>
                </li>
              ))}
            </ul>
          )}
          {leave && (
            <p className="crm-buys__note">Leaves out <b className="crm-buys__out">{nameOf(leave.itemId).option(leave.optionId).toLowerCase()}</b> on {leave.n} of {leave.of} {nameOf(leave.itemId).name}</p>
          )}
        </section>
        <CreditPanel key={c.id} customerId={c.id} name={c.name ?? formatLkMobile(c.phone)} events={events} now={now} isOwner={isOwner} onSaved={onCredit} />
      </div>

      <section className="crm-card crm-messages" aria-label="Messages">
        <p>
          {offers === 'no' ? 'Asked for no messages: no campaign reaches them.'
            : offers === 'yes' ? 'Signed up for offers: campaigns can reach them.' : 'Not signed up for offers: campaigns cannot reach them.'}
          {offers === 'yes' && lastOffer && (
            <span className="crm__muted"> Last: “{lastOffer.title}” on {new Date(lastOffer.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
              {lastOffer.cameAt ? `, came in ${Math.max(0, Math.round((lastOffer.cameAt - lastOffer.at) / DAY))} days later.` : ', not back since.'}</span>
          )}
        </p>
        <button type="button" className={c.optedOut ? 'chip chip--solid' : 'linkbtn'} disabled={busy} onClick={() => void toggle()}>
          {c.optedOut ? 'Allow messages again' : 'No messages for this customer'}
        </button>
        {error && <p className="setup__error" role="alert">{error}</p>}
      </section>

      <section className="crm-card crm-table" aria-label="Bills">
        <header className="crm-chart__head crm-table__head"><h2>Bills</h2>{stats && <span className="num">{stats.orders} · Rs {fmt(stats.spent)}</span>}</header>
        {history.length === 0 ? <p className="crm__muted crm-table__empty">Nothing yet: their number has not been given at Charge.</p> : (
          <div className="crm-table__scroll">
            <table className="crm-list crm-list--bills">
              <thead><tr><th scope="col">Date</th><th scope="col">Order</th><th scope="col">Items</th><th scope="col">Paid by</th><th scope="col" className="crm-list__n">Paid</th></tr></thead>
              <tbody>
                {(allBills ? history : history.slice(0, BILLS_SHOWN)).map((s) => {
                  const open = openBills.get(s.id);
                  return (
                    <tr key={s.id}>
                      <td>{shortDate(s.paidAt)} {s.saleTime}</td>
                      <td><span className="crm-badge num">ORDER {s.orderNumber}</span></td>
                      <td>
                        {s.items.map((it) => `${it.qty} × ${it.itemName}${it.size ? ` ${it.size}` : ''}`).join(', ')}
                        {s.items.some((it) => it.leftOut) && <span className="crm-list__outs">{s.items.filter((it) => it.leftOut).map((it) => `no ${it.leftOut}`).join(' · ')}</span>}
                      </td>
                      <td className={open ? 'crm-list__late' : undefined}>{TENDER[s.tender] ?? s.tender}{open ? ` · Rs ${fmt(open)} open` : ''}</td>
                      <td className="num crm-list__n">Rs {fmt(s.total)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {history.length > BILLS_SHOWN && !allBills && <button type="button" className="linkbtn crm-table__more" onClick={() => setAllBills(true)}>All {history.length} bills →</button>}
      </section>

      {isOwner && (
        <p className="crm-profile__remove">
          <button type="button" className="linkbtn crm-danger" disabled={busy} onClick={() => void remove()}>Remove customer</button>
          <span className="crm__muted">Takes them off the list for good. Their past sales stay in the sales, without their name.</span>
        </p>
      )}
    </article>
  );
}
