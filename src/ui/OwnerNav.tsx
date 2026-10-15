/**
 * The one header for the owner's and manager's screens (Owner view, Menu,
 * Inventory, Suppliers, Shop setup): the same links in the same place on every
 * one, the current one marked. No key hints in it, so nothing shifts between
 * screens (F3 and Esc still work where they did). All of them are managers' and owners' screens, so
 * everyone who sees this bar may open every link but Recipes, the owner's alone (Root still checks).
 */
import { useSyncExternalStore } from 'react';
import { usesLogin } from '../services/auth.ts';
import { signedIn, subscribeAuth } from '../services/serverAuth.ts';

export type Section = 'owner' | 'manager' | 'menu' | 'recipes' | 'inventory' | 'suppliers' | 'setup';

/** ownerOnly: the owner's recipes are the shop's secret; managers do not see the link. */
const SECTIONS: { id: Section; label: string; ownerOnly?: boolean }[] = [
  { id: 'owner', label: 'Owner' },
  { id: 'manager', label: 'Manager' },
  { id: 'menu', label: 'Menu' },
  { id: 'recipes', label: 'Recipes', ownerOnly: true },
  { id: 'inventory', label: 'Inventory' },
  { id: 'suppliers', label: 'Suppliers' },
  { id: 'setup', label: 'Shop setup' },
];

export function OwnerNav({ current, onRegister }: {
  current: Section;
  /** Back to selling. Without it, a plain link to the Register. */
  onRegister?: () => void;
}) {
  const role = useSyncExternalStore(subscribeAuth, () => signedIn()?.role ?? null);
  const isOwner = !usesLogin() || role === 'owner';
  return (
    <header className="owner__head">
      <span className="brand">CheesyBeez</span>
      <nav className="owner__nav" aria-label="Owner sections">
        {SECTIONS.filter((s) => isOwner || !s.ownerOnly).map((s) => (
          <a key={s.id} href={`#${s.id}`} aria-current={s.id === current ? 'page' : undefined}>{s.label}</a>
        ))}
        {onRegister
          ? <button type="button" className="owner__back" onClick={onRegister}>Register</button>
          : <a href="#">Register</a>}
      </nav>
    </header>
  );
}
