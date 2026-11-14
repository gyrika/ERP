import { useEffect, useMemo, useState } from 'react';
import {
  AUDIENCE_LABEL, campaignsFromEvents, checkMessage, MAX_BODY, MAX_TITLE, winbackFromEvents, type Audience,
} from '../../domain/campaigns.ts';
import { RESULT_DAYS, resultText, type CampaignResult } from '../../domain/campaignResults.ts';
import { fmt } from '../../domain/money.ts';
import type { SyncEvent } from '../../domain/sync.ts';
import { crmClient } from '../../services/crmClient.ts';
import { addEvents } from '../eventLog.ts';
import { shortDate } from './CustomerList.tsx';
import type { CrmData } from './CustomersView.tsx';

/**
 * Campaigns: a push notification to a segment, through the CheesyBeez app (free; no SMS).
 * Who: the owner, deciding to bring people in. What he knows: who his customers are (the list).
 * The one next thing: pick who, write two lines, see how many it reaches, Send. A test to his own
 * number first is one tap. A message cannot be called back once sent, so the reach is shown before.
 * Managers see what was sent; sending is the owner's.
 */
const WHO: Audience[] = ['all', 'new', 'regular', 'vip', 'inactive'];
const letters = (s: string) => [...s].length;

export function CampaignsPanel({ isOwner, data, events }: { isOwner: boolean; data: CrmData | null; events: readonly SyncEvent[]; now: number }) {
  const [who, setWho] = useState<Audience>('inactive');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [reach, setReach] = useState<{ customers: number; reachable: number } | null>(null);
  const [testPhone, setTestPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  // What was just sent or set shows at once; the shop's history catches up a moment later.
  const [mine, setMine] = useState<SyncEvent[]>([]);
  const all = useMemo(() => {
    const known = new Set(events.map((e) => e.id));
    return [...events, ...mine.filter((e) => !known.has(e.id))];
  }, [events, mine]);
  const sent = useMemo(() => campaignsFromEvents(all), [all]);
  // What each campaign brought in: worked out on the shop PC (who was reached stays there), asked again after a send.
  const [results, setResults] = useState<Record<string, CampaignResult>>({});
  useEffect(() => {
    let live = true;
    crmClient.results().then((r) => { if (live) setResults(r.results); }, () => { /* the list still shows; the column says – */ });
    return () => { live = false; };
  }, [sent.length]);
  const auto = useMemo(() => winbackFromEvents(all), [all]);
  const [autoText, setAutoText] = useState({ title: auto.title, body: auto.body });
  useEffect(() => { setAutoText({ title: auto.title, body: auto.body }); }, [auto.title, auto.body]);

  useEffect(() => {
    if (!isOwner || !data) return;
    let live = true;
    setReach(null);
    crmClient.reach(who).then((r) => { if (live) setReach(r); }, (e: unknown) => { if (live) setError(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [who, isOwner, data]);

  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    setError('');
    setDone('');
    try { setDone(await fn()); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    setBusy(false);
  };
  const send = (test: boolean) => run(async () => {
    const r = await crmClient.send(test ? 'test' : who, title, body, test ? testPhone : undefined);
    addEvents(r.events);
    setMine((m) => [...m, ...r.events]);
    const e = r.events[0] as { delivered: number; failed: number; reachable: number };
    if (!test) { setTitle(''); setBody(''); }
    return test ? (e.delivered ? 'Test sent to your phone.' : 'The test did not arrive: is the app still allowed to notify on that phone?')
      : `Sent: reached ${e.delivered} of ${e.reachable}${e.failed ? ` (${e.failed} could not be reached now)` : ''}.`;
  });
  const saveAuto = (on: boolean) => run(async () => {
    const r = await crmClient.setAuto(on, autoText.title, autoText.body);
    addEvents(r.events);
    setMine((m) => [...m, ...r.events]);
    return on ? '“We miss you” is on.' : '“We miss you” is off.';
  });

  const why = checkMessage({ title, body });
  const history = (
    <section className="crm-import" aria-label="Sent">
      <h2>Sent</h2>
      {sent.length === 0 ? <p className="crm__muted">Nothing sent yet.</p> : (
        <table className="crm-list">
          <thead><tr><th scope="col">Date</th><th scope="col">To</th><th scope="col">Message</th><th scope="col" className="crm-list__n">Reached</th><th scope="col">Came in ({RESULT_DAYS} days)</th></tr></thead>
          <tbody>
            {sent.map((c) => {
              const r = results[c.id];
              const words = r ? resultText(r, fmt) : null;
              return (
                <tr key={c.id}>
                  <td>{shortDate(c.at)}</td>
                  <td>{c.kind === 'auto' ? 'We miss you (automatic)' : AUDIENCE_LABEL[c.audience]}</td>
                  <td><b>{c.title}</b> · {c.body}</td>
                  <td className="num crm-list__n">{c.delivered} of {c.reachable}</td>
                  <td className="crm-result">
                    {words ? <>{words.brought}{words.others && <span className="crm__muted crm-result__others">{words.others}</span>}</> : <span className="crm__muted">–</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );

  if (!isOwner) return <><p className="crm__lead">Campaigns are sent by the owner. What was sent:</p>{history}</>;

  return (
    <>
      <p className="crm__lead">A notification on the phones of customers who have the CheesyBeez app and allow offers. {data ? `${data.withApp.size} of ${data.customers.length} have it.` : ''}</p>
      <section className="crm-import" aria-label="New campaign">
        <h2>New campaign</h2>
        <div className="cats crm-wrap" role="group" aria-label="Send to">
          {WHO.map((a) => <button key={a} type="button" className="pill" aria-pressed={who === a} onClick={() => setWho(a)}>{AUDIENCE_LABEL[a]}</button>)}
        </div>
        <p className="crm-reach" aria-live="polite">
          {reach === null ? <span className="skeleton crm__line" /> : reach.reachable === 0
            ? `Reaches nobody yet: none of the ${reach.customers} ${AUDIENCE_LABEL[who].toLowerCase()} customers have the app.`
            : `Reaches ${reach.reachable} of ${reach.customers} ${who === 'all' ? '' : `${AUDIENCE_LABEL[who].toLowerCase()} `}customers.`}
        </p>
        <label className="setup__field"><span>Title <span className="crm__muted num">{letters(title)}/{MAX_TITLE}</span></span>
          <input value={title} maxLength={MAX_TITLE} onChange={(e) => setTitle(e.target.value)} placeholder="Weekend offer" /></label>
        <label className="setup__field"><span>Message <span className="crm__muted num">{letters(body)}/{MAX_BODY}</span></span>
          <textarea className="crm-text" value={body} maxLength={MAX_BODY} rows={3} onChange={(e) => setBody(e.target.value)} placeholder="Two large pizzas for the price of one, Saturday and Sunday." /></label>
        <div className="crm-import__actions">
          <button type="button" className="inv-page__primary" disabled={busy || why !== null || !reach?.reachable} onClick={() => void send(false)}>
            {reach?.reachable ? `Send to ${reach.reachable}` : 'Send'}
          </button>
          <label className="crm-test">
            <span>Test to my number</span>
            <input className="num" value={testPhone} onChange={(e) => setTestPhone(e.target.value)} placeholder="077 123 4567" aria-label="My mobile, for a test" />
            <button type="button" className="chip" disabled={busy || why !== null || !testPhone.trim()} onClick={() => void send(true)}>Send test</button>
          </label>
        </div>
        {done && <p className="setup__done" role="status">{done}</p>}
        {error && <p className="setup__error" role="alert">{error}</p>}
      </section>

      <section className="crm-import" aria-label="We miss you">
        <h2>We miss you <span className={auto.on ? 'unlock__on' : 'unlock__off'}>· {auto.on ? 'On' : 'Off'}</span></h2>
        <p className="crm__hint">Sent by itself, once, to a customer with the app on the day they reach 30 days without a visit (between 10 am and 8 pm).</p>
        <label className="setup__field"><span>Title</span>
          <input value={autoText.title} maxLength={MAX_TITLE} onChange={(e) => setAutoText({ ...autoText, title: e.target.value })} /></label>
        <label className="setup__field"><span>Message</span>
          <textarea className="crm-text" value={autoText.body} maxLength={MAX_BODY} rows={2} onChange={(e) => setAutoText({ ...autoText, body: e.target.value })} /></label>
        <div className="crm-import__actions">
          <button type="button" className={auto.on ? 'chip' : 'inv-page__primary'} disabled={busy || checkMessage(autoText) !== null} onClick={() => void saveAuto(!auto.on)}>
            {auto.on ? 'Turn off' : 'Turn on'}
          </button>
          {auto.on && <button type="button" className="linkbtn" disabled={busy || checkMessage(autoText) !== null} onClick={() => void saveAuto(true)}>Save the words</button>}
        </div>
      </section>
      {history}
    </>
  );
}
