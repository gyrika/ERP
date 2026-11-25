import { useMemo, useState } from 'react';
import { creditFromEvents, daysSince, settingLabel } from '../../domain/credit.ts';
import { comingBack, creditSaleIds, needsYou, relativeDay, weekStrip } from '../../domain/crmPage.ts';
import { isGoneQuiet } from '../../domain/customerInsights.ts';
import { crmSummary, DEFAULT_SEGMENT_RULES, segmentsOf, statsOf, visitsFromEvents, type Segment } from '../../domain/customers.ts';
import { fmt } from '../../domain/money.ts';
import { formatLkMobile } from '../../domain/phone.ts';
import type { SyncEvent } from '../../domain/sync.ts';
import { crmClient } from '../../services/crmClient.ts';
import { ComingBackChart, SegmentBar, WeekDots } from './charts.tsx';
import type { CrmData, Notice } from './CustomersView.tsx';
import { NeedsYou } from './NeedsYou.tsx';

/**
 * The customer list. Who: the owner (or a manager) asking "who are my customers, who stopped coming,
 * who owes?". Three sentences at the top say what needs them (one tap each); two small charts show
 * who the customers are and whether they come back; the list under them narrows by segment, Gone
 * quiet, Owes or a search, and a row opens the customer. docs/crm-redesign.md.
 */
export const SEGMENT_LABEL: Record<Segment, string> = { new: 'New', regular: 'Regular', vip: 'VIP', inactive: 'Inactive' };
const SHOWN = 200;
const WEEKS = 12;

export const shortDate = (at: number) => new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const digits = (s: string) => s.replace(/\D/g, '');
/** Up to two letters for a customer's circle: first and last name, or # without a name. */
export const initials = (name: string | null) =>
  name ? name.trim().split(/\s+/).filter(Boolean).map((w) => [...w][0]).filter((_, i, a) => i === 0 || i === a.length - 1).join('').toUpperCase() : '#';

export type ListFilter = Segment | 'all' | 'owes' | 'quiet';

/**
 * Add customer: one person by hand (a regular who never gave their number at Charge). The mobile
 * first (it is who they are), the name if known; a number already on the list says whose it is.
 */
