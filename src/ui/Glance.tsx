import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { Glance, Station, StationId } from '../domain/glance.ts';
import type { Insight } from '../domain/insights.ts';
import { fmt } from '../domain/money.ts';
import { TypeOut } from './TypeOut.tsx';

/**
 * Today at a glance (SCRUM-173). Serves the owner: he knows his shop, not the screens, and wants
 * to see in one look how it is doing, then ask "what is that?" of anything. The sales ring, the
 * shop as five stations from Deliveries to Money, sales by hour against a usual day, every
 * Rs 100 sold, a dot per stock item, and the To do list. Anything tapped explains itself on the
 * black screen (at the bottom on a phone, on the right on the counter PC), typed out; untapped,
 * the screen says the day in a sentence. Numbers count up on opening, and a station pulses when
 * something new happens there. Small charts as evidence, never a wall of them.
 */
const rs = (c: number) => `Rs ${fmt(Math.round(c / 100) * 100)}`;
const PULSE_MS = 900;
const COUNT_MS = 600;

const reduced = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function'
  && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** 0 → 1 over COUNT_MS once, eased; 1 at once with reduced motion. */
function useCountUp(): number {
  const [e, setE] = useState(() => (reduced() ? 1 : 0));
  useEffect(() => {
    if (e === 1) return;
    const start = performance.now();
    let id = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - start) / COUNT_MS);
      setE(1 - Math.pow(1 - k, 3));
      if (k < 1) id = requestAnimationFrame(step);
    };
    id = requestAnimationFrame(step);
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return e;
}

/** The stations whose number just changed: each pulses once. */
function usePulses(stations: readonly Station[]): ReadonlySet<StationId> {
  const last = useRef<Map<StationId, string> | null>(null);
  const [on, setOn] = useState<ReadonlySet<StationId>>(new Set());
  useEffect(() => {
    const now = new Map(stations.map((s) => [s.id, s.value]));
    const before = last.current;
    last.current = now;
    if (!before) return;
    const changed = new Set(stations.filter((s) => before.get(s.id) !== s.value).map((s) => s.id));
    if (!changed.size) return;
    setOn(changed);
    const t = setTimeout(() => setOn(new Set()), PULSE_MS);
    return () => clearTimeout(t);
  }, [stations]);
  return on;
}

const ICONS: Record<StationId, ReactNode> = {
  deliveries: <path d="M3 7h11v9H3zM14 10h4l3 3v3h-7M7 19a1.5 1.5 0 1 0 0-.01M17 19a1.5 1.5 0 1 0 0-.01" />,
  shelves: <path d="M3 8l9-5 9 5v8l-9 5-9-5zM3 8l9 5 9-5M12 13v8" />,
  kitchen: <path d="M12 3c1 3 4 4.5 4 8.5a4 4 0 0 1-8 0c0-2 1-3 2-4 0 1.5 1 2.5 2 2.5 0-2-1-4 0-7z" />,
  counter: <path d="M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6" />,
  money: <path d="M3 7h18v12H3zM3 11h18M16 15h2" />,
};
const icon = (d: ReactNode, size = 24) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>
);

/** What the black screen shows: a key per thing that can be tapped. */
type Key = 'summary' | 'ring' | 'split' | 'stock' | StationId | `hour:${number}` | `dot:${string}` | `todo:${string}`;

