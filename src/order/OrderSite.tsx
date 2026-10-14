import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { menuItems, setMenuState } from '../domain/menu.ts';
import { fmt } from '../domain/money.ts';
import { Banknote, Clock, Hamburger, MapPin, MessageCircle, Phone, Pizza, Plus, ShoppingBag, Soup } from 'lucide-react';
import { clockText, normalisePhone, onlineLineTotal, onlineTotal, statusText, type OnlineLine } from '../domain/online.ts';
import { SHOP_HEADER } from '../domain/receipt.ts';
import type { Category, MenuItem, MenuTag, SizeId } from '../domain/types.ts';
import { api, remembered, type MyOrder, type Placed, type ShopInfo } from './api.ts';
import { HERO, PHOTOS } from './photos.ts';

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
const itemOf = (id: string) => {
  const item = menuItems().find((entry) => entry.id === id);
  if (!item) throw new Error(`Unknown menu item: ${id}`);
  return item;
};
/**
 * What the page knows about taking orders: one state at a time. A check that fails says
 * nothing about the shop, so it is never shown as closed.
 */
type Taking = 'loading' | 'open' | 'closed' | 'failed';

/** The one message for the state, or nothing (loading and open need none). */
function TakingNote({ taking, onRetry, closed }: { taking: Taking; onRetry: () => void; closed: string }) {
  if (taking === 'closed') return <p className="o-closed" role="status">{closed}</p>;
  if (taking === 'failed') {
    return (
      <p className="o-closed o-closed--retry" role="status">
        <span>We couldn&apos;t check if we&apos;re open.</span>
        <button type="button" className="o-link" onClick={onRetry}>Retry</button>
      </p>
    );
  }
  return null;
}

/** Header (64) + chips (72): the line just under them decides which section is being read. */
const UNDER_CHIPS = 136;
const smooth = (): ScrollBehavior => (window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ? 'auto' : 'smooth');

/**
 * The Pizza / Burgers / Pasta chips: sticky under the header, the section being read filled in
 * the accent, a tap scrolls smoothly there. Plain links underneath, so they work without script.
 */
function SectionTabs() {
  const [active, setActive] = useState<Category>(SECTIONS[0].id);
  /** While a tap's smooth scroll runs, the sections it passes do not take the highlight. */
  const jumping = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    let under: string | null = null;
    let atEnd = false;
    const pick = () => {
      if (jumping.current) return;
      // The last section is short and may never reach the line: at the end of the page, it is the one.
      const id = atEnd ? SECTIONS[SECTIONS.length - 1].id : under;
      if (id) setActive(id as Category);
    };
    let line: IntersectionObserver | null = null;
    /** A 1px band just under the chips: exactly one section crosses it at a time. */
    const watchLine = () => {
      line?.disconnect();
      line = new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (e.isIntersecting) under = e.target.id;
          // Scrolling back up past a section's start: the one before it is being read (Pizza above the first).
          else if (e.target.id === under && e.boundingClientRect.top >= UNDER_CHIPS) {
            const i = SECTIONS.findIndex((sec) => sec.id === under);
            under = SECTIONS[Math.max(0, i - 1)].id;
          }
        }
        pick();
      }, { rootMargin: `-${UNDER_CHIPS}px 0px -${Math.max(0, window.innerHeight - UNDER_CHIPS - 1)}px 0px` });
      SECTIONS.forEach((sec) => { const el = document.getElementById(sec.id); if (el) line!.observe(el); });
    };
    const end = new IntersectionObserver((entries) => { atEnd = entries.some((e) => e.isIntersecting); pick(); });
    const foot = document.querySelector('.o-foot');
    if (foot) end.observe(foot);
    watchLine();
    window.addEventListener('resize', watchLine);
    return () => {
      line?.disconnect(); end.disconnect(); window.removeEventListener('resize', watchLine);
      if (jumping.current) clearTimeout(jumping.current);
    };
  }, []);

  const go = (e: React.MouseEvent, id: Category) => {
    const el = document.getElementById(id);
    if (!el) return;
    e.preventDefault();
    setActive(id);
    if (jumping.current) clearTimeout(jumping.current);
    jumping.current = setTimeout(() => { jumping.current = null; }, 800);
    el.scrollIntoView?.({ behavior: smooth(), block: 'start' });
    history.replaceState(null, '', `#${id}`);
  };

  return (
    <nav className="o-tabs" aria-label="Menu sections">
      {SECTIONS.map((sec) => (
        <a key={sec.id} href={`#${sec.id}`} aria-current={active === sec.id ? 'true' : undefined} onClick={(e) => go(e, sec.id)}>{sec.label}</a>
      ))}
    </nav>
  );
}

