import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { MENU } from '../domain/menu.ts';
import { fmt } from '../domain/money.ts';
import { normalisePhone, onlineLineTotal, onlineTotal, type OnlineLine } from '../domain/online.ts';
import type { Category, MenuItem, SizeId } from '../domain/types.ts';
import { api, remembered, type MyOrder, type Placed, type ShopInfo } from './api.ts';

/**
 * cheesybeez.com: order ahead, collect it hot, pay at the shop.
 * Serves the customer at home on their phone: hungry, knows what they like, and
 * wants one thing next: their order placed in under a minute, then to know when it
 * is ready. So: the menu, a basket, name and phone, and a live status. No account.
 */
const rs = (cents: number) => `Rs ${fmt(cents)}`;
const SECTIONS: { id: Category; label: string }[] = [
  { id: 'pizza', label: 'Pizza' }, { id: 'burger', label: 'Burgers' }, { id: 'pasta', label: 'Pasta' },
];
const itemOf = (id: string) => MENU.find((m) => m.id === id)!;
const fromPrice = (m: MenuItem) => (m.variants ? m.variants[0].price : (m.price ?? 0));

/** "2 × Devilled Chicken · Large · Full cheese · No onion" */
export const lineText = (l: OnlineLine): string => {
  const item = itemOf(l.itemId);
  const parts = [
    item.variants?.find((v) => v.id === l.size)?.label,
    ...l.adds.map((id) => item.adds.find((o) => o.id === id)?.label),
    ...l.outs.map((id) => item.leaveOut.find((o) => o.id === id)?.label),
  ].filter(Boolean);
  return [`${l.qty > 1 ? `${l.qty} × ` : ''}${item.name.en}`, ...parts].join(' · ');
};

const same = (a: OnlineLine, b: OnlineLine) =>
  a.itemId === b.itemId && a.size === b.size && [...a.adds].sort().join() === [...b.adds].sort().join() && [...a.outs].sort().join() === [...b.outs].sort().join();

function useEscape(onClose: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
}

function Sheet({ label, onClose, children }: { label: string; onClose: () => void; children: React.ReactNode }) {
  useEscape(onClose);
  return (
    <>
      <div className="o-scrim" onClick={onClose} />
      <div className="o-sheet" role="dialog" aria-modal="true" aria-label={label}>
        <button type="button" className="o-sheet__close" onClick={onClose} aria-label="Close">×</button>
        {children}
      </div>
    </>
  );
}

/** One item: size, extras, leave-outs, how many. Sensible defaults, so "Add" is often the only tap. */
function ItemSheet({ item, onAdd, onClose }: { item: MenuItem; onAdd: (l: OnlineLine) => void; onClose: () => void }) {
  const [size, setSize] = useState<SizeId | undefined>(item.variants?.[0].id);
  const [adds, setAdds] = useState<string[]>([]);
  const [outs, setOuts] = useState<string[]>([]);
  const [qty, setQty] = useState(1);
  const line: OnlineLine = { itemId: item.id, qty, ...(size ? { size } : {}), adds, outs };
  const toggle = (list: string[], set: (v: string[]) => void, id: string) => set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  return (
    <Sheet label={item.name.en} onClose={onClose}>
      <h2 className="o-sheet__title">{item.name.en}</h2>
      <p className="o-sheet__desc">{item.description}</p>
      {item.variants && (
        <fieldset className="o-group">
          <legend>Size</legend>
          <div className="o-chips">
            {item.variants.map((v) => (
              <button key={v.id} type="button" className="o-chip" aria-pressed={size === v.id} onClick={() => setSize(v.id)}>
                {v.label}{v.hint && <span className="o-chip__hint"> {v.hint}</span>}<span className="o-chip__price">{rs(v.price)}</span>
              </button>
            ))}
          </div>
        </fieldset>
      )}
      {item.adds.length > 0 && (
        <fieldset className="o-group">
          <legend>Extras</legend>
          <div className="o-chips">
            {item.adds.map((o) => (
              <button key={o.id} type="button" className="o-chip" aria-pressed={adds.includes(o.id)} onClick={() => toggle(adds, setAdds, o.id)}>
                {o.label}<span className="o-chip__price">+{fmt(o.price)}</span>
              </button>
            ))}
          </div>
        </fieldset>
      )}
      {item.leaveOut.length > 0 && (
        <fieldset className="o-group">
          <legend>Leave out</legend>
          <div className="o-chips">
            {item.leaveOut.map((o) => (
              <button key={o.id} type="button" className="o-chip" aria-pressed={outs.includes(o.id)} onClick={() => toggle(outs, setOuts, o.id)}>
                {o.label}
              </button>
            ))}
          </div>
        </fieldset>
      )}
      <div className="o-sheet__foot">
        <div className="o-qty" role="group" aria-label="How many">
          <button type="button" onClick={() => setQty((q) => Math.max(1, q - 1))} aria-label="One fewer" disabled={qty === 1}>−</button>
          <span className="num" aria-live="polite">{qty}</span>
          <button type="button" onClick={() => setQty((q) => Math.min(20, q + 1))} aria-label="One more">+</button>
        </div>
        <button type="button" className="o-primary" onClick={() => onAdd(line)}>Add · {rs(onlineLineTotal(line))}</button>
      </div>
    </Sheet>
  );
}

