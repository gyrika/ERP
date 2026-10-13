import { CATEGORIES, POPULAR_IDS, menuItems } from '../domain/menu.ts';
import { fmtPlain } from '../domain/money.ts';
import type { MenuItem, SizeId } from '../domain/types.ts';
import { useMenu } from './menuStore.ts';

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

/** What the owner offers: hidden items are not shown; sold-out ones show, greyed. */
const visible = (c: CategoryId): MenuItem[] =>
  (c === 'popular'
    ? POPULAR_IDS.map((id) => menuItems().find((m) => m.id === id)!).filter(Boolean)
    : menuItems().filter((m) => m.category === c)
  ).filter((m) => !m.hidden);

export function Menu({ category, onCategory, onQuickAdd, onCustomise, hint }: Props) {
  useMenu();
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
          <div key={item.id} className={`card${item.soldOut ? ' card--soldout' : ''}`}>
            {item.soldOut && <span className="card__soldout">Sold out</span>}
            <button type="button" className="card__title" disabled={item.soldOut} onClick={() => onCustomise(item)}>
              <span className="card__name">
                {item.number !== undefined && <span className="card__no num" aria-hidden="true">{item.number}</span>}
                {item.name.en}
              </span>
              <span className="card__desc">{item.description}</span>
            </button>
            <div className="card__prices">
              {item.variants && item.variants.length === 2 ? (
                item.variants.map((v) => (
                  <button key={v.id} type="button" className="price num" disabled={item.soldOut} onClick={() => onQuickAdd(item, v.id)}>
                    {v.id} {fmtPlain(v.price)}
                  </button>
                ))
              ) : item.variants ? (
                <button type="button" className="price num" disabled={item.soldOut} onClick={() => onCustomise(item)}>
                  from {fmtPlain(Math.min(...item.variants.map((v) => v.price)))}
                </button>
              ) : (
                <button type="button" className="price num" disabled={item.soldOut} onClick={() => onQuickAdd(item)}>
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
