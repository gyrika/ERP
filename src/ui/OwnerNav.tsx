/**
 * The owner's and manager's screens share one sidebar (SCRUM-131), laid out like ChatGPT's list
 * of chats: the parts of the shop on the left, each with one line saying what is going on there
 * and a badge only when something there needs a decision; the part picked fills the right.
 * Serves the owner: they know the shop, not the screens, and want to see what needs them
 * without opening every screen. Parts needing him come first ("Needs you"), the rest after.
 * Ctrl K (or "Ask or find") jumps to any part. On a narrow screen the list folds into a drawer.
 * Recipes are the owner's alone (Root still checks); a manager's phone shows Counts and Stock only.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { ownerParts, type PartId, type PartLine } from '../domain/ownerParts.ts';
import type { SyncEvent } from '../domain/sync.ts';
import { usesLogin } from '../services/auth.ts';
import { useShopEvents } from '../services/ownerData.ts';
import { isManagerPhone } from '../services/pairing.ts';
import { signedIn, subscribeAuth } from '../services/serverAuth.ts';
import { CommandPalette } from './CommandPalette.tsx';

export type Section = PartId;

/** ownerOnly: the owner's recipes are the shop's secret; managers do not see the part. */
const PARTS: { id: Section; label: string; ownerOnly?: boolean }[] = [
  { id: 'owner', label: 'Today' },
  { id: 'inventory', label: 'Stock' },
  { id: 'menu', label: 'Menu' },
  { id: 'recipes', label: 'Recipes', ownerOnly: true },
  { id: 'manager', label: 'Counts' },
  { id: 'suppliers', label: 'Suppliers' },
  { id: 'setup', label: 'Shop setup' },
];
const PHONE = new Set<Section>(['manager', 'inventory']);

/** Every screen beside the sidebar reads the same history, so its lines are worked out once. */
let last: { events: readonly SyncEvent[]; lines: Record<Section, PartLine> } | null = null;
const linesFor = (events: readonly SyncEvent[], at: number) => {
  if (last?.events !== events) last = { events, lines: ownerParts(events, at) };
  return last.lines;
};

export function OwnerNav({ current, onRegister }: {
  current: Section;
  /** Back to selling. Without it, a plain link to the Register. */
  onRegister?: () => void;
}) {
  const role = useSyncExternalStore(subscribeAuth, () => signedIn()?.role ?? null);
  const isOwner = !usesLogin() || role === 'owner';
  // The manager's phone app (SCRUM-94): counts and stock only, and no Register.
  const phone = isManagerPhone();
  const data = useShopEvents();
  const events = data.state === 'loading' ? undefined : data.events;
  const at = data.state === 'loading' ? 0 : data.at ?? Date.now();
  const lines = useMemo(() => (events ? linesFor(events, at) : null), [events, at]);
  const [drawer, setDrawer] = useState(false);
  const [asking, setAsking] = useState(false);

  const parts = PARTS.filter((p) => (phone ? PHONE.has(p.id) : isOwner || !p.ownerOnly));
  const needsYou = parts.filter((p) => (lines?.[p.id].badge ?? 0) > 0);
  const quiet = parts.filter((p) => !needsYou.includes(p));
  const here = parts.find((p) => p.id === current);

  useEffect(() => {
    if (phone) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setAsking(true); }
      else if (e.key === 'Escape' && (asking || drawer)) { e.stopImmediatePropagation(); setAsking(false); setDrawer(false); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [phone, asking, drawer]);

  const go = (id: Section) => { location.hash = `#${id}`; };
  const row = (p: (typeof PARTS)[number]) => {
    const line = lines?.[p.id];
    return (
      <li key={p.id}>
        <a
          href={`#${p.id}`} className="side__part" aria-current={p.id === current ? 'page' : undefined}
          aria-label={p.label} aria-describedby={`side-${p.id}`} onClick={() => setDrawer(false)}
        >
          <span className="side__text">
            <span className="side__label">{p.label}</span>
            {line ? <span className="side__preview" id={`side-${p.id}`}>{line.preview}</span>
              : <span className="side__preview skeleton" id={`side-${p.id}`} />}
          </span>
          {line && line.badge > 0 && <span className="side__badge num" aria-hidden="true">{line.badge}</span>}
        </a>
      </li>
    );
  };

  return (
    <>
      <div className="side-top">
        <button type="button" className="side-top__open" aria-label="Show the parts of the shop" aria-expanded={drawer} onClick={() => setDrawer(true)}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
            <line x1="4" y1="7" x2="20" y2="7" /><line x1="4" y1="12" x2="20" y2="12" /><line x1="4" y1="17" x2="14" y2="17" />
          </svg>
        </button>
        <span className="side-top__title">{here?.label ?? 'CheesyBeez'}</span>
      </div>
      {drawer && <div className="side__scrim" onClick={() => setDrawer(false)} />}
      <nav className={`side${drawer ? ' side--open' : ''}`} aria-label="Owner sections">
        <div className="side__head">
          <span className="brand">CheesyBeez</span>
        </div>
        {!phone && (
          <button type="button" className="side__ask" onClick={() => setAsking(true)}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
              <circle cx="11" cy="11" r="7" /><line x1="16.5" y1="16.5" x2="21" y2="21" />
            </svg>
            <span>Ask or find…</span>
            <kbd>Ctrl K</kbd>
          </button>
        )}
        {needsYou.length > 0 && (
          <>
            <h2 className="side__group">Needs you</h2>
            <ul className="side__list">{needsYou.map(row)}</ul>
          </>
        )}
        {lines && <h2 className="side__group">{needsYou.length ? 'All quiet' : 'Nothing needs you'}</h2>}
        <ul className="side__list">{quiet.map(row)}</ul>
        {!phone && (
          <div className="side__foot">
            {onRegister
              ? <button type="button" className="side__register" onClick={onRegister}>Register</button>
              : <a className="side__register" href="#">Register</a>}
          </div>
        )}
      </nav>
      {asking && (
        <CommandPalette
          placeholder="Ask or find…"
          commands={[
            // Its line too, so "onion" finds Stock when onion is what is going on there.
            ...parts.map((p) => ({ id: p.id, label: lines ? `${p.label} · ${lines[p.id].preview}` : p.label, run: () => go(p.id) })),
            { id: 'register', label: 'Register', run: () => (onRegister ? onRegister() : void (location.hash = '')) },
          ]}
          onClose={() => setAsking(false)}
        />
      )}
    </>
  );
}