function AddCustomer({ onAdded }: { onAdded: (n: Notice) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [nickname, setNickname] = useState('');
  const [error, setError] = useState('');
  if (!open) {
    return (
      <button type="button" className="inv-page__primary crm-add__open" onClick={() => setOpen(true)}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
        Add customer
      </button>
    );
  }
  const add = async () => {
    setBusy(true);
    setError('');
    try {
      const { customer } = await crmClient.add(phone, name, nickname);
      setPhone(''); setName(''); setNickname(''); setOpen(false);
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
      <label className="setup__field"><span>Nickname <span className="crm__muted">if any</span></span>
        <input value={nickname} maxLength={40} onChange={(e) => setNickname(e.target.value)} /></label>
      <button type="submit" className="inv-page__primary" disabled={busy || !phone.trim()}>Add</button>
      <button type="button" className="linkbtn" onClick={() => { setOpen(false); setError(''); }}>Cancel</button>
      {error && <p className="setup__error" role="alert">{error}</p>}
    </form>
  );
}

const FILTER_LABEL: Record<ListFilter, string> = { all: 'All', ...SEGMENT_LABEL, quiet: 'Gone quiet', owes: 'Owes' };

export function CustomerList({ data, events, now, onAdded, show = 'all' }: {
  data: CrmData | null; events: readonly SyncEvent[]; now: number; onAdded: (n: Notice) => Promise<void>;
  /** Open at this filter: Owes from the owner's To do (credit.ts), New or Gone quiet from a card. */
  show?: ListFilter;
}) {
  const [filter, setFilter] = useState<ListFilter>(show);
  const [query, setQuery] = useState('');
  const credit = useMemo(() => creditFromEvents(events), [events]);
  const onCredit = useMemo(() => creditSaleIds(credit.values()), [credit]);
  const visits = useMemo(() => visitsFromEvents(events), [events]);
  const rows = useMemo(() => {
    if (!data) return null;
    const segments = segmentsOf(data.customers, visits, DEFAULT_SEGMENT_RULES, now);
    return data.customers.map((c) => {
      const list = visits.get(c.id) ?? [];
      return { c, segment: segments.get(c.id)!, stats: statsOf(c.id, list), quiet: isGoneQuiet(list, now), weeks: weekStrip(list, now, WEEKS, onCredit) };
    }).sort((a, b) => (b.stats?.lastVisitAt ?? 0) - (a.stats?.lastVisitAt ?? 0) || (a.c.name ?? '~').localeCompare(b.c.name ?? '~'));
  }, [data, visits, now, onCredit]);
  const summary = useMemo(() => (data ? crmSummary(data.customers, visits, DEFAULT_SEGMENT_RULES, now) : null), [data, visits, now]);
  const cards = useMemo(() => (data && summary ? needsYou({ customers: data.customers, visits, credit, newThisMonth: summary.newThisMonth, now }) : []), [data, summary, visits, credit, now]);
  const back = useMemo(() => comingBack(visits, now, WEEKS), [visits, now]);

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
  const owing = (id: string) => credit.get(id)?.owes ?? 0;
  const counts: Record<ListFilter, number> = {
    all: summary.total, ...summary.bySegment,
    quiet: rows.filter((r) => r.quiet).length,
    owes: rows.filter((r) => owing(r.c.id) > 0).length,
  };
  const matches = rows.filter((r) => (filter === 'all' || (filter === 'owes' ? owing(r.c.id) > 0 : filter === 'quiet' ? r.quiet : r.segment === filter)) && (!q
    || (r.c.name ?? '').toLowerCase().includes(q)
    || (r.c.nickname ?? '').toLowerCase().includes(q)
    || (qDigits.length >= 3 && (digits(formatLkMobile(r.c.phone)).includes(qDigits) || digits(r.c.phone).includes(qDigits)))));
  const filters: ListFilter[] = ['all', 'new', 'regular', 'vip', 'inactive', ...(counts.quiet || filter === 'quiet' ? ['quiet' as const] : []), ...(counts.owes || filter === 'owes' ? ['owes' as const] : [])];
  const pick = (f: ListFilter) => setFilter((was) => (was === f && f !== 'all' ? 'all' : f));

  return (
    <>
      <div className="crm-listhead">
        <p className="crm-listhead__count"><span className="num">{summary.total.toLocaleString('en-GB')}</span> {summary.total === 1 ? 'person' : 'people'} · <span className="num">{data.withApp.size}</span> get offers on the app</p>
        <AddCustomer onAdded={onAdded} />
      </div>

      <NeedsYou cards={cards} />

      <div className="crm-charts">
        <SegmentBar counts={summary.bySegment} picked={filter === 'all' || filter === 'owes' || filter === 'quiet' ? null : filter} onPick={pick} />
        <ComingBackChart data={back} />
      </div>

      <section className="crm-card crm-table" aria-label="All customers">
        <div className="crm-filter">
          <input type="search" className="crm-filter__search" placeholder="Name, nickname, or last digits of mobile" aria-label="Search customers" value={query} onChange={(e) => setQuery(e.target.value)} />
          <div className="cats" role="group" aria-label="Show">
            {filters.map((f) => (
              <button key={f} type="button" className="pill" aria-pressed={filter === f} onClick={() => pick(f)}>
                {FILTER_LABEL[f]} <span className="num crm-filter__n">{counts[f].toLocaleString('en-GB')}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="crm-table__scroll">
          {filter === 'owes' ? (
            // Who owes on credit, most first: what, against which limit, and how long since they paid.
            <table className="crm-list" aria-label="Owes on credit">
              <thead><tr><th scope="col">Name</th><th scope="col">Mobile</th><th scope="col" className="crm-list__n">Owes</th><th scope="col">Credit</th><th scope="col">Last paid back</th><th scope="col">Oldest unpaid</th></tr></thead>
              <tbody>
                {[...matches].sort((a, b) => owing(b.c.id) - owing(a.c.id)).map(({ c }) => {
                  const a = credit.get(c.id)!;
                  return (
                    <tr key={c.id}>
                      <td><a href={`#customers/c/${c.id}`}>{c.name ?? <span className="crm__muted">No name</span>}</a></td>
                      <td className="num">{formatLkMobile(c.phone)}</td>
                      <td className="num crm-list__n crm-list__owes">Rs {fmt(a.owes)}</td>
                      <td>{settingLabel(a.setting)}</td>
                      <td>{a.lastPaidAt ? shortDate(a.lastPaidAt) : <span className="crm__muted">Never</span>}</td>
                      <td>{a.oldestOpenAt ? `${daysSince(a.oldestOpenAt, now)} days` : '–'}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot><tr><th scope="row" colSpan={2}>In all</th><td className="num crm-list__n crm-list__owes">Rs {fmt(matches.reduce((n, r) => n + owing(r.c.id), 0))}</td><td colSpan={3} /></tr></tfoot>
            </table>
          ) : (
            <table className="crm-list crm-list--people">
              <thead><tr>
                <th scope="col">Customer</th><th scope="col">Who</th><th scope="col">Last {WEEKS} weeks</th>
                <th scope="col" className="crm-list__n">Orders</th><th scope="col">Last came</th><th scope="col" className="crm-list__n">Spent</th><th scope="col" className="crm-list__n">Owes</th>
              </tr></thead>
              <tbody>
                {matches.slice(0, SHOWN).map(({ c, segment: s, stats, quiet, weeks }) => (
                  <tr key={c.id}>
                    <td>
                      <span className="crm-who">
                        <span className="crm-avatar" aria-hidden="true">{initials(c.name)}</span>
                        <span className="crm-who__text">
                          <a href={`#customers/c/${c.id}`} className="crm-who__name">{c.name ?? 'No name'}</a>
                          <span className="num crm-who__phone">{formatLkMobile(c.phone)}{c.optedOut && ' · no messages'}</span>
                        </span>
                      </span>
                    </td>
                    <td><span className="crm-key"><i className={`crm-dot crm-dot--${s}`} />{SEGMENT_LABEL[s]}</span>{quiet && <span className="crm-tag">Gone quiet</span>}</td>
                    <td><WeekDots weeks={weeks} /></td>
                    <td className="num crm-list__n">{stats?.orders ?? 0}</td>
                    <td className={quiet || s === 'inactive' ? 'crm-list__late' : undefined}>{stats ? relativeDay(stats.lastVisitAt, now) : <span className="crm__muted">Never</span>}</td>
                    <td className="num crm-list__n">{stats ? `Rs ${fmt(stats.spent)}` : '–'}</td>
                    <td className="num crm-list__n">{owing(c.id) > 0 ? <b>Rs {fmt(owing(c.id))}</b> : <span className="crm__muted">–</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <p className="crm__muted crm__count" aria-live="polite">
          {matches.length === 0 ? 'Nobody matches.' : matches.length > SHOWN ? `Showing ${SHOWN} of ${matches.length}: search to narrow.` : `${matches.length} shown.`}
        </p>
      </section>
    </>
  );
}
