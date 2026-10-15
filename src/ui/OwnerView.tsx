import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { rulesSuggestions, type CaseView, type Insight } from '../domain/insights.ts';
import { daysAgo } from '../domain/itemStory.ts';
import { MAX_NOTE } from '../domain/gapReview.ts';
import { SEED_INVENTORY, SEED_SUPPLIERS } from '../domain/inventoryData.ts';
import { inventoryFromEvents, suppliersFromEvents } from '../domain/inventory.ts';
import { fmt } from '../domain/money.ts';
import { useInstall } from '../services/ownerApp.ts';
import { adminShop, ownerToken } from '../services/pairing.ts';
import { usesLogin } from '../services/auth.ts';
import { reviewGap } from '../services/inventoryStore.ts';
import { loadMe } from '../services/managerPhone.ts';
import { usePhotoUrl } from '../services/photos.ts';
import { signedIn, subscribeAuth } from '../services/serverAuth.ts';
import { readAll, subscribeEvents } from './eventLog.ts';
import { useShopEvents } from '../services/ownerData.ts';
import { OwnerNav } from './OwnerNav.tsx';

/**
 * The Owner view. Serves the owner: they know the shop, not the screens, and
 * read this on a phone between other things. The one question it answers is
 * "does anything need me?": today in one line, then ONE feed of cards, each
 * with one tap behind it. No charts, no tables (CLAUDE.md).
 */
const timeOf = (t: number) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/**
 * The gaps behind "Gaps to check" (SCRUM-95): what was counted, the manager's reason, the
 * photo of the shelf, then OK or Ask. A question waits for the manager's answer here.
 */
function GapReview({ cases, canReview }: { cases: CaseView[]; canReview: boolean }) {
  return (
    <ul className="gaps">
      {cases.map((c) => <GapItem key={c.gap.countId} view={c} canReview={canReview} />)}
    </ul>
  );
}

function GapItem({ view, canReview }: { view: CaseView; canReview: boolean }) {
  const { gap, name, gapText } = view;
  const photo = usePhotoUrl(gap.photo);
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState('');
  const review = gap.review;
  return (
    <li className="gap" aria-label={name}>
      <div className="gap__head">
        <strong>{name}</strong>
        <span className={`num${gap.delta < 0 ? ' gap__short' : ''}`}>Rs {fmt(Math.abs(gap.valueCents))}</span>
      </div>
      <p className="gap__sub">{gapText} · {gap.by}, {daysAgo(gap.at, Date.now())}</p>
      {gap.photo && (photo
        ? <a href={photo} target="_blank" rel="noreferrer"><img className="gap__photo" src={photo} alt={`Shelf photo of ${name}`} /></a>
        : <p className="gap__sub">Photo loading…</p>)}
      {review.kind === 'asked' && (
        <div className="gap__talk">
          <p><b>{review.by}:</b> {review.note || 'Please explain.'}</p>
          {review.answer ? <p><b>{review.answer.by}:</b> {review.answer.note}</p> : <p className="gap__sub">Waiting for the answer.</p>}
        </div>
      )}
      {canReview && (asking ? (
        <form className="gap__ask" onSubmit={(e) => { e.preventDefault(); reviewGap(gap, 'ask', note); setAsking(false); setNote(''); }}>
          <textarea className="inv-modal__input" rows={2} maxLength={MAX_NOTE} autoFocus value={note} aria-label={`Question about ${name}`}
            placeholder="What would you like to know?" onChange={(e) => setNote(e.target.value)} />
          <div className="gap__actions">
            <button type="button" className="linkbtn" onClick={() => setAsking(false)}>Cancel</button>
            <button type="submit" className="insight__action">Send</button>
          </div>
        </form>
      ) : (
        <div className="gap__actions">
          <button type="button" className="chip" onClick={() => setAsking(true)}>{review.kind === 'asked' ? 'Ask again' : 'Ask'}</button>
          <button type="button" className="insight__action" aria-label={`OK ${name}`} onClick={() => reviewGap(gap, 'ok')}>OK</button>
        </div>
      ))}
    </li>
  );
}

