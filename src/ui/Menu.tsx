import { CATEGORIES, MENU, POPULAR_IDS } from '../domain/menu.ts';
import { fmtPlain } from '../domain/money.ts';
import type { MenuItem, SizeId } from '../domain/types.ts';

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

const visible = (c: CategoryId): MenuItem[] =>
  c === 'popular'
    ? POPULAR_IDS.map((id) => MENU.find((m) => m.id === id)!).filter(Boolean)
    : MENU.filter((m) => m.category === c);

export function Menu({ category, onCategory, onQuickAdd, onCustomise, hint }: Props) {
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
        {visible(category).map((item) => (
          <div key={item.id} className="card">
            <button type="button" className="card__title" onClick={() => onCustomise(item)}>
              <span className="card__name">{item.name.en}</span>
              <span className="card__desc">{item.description}</span>
            </button>
            <div className="card__prices">
              {item.variants && item.variants.length === 2 ? (
                item.variants.map((v) => (
                  <button key={v.id} type="button" className="price num" onClick={() => onQuickAdd(item, v.id)}>
                    {v.id} {fmtPlain(v.price)}
                  </button>
                ))
              ) : item.variants ? (
                <button type="button" className="price num" onClick={() => onCustomise(item)}>
                  from {fmtPlain(Math.min(...item.variants.map((v) => v.price)))}
                </button>
              ) : (
                <button type="button" className="price num" onClick={() => onQuickAdd(item)}>
                  {fmtPlain(item.price ?? 0)}
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
