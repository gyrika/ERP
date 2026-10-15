import { useEffect, useMemo, useState } from 'react';
import type { Actor } from '../domain/auth.ts';
import { OwnerPin } from './OwnerPin.tsx';
import {
  countedSince, countsDue, dailyStreak, dayGrid, monthStart, startOfDay, tiersOf, weekStart, type DayCell, type DueCount, type Tier,
} from '../domain/counting.ts';
import { answerGap, setCountTier, useCountHistory, useGapCases, useInventory } from '../services/inventoryStore.ts';
import { asked, MAX_NOTE, type GapCase } from '../domain/gapReview.ts';
import { reasonLabel } from '../domain/counting.ts';
import { formatQuantity } from '../domain/quantity.ts';
import { fmt } from '../domain/money.ts';
import { useWaitingPhotos } from '../services/photos.ts';
import { useInstall } from '../services/ownerApp.ts';
import { isManagerPhone } from '../services/pairing.ts';
import { CountFlow } from './CountFlow.tsx';
import { OwnerNav } from './OwnerNav.tsx';

/**
 * The manager's page (SCRUM-90). Serves the manager at the start of a shift: they
 * know the shop; what they need next is what to count today, and how they are
 * keeping up. Today's progress, then the three count lists (daily, weekly,
 * monthly) each with one Start, then the record of past days, GitHub style.
 * The same page opens on the manager's phone later (story 2). The owner can move
 * any item to another list (Edit lists, owner PIN every time, locks after a minute
 * untouched); the rest stay automatic.
 */
const TIERS: { id: Tier; label: string; period: string }[] = [
  { id: 'daily', label: 'Daily', period: 'today' },
  { id: 'weekly', label: 'Weekly', period: 'this week' },
  { id: 'monthly', label: 'Monthly', period: 'this month' },
];
/** Edit lists closes after this long untouched. */
export const EDIT_IDLE_MS = 60_000;
const DAY_NAMES = ['Mon', '', 'Wed', '', 'Fri', '', ''];
const dayLabel = (t: number) => new Date(t).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
const monthLabel = (t: number) => new Date(t).toLocaleDateString('en-GB', { month: 'short' });