export function GlanceView({ glance: g, insights, links, onOpen }: {
  glance: Glance;
  insights: readonly Insight[];
  /** On the counter: each explanation links to its records (the owner's phone has no such screens). */
  links: boolean;
  /** Opens a To do item's list (and the count review). */
  onOpen: (id: string) => void;
}) {
  const [key, setKey] = useState<Key>('summary');
  const e = useCountUp();
  const pulses = usePulses(g.stations);
  const pick = (k: Key) => setKey((was) => (was === k ? 'summary' : k));
  const maxHour = Math.max(1, ...g.hours.map((h) => Math.max(h.today ?? 0, h.usual ?? 0)));
  const share = g.share === null ? null : Math.min(1, g.share);
  const C = 2 * Math.PI * 54;

  // What the screen says, and where its records are.
  const station = g.stations.find((s) => s.id === key);
  const todo = key.startsWith('todo:') ? insights.find((i) => `todo:${i.id}` === key) : undefined;
  const screen: { title: string; text: string; href?: string | null; open?: Insight } =
    key === 'summary' ? { title: 'Today in a sentence', text: g.summary }
      : key === 'ring' ? { title: 'Sales today', text: g.ringExplain }
        : key === 'split' && g.split ? { title: 'Every Rs 100', text: g.split.explain }
          : key === 'stock' ? { title: 'Stock', text: g.stock.explain, href: '#items' }
            : station ? { title: station.label, text: station.explain, href: station.href }
              : key.startsWith('hour:') ? { title: 'Sales by hour', text: g.hours.find((h) => `hour:${h.hour}` === key)?.explain ?? '' }
                : key.startsWith('dot:') ? { title: 'Stock', text: g.stock.dots.find((d) => `dot:${d.id}` === key)?.explain ?? '', href: `#items/item/${encodeURIComponent(key.slice(4))}` }
                  : todo ? {
                    title: 'To do',
                    text: [todo.title + '.', todo.detail, ...todo.action.items.slice(0, 4).map((i) => [i.primary, i.secondary].filter(Boolean).join(' · '))].filter(Boolean).join('\n'),
                    open: todo,
                  }
                    : { title: 'Today in a sentence', text: g.summary };

  return (
    <div className="glance">
      <div className="glance__main">
        <button type="button" className="glance__card glance__sales" aria-pressed={key === 'ring'} onClick={() => pick('ring')}
          aria-label={`Sales today ${rs(g.sales)}${share !== null ? `, ${Math.round((g.share ?? 0) * 100)}% of a usual day` : ''}`}>
          <svg className="glance__ring" viewBox="0 0 128 128" aria-hidden="true">
            <circle cx="64" cy="64" r="54" className="glance__ring-track" />
            {share !== null && <circle cx="64" cy="64" r="54" className="glance__ring-fill" strokeDasharray={`${(C * share * e).toFixed(1)} ${C.toFixed(1)}`} transform="rotate(-90 64 64)" />}
            <text x="64" y={share !== null ? 62 : 70} textAnchor="middle" className="glance__ring-pct">{share !== null ? `${Math.round((g.share ?? 0) * 100 * e)}%` : '–'}</text>
            {share !== null && <text x="64" y="82" textAnchor="middle" className="glance__ring-sub">of usual</text>}
          </svg>
          <span className="glance__sales-text">
            <span className="glance__label">Sales today</span>
            <span className="glance__big num">{rs(g.sales * e)}</span>
            <span className="glance__sub num">{Math.round(g.orders * e)} {g.orders === 1 ? 'order' : 'orders'}{g.usualDay !== null && <> · usual day {rs(g.usualDay)}</>}</span>
          </span>
        </button>

        <section className="glance__card" aria-label="The shop">
          <div className="glance__flow">
            <span className="glance__flow-line" aria-hidden="true" />
            {g.stations.map((s) => (
              <button key={s.id} type="button" className={`glance__st glance__st--${s.tone}${pulses.has(s.id) ? ' glance__st--pulse' : ''}`}
                aria-pressed={key === s.id} onClick={() => pick(s.id)}
                aria-label={`${s.label}: ${s.value}${s.badge ? `, ${s.badge} to look at` : s.tone === 'ok' ? ', fine' : ''}`}>
                <span className="glance__st-ring">
                  {icon(ICONS[s.id])}
                  {s.badge > 0 && <span className="glance__st-badge num" aria-hidden="true">{s.badge}</span>}
                </span>
                <span className="glance__st-label">{s.label}</span>
                <span className="glance__st-value num">{s.value}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="glance__card" aria-label="Sales by hour">
          <div className="glance__head">
            <span className="glance__label">Sales by hour</span>
            <span className="glance__legend">
              <span><i className="glance__key glance__key--today" />Today</span>
              {g.usualDay !== null && <span><i className="glance__key glance__key--usual" />Usual</span>}
            </span>
          </div>
          <div className="glance__bars">
            {g.hours.map((h) => (
              <button key={h.hour} type="button" className="glance__bar" aria-pressed={key === `hour:${h.hour}`} onClick={() => pick(`hour:${h.hour}`)}
                aria-label={`${h.label}: ${h.today === null ? 'still to come' : rs(h.today)}`}>
                {h.usual !== null && <span className="glance__bar-usual" style={{ height: `${(h.usual / maxHour) * 100 * e}%` }} />}
                {h.today !== null && <span className="glance__bar-today" style={{ height: `${(h.today / maxHour) * 100 * e}%` }} />}
              </button>
            ))}
          </div>
          <div className="glance__axis" aria-hidden="true">
            {g.hours.filter((_, i) => i % 3 === 0 || i === g.hours.length - 1).map((h) => <span key={h.hour}>{h.label}</span>)}
          </div>
        </section>

        <div className="glance__pair">
          <button type="button" className="glance__card" aria-pressed={key === 'split'} onClick={() => pick('split')} disabled={!g.split}
            aria-label={g.split ? `Every Rs 100 sold: Rs ${g.split.food} food, Rs ${g.split.waste} waste, Rs ${g.split.kept} kept` : 'Every Rs 100 sold: nothing sold yet'}>
            <span className="glance__label">Every Rs 100 sold</span>
            {g.split ? (
              <>
                <span className="glance__split" aria-hidden="true">
                  <span className="glance__split-food" style={{ flexGrow: Math.max(1, g.split.food) }} />
                  {g.split.waste > 0 && <span className="glance__split-waste" style={{ flexGrow: g.split.waste }} />}
                  <span className="glance__split-kept" style={{ flexGrow: Math.max(1, g.split.kept) }} />
                </span>
                <span className="glance__split-keys num">
                  <span><b>Rs {g.split.food}</b> food</span><span><b>Rs {g.split.waste}</b> waste</span><span><b>Rs {g.split.kept}</b> kept</span>
                </span>
              </>
            ) : <span className="glance__sub">Nothing sold yet.</span>}
          </button>

          <section className="glance__card" aria-label="Stock">
            <button type="button" className="glance__head glance__head--tap" aria-pressed={key === 'stock'} onClick={() => pick('stock')}>
              <span className="glance__label">Stock · <span className="num">{rs(g.stock.value)}</span></span>
              <span className="glance__sub num">{g.stock.low} low · {g.stock.out} out</span>
            </button>
            <div className="glance__dots">
              {g.stock.dots.map((d) => (
                <button key={d.id} type="button" className={`glance__dot glance__dot--${d.status}`} aria-pressed={key === `dot:${d.id}`}
                  aria-label={`${d.name}, ${d.status === 'ok' ? 'in stock' : d.status === 'unknown' ? 'never counted' : d.status}`} onClick={() => pick(`dot:${d.id}`)} />
              ))}
            </div>
          </section>
        </div>

        <section className="glance__todo" aria-label="Needs your attention">
          <span className="glance__label">To do{insights.length ? ` · ${insights.length}` : ''}</span>
          {insights.length === 0 && <p className="glance__calm">Nothing needs you right now.</p>}
          {insights.map((i) => (
            <article key={i.id} className={`glance__task glance__task--${i.tone}`} aria-label={i.title}>
              <button type="button" className="glance__task-main" aria-pressed={key === `todo:${i.id}`} onClick={() => pick(`todo:${i.id}`)}>
                <span className="glance__task-dot" aria-hidden="true" />
                <span>{i.title}</span>
              </button>
              <button type="button" className="insight__action" onClick={() => onOpen(i.id)}>{i.action.label}</button>
            </article>
          ))}
        </section>
      </div>

      <section className="glance__screen" aria-label="Shop screen">
        <div className="glance__screen-head">
          <span className="glance__screen-title">{screen.title}</span>
          {key !== 'summary' && (
            <button type="button" className="glance__screen-close" aria-label="Back to the summary" onClick={() => setKey('summary')}>
              {icon(<path d="M6 6l12 12M18 6L6 18" />, 18)}
            </button>
          )}
        </div>
        <div aria-live="polite"><TypeOut text={screen.text} className="glance__screen-text" /></div>
        {screen.open && <button type="button" className="glance__screen-link" onClick={() => onOpen(screen.open!.id)}>{screen.open.action.label} →</button>}
        {links && screen.href && <a className="glance__screen-link" href={screen.href}>See the records →</a>}
      </section>
    </div>
  );
}

/** The shape of what is coming while the history loads: never a spinner. */
export function GlanceSkeleton() {
  const box = (h: number): CSSProperties => ({ height: h });
  return (
    <div className="glance" aria-busy="true" aria-label="Loading">
      <div className="glance__main">
        <div className="glance__card skeleton" style={box(160)} />
        <div className="glance__card skeleton" style={box(120)} />
        <div className="glance__card skeleton" style={box(180)} />
      </div>
      <div className="glance__screen" />
    </div>
  );
}
