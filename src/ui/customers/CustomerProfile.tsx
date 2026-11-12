import { useMemo, useState } from 'react';
import { DEFAULT_SEGMENT_RULES, purchaseHistory, segmentsOf, statsOf, visitsFromEvents, type CustomerSource } from '../../domain/customers.ts';
import { fmt } from '../../domain/money.ts';
import { formatLkMobile } from '../../domain/phone.ts';
import type { SyncEvent } from '../../domain/sync.ts';
import { crmClient } from '../../services/crmClient.ts';
import { SEGMENT_LABEL, shortDate } from './CustomerList.tsx';
import type { CrmData, Notice } from './CustomersView.tsx';

/**
 * One customer. Who: the owner or a manager who tapped a name. What they want: how often this
 * person comes, what they buy, and whether they may be sent offers. Opting out is one tap and is
 * respected by every campaign (Sri Lanka PDPA); tap again if they change their mind.
 */
const SOURCE: Record<CustomerSource, string> = { pos: 'Given at the counter', import: 'From the imported list', manual: 'Added by hand', app: 'Signed up in the app' };

export function CustomerProfile({ id, data, events, now, isOwner, onChanged, onRemoved }: {
  id: string; data: CrmData | null; events: readonly SyncEvent[]; now: number; isOwner: boolean;
  onChanged: () => Promise<void>; onRemoved: (n: Notice) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const c = data?.customers.find((x) => x.id === id) ?? null;
  const visits = useMemo(() => visitsFromEvents(events), [events]);
  const history = useMemo(() => purchaseHistory(events, id), [events, id]);

  if (!data) return <div className="skeleton crm-import__skeleton" aria-label="Loading customer" />;
  if (!c) return <p className="crm__lead">No such customer. <a href="#customers">Back to the list</a></p>;
  const stats = statsOf(c.id, visits.get(c.id) ?? []);
  const segment = segmentsOf(data.customers, visits, DEFAULT_SEGMENT_RULES, now).get(c.id)!;

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

  return (
    <article className="crm-profile" aria-label={c.name ?? formatLkMobile(c.phone)}>
      <p><a href="#customers">← All customers</a></p>
      <header className="crm-profile__head">
        <div>
          <h2>{c.name ?? 'No name'}</h2>
          <p className="num crm-profile__phone">{formatLkMobile(c.phone)}</p>
          <p className="crm__muted">{SOURCE[c.source]} · since {shortDate(c.createdAt)}</p>
        </div>
        <span className={`crm-seg crm-seg--${segment}`}>{SEGMENT_LABEL[segment]}</span>
      </header>

      <ul className="crm-tiles" aria-label="This customer">
        <li><b className="num">{stats?.orders ?? 0}</b><span>orders</span></li>
        <li><b className="num">{stats ? `Rs ${fmt(stats.spent)}` : '–'}</b><span>spent</span></li>
        <li><b>{stats ? shortDate(stats.firstVisitAt) : '–'}</b><span>first visit</span></li>
        <li><b>{stats ? shortDate(stats.lastVisitAt) : 'Never'}</b><span>last visit</span></li>
      </ul>

      <section className="crm-profile__messages" aria-label="Messages">
        <p>
          {c.optedOut ? 'Asked for no messages: no campaign reaches them.'
            : data.withApp.has(c.id) ? 'Has the app: campaigns can reach them.' : 'No app yet: campaigns cannot reach them.'}
        </p>
        <button type="button" className={c.optedOut ? 'chip chip--solid' : 'chip'} disabled={busy} onClick={() => void toggle()}>
          {c.optedOut ? 'Allow messages again' : 'No messages for this customer'}
        </button>
        {error && <p className="setup__error" role="alert">{error}</p>}
      </section>
      {isOwner && (
        <p className="crm-profile__remove">
          <button type="button" className="linkbtn crm-danger" disabled={busy} onClick={() => void remove()}>Remove customer</button>
          <span className="crm__muted">Takes them off the list for good. Their past sales stay in the sales, without their name.</span>
        </p>
      )}

      <h3>What they bought</h3>
      {history.length === 0 ? <p className="crm__muted">Nothing yet: their number has not been given at Charge.</p> : (
        <table className="crm-list">
          <thead><tr><th scope="col">Date</th><th scope="col">Order</th><th scope="col">Items</th><th scope="col" className="crm-list__n">Paid</th></tr></thead>
          <tbody>
            {history.map((s) => (
              <tr key={s.id}>
                <td>{shortDate(s.paidAt)} {s.saleTime}</td>
                <td className="num">{s.orderNumber}</td>
                <td>{s.items.map((it) => `${it.qty} × ${it.itemName}${it.size ? ` ${it.size}` : ''}`).join(', ')}</td>
                <td className="num crm-list__n">Rs {fmt(s.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </article>
  );
}
