import type { ComingBack, WeekCell } from '../../domain/crmPage.ts';
import type { Segment } from '../../domain/customers.ts';
import { SEGMENT_LABEL } from './CustomerList.tsx';

/**
 * The Customers screens' small pictures: evidence beside a sentence, never a wall of charts.
 * Plain elements (no chart library); each says its numbers to a screen reader.
 */

const ORDER: Segment[] = ['new', 'regular', 'vip', 'inactive'];
const MEANS: Record<Segment, string> = { new: 'first visit in 30 days', regular: 'come back', vip: 'top spend, 90 days', inactive: '30+ days away' };

/** Who they are: one bar split by segment; a part is a button that narrows the list to it. */
export function SegmentBar({ counts, picked, onPick }: { counts: Record<Segment, number>; picked: Segment | null; onPick: (s: Segment) => void }) {
  const total = ORDER.reduce((n, s) => n + counts[s], 0);
  return (
    <section className="crm-card crm-chart" aria-label="Who they are">
      <header className="crm-chart__head"><h2>Who they are</h2><span>Tap a part to see them</span></header>
      {total > 0 && (
        <div className="crm-segbar">
          {ORDER.filter((s) => counts[s] > 0).map((s) => (
            <button key={s} type="button" className={`crm-segbar__part crm-dot--${s}`} style={{ flexGrow: counts[s] }}
              aria-label={`${SEGMENT_LABEL[s]}: ${counts[s]}`} aria-pressed={picked === s} onClick={() => onPick(s)} />
          ))}
        </div>
      )}
      <ul className="crm-segbar__legend">
        {ORDER.map((s) => (
          <li key={s}>
            <span className="crm-key"><i className={`crm-dot crm-dot--${s}`} />{SEGMENT_LABEL[s]}</span>
            <b className="num">{counts[s].toLocaleString('en-GB')}</b>
            <small>{MEANS[s]}</small>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Coming back: named orders a week, from people who had been before over their first visit. */
export function ComingBackChart({ data }: { data: ComingBack }) {
  const top = Math.max(1, ...data.weeks.map((w) => w.returning + w.first));
  const words = data.weeks.map((w, i) => `${data.weeks.length - 1 - i === 0 ? 'this week' : `${data.weeks.length - 1 - i} weeks ago`}: ${w.returning} returning, ${w.first} first`).join('; ');
  return (
    <section className="crm-card crm-chart" aria-label="Coming back">
      <header className="crm-chart__head">
        <h2>Coming back</h2>
        <span className="crm-chart__keys"><span className="crm-key"><i className="crm-dot crm-dot--regular" />Returning</span><span className="crm-key"><i className="crm-dot crm-dot--new" />First visit</span></span>
      </header>
      <p className="crm-chart__say">
        {data.shareThisWeek === null ? 'No orders with a customer on them this week yet.'
          : <><b className="num">{Math.round(data.shareThisWeek * 100)}%</b> of named orders this week came from people who had been before.</>}
      </p>
      <div className="crm-weeks" role="img" aria-label={`Orders with a customer, the last ${data.weeks.length} weeks: ${words}`}>
        {data.weeks.map((w, i) => (
          <div key={i} className="crm-weeks__col">
            <i className="crm-weeks__first" style={{ height: `${(w.first / top) * 100}%` }} />
            <i className={`crm-weeks__back${i === data.weeks.length - 1 ? ' crm-weeks__back--now' : ''}`} style={{ height: `${(w.returning / top) * 100}%` }} />
          </div>
        ))}
      </div>
      <div className="crm-chart__axis"><span>{data.weeks.length} weeks ago</span><span>This week</span></div>
    </section>
  );
}

/** A customer's weeks as dots: grey none, mid one, dark more. */
export function WeekDots({ weeks }: { weeks: WeekCell[] }) {
  const came = weeks.filter((w) => w.length).length;
  return (
    <span className="crm-wdots" role="img" aria-label={`Came in ${came} of the last ${weeks.length} weeks`}>
      {weeks.map((w, i) => <i key={i} className={w.length > 1 ? 'crm-wdots--more' : w.length ? 'crm-wdots--one' : undefined} />)}
    </span>
  );
}

/** A customer's visits over many weeks on one line: a dot per visit, bigger for a bigger bill, hollow on credit. */
export function VisitLine({ weeks }: { weeks: WeekCell[] }) {
  const visits = weeks.reduce((n, w) => n + w.length, 0);
  const credit = weeks.reduce((n, w) => n + w.filter((v) => v.credit).length, 0);
  return (
    <div className="crm-vline" role="img" aria-label={`${visits} visits in the last ${weeks.length} weeks${credit ? `, ${credit} on credit` : ''}`}>
      {weeks.map((w, i) => (
        <span key={i} className="crm-vline__week">
          {w.slice(0, 2).map((v, j) => <i key={j} className={`crm-vline__dot crm-vline__dot--${v.size}${v.credit ? ' crm-vline__dot--credit' : ''}`} />)}
        </span>
      ))}
    </div>
  );
}
