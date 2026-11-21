import { useEffect, useMemo, useState } from 'react';
import {
  AUDIENCE_LABEL, campaignsFromEvents, checkMessage, checkReceiptOffer, MAX_BODY, MAX_RECEIPT_HEADLINE, MAX_RECEIPT_LINE, MAX_TITLE,
  receiptOfferFromEvents, winbackFromEvents, type Audience, type ReceiptOffer,
} from '../../domain/campaigns.ts';
import { RESULT_DAYS, resultText, type CampaignResult } from '../../domain/campaignResults.ts';
import { reachFunnel, signupsByMonth } from '../../domain/crmPage.ts';
import { fmt } from '../../domain/money.ts';
import type { SyncEvent } from '../../domain/sync.ts';
import { crmClient } from '../../services/crmClient.ts';
import { addEvents } from '../eventLog.ts';
import type { CrmData } from './CustomersView.tsx';

/**
 * Campaigns: a push notification to a group, through the CheesyBeez app (free; no SMS).
 * Who: the owner, deciding to bring people in. What he knows: who his customers are (the list).
 * The one next thing: pick who (each says how many it reaches), write two lines and see them as the
 * phone will, Send. Above it, the real limit on every campaign: how many signed up for offers, and
 * the receipt's QR that grows it. Below, what each campaign brought beside those it did not reach.
 * A message cannot be called back once sent, so the reach is shown before. Managers see what was sent.
 */
type Who = Exclude<Audience, 'test'>;
const WHO: Who[] = ['all', 'new', 'regular', 'vip', 'inactive', 'quiet'];
type Reach = Record<Who, { customers: number; reachable: number }>;
const letters = (s: string) => [...s].length;
const day = (at: number) => new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
const pct = (n: number, of: number) => (of ? Math.round((n / of) * 100) : 0);