function Checkout({ basket, shop, onChange, onPlaced, onClose }: {
  basket: OnlineLine[]; shop: ShopInfo | null; onChange: (b: OnlineLine[]) => void; onPlaced: (p: Placed) => void; onClose: () => void;
}) {
  const [me, setMe] = useState(remembered.me);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const phoneOk = normalisePhone(me.phone) !== null;
  const ready = me.name.trim() !== '' && phoneOk && basket.length > 0 && shop?.open === true && !sending;
  const setQty = (i: number, qty: number) => onChange(qty < 1 ? basket.filter((_, j) => j !== i) : basket.map((l, j) => (j === i ? { ...l, qty: Math.min(20, qty) } : l)));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    setSending(true);
    setError('');
    try {
      remembered.setMe(me);
      onPlaced(await api.place({ name: me.name, phone: me.phone, note, lines: basket }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSending(false);
    }
  };

  return (
    <Sheet label="Your order" onClose={onClose}>
      <h2 className="o-sheet__title">Your order</h2>
      <ul className="o-basket">
        {basket.map((l, i) => (
          <li key={i}>
            <span className="o-basket__text">{lineText({ ...l, qty: 1 })}</span>
            <div className="o-qty o-qty--small" role="group" aria-label={`How many ${itemOf(l.itemId).name.en}`}>
              <button type="button" onClick={() => setQty(i, l.qty - 1)} aria-label={l.qty === 1 ? 'Remove' : 'One fewer'}>−</button>
              <span className="num">{l.qty}</span>
              <button type="button" onClick={() => setQty(i, l.qty + 1)} aria-label="One more">+</button>
            </div>
            <span className="num o-basket__price">{fmt(onlineLineTotal(l))}</span>
          </li>
        ))}
      </ul>
      {basket.length === 0 && <p className="o-muted">Your order is empty.</p>}
      <div className="o-total"><span>Total</span><b className="num">{rs(onlineTotal(basket))}</b></div>

      <form className="o-form" onSubmit={(e) => void submit(e)}>
        <label>Your name
          <input value={me.name} onChange={(e) => setMe({ ...me, name: e.target.value })} autoComplete="given-name" maxLength={40} required />
        </label>
        <label>Phone number
          <input value={me.phone} onChange={(e) => setMe({ ...me, phone: e.target.value })} type="tel" inputMode="tel" autoComplete="tel" placeholder="077 123 4567" required />
          {me.phone && !phoneOk && <span className="o-hint">A Sri Lankan number, like 077 123 4567</span>}
        </label>
        <label><span>Note for the shop <span className="o-muted">(optional)</span></span>
          <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={140} placeholder="Extra spicy, cut in 8…" />
        </label>
        {error && <p className="o-error" role="alert">{error}</p>}
        {shop && !shop.open && <p className="o-error" role="status">The shop is not taking online orders right now.</p>}
        <button type="submit" className="o-primary o-primary--wide" disabled={!ready}>
          {sending ? 'Sending…' : `Place order · ${rs(onlineTotal(basket))}`}
        </button>
        <p className="o-muted o-center">Pickup at the shop. Pay when you collect: cash or bank transfer.</p>
      </form>
    </Sheet>
  );
}

const STEPS = ['Sent', 'Accepted', 'Ready'] as const;
const at = (ms: number) => new Date(ms).toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true });

