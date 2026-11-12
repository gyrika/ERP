import { useMemo, useState } from 'react';
import { crmSummary, DEFAULT_SEGMENT_RULES, segmentsOf, statsOf, visitsFromEvents, type Segment } from '../../domain/customers.ts';
import { fmt } from '../../domain/money.ts';
import { formatLkMobile } from '../../domain/phone.ts';
import type { SyncEvent } from '../../domain/sync.ts';
import { crmClient } from '../../services/crmClient.ts';
import type { CrmData, Notice } from './CustomersView.tsx';

/**
 * The customer list. Who: the owner (or a manager) asking "who are my customers, and who stopped
 * coming?". The numbers at the top answer that at a glance; a segment chip or a search narrows the
 * list; a row opens the customer.
 */
export const SEGMENT_LABEL: Record<Segment, string> = { new: 'New', regular: 'Regular', vip: 'VIP', inactive: 'Inactive' };
const SHOWN = 200;

export const shortDate = (at: number) => new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const digits = (s: string) => s.replace(/\D/g, '');

/**
 * Add customer: one person by hand (a regular who never gave their number at Charge). The mobile
 * first (it is who they are), the name if known; a number already on the list says whose it is.
 */
function AddCustomer({ onAdded }: { onAdded: (n: Notice) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!open) return <button type="button" className="inv-page__primary" onClick={() => setOpen(true)}>Add customer</button>;
  const add = async () => {
    setBusy(true);
    setError('');
    try {
      const { customer } = await crmClient.add(phone, name);
      setPhone(''); setName(''); setOpen(false);
      await onAdded({ message: `Added ${customer.name ?? formatLkMobile(customer.phone)}.` });
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    setBusy(false);
  };
  return (
    <form className="crm-add" aria-label="Add customer" onSubmit={(e) => { e.preventDefault(); void add(); }}>
      <label className="setup__field"><span>Mobile</span>
        <input className="num" inputMode="tel" autoFocus value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="077 123 4567" /></label>
      <label className="setup__field"><span>Name <span className="crm__muted">if known</span></span>
        <input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} /></label>
      <button type="submit" className="inv-page__primary" disabled={busy || !phone.trim()}>Add</button>
      <button type="button" className="linkbtn" onClick={() => { setOpen(false); setError(''); }}>Cancel</button>
      {error && <p className="setup__error" role="alert">{error}</p>}
    </form>
  );
}

export function CustomerList({ data, events, now, onAdded }: { data: CrmData | null; events: readonly SyncEvent[]; now: number; onAdded: (n: Notice) => Promise<void> }) {
  const [segment, setSegment] = useState<Segment | 'all'>('all');
  const [query, setQuery] = useState('');
  const visits = useMemo(() => visitsFromEvents(events), [events]);
  const rows = useMemo(() => {
    if (!data) return null;
    const segments = segmentsOf(data.customers, visits, DEFAULT_SEGMENT_RULES, now);
    return data.customers.map((c) => ({ c, segment: segments.get(c.id)!, stats: statsOf(c.id, visits.get(c.id) ?? []) }))
      .sort((a, b) => (b.stats?.lastVisitAt ?? 0) - (a.stats?.lastVisitAt ?? 0) || (a.c.name ?? '~').localeCompare(b.c.name ?? '~'));
  }, [data, visits, now]);
  const summary = useMemo(() => (data ? crmSummary(data.customers, visits, DEFAULT_SEGMENT_RULES, now) : null), [data, visits, now]);

  if (!rows || !summary || !data) return <div className="skeleton crm-import__skeleton" aria-label="Loading customers" />;
  if (!rows.length) {
    return (
      <>
        <p className="crm__lead">No customers yet. <a href="#customers/import">Import your list</a>, add one here, or they are added as mobile numbers are given at Charge.</p>
        <AddCustomer onAdded={onAdded} />
      </>
    );
  }

  const q = query.trim().toLowerCase();
  const qDigits = digits(q);
  const matches = rows.filter((r) => (segment === 'all' || r.segment === segment) && (!q
    || (r.c.name ?? '').toLowerCase().includes(q)
    || (qDigits.length >= 3 && (digits(formatLkMobile(r.c.phone)).includes(qDigits) || digits(r.c.phone).includes(qDigits)))));
  const pct = (n: number | null) => (n === null ? '–' : `${Math.round(n * 100)}%`);

  return (
    <>
      <ul className="crm-tiles" aria-label="Customers at a glance">
        <li><b className="num">{summary.total.toLocaleString('en-GB')}</b><span>customers</span></li>
        <li><b className="num">{summary.newThisMonth}</b><span>new this month</span></li>
        <li><b className="num">{summary.active}</b><span>active</span></li>
        <li><b className="num">{summary.inactive}</b><span>inactive (30+ days)</span></li>
        <li><b className="num">{pct(summary.repeatRate)}</b><span>came back</span></li>
        <li><b className="num">{data.withApp.size}</b><span>have the app</span></li>
      </ul>

      {summary.top.length > 0 && (
        <p className="crm__top">
          <span>Top customers:</span>{' '}
          {summary.top.slice(0, 3).map((t, i) => {
            const c = data.customers.find((x) => x.id === t.customerId);
            return <span key={t.customerId}>{i > 0 && ' · '}<a href={`#customers/c/${t.customerId}`}>{c?.name ?? formatLkMobile(c?.phone ?? '')}</a> <span className="num">Rs {fmt(t.spent)}</span></span>;
          })}
        </p>
      )}

      <div className="crm-filter">
        <div className="cats" role="group" aria-label="Segment">
          {(['all', 'new', 'regular', 'vip', 'inactive'] as const).map((s) => (
            <button key={s} type="button" className="pill" aria-pressed={segment === s} onClick={() => setSegment(s)}>
              {s === 'all' ? 'All' : SEGMENT_LABEL[s]} <span className="num crm-filter__n">{s === 'all' ? summary.total : summary.bySegment[s]}</span>
            </button>
          ))}
        </div>
        <input type="search" className="crm-filter__search" placeholder="Name or mobile" aria-label="Search customers" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <AddCustomer onAdded={onAdded} />

      <table className="crm-list">
        <thead><tr><th scope="col">Name</th><th scope="col">Mobile</th><th scope="col">Segment</th><th scope="col" className="crm-list__n">Orders</th><th scope="col" className="crm-list__n">Spent</th><th scope="col">Last visit</th></tr></thead>
        <tbody>
          {matches.slice(0, SHOWN).map(({ c, segment: s, stats }) => (
            <tr key={c.id}>
              <td><a href={`#customers/c/${c.id}`}>{c.name ?? <span className="crm__muted">No name</span>}</a>{c.optedOut && <span className="crm__muted"> · no messages</span>}</td>
              <td className="num">{formatLkMobile(c.phone)}</td>
              <td><span className={`crm-seg crm-seg--${s}`}>{SEGMENT_LABEL[s]}</span></td>
              <td className="num crm-list__n">{stats?.orders ?? 0}</td>
              <td className="num crm-list__n">{stats ? `Rs ${fmt(stats.spent)}` : '–'}</td>
              <td>{stats ? shortDate(stats.lastVisitAt) : <span className="crm__muted">Never</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="crm__muted crm__count" aria-live="polite">
        {matches.length === 0 ? 'Nobody matches.' : matches.length > SHOWN ? `Showing ${SHOWN} of ${matches.length}: search to narrow.` : `${matches.length} shown.`}
      </p>
    </>
  );
}
