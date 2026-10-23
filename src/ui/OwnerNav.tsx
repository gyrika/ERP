/**
 * The owner's and manager's menu (Owner, Manager, Menu, Recipes, Inventory, Suppliers, Shop
 * setup): the same tabs in the same place on every screen, the current one filled, a small
 * number where something waits, Register and Switch user at the bottom. OwnerShell puts it on
 * the left (a drawer on narrow screens). Everyone who sees it may open every tab but Recipes,
 * the owner's alone (Root still checks).
 */
import { useSyncExternalStore, type KeyboardEvent, type ReactNode } from 'react';
import { usesLogin } from '../services/auth.ts';
import { isManagerPhone } from '../services/pairing.ts';
import { signedIn, subscribeAuth } from '../services/serverAuth.ts';
import { useBadges } from './shellBadges.ts';

export type Section = 'owner' | 'manager' | 'menu' | 'recipes' | 'inventory' | 'suppliers' | 'setup';

/** Simple line icons, 20px, drawn in the text colour. */
const icon = (d: ReactNode) => (
  <svg className="oshell__icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{d}</svg>
);
const ICONS: Record<Section, ReactNode> = {
  owner: icon(<><path d="M4 19V10" /><path d="M10 19V5" /><path d="M16 19v-7" /><path d="M22 19H2" /></>),
  manager: icon(<><rect x="5" y="4" width="14" height="17" rx="2" /><path d="M9 4V3h6v1" /><path d="M9 10h6M9 14h6M9 18h3" /></>),
  menu: icon(<><path d="M4 5h16M4 12h16M4 19h10" /></>),
  recipes: icon(<><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></>),
  inventory: icon(<><path d="M3 8l9-5 9 5v8l-9 5-9-5z" /><path d="M3 8l9 5 9-5M12 13v8" /></>),
  suppliers: icon(<><path d="M2 6h11v10H2zM13 10h4l4 4v2h-8z" /><circle cx="6" cy="18" r="2" /><circle cx="17" cy="18" r="2" /></>),
  setup: icon(<><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1" /></>),
};

/** ownerOnly: the owner's recipes are the shop's secret; managers do not see the tab. */
export const SECTIONS: { id: Section; label: string; ownerOnly?: boolean }[] = [
  { id: 'owner', label: 'Owner' },
  { id: 'manager', label: 'Manager' },
  { id: 'menu', label: 'Menu' },
  { id: 'recipes', label: 'Recipes', ownerOnly: true },
  { id: 'inventory', label: 'Inventory' },
  { id: 'suppliers', label: 'Suppliers' },
  { id: 'setup', label: 'Shop setup' },
];
const PHONE = new Set<Section>(['manager', 'inventory']);
const BADGE_WORDS: Partial<Record<Section, string>> = { owner: 'to look at', inventory: 'to order' };

/** The tabs this person sees: the manager's phone app has counts and stock only. */
export function useSections() {
  const role = useSyncExternalStore(subscribeAuth, () => signedIn()?.role ?? null);
  const isOwner = !usesLogin() || role === 'owner';
  const phone = isManagerPhone();
  return SECTIONS.filter((s) => (phone ? PHONE.has(s.id) : isOwner || !s.ownerOnly));
}

export function OwnerMenu({ current, onRegister, onSwitch, onPick }: {
  current: Section;
  /** Back to selling (F3 does the same). The manager's phone has no Register. */
  onRegister?: () => void;
  /** Switch user (F4): the next person logs in. */
  onSwitch?: () => void;
  /** A tab was chosen (closes the drawer on narrow screens). */
  onPick?: () => void;
}) {
  const sections = useSections();
  const badges = useBadges();
  const person = useSyncExternalStore(subscribeAuth, signedIn);
  const phone = isManagerPhone();

  /** Up and down move between the tabs, like a list. */
  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const links = [...e.currentTarget.querySelectorAll<HTMLAnchorElement>('a')];
    const i = links.indexOf(document.activeElement as HTMLAnchorElement);
    if (i < 0) return;
    e.preventDefault();
    links[(i + (e.key === 'ArrowDown' ? 1 : links.length - 1)) % links.length].focus();
  };

  return (
    <>
      <span className="brand oshell__brand">CheesyBeez</span>
      <nav className="oshell__nav" aria-label="Owner sections" onKeyDown={onKey}>
        {sections.map((s, i) => {
          const n = badges[s.id] ?? 0;
          return (
            // The link is named by its label alone; the count is said as a description.
            <a key={s.id} href={`#${s.id}`} aria-current={s.id === current ? 'page' : undefined} onClick={onPick} aria-label={s.label}
              aria-describedby={n > 0 ? `badge-${s.id}` : undefined} title={i < 9 ? `Ctrl+${i + 1}` : undefined}>
              {ICONS[s.id]}
              <span className="oshell__label">{s.label}</span>
              {n > 0 && <span className="oshell__badge" aria-hidden>{n}</span>}
              {n > 0 && <span id={`badge-${s.id}`} className="sr-only">{n} {BADGE_WORDS[s.id] ?? 'waiting'}</span>}
            </a>
          );
        })}
      </nav>
      {!phone && (
        <div className="oshell__foot">
          {onRegister && <button type="button" className="oshell__register" aria-label="Register" onClick={onRegister}>Register <kbd aria-hidden>F3</kbd></button>}
          {person && onSwitch && (
            <div className="oshell__who">
              <span><b>{person.name}</b><small>{person.role === 'owner' ? 'Owner' : 'Manager'}</small></span>
              <button type="button" className="linkbtn" onClick={onSwitch}>Switch user</button>
            </div>
          )}
        </div>
      )}
    </>
  );
}