/** The order after it is placed: one big line saying where it is, and the number to say at the counter. */
function Status({ placed, onDone, onAgain }: { placed: Placed; onDone: () => void; onAgain: () => void }) {
  const [order, setOrder] = useState<MyOrder | null>(null);
  const [lost, setLost] = useState(false);
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try { const o = await api.order(placed.id, placed.token); if (!stop) { setOrder(o); setLost(false); } }
      catch { if (!stop) setLost(true); }
      if (!stop) timer = setTimeout(() => void load(), 5_000);
    };
    void load();
    return () => { stop = true; clearTimeout(timer); };
  }, [placed]);

  const step = !order ? 0 : order.status === 'new' ? 0 : order.status === 'accepted' ? 1 : order.status === 'ready' || order.status === 'collected' ? 2 : -1;
  const ended = order && ['declined', 'expired', 'collected'].includes(order.status);

  return (
    <main className="o-status" aria-label="Your order">
      {!order ? <div className="o-skeleton" aria-label="Loading" /> : (
        <>
          {step >= 0 && (
            <ol className="o-steps" aria-label="Progress">
              {STEPS.map((s, i) => <li key={s} className={i <= step ? 'is-done' : ''} aria-current={i === step ? 'step' : undefined}>{s}</li>)}
            </ol>
          )}
          {order.status === 'new' && (<>
            <h1>Sent to the shop</h1>
            <p className="o-lead">Waiting for them to accept it. This usually takes a few minutes; keep this page open.</p>
          </>)}
          {order.status === 'accepted' && (<>
            <p className="o-kicker">Your order number</p>
            <h1 className="o-number num">{order.orderNumber}</h1>
            <p className="o-lead">Accepted. Ready around <b>{order.readyBy ? at(order.readyBy) : 'soon'}</b>. Say your number at the counter.</p>
          </>)}
          {order.status === 'ready' && (<>
            <p className="o-kicker">Ready for pickup</p>
            <h1 className="o-number num">{order.orderNumber}</h1>
            <p className="o-lead">It’s hot and waiting. Say your number at the counter and pay there.</p>
          </>)}
          {order.status === 'collected' && (<>
            <h1>Enjoy your meal</h1>
            <p className="o-lead">Thank you for ordering from CheesyBeez.</p>
          </>)}
          {order.status === 'declined' && (<>
            <h1>Sorry, the shop couldn’t take this order</h1>
            <p className="o-lead">{order.reason}.</p>
          </>)}
          {order.status === 'expired' && (<>
            <h1>The shop didn’t answer in time</h1>
            <p className="o-lead">Your order was not made. Please try again in a little while.</p>
          </>)}
          {lost && <p className="o-muted" role="status">No connection: trying again…</p>}

          <section className="o-receipt" aria-label="What you ordered">
            <ul>{order.lines.map((l, i) => <li key={i}><span>{lineText(l)}</span><span className="num">{fmt(onlineLineTotal(l))}</span></li>)}</ul>
            <div className="o-total"><span>To pay at the shop</span><b className="num">{rs(order.total)}</b></div>
          </section>
          {ended && (
            <div className="o-actions">
              <button type="button" className="o-primary" onClick={onAgain}>Order the same again</button>
              <button type="button" className="o-link" onClick={onDone}>Back to the menu</button>
            </div>
          )}
        </>
      )}
    </main>
  );
}