const PLACEHOLDER: Record<Category, typeof Pizza> = { pizza: Pizza, burger: Hamburger, pasta: Soup };
const TAG_LABEL: Record<MenuTag, string> = { popular: 'Popular', veg: 'Veg' };

/**
 * One menu card: photo (or a quiet placeholder), tags, name, two lines of description, price.
 * The card opens the full sheet (extras, leave-outs); the + beside it is the quick add.
 */
function ItemCard({ item, closed, onOpen, onQuickAdd }: { item: MenuItem; closed: boolean; onOpen: () => void; onQuickAdd: () => void }) {
  const photo = PHOTOS[item.id];
  const Icon = PLACEHOLDER[item.category];
  return (<>
    <button type="button" className={`o-item${item.soldOut ? ' o-item--out' : ''}`} disabled={item.soldOut} onClick={onOpen}>
      <span className="o-item__photo">
        {photo ? <img src={photo} alt="" width={96} height={96} loading="lazy" decoding="async" /> : <Icon aria-hidden />}
      </span>
      <span className="o-item__body">
        {item.tags && item.tags.length > 0 && (
          <span className="o-item__tags">
            {item.tags.map((t) => <span key={t} className={`o-tag o-tag--${t}`}>{TAG_LABEL[t]}</span>)}
          </span>
        )}
        <span className="o-item__name">{item.name.en}</span>
        <span className="o-item__desc">{item.description}</span>
        <span className="o-item__price num">
          {item.soldOut ? <span className="o-item__from">Sold out today</span> : (<>
            {item.variants && <span className="o-item__from">from </span>}
            <span className="o-item__amount">{rs(fromPrice(item))}</span>
          </>)}
        </span>
      </span>
    </button>
    {!closed && !item.soldOut && (
      <button type="button" className="o-item__add" aria-label={`Add ${item.name.en}`} onClick={onQuickAdd}><Plus aria-hidden /></button>
    )}
  </>);
}

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
function ItemSheet({ item, closed, onAdd, onClose }: { item: MenuItem; closed: boolean; onAdd: (l: OnlineLine) => void; onClose: () => void }) {
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
        <button type="button" className="o-primary" disabled={closed} onClick={() => onAdd(line)}>
          {closed ? 'Closed for online orders' : `Add · ${rs(onlineLineTotal(line))}`}
        </button>
      </div>
    </Sheet>
  );
}

/** The + on an item with sizes: one tap on a size adds it with the defaults. */
function SizeSheet({ item, onAdd, onMore, onClose }: { item: MenuItem; onAdd: (l: OnlineLine) => void; onMore: () => void; onClose: () => void }) {
  return (
    <Sheet label={`${item.name.en}: choose a size`} onClose={onClose}>
      <h2 className="o-sheet__title">{item.name.en}</h2>
      <div className="o-sizes">
        {item.variants?.map((v) => (
          <button key={v.id} type="button" className="o-size" onClick={() => onAdd({ itemId: item.id, qty: 1, size: v.id, adds: [], outs: [] })}>
            <span className="o-size__label">{v.label}{v.hint && <span className="o-chip__hint"> {v.hint}</span>}</span>
            <span className="num o-size__price">{rs(v.price)}</span>
          </button>
        ))}
      </div>
      {(item.adds.length > 0 || item.leaveOut.length > 0) && (
        <button type="button" className="o-link o-sizes__more" onClick={onMore}>Extras or leave something out</button>
      )}
    </Sheet>
  );
}

/** The order's lines with − / + ; − on the last one removes the line. Shared by the checkout sheet and the desktop panel. */
function BasketLines({ basket, onChange }: { basket: OnlineLine[]; onChange: (b: OnlineLine[]) => void }) {
  const setQty = (i: number, qty: number) => onChange(qty < 1 ? basket.filter((_, j) => j !== i) : basket.map((l, j) => (j === i ? { ...l, qty: Math.min(20, qty) } : l)));
  return (
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
  );
}

/** Desktop only (CSS): the order stays in view on the right while the menu scrolls. */
function CartPanel({ basket, onChange, onCheckout }: { basket: OnlineLine[]; onChange: (b: OnlineLine[]) => void; onCheckout: () => void }) {
  return (
    <section className="o-panel o-cart" aria-label="Your order">
      <h2 className="o-panel__title">Your order</h2>
      {basket.length === 0 ? <p className="o-cart__empty"><ShoppingBag aria-hidden />Your order is empty</p> : (<>
        <BasketLines basket={basket} onChange={onChange} />
        <div className="o-total"><span>Total</span><b className="num">{rs(onlineTotal(basket))}</b></div>
        <button type="button" className="o-primary o-primary--wide" onClick={onCheckout}>Checkout</button>
      </>)}
    </section>
  );
}