/** A sent campaign: when, what, how many it reached, the share that came in (with the others beside it), and what it brought. */
function SentList({ sent, results }: { sent: ReturnType<typeof campaignsFromEvents>; results: Record<string, CampaignResult> }) {
  return (
    <section className="crm-card crm-table" aria-label="What they brought">
      <header className="crm-chart__head crm-table__head">
        <h2>What they brought</h2>
        <span className="crm-chart__keys">
          <span className="crm-key"><i className="crm-dot crm-dot--regular" />Came in within {RESULT_DAYS} days</span>
          <span className="crm-key"><i className="crm-sent__mark-key" />Others like them, not sent it</span>
        </span>
      </header>
      {sent.length === 0 ? <p className="crm__muted crm-table__empty">Nothing sent yet.</p> : (
        <div className="crm-table__scroll">
          <table className="crm-list crm-list--sent">
            <thead><tr><th scope="col">Sent</th><th scope="col">Message</th><th scope="col" className="crm-list__n">Reached</th><th scope="col">Came in ({RESULT_DAYS} days)</th></tr></thead>
            <tbody>
              {sent.map((c) => {
                const r = results[c.id];
                const words = r ? resultText(r, fmt) : null;
                return (
                  <tr key={c.id}>
                    <td>{day(c.at)}</td>
                    <td><b>{c.title}</b><span className="crm-sent__to">{c.kind === 'auto' ? 'We miss you (automatic)' : AUDIENCE_LABEL[c.audience]} · {c.body}</span></td>
                    <td className="num crm-list__n">{c.delivered} of {c.reachable}</td>
                    <td className="crm-result">
                      {r && r.reached > 0 && (
                        <span className="crm-sent__bar" role="img" aria-label={`${pct(r.cameIn, r.reached)}% came in${r.compared ? `, others ${pct(r.comparedCameIn, r.compared)}%` : ''}`}>
                          <i className="crm-sent__fill" style={{ width: `${pct(r.cameIn, r.reached)}%` }} />
                          {r.compared > 0 && <i className="crm-sent__mark" style={{ left: `${pct(r.comparedCameIn, r.compared)}%` }} />}
                        </span>
                      )}
                      {words ? <>{words.brought}{words.others && <span className="crm__muted crm-result__others">{words.others}</span>}</> : <span className="crm__muted">–</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function CampaignsPanel({ isOwner, data, events, now, to }: { isOwner: boolean; data: CrmData | null; events: readonly SyncEvent[]; now: number; to?: 'quiet' }) {
  const [who, setWho] = useState<Who>(to ?? 'inactive');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [reach, setReach] = useState<Reach | null>(null);
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
  const autoSent = useMemo(() => sent.filter((c) => c.kind === 'auto').reduce((n, c) => n + c.delivered, 0), [sent]);
  const [autoText, setAutoText] = useState({ title: auto.title, body: auto.body });
  useEffect(() => { setAutoText({ title: auto.title, body: auto.body }); }, [auto.title, auto.body]);
  const receipt = useMemo(() => receiptOfferFromEvents(all), [all]);
  const [receiptText, setReceiptText] = useState<ReceiptOffer>(receipt);
  useEffect(() => { setReceiptText(receipt); }, [receipt]);
  const receiptWhy = checkReceiptOffer(receiptText);

  // Every group's reach in one ask, again after each send.
  useEffect(() => {
    if (!isOwner || !data) return;
    let live = true;
    crmClient.reachAll().then((r) => { if (live) setReach(r.reach); }, (e: unknown) => { if (live) setError(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [isOwner, data, sent.length]);

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
    return test ? (e.delivered ? 'Test sent to your phone.' : 'The test did not arrive: are notifications still allowed for cheesybeez.com on that phone?')
      : `Sent: reached ${e.delivered} of ${e.reachable}${e.failed ? ` (${e.failed} could not be reached now)` : ''}.`;
  });
  const saveAuto = (on: boolean) => run(async () => {
    const r = await crmClient.setAuto(on, autoText.title, autoText.body);
    addEvents(r.events);
    setMine((m) => [...m, ...r.events]);
    return on ? '“We miss you” is on.' : '“We miss you” is off.';
  });
  const saveReceipt = () => run(async () => {
    const r = await crmClient.setReceipt(receiptText.headline, receiptText.line);
    addEvents(r.events);
    setMine((m) => [...m, ...r.events]);
    return 'The receipt prints the new words from the next sale.';
  });

  const history = <SentList sent={sent} results={results} />;
  if (!isOwner) return <><p className="crm__lead">Campaigns are sent by the owner. What was sent:</p>{history}</>;

  const funnel = data ? reachFunnel(data.customers, data.withApp) : null;
  const signups = data ? signupsByMonth(data.customers, now) : null;
  const here = reach?.[who] ?? null;
  const why = checkMessage({ title, body });
  const autoWhy = checkMessage(autoText);
  const width = (n: number) => `${funnel && funnel.total ? Math.max(1, (n / funnel.total) * 100) : 0}%`;

  return (
    <>
      {funnel && (
        <section className="crm-card crm-reach" aria-label="Who a message can reach">
          <div className="crm-reach__bars">
            <h2>Who a message can reach</h2>
            <div className="crm-reach__grid">
              <span>Customers</span><span className="crm-reach__track"><i className="crm-reach__fill crm-reach__fill--all" style={{ width: '100%' }} /></span><b className="num">{funnel.total.toLocaleString('en-GB')}</b>
              <span>Signed up for offers</span><span className="crm-reach__track"><i className="crm-reach__fill crm-reach__fill--app" style={{ width: width(funnel.signedUp) }} /></span><b className="num">{funnel.signedUp.toLocaleString('en-GB')}</b>
              <span>Can be reached now</span><span className="crm-reach__track"><i className="crm-reach__fill" style={{ width: width(funnel.reachable) }} /></span><b className="num">{funnel.reachable.toLocaleString('en-GB')}</b>
            </div>
            {funnel.optedOut > 0 && <span className="crm__hint">{funnel.optedOut} asked for no messages. Every campaign respects that.</span>}
          </div>
          {signups && (
            <div className="crm-reach__grow">
              <span className="crm-label">Grow it</span>
              <b>{signups.thisMonth === 0 ? 'No sign-ups from the receipt QR this month yet.'
                : `The receipt QR brought ${signups.thisMonth} sign-up${signups.thisMonth === 1 ? '' : 's'} this month${signups.lastMonth ? `, ${signups.lastMonth} last month` : ''}.`}</b>
              <span>A reason to scan works best: an offer on the receipt.</span>
            </div>
          )}
        </section>
      )}

      <div className="crm-two">
        <section className="crm-card crm-compose" aria-label="New campaign">
          <h2>New campaign</h2>
          <div className="crm-compose__who">
            <span className="crm-compose__lbl">Send to</span>
            <div className="cats crm-wrap" role="group" aria-label="Send to">
              {WHO.map((a) => (
                <button key={a} type="button" className="pill" aria-pressed={who === a} onClick={() => setWho(a)}>
                  {AUDIENCE_LABEL[a]}{reach && <span className="num crm-filter__n">{reach[a].reachable}</span>}
                </button>
              ))}
            </div>
            <p className="crm-reach__line" aria-live="polite">
              {here === null ? <span className="skeleton crm__line" /> : here.reachable === 0
                ? `Reaches nobody yet: none of the ${here.customers} ${AUDIENCE_LABEL[who].toLowerCase()} customers have signed up for offers.`
                : `Reaches ${here.reachable} of ${here.customers} ${who === 'all' ? '' : `${AUDIENCE_LABEL[who].toLowerCase()} `}customers.`}
            </p>
          </div>
          <label className="setup__field"><span>Title <span className="crm__muted num">{letters(title)}/{MAX_TITLE}</span></span>
            <input value={title} maxLength={MAX_TITLE} onChange={(e) => setTitle(e.target.value)} placeholder="Weekend offer" /></label>
          <label className="setup__field"><span>Message <span className="crm__muted num">{letters(body)}/{MAX_BODY}</span></span>
            <textarea className="crm-text" value={body} maxLength={MAX_BODY} rows={3} onChange={(e) => setBody(e.target.value)} placeholder="Two large pizzas for the price of one, Saturday and Sunday." /></label>
          <div className="crm-import__actions crm-compose__actions">
            <label className="crm-test">
              <input className="num" value={testPhone} onChange={(e) => setTestPhone(e.target.value)} placeholder="077 123 4567" aria-label="My mobile, for a test" />
              <button type="button" className="inv-page__secondary crm-btn-ghost" disabled={busy || why !== null || !testPhone.trim()} onClick={() => void send(true)}>Send test</button>
            </label>
            <button type="button" className="inv-page__primary" disabled={busy || why !== null || !here?.reachable} onClick={() => void send(false)}>
              {here?.reachable ? `Send to ${here.reachable}` : 'Send'}
            </button>
          </div>
          <span className="crm__hint">A sent message can’t be called back. Test it on your phone first.</span>
          {done && <p className="setup__done" role="status">{done}</p>}
          {error && <p className="setup__error" role="alert">{error}</p>}
        </section>

        <section className="crm-card crm-phone" aria-label="On their phone">
          <span className="crm-label">On their phone</span>
          <div className="crm-phone__frame" role="img" aria-label={`The notification: ${title || 'Title'}. ${body || 'Your message shows here.'}`}>
            <div className="crm-phone__clock num">{new Date(now).toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Colombo' })}</div>
            <div className="crm-phone__note">
              <span className="crm-phone__icon" aria-hidden="true" />
              <span className="crm-phone__text">
                <span className="crm-phone__app"><span>CheesyBeez</span><span>now</span></span>
                <b>{title || 'Title'}</b>
                <span>{body || 'Your message shows here.'}</span>
              </span>
            </div>
          </div>
          <span className="crm__hint">No names in the message: it may show on a locked screen.</span>
        </section>
      </div>

      <div className="crm-two">
        <section className="crm-card crm-auto" aria-label="We miss you">
          <header className="crm-credit__head">
            <div><h2>We miss you</h2><span className="crm__hint">{auto.on ? `On${autoSent ? ` · sent ${autoSent} times` : ''}` : 'Off'}</span></div>
            <button type="button" role="switch" aria-checked={auto.on} aria-label="We miss you, sent by itself" className="crm-switch"
              disabled={busy || autoWhy !== null} onClick={() => void saveAuto(!auto.on)}><i /></button>
          </header>
          <p className="crm__hint">Sent by itself, once, to a customer signed up for offers on the day they reach 30 days without a visit (between 10 am and 8 pm).</p>
          <label className="setup__field"><span>Title</span>
            <input value={autoText.title} maxLength={MAX_TITLE} onChange={(e) => setAutoText({ ...autoText, title: e.target.value })} /></label>
          <label className="setup__field"><span>Message</span>
            <textarea className="crm-text" value={autoText.body} maxLength={MAX_BODY} rows={2} onChange={(e) => setAutoText({ ...autoText, body: e.target.value })} /></label>
          {auto.on && (autoText.title !== auto.title || autoText.body !== auto.body) && (
            <button type="button" className="inv-page__primary crm-auto__save" disabled={busy || autoWhy !== null} onClick={() => void saveAuto(true)}>Save the words</button>
          )}
        </section>

        <section className="crm-card crm-receipt" aria-label="On the receipt">
          <div className="crm-receipt__fields">
            <div><h2>On the receipt</h2><span className="crm__hint">Printed above the QR code at the bottom of every receipt.</span></div>
            <label className="setup__field"><span>First line <span className="crm__muted num">{receiptText.headline.length}/{MAX_RECEIPT_HEADLINE}</span></span>
              <input value={receiptText.headline} maxLength={MAX_RECEIPT_HEADLINE} onChange={(e) => setReceiptText({ ...receiptText, headline: e.target.value })} /></label>
            <label className="setup__field"><span>Second line <span className="crm__muted">if you want one</span> <span className="crm__muted num">{receiptText.line.length}/{MAX_RECEIPT_LINE}</span></span>
              <input value={receiptText.line} maxLength={MAX_RECEIPT_LINE} onChange={(e) => setReceiptText({ ...receiptText, line: e.target.value })} placeholder="10% off your next pizza" /></label>
            {receiptWhy && <p className="crm__hint">{receiptWhy}</p>}
            <button type="button" className="inv-page__primary crm-auto__save" disabled={busy || receiptWhy !== null || (receiptText.headline.trim() === receipt.headline && receiptText.line.trim() === receipt.line)} onClick={() => void saveReceipt()}>
              Save the receipt words
            </button>
          </div>
          <div className="crm-receipt__paper" role="img" aria-label={`The receipt's end: ${receiptText.headline} ${receiptText.line}`}>
            <span className="crm-receipt__rule" />
            <b>{receiptText.headline || ' '}</b>
            {receiptText.line && <span>{receiptText.line}</span>}
            <svg width="64" height="64" viewBox="0 0 21 21" aria-hidden="true" shapeRendering="crispEdges">
              <path fill="currentColor" d="M0 0h7v7H0zM14 0h7v7h-7zM0 14h7v7H0z" />
              <path fill="#fff" d="M1 1h5v5H1zM15 1h5v5h-5zM1 15h5v5H1z" />
              <path fill="currentColor" d="M2 2h3v3H2zM16 2h3v3h-3zM2 16h3v3H2zM9 1h2v2H9zM8 4h2v2H8zM11 5h2v3h-2zM9 9h3v2H9zM14 9h2v2h-2zM17 8h3v2h-3zM8 12h2v3H8zM12 13h3v2h-3zM16 12h2v4h-2zM10 16h2v4h-2zM14 17h2v3h-2zM18 18h2v2h-2zM1 9h3v2H1zM5 10h2v2H5z" />
            </svg>
            <span>cheesybeez.com</span>
          </div>
        </section>
      </div>

      {history}
    </>
  );
}