export function OrderSite() {
  const [shop, setShop] = useState<ShopInfo | null>(null);
  const [shopError, setShopError] = useState(false);
  const [basket, setBasketState] = useState<OnlineLine[]>(remembered.basket);
  const [placed, setPlaced] = useState<Placed | null>(remembered.current);
  const [open, setOpen] = useState<MenuItem | null>(null);
  const [checkout, setCheckout] = useState(false);
  const [added, setAdded] = useState(0);

  useEffect(() => {
    const load = () => api.shop().then((s) => { setShop(s); setShopError(false); }, () => setShopError(true));
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => { if (shop) document.title = `${shop.name} · Order online`; }, [shop]);

  const setBasket = useCallback((b: OnlineLine[]) => { setBasketState(b); remembered.setBasket(b); }, []);
  const add = (l: OnlineLine) => {
    const hit = basket.findIndex((x) => same(x, l));
    setBasket(hit >= 0 ? basket.map((x, i) => (i === hit ? { ...x, qty: Math.min(20, x.qty + l.qty) } : x)) : [...basket, l]);
    setOpen(null);
    setAdded((n) => n + 1);
  };
  const count = useMemo(() => basket.reduce((n, l) => n + l.qty, 0), [basket]);

  if (placed) {
    return (
      <div className="o-page">
        <Header shop={shop} />
        <Status
          placed={placed}
          onDone={() => { remembered.setCurrent(null); setPlaced(null); }}
          onAgain={() => { setBasket(remembered.last()); remembered.setCurrent(null); setPlaced(null); setCheckout(true); }}
        />
      </div>
    );
  }

  return (
    <div className="o-page">
      <Header shop={shop} />
      <section className="o-hero">
        <h1>Order ahead.<br /><span>Collect it hot.</span></h1>
        <p>Choose, send, and pick it up at the shop. You pay when you collect.</p>
        {shop && !shop.open && <p className="o-closed" role="status">Online orders are closed right now. You can still look at the menu.</p>}
        {shopError && <p className="o-closed" role="status">Can’t reach CheesyBeez right now. Check your connection.</p>}
      </section>

      <nav className="o-tabs" aria-label="Menu sections">
        {SECTIONS.map((s) => <a key={s.id} href={`#${s.id}`}>{s.label}</a>)}
      </nav>

      <main className="o-menu">
        {SECTIONS.map((s) => (
          <section key={s.id} id={s.id} className="o-section" aria-labelledby={`h-${s.id}`}>
            <h2 id={`h-${s.id}`}>{s.label}</h2>
            <ul className="o-items">
              {MENU.filter((m) => m.category === s.id).map((m) => (
                <li key={m.id}>
                  <button type="button" className="o-item" onClick={() => setOpen(m)}>
                    <span className="o-item__name">{m.name.en}</span>
                    <span className="o-item__desc">{m.description}</span>
                    <span className="o-item__price num">{m.variants ? 'from ' : ''}{rs(fromPrice(m))}</span>
                    <span className="o-item__add" aria-hidden>+</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </main>
      <footer className="o-foot">CheesyBeez · Pizza, burgers and pasta</footer>

      {count > 0 && (
        <div className="o-bar">
          <button type="button" className="o-primary o-primary--wide" key={added} onClick={() => setCheckout(true)}>
            <span className="o-bar__count num">{count}</span> View order <span className="num">{rs(onlineTotal(basket))}</span>
          </button>
        </div>
      )}
      {open && <ItemSheet item={open} onAdd={add} onClose={() => setOpen(null)} />}
      {checkout && (
        <Checkout
          basket={basket} shop={shop} onChange={setBasket} onClose={() => setCheckout(false)}
          onPlaced={(p) => { remembered.setLast(basket); remembered.setCurrent(p); setBasket([]); setCheckout(false); setPlaced(p); }}
        />
      )}
    </div>
  );
}

function Header({ shop }: { shop: ShopInfo | null }) {
  return (
    <header className="o-head">
      <span className="o-brand">
        <img src="/icons/icon-192.png" alt="" width={32} height={32} />CheesyBeez
      </span>
      {shop && (
        <span className={`o-pill${shop.open ? ' o-pill--open' : ''}`}>
          {shop.open ? 'Open for pickup' : 'Online orders closed'}
        </span>
      )}
    </header>
  );
}