function Detail({ insight, onClose, canReview }: { insight: Insight; onClose: () => void; canReview: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="sheet owner-sheet" role="dialog" aria-modal="true" aria-label={insight.title}>
        <div className="sheet__body">
          <div className="sheet__title">
            <h1>{insight.title}</h1>
            <button type="button" className="linkbtn" onClick={onClose} autoFocus>Close</button>
          </div>
          {insight.cases && <GapReview cases={insight.cases} canReview={canReview} />}
          <ul className="owner-list">
            {insight.action.items.map((item, i) => (
              <li key={i}>
                <span className="owner-list__main">
                  <span>{item.primary}</span>
                  {(item.secondary || item.at) && (
                    <span className="owner-list__sub">
                      {[item.secondary, item.at ? timeOf(item.at) : null].filter(Boolean).join(' · ')}
                    </span>
                  )}
                </span>
                {item.amount !== undefined && <span className="owner-list__amount num">{fmt(item.amount)}</span>}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </>
  );
}

/**
 * `phone`: on the owner's phone (the cloud site): no links to the counter's screens.
 * `onBack`: back to the Register (F3 does the same).
 */
export function OwnerView({ phone = false, onBack, shop }: {
  phone?: boolean;
  onBack?: () => void;
  /** Another shop, from the developer's Shops screen: its id in the header, Back goes to Shops. */
  shop?: string;
} = {}) {
  const data = useShopEvents();
  // What this device just recorded (the owner's OK or question) shows at once, before the shop has it.
  const [local, setLocal] = useState(readAll);
  useEffect(() => subscribeEvents(() => setLocal(readAll())), []);
  // Who may check gaps: the owner. On the owner's phone, once the cloud has said whose phone it is.
  const role = useSyncExternalStore(subscribeAuth, () => signedIn()?.role ?? null);
  const [phoneReady, setPhoneReady] = useState(false);
  useEffect(() => { if (phone && ownerToken()) loadMe().then(() => setPhoneReady(true), () => {}); }, [phone]);
  const canReview = phone ? phoneReady : !shop && (!usesLogin() || role === 'owner');
  const install = useInstall();
  /** The developer's admin view of a shop: not an owner's phone, so no home-screen offer. */
  const offerInstall = phone && !adminShop();
  const [open, setOpen] = useState<string | null>(null);
  const remote = data.state === 'ready' ? data.events : data.state === 'error' ? data.events : undefined;
  const events = useMemo(() => {
    if (!remote) return undefined;
    const known = new Set(remote.map((e) => e.id));
    const mine = local.filter((e) => !known.has(e.id) && e.type.startsWith('stock.gap_'));
    return mine.length ? [...remote, ...mine] : remote;
  }, [remote, local]);
  const at = (data.state === 'loading' ? undefined : data.at) ?? Date.now();

  const { summary, insights } = useMemo(() => {
    if (!events) return { summary: null, insights: [] as Insight[] };
    const shop = {
      events,
      now: at,
      stock: {
        items: inventoryFromEvents(SEED_INVENTORY, events).filter((item) => !item.archived),
        suppliers: suppliersFromEvents(SEED_SUPPLIERS, events),
      },
    };
    return { summary: rulesSuggestions.summary(shop), insights: rulesSuggestions.insights(shop) };
  }, [events, at]);
  const opened = insights.find((i) => i.id === open) ?? null;

  return (
    <div className="owner">
      {shop ? (
        <header className="owner__head">
          <button type="button" className="shops__back" onClick={onBack}>Shops</button>
          <span className="brand">{shop}</span>
          {data.state !== 'loading' && <span className="owner__updated">Updated {timeOf(at)}</span>}
        </header>
      ) : phone ? (
        <header className="owner__head">
          <span className="brand">CheesyBeez</span>
          {data.state !== 'loading' && <span className="owner__updated">Updated {timeOf(at)}</span>}
        </header>
      ) : <OwnerNav current="owner" onRegister={onBack} />}

      <main className="owner__main" aria-label="Owner">
        <section className="owner__today" aria-label="Today">
          <span className="owner__label">
            Today · {new Date(at).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}
          </span>
          {summary ? (
            <>
              <span className="owner__big num">Rs {fmt(summary.salesCents)}</span>
              <span className="owner__sub num">
                {summary.orders} {summary.orders === 1 ? 'order' : 'orders'}
                {summary.orders > 0 && ` · average Rs ${fmt(Math.round(summary.averageCents / 100) * 100)}`}
              </span>
            </>
          ) : (
            <span className="owner__big skeleton" aria-label="Loading" />
          )}
        </section>

        {offerInstall && install.kind === 'button' && (
          <p className="owner__install">
            <span>Put CheesyBeez on your home screen.</span>
            <button type="button" className="insight__action" onClick={install.install}>Install app</button>
          </p>
        )}
        {offerInstall && install.kind === 'iphone' && (
          <p className="owner__install">To put it on your home screen: tap <b>Share</b>, then <b>Add to Home Screen</b>.</p>
        )}

        {data.state === 'error' && (
          <p className="owner__note" role="status">
            {data.message.startsWith('This link')
              ? `${data.message} Ask for a new one.`
              : `${phone ? 'No connection' : 'Can’t reach the shop server'}${events ? `: showing the figures from ${timeOf(at)}.` : '.'}`}
          </p>
        )}

        <section className="owner__feed" aria-label="Needs your attention">
          {!events && [0, 1, 2].map((i) => <div key={i} className="insight skeleton" aria-hidden />)}
          {events && insights.length === 0 && <p className="owner__calm">Nothing needs you right now.</p>}
          {insights.map((i) => (
            <article key={i.id} className={`insight insight--${i.tone}`} aria-label={i.title}>
              <div className="insight__text">
                <h2>{i.title}</h2>
                <p>{i.detail}</p>
              </div>
              <button type="button" className="insight__action" onClick={() => setOpen(i.id)}>{i.action.label}</button>
            </article>
          ))}
        </section>
      </main>

      {opened && <Detail insight={opened} canReview={canReview} onClose={() => setOpen(null)} />}
    </div>
  );
}