/** 0771817968 → "077 181 7968" */
const phoneText = (p: string) => `${p.slice(0, 3)} ${p.slice(3, 6)} ${p.slice(6)}`;

/**
 * Desktop, under the order: where to collect, when, how to pay, and a way to ask. Only what the
 * owner has given (the cloud's ORDER_PHONE / ORDER_ADDRESS / ORDER_HOURS); a missing one is left out.
 */
function PickupInfo({ shop }: { shop: ShopInfo | null }) {
  const place = shop?.address ?? SHOP_HEADER.lines.join(', ');
  const maps = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${SHOP_HEADER.name} ${place}`)}`;
  const phone = shop?.phone;
  return (
    <section className="o-panel o-info" aria-label="Pickup info">
      <h2 className="o-panel__title">Pickup info</h2>
      <ul className="o-info__rows">
        <li><MapPin aria-hidden /><span>{SHOP_HEADER.name}, {place}<br /><a href={maps} target="_blank" rel="noopener noreferrer">Open in Maps</a></span></li>
        {shop?.hours && <li><Clock aria-hidden /><span>Daily {clockText(shop.hours.opens)} – {clockText(shop.hours.closes)}</span></li>}
        <li><Banknote aria-hidden /><span>Pay when you collect: cash or bank transfer</span></li>
      </ul>
      {phone && (<>
        <p className="o-info__ask">Questions? <span className="num">{phoneText(phone)}</span></p>
        <div className="o-info__actions">
          <a className="o-btn" href={`tel:+94${phone.slice(1)}`}><Phone aria-hidden />Call</a>
          <a className="o-btn" href={`https://wa.me/94${phone.slice(1)}`} target="_blank" rel="noopener noreferrer"><MessageCircle aria-hidden />WhatsApp</a>
        </div>
      </>)}
    </section>
  );
}

