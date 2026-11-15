import { comboBlocked, usualPick } from '../domain/combos.ts';
import { POPULAR_IDS, comboEntries, menuItems, menuSections } from '../domain/menu.ts';
import { sizeShort } from '../domain/sections.ts';
import { fmt } from '../domain/money.ts';
import type { Category, Combo, MenuItem, SizeId } from '../domain/types.ts';
import { photoUrl, shopHasPhotos } from '../services/menuPhotos.ts';
import { useMenu } from './menuStore.ts';

export type CategoryId = 'popular' | Category | 'combos';

interface Props {
  category: CategoryId;
  onCategory: (c: CategoryId) => void;
  /** One tap on a price adds the item right away. */
  onQuickAdd: (item: MenuItem, size?: SizeId) => void;
  /** Tapping the name opens the extras sheet before adding. */
  onCustomise: (item: MenuItem) => void;
  /** One tap on a combo's price adds the whole box with its usual picks (SCRUM-231). */
  onAddCombo: (comboId: string) => void;
  /** Opens typed shorthand ("2L margherita, burger"); absent in manager mode. */
  onType?: () => void;
}

/** What the owner offers: hidden items are not shown; sold-out ones show, greyed. */
const visible = (c: CategoryId): MenuItem[] =>
  (c === 'popular'
    ? POPULAR_IDS.map((id) => menuItems().find((m) => m.id === id)!).filter(Boolean)
    : menuItems().filter((m) => m.category === c)
  ).filter((m) => !m.hidden);

/** Combos on offer, in the order they were made. */
export const offeredCombos = (): { id: string; combo: Combo }[] => comboEntries().filter(({ combo }) => !combo.hidden);

/** The section bar's tabs in order: Alt+1 … Alt+9 pick them. Combos only once the shop has one: no empty tabs. */
export const menuTabs = (): CategoryId[] => sectionTabs().map((t) => t.id);
/** Popular, the sections the owner offers in his order (SCRUM-241), then Combos once there is one. */
const sectionTabs = (): { id: CategoryId; label: string }[] => [
  { id: 'popular', label: 'Popular' },
  ...menuSections().filter((s) => !s.hidden).map((s) => ({ id: s.id, label: s.label })),
  ...(offeredCombos().length ? [{ id: 'combos' as const, label: 'Combos' }] : []),
];

/** Up to this many sizes get a price button each on the card; more open the item. */
const BUTTONS = 3;

/** A dish of his own sections gets a plate. */
const PLATE = 'M3 13h18 M5 13a7 6 0 0 1 14 0 M12 5v2';
const ICON: Partial<Record<Category, string>> = {
  pizza: 'M12 21L3.5 6.6a14 14 0 0 1 17 0Z',
  burger: 'M4 11a8 7 0 0 1 16 0Z M3 14.5h18 M5 18h14',
  pasta: 'M3 12h18a9 8 0 0 1-18 0Z M8 12c0-3 1.8-5 4-5s4 2 4 5',
};

/** One slot of a box: filled = always that dish, dashed = a choice (one tap gives the usual). */
function SlotGlyph({ category, choice, mark }: { category: Category; choice: boolean; mark?: string }) {
  return (
    <span className={`slotg${choice ? ' slotg--choice' : ''}`}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d={ICON[category] ?? PLATE} />
      </svg>
      {mark && <span className="slotg__mark">{mark}</span>}
    </span>
  );
}

/** "Usual: Devilled Chicken L · 2 × Chicken Burger · Italian Pasta S". */
const comboLine = (combo: Combo, items: MenuItem[]): string => {
  const dishes = combo.slots.map((s) => {
    const m = usualPick(s, items);
    const size = s.size && m?.variants?.find((v) => v.id === s.size);
    return m ? `${s.qty > 1 ? `${s.qty} × ` : ''}${m.name.en}${size ? ` ${sizeShort(size)}` : ''}` : '';
  }).filter(Boolean).join(' · ');
  return combo.slots.some((s) => Object.keys(s.options).length > 1) ? `Usual: ${dishes}` : dishes;
};

