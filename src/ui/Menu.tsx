import { useCallback } from 'react';
import { CATEGORIES, MENU, POPULAR_IDS } from '../domain/menu.ts';
import { fmtPlain } from '../domain/money.ts';
import { useActiveRecipes } from '../services/inventoryStore.ts';
import { RECIPES } from '../domain/recipes.ts';
import type { MenuItem, SizeId } from '../domain/types.ts';
import { isOutOfStock, useInventory } from '../services/inventoryStore.ts';

export type CategoryId = (typeof CATEGORIES)[number]['id'];

interface Props {
  category: CategoryId;
  onCategory: (c: CategoryId) => void;
  /** One tap on a price adds the item right away. */
  onQuickAdd: (item: MenuItem, size?: SizeId) => void;
  /** Tapping the name opens the extras sheet before adding. */
  onCustomise: (item: MenuItem) => void;
  hint: string;
}

/** Sold-out items remain visible but disabled. */
const visible = (c: CategoryId): MenuItem[] =>
  c === 'popular'
    ? POPULAR_IDS.flatMap((id) => {
        const item = MENU.find((menuItem) => menuItem.id === id);
        return item ? [item] : [];
      })
    : MENU.filter((item) => item.category === c);

export function Menu({ category, onCategory, onQuickAdd, onCustomise, hint }: Props) {
  const { items: inventoryItems } = useInventory();
  const activeRecipes = useActiveRecipes();

  const isMenuAvailable = useCallback(
    (menuItemId: string): boolean => {
      const dyn = activeRecipes[menuItemId];
      const recipe = dyn ? { baseIngredients: dyn } : RECIPES[menuItemId];
      if (!recipe) return true;
      for (const line of recipe.baseIngredients) {
        const ingredient = inventoryItems.find((inv) => inv.id === line.inventoryId);
        if (!ingredient) continue;
        if ((ingredient.onHandBaseUnits !== undefined && ingredient.onHandBaseUnits <= 0) || isOutOfStock(ingredient)) {
          return false;
        }
      }
      return true;
    },
    [inventoryItems, activeRecipes]
  );

  return (
    <>
      <nav className="cats" aria-label="Menu">
        {CATEGORIES.map((c) => (
          <button key={c.id} type="button" className="pill" aria-pressed={category === c.id} onClick={() => onCategory(c.id)}>
            {c.label}
          </button>
        ))}
        <span className="hint">{hint}</span>
      </nav>

      <div className="grid">
        {visible(category).map((item) => {
          const available = isMenuAvailable(item.id);
          return (
            <div key={item.id} className={`card${!available ? ' card--out' : ''}`} aria-disabled={!available ? 'true' : undefined}>
              <button
                type="button"
                className="card__title"
                aria-disabled={!available ? 'true' : undefined}
                onClick={available ? () => onCustomise(item) : undefined}
              >
                <span className="card__name">
                  {item.number !== undefined && <span className="card__no num" aria-hidden="true">{item.number}</span>}
                  {item.name.en}
                </span>
                {!available && <span className="inv-badge inv-badge--alert">Out of stock</span>}
                <span className="card__desc">{item.description}</span>
              </button>
              <div className="card__prices">
                {item.variants && item.variants.length === 2 ? (
                  item.variants.map((v) => (
                    <button
                      key={v.id}
                      type="button"
                      className="price num"
                      aria-disabled={!available ? 'true' : undefined}
                      onClick={available ? () => onQuickAdd(item, v.id) : undefined}
                    >
                      {v.id} {fmtPlain(v.price)}
                    </button>
                  ))
                ) : item.variants ? (
                  <button
                    type="button"
                    className="price num"
                    aria-disabled={!available ? 'true' : undefined}
                    onClick={available ? () => onCustomise(item) : undefined}
                  >
                    from {fmtPlain(Math.min(...item.variants.map((v) => v.price)))}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="price num"
                    aria-disabled={!available ? 'true' : undefined}
                    onClick={available ? () => onQuickAdd(item) : undefined}
                  >
                    {fmtPlain(item.price ?? 0)}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