export function ManagerView({ onRegister }: { onRegister?: () => void }) {
  const { items } = useInventory();
  const history = useCountHistory();
  const [counting, setCounting] = useState<DueCount[] | null>(null);
  /** Edit lists: closed, asking for the owner's PIN, or open for that owner. */
  const [edit, setEdit] = useState<'closed' | 'pin' | Actor>('closed');
  const editor = typeof edit === 'object' ? edit : null;
  const waiting = useWaitingPhotos();
  /** A day picked on the record: its counts are listed below it (SCRUM-97). */
  const [picked, setPicked] = useState<number | null>(null);
  const questions = asked(useGapCases());
  // The manager's phone app (SCRUM-94): offered for the home screen; the lists are edited at the shop.
  const phone = isManagerPhone();
  const install = useInstall();

  useEffect(() => {
    if (!editor) return;
    let t = setTimeout(() => setEdit('closed'), EDIT_IDLE_MS);
    const awake = () => { clearTimeout(t); t = setTimeout(() => setEdit('closed'), EDIT_IDLE_MS); };
    const events = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
    for (const e of events) window.addEventListener(e, awake, { passive: true });
    return () => { clearTimeout(t); for (const e of events) window.removeEventListener(e, awake); };
  }, [editor]);
  const now = Date.now();

  const tiers = useMemo(() => tiersOf(items), [items]);
  const due = useMemo(() => countsDue(items, tiers, now), [items, tiers, now]);
  const byTier = (t: Tier) => items.filter((i) => (tiers.get(i.id) ?? 'monthly') === t);
  const since: Record<Tier, number> = { daily: startOfDay(now), weekly: weekStart(now), monthly: monthStart(now) };

  // Today: what was due at the start of the day (still due, or counted today).
  const countedToday = new Set(history.filter((c) => c.at >= since.daily).map((c) => c.itemId));
  const todayTotal = due.length + countedToday.size;
  const todayDone = countedToday.size;

  const dailyIds = useMemo(() => new Set(items.filter((i) => tiers.get(i.id) === 'daily').map((i) => i.id)), [items, tiers]);
  const cells = useMemo(() => dayGrid(history, dailyIds, now, 52), [history, dailyIds, now]);
  const streak = dailyStreak(cells, now);

  return (
    <div className="owner">
      <OwnerNav current="manager" onRegister={onRegister} />
      <main className="owner__main mgr" aria-label="Manager">
        <div className="mgr__title-row">
          <h1 className="mgr__title">Counts</h1>
          {phone ? null : edit === 'pin'
            ? <OwnerPin onOpen={setEdit} onCancel={() => setEdit('closed')} refusal="Only the owner can edit the lists." />
            : (
              <button type="button" className="chip" aria-pressed={!!editor} onClick={() => setEdit(editor ? 'closed' : 'pin')}>
                {editor ? 'Done' : 'Edit lists'}
              </button>
            )}
        </div>
        {phone && install.kind === 'button' && (
          <p className="owner__install">
            <span>Put CheesyBeez Manager on your home screen.</span>
            <button type="button" className="insight__action" onClick={install.install}>Install app</button>
          </p>
        )}
        {phone && install.kind === 'iphone' && (
          <p className="owner__install">To put it on your home screen: tap <b>Share</b>, then <b>Add to Home Screen</b>.</p>
        )}
        {waiting > 0 && <p className="mgr__hint" role="status">{waiting} {waiting === 1 ? 'photo waits' : 'photos wait'} for the signal; they send by themselves.</p>}
        {editor && <p className="mgr__hint">Move any item to another list. Automatic follows what sales use.</p>}

        {questions.length > 0 && (
          <section className="mgr__asks" aria-label="The owner asks">
            <h2>The owner asks</h2>
            {questions.map((q) => {
              const item = items.find((i) => i.id === q.itemId);
              return <Question key={q.countId} gap={q} name={item?.name ?? q.itemId}
                gapText={`${item ? formatQuantity(Math.abs(q.delta), item.baseUnit) : Math.abs(q.delta)} ${q.delta < 0 ? 'short' : 'over'} · ${reasonLabel(q.reason)} · Rs ${fmt(Math.abs(q.valueCents))}`} />;
            })}
          </section>
        )}

        <section className="mgr__today" aria-label="Today">
          <div className="mgr__today-head">
            <span className="mgr__today-label">{dayLabel(now)}</span>
            <strong className="num">{todayDone} of {todayTotal} counted today</strong>
          </div>
          <div className="mgr__bar" role="progressbar" aria-label="Counted today" aria-valuemin={0} aria-valuemax={todayTotal} aria-valuenow={todayDone}>
            <span style={{ width: `${todayTotal ? (todayDone / todayTotal) * 100 : 100}%` }} />
          </div>
          {due.length > 0
            ? <button type="button" className="cta mgr__start" onClick={() => setCounting(due)}>Count all {due.length} due</button>
            : <p className="mgr__alldone">Everything due today is counted.</p>}
        </section>

        <div className="mgr__tiers">
          {TIERS.map((t) => {
            const list = byTier(t.id);
            const tierDue = due.filter((d) => d.tier === t.id);
            const done = countedSince(history, list.map((i) => i.id), since[t.id]);
            return (
              <section key={t.id} className="mgr__tier" aria-label={`${t.label} counts`}>
                <header className="mgr__tier-head">
                  <h2>{t.label}</h2>
                  <span className="num">{done} of {list.length} {t.period}</span>
                </header>
                <ul className="mgr__items">
                  {list.length === 0 && <li className="mgr__none">Nothing here yet: tiers follow what sales use.</li>}
                  {list.map((i) => {
                    const d = tierDue.find((x) => x.id === i.id);
                    const state = !d ? 'done' : d.state;
                    return (
                      <li key={i.id}>
                        <span>{i.name}</span>
                        {editor ? (
                          <select className="mgr__pick" aria-label={`How often to count ${i.name}`} value={i.tier ?? 'auto'}
                            onChange={(e) => setCountTier(i.id, e.target.value === 'auto' ? null : e.target.value as Tier, editor)}>
                            <option value="auto">Automatic</option>
                            {TIERS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
                          </select>
                        ) : (
                          <span className={`mgr__chip mgr__chip--${state}`}>
                            {state === 'done' ? 'Done' : state === 'overdue' ? 'Overdue' : state === 'never' ? 'First count' : 'Due'}
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
                {tierDue.length > 0 && (
                  <button type="button" className="insight__action" onClick={() => setCounting(tierDue)}>
                    Start {t.label.toLowerCase()} · {tierDue.length}
                  </button>
                )}
              </section>
            );
          })}
        </div>

        <section className="mgr__history" aria-label="Count record">
          <header className="mgr__tier-head">
            <h2>Record</h2>
            <span className="num">{streak > 0 ? `Daily count done ${streak} ${streak === 1 ? 'day' : 'days'} in a row` : 'No streak yet'}</span>
          </header>
          <Grid cells={cells} picked={picked} onPick={(d) => setPicked(picked === d ? null : d)} />
          {picked !== null && (
            <div className="mgr__day" aria-label={`Counts on ${dayLabel(picked)}`} role="region">
              <h3>{dayLabel(picked)}</h3>
              <ul>
                {history.filter((c) => startOfDay(c.at) === picked).slice().reverse().map((c) => (
                  <li key={c.id}>
                    <span>{items.find((i) => i.id === c.itemId)?.name ?? c.itemId}</span>
                    <span className={c.big && c.valueCents < 0 ? 'mgr__day-gap' : 'mgr__day-ok'}>
                      {c.big ? `${c.valueCents < 0 ? 'short' : 'over'} Rs ${fmt(Math.abs(c.valueCents))} · ${reasonLabel(c.reason!)}` : 'matched'}
                    </span>
                    <span className="mgr__day-by">{c.by} · {new Date(c.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="mgr__legend" aria-hidden="true">
            <span>Less</span>{[0, 1, 2, 3].map((l) => <i key={l} className={`mgr__cell mgr__cell--${l}`} />)}<span>Every daily item</span>
          </div>
        </section>
      </main>
      {counting && <CountFlow due={counting} rows={items} onClose={() => setCounting(null)} />}
    </div>
  );
}

/** One question from the owner about a gap, answered in a line or two (SCRUM-95). */
function Question({ gap, name, gapText }: { gap: GapCase; name: string; gapText: string }) {
  const [note, setNote] = useState('');
  if (gap.review.kind !== 'asked') return null;
  return (
    <form className="mgr__ask" aria-label={`Question about ${name}`} onSubmit={(e) => { e.preventDefault(); if (note.trim()) answerGap(gap, note); }}>
      <p><strong>{name}</strong> · {gapText}</p>
      <p className="mgr__ask-q">{gap.review.by}: {gap.review.note || 'Please explain.'}</p>
      <textarea className="inv-modal__input" rows={2} maxLength={MAX_NOTE} value={note} aria-label={`Your answer about ${name}`}
        placeholder="What happened?" onChange={(e) => setNote(e.target.value)} />
      <button type="submit" className="insight__action" disabled={!note.trim()}>Answer</button>
    </form>
  );
}

function Grid({ cells, picked, onPick }: { cells: DayCell[]; picked: number | null; onPick: (day: number) => void }) {
  const weeks: DayCell[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return (
    <div className="mgr__grid-wrap">
      <div className="mgr__grid" role="group" aria-label={`Count record, last ${weeks.length} weeks`}>
        <div className="mgr__days" aria-hidden="true">{DAY_NAMES.map((d, i) => <span key={i}>{d}</span>)}</div>
        {weeks.map((w, wi) => (
          <div key={wi} className="mgr__week">
            <span className="mgr__month" aria-hidden="true">
              {wi === 0 || new Date(w[0].day).getMonth() !== new Date(weeks[wi - 1][0].day).getMonth() ? monthLabel(w[0].day) : ''}
            </span>
            {w.map((c) => {
              const label = c.level === null ? undefined : `${dayLabel(c.day)} · ${c.counted ? `${c.daily} daily, ${c.counted} counted${c.gaps ? ` · ${c.gaps} ${c.gaps === 1 ? 'gap' : 'gaps'}` : ''}` : 'no counts'}`;
              // A day with counts opens its list (SCRUM-97); an empty day has nothing to show.
              return c.counted
                ? <button key={c.day} type="button" className={`mgr__cell mgr__cell--${c.level} mgr__cell--pick`} aria-pressed={picked === c.day}
                    title={label} aria-label={label} onClick={() => onPick(c.day)} />
                : <i key={c.day} className={`mgr__cell mgr__cell--${c.level ?? 'future'}`} title={label} />;
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