export function Menu({ category, onCategory, onQuickAdd, onCustomise, onAddCombo, onType }: Props) {
  useMenu();
  const combos = offeredCombos();
  // The tab shows only once the shop has a combo: no empty tabs.
  const tabs = sectionTabs();
  // A tab that went away (no combos left, a section hidden) falls back to Popular.
  const showing = tabs.some((t) => t.id === category) ? category : 'popular';
  const items = menuItems();
  // Photos on the tiles once the shop has any; an item without one keeps a blank, so the grid stays even.
  const photos = shopHasPhotos();
  /** A tap on the photo: the first size, or the item's only price; more sizes than buttons open the item. */
  const photoTap = (item: MenuItem) => {
    if (item.variants && item.variants.length <= BUTTONS && item.variants[0]) onQuickAdd(item, item.variants[0].id);
    else if (!item.variants) onQuickAdd(item);
    else onCustomise(item);
  };
  return (
    <>
      <nav className="cats" aria-label="Menu">
        {tabs.map((c, i) => (
          <button key={c.id} type="button" className="pill" aria-pressed={showing === c.id} onClick={() => onCategory(c.id)}
            title={i < 9 ? `Alt+${i + 1}` : undefined}>
            {c.label}
          </button>
        ))}
        {/* Always in sight: any letter or digit opens it too, so the keyboard never has to aim. */}
        {onType && <button type="button" className="typeit" onClick={onType}>Type an order…</button>}
      </nav>

      {showing === 'combos' ? (
        <div className="grid">
          {combos.map(({ id, combo }) => {
            const blocked = comboBlocked(combo, items);
            return (
              <div key={id} className={`card${blocked ? ' card--soldout' : ''}`}>
                {blocked && <span className="card__soldout">{blocked}</span>}
                <div className="card__slots" aria-hidden="true">
                  {combo.slots.map((s, i) => {
                    const m = items.find((x) => x.id === s.usual);
                    return m && (
                      <SlotGlyph key={i} category={m.category} choice={Object.keys(s.options).length > 1}
                        mark={s.qty > 1 ? `×${s.qty}` : (s.size && m.variants?.find((v) => v.id === s.size) ? sizeShort(m.variants.find((v) => v.id === s.size)!) : s.size)} />
                    );
                  })}
                </div>
                <div className="card__title">
                  <span className="card__name">{combo.name.en}</span>
                  <span className="card__desc">{comboLine(combo, items)}</span>
                </div>
                <div className="card__prices">
                  <button type="button" className="price num" disabled={Boolean(blocked)} onClick={() => onAddCombo(id)}
                    aria-label={`Add ${combo.name.en}, ${fmt(combo.price)}`}>
                    {fmt(combo.price)}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="grid">
          {visible(showing).map((item) => (
            <div key={item.id} className={`card${photos ? ' card--photo' : ''}${item.soldOut ? ' card--soldout' : ''}`}>
              {photos && (
                // The same as the price buttons below, for the hand: no second stop for the keyboard.
                <button type="button" className="card__photo" tabIndex={-1} aria-hidden="true" disabled={item.soldOut} onClick={() => photoTap(item)}>
                  {photoUrl(item.id) && <img src={photoUrl(item.id)!} alt="" loading="lazy" decoding="async" draggable={false} />}
                </button>
              )}
              {item.soldOut && <span className="card__soldout">Sold out</span>}
              <button type="button" className="card__title" disabled={item.soldOut} onClick={() => onCustomise(item)}>
                <span className="card__name">
                  {item.number !== undefined && <span className="card__no num" aria-hidden="true">{item.number}</span>}
                  {item.name.en}
                </span>
                <span className="card__desc">{item.description}</span>
              </button>
              <div className="card__prices">
                {item.variants && item.variants.length >= 1 && item.variants.length <= BUTTONS ? (
                  item.variants.map((v) => (
                    // Three to a card: the size small above its price, so it fits a narrow tile.
                    <button key={v.id} type="button" className={`price num${item.variants!.length === 3 ? ' price--stack' : ''}`} disabled={item.soldOut} onClick={() => onQuickAdd(item, v.id)}>
                      {item.variants!.length === 3 ? <><span>{sizeShort(v)}</span> {fmt(v.price)}</> : <>{sizeShort(v)} {fmt(v.price)}</>}
                    </button>
                  ))
                ) : item.variants ? (
                  <button type="button" className="price num" disabled={item.soldOut} onClick={() => onCustomise(item)}>
                    from {fmt(Math.min(...item.variants.map((v) => v.price)))}
                  </button>
                ) : (
                  <button type="button" className="price num" disabled={item.soldOut} onClick={() => onQuickAdd(item)}>
                    {fmt(item.price ?? 0)}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