function Checkout({ basket, taking, onRetry, onChange, onPlaced, onClose }: {
  basket: OnlineLine[]; taking: Taking; onRetry: () => void; onChange: (b: OnlineLine[]) => void; onPlaced: (p: Placed) => void; onClose: () => void;
}) {
  const [me, setMe] = useState(remembered.me);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const phoneOk = normalisePhone(me.phone) !== null;
  const ready = me.name.trim() !== '' && phoneOk && basket.length > 0 && taking === 'open' && !sending;

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
      <BasketLines basket={basket} onChange={onChange} />
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
        <TakingNote taking={taking} onRetry={onRetry} closed="The shop is not taking online orders right now." />
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
  const [taking, setTaking] = useState<Taking>('loading');
  const checks = useRef(0);
  const [basket, setBasketState] = useState<OnlineLine[]>(remembered.basket);
  const [placed, setPlaced] = useState<Placed | null>(remembered.current);
  const [open, setOpen] = useState<MenuItem | null>(null);
  const [sizeFor, setSizeFor] = useState<MenuItem | null>(null);
  const [checkout, setCheckout] = useState(false);
  /** Bumps on every add: replays the bar's pop and the toast. */
  const [added, setAdded] = useState(0);
  const [toast, setToast] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  /** Asks the cloud; only the newest answer counts. A failure keeps the last menu but not the last open/closed. */
  const check = useCallback(() => {
    const n = ++checks.current;
    api.shop().then((s) => {
      if (n !== checks.current) return;
      if (s.menuState) setMenuState(s.menuState);
      setShop(s);
      setTaking(s.open ? 'open' : 'closed');
    }, () => { if (n === checks.current) setTaking('failed'); });
  }, []);
  const retry = useCallback(() => { setTaking('loading'); check(); }, [check]);
  useEffect(() => {
    check();
    const t = setInterval(check, 60_000);
    return () => clearInterval(t);
  }, [check]);
  useEffect(() => { if (shop) document.title = `${shop.name} · Order online`; }, [shop]);

  const setBasket = useCallback((b: OnlineLine[]) => { setBasketState(b); remembered.setBasket(b); }, []);
  const add = (l: OnlineLine) => {
    if (taking === 'closed') return;
    const hit = basket.findIndex((x) => same(x, l));
    setBasket(hit >= 0 ? basket.map((x, i) => (i === hit ? { ...x, qty: Math.min(20, x.qty + l.qty) } : x)) : [...basket, l]);
    setOpen(null);
    setSizeFor(null);
    setAdded((n) => n + 1);
    setToast(true);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(false), 1800);
  };
  /** The + : one size goes straight in; several sizes ask which first. */
  const quickAdd = (m: MenuItem) => {
    if (m.variants && m.variants.length > 1) setSizeFor(m);
    else add({ itemId: m.id, qty: 1, ...(m.variants ? { size: m.variants[0].id } : {}), adds: [], outs: [] });
  };
  const count = useMemo(() => basket.reduce((n, l) => n + l.qty, 0), [basket]);

  if (placed) {
    return (
      <div className="o-page">
        <Header taking={taking} shop={shop} onRetry={retry} />
        <div className="o-wrap o-wrap--narrow">
          <Status
            placed={placed}
            onDone={() => { remembered.setCurrent(null); setPlaced(null); }}
            onAgain={() => { setBasket(remembered.last()); remembered.setCurrent(null); setPlaced(null); setCheckout(true); }}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="o-page">
      <Header taking={taking} shop={shop} onRetry={retry} />
      {/* Edge to edge; the headline stays in the centred container. */}
      <section className="o-hero">
        <picture>
          <source media="(min-width: 640px)" srcSet={HERO.large} />
          <img src={HERO.small} alt="" width={800} height={600} fetchPriority="high" decoding="async" />
        </picture>
        <div className="o-wrap o-hero__text">
          <h1>Order ahead.<br /><span>Collect it hot.</span></h1>
          <p>Order here, collect at the shop.</p>
        </div>
      </section>
      <div className="o-wrap o-layout">
        <div className="o-col">
          <ul className="o-trust">
            <li><ShoppingBag aria-hidden />Pickup only</li>
            <li><Banknote aria-hidden />Pay when you collect</li>
            <li><Clock aria-hidden />We confirm your ready time</li>
          </ul>

          <SectionTabs />

          <main className="o-menu">
            {SECTIONS.map((s) => (
              <section key={s.id} id={s.id} className="o-section" aria-labelledby={`h-${s.id}`}>
                <h2 id={`h-${s.id}`}>{s.label}</h2>
                <ul className="o-items">
                  {menuItems().filter((m) => m.category === s.id && !m.hidden).map((m) => (
                    <li key={m.id}>
                      <ItemCard item={m} closed={taking === 'closed'} onOpen={() => setOpen(m)} onQuickAdd={() => quickAdd(m)} />
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </main>
          <footer className="o-foot">CheesyBeez · Pizza, burgers and pasta</footer>
        </div>
        <aside className="o-side" aria-label="Your order and pickup">
          <CartPanel basket={basket} onChange={setBasket} onCheckout={() => setCheckout(true)} />
          <PickupInfo shop={shop} />
        </aside>
      </div>

      {/* Phones: slides up with the first item; the desktop has the panel instead. */}
      {count > 0 && (
        <div className="o-bar">
          <button type="button" className="o-primary o-primary--wide" key={added} onClick={() => setCheckout(true)}>
            <span className="num">{`${count} ${count === 1 ? 'item' : 'items'} · ${rs(onlineTotal(basket))} · View order`}</span>
          </button>
        </div>
      )}
      <div className="o-toast-at" aria-live="polite">{toast && <div className="o-toast" key={added}>Added to order</div>}</div>
      {sizeFor && <SizeSheet item={sizeFor} onAdd={add} onMore={() => { setOpen(sizeFor); setSizeFor(null); }} onClose={() => setSizeFor(null)} />}
      {open && <ItemSheet item={open} closed={taking === 'closed'} onAdd={add} onClose={() => setOpen(null)} />}
      {checkout && (
        <Checkout
          basket={basket} taking={taking} onRetry={retry} onChange={setBasket} onClose={() => setCheckout(false)}
          onPlaced={(p) => { remembered.setLast(basket); remembered.setCurrent(p); setBasket([]); setCheckout(false); setPlaced(p); }}
        />
      )}
    </div>
  );
}

/**
 * Logo left, the shop's state right: the only place the page says whether it takes orders.
 * Loading is a quiet placeholder; a failed check offers Retry and never claims closed.
 */
function Header({ taking, shop, onRetry }: { taking: Taking; shop: ShopInfo | null; onRetry: () => void }) {
  return (
    <header className="o-head">
      <div className="o-wrap o-head__in">
        <span className="o-brand">
          <img src="/icons/icon-192.png" alt="" width={32} height={32} />CheesyBeez
        </span>
        {taking === 'loading' && <span className="o-pill o-pill--loading" aria-hidden />}
        {(taking === 'open' || taking === 'closed') && (
          <span className={`o-pill o-pill--${taking}`} role="status">
            {statusText(taking === 'open', shop?.hours ?? null, Date.now())}
          </span>
        )}
        {taking === 'failed' && (
          <button type="button" className="o-pill o-pill--retry" onClick={onRetry} aria-label="We couldn't check if we're open. Retry">
            Couldn&apos;t check · <u>Retry</u>
          </button>
        )}
      </div>
    </header>
  );
}
