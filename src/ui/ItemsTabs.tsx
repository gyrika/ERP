import { isManagerPhone } from '../services/pairing.ts';

/**
 * Items: everything the shop holds, in the order the food goes: raw materials (bought from
 * suppliers), semi-processed (made in the kitchen), finished (on the menu, each with its recipe).
 * One place instead of Stock, Recipes, Menu and Suppliers. Semi-processed items are items, not
 * recipes: everyone sees them, with no PIN. Only the finished items' recipes are the owner's.
 */
export type ItemsTab = 'raw' | 'semi' | 'finished';

const TABS: { id: ItemsTab; label: string; href: string }[] = [
  { id: 'raw', label: 'Raw materials', href: '#items' },
  { id: 'semi', label: 'Semi-processed', href: '#items/semi' },
  { id: 'finished', label: 'Finished', href: '#items/finished' },
];

export function ItemsTabs({ current }: { current: ItemsTab }) {
  // The manager's phone has the stock only.
  if (isManagerPhone()) return null;
  return (
    <nav className="items-tabs" aria-label="Items">
      {TABS.map((t) => (
        <a key={t.id} href={t.href} className="pill" aria-current={t.id === current ? 'page' : undefined}>{t.label}</a>
      ))}
    </nav>
  );
}
