import { useEffect, useMemo, useState } from 'react';
import { rulesSuggestions, type Insight } from '../domain/insights.ts';
import { SEED_INVENTORY, SEED_SUPPLIERS } from '../domain/inventoryData.ts';
import { inventoryFromEvents, suppliersFromEvents } from '../domain/inventory.ts';
import { fmt } from '../domain/money.ts';
import { useInstall } from '../services/ownerApp.ts';
import { useShopEvents } from '../services/ownerData.ts';

/**
 * The Owner view. Serves the owner: they know the shop, not the screens, and
 * read this on a phone between other things. The one question it answers is
 * "does anything need me?": today in one line, then ONE feed of cards, each
 * with one tap behind it. No charts, no tables (CLAUDE.md).
 */
const timeOf = (t: number) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

function Detail({ insight, onClose }: { insight: Insight; onClose: () => void }) {
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
export function OwnerView({ phone = false, onBack }: { phone?: boolean; onBack?: () => void } = {}) {
  const data = useShopEvents();
  const install = useInstall();
  const [open, setOpen] = useState<string | null>(null);
  const events = data.state === 'ready' ? data.events : data.state === 'error' ? data.events : undefined;
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
      <header className="owner__head">
        <span className="brand">CheesyBeez</span>
        {phone ? (
          data.state !== 'loading' && <span className="owner__updated">Updated {timeOf(at)}</span>
        ) : (
          <nav className="owner__nav" aria-label="Owner sections">
            <a href="#menu">Menu</a>
            <a href="#setup">Shop setup</a>
            <a href="#inventory">Inventory</a>
            <a href="#suppliers">Suppliers</a>
            {onBack
              ? <button type="button" className="owner__back" onClick={onBack}>Register <kbd>F3</kbd></button>
              : <a href="#">Register</a>}
          </nav>
        )}
      </header>

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

        {phone && install.kind === 'button' && (
          <p className="owner__install">
            <span>Put CheesyBeez on your home screen.</span>
            <button type="button" className="insight__action" onClick={install.install}>Install app</button>
          </p>
        )}
        {phone && install.kind === 'iphone' && (
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

      {opened && <Detail insight={opened} onClose={() => setOpen(null)} />}
    </div>
  );
}
