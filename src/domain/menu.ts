import type { MenuItem, Option, Variant } from './types.ts';

/** Rupees → cents. */
const rs = (n: number) => n * 100;

const opt = (id: string, label: string, price = 0): Option => ({ id, label, price });

/**
 * The real CheesyBeez printed menus (Pizza p1–2, Burger, Pasta). Names,
 * descriptions and prices are copied from them; item numbers are the
 * numbers staff and customers use. Sinhala/Tamil labels are not filled in
 * yet: they must come from the owner, not be guessed.
 */

const PIZZA_ADDS: Option[] = [
  opt('full-cheese', 'Full cheese', rs(600)),
  opt('half-cheese', 'Half cheese', rs(300)),
  opt('chicken', 'Chicken', rs(400)),
  opt('sausages', 'Sausages', rs(300)),
  opt('bacon', 'Bacon', rs(450)),
  opt('seafood', 'Seafood', rs(400)),
  opt('tonno', 'Tonno', rs(350)),
  opt('bbq-pork', 'BBQ pork', rs(350)),
];

const BURGER_ADDS: Option[] = [
  opt('cheese-slice', 'Cheese slice', rs(150)),
  opt('bullseye', 'Bullseye (Egg)', rs(70)),
  opt('chicken-patty', 'Chicken patty', rs(170)),
  opt('bacon-egg', 'Bacon & Egg', rs(360)),
];

const NO = {
  onion: opt('no-onion', 'No onion'),
  capsicum: opt('no-capsicum', 'No capsicum'),
  pepper: opt('no-bell-pepper', 'No bell pepper'),
  tomato: opt('no-tomato', 'No tomato'),
  mushroom: opt('no-mushroom', 'No mushroom'),
  corn: opt('no-sweet-corn', 'No sweet corn'),
  lettuce: opt('no-lettuce', 'No lettuce'),
  sauce: opt('no-sauce', 'No burger sauce'),
  spicy: opt('less-spicy', 'Less spicy'),
};

const pizzaSizes = (m: number, l: number): Variant[] => [
  { id: 'M', label: 'Medium', hint: '10"', price: rs(m) },
  { id: 'L', label: 'Large', hint: '12"', price: rs(l) },
];

const pizza = (
  id: string, name: string, description: string, aliases: string[],
  m: number, l: number, leaveOut: Option[],
): MenuItem => ({
  id, category: 'pizza', name: { en: name }, description, aliases,
  variants: pizzaSizes(m, l), adds: PIZZA_ADDS, leaveOut,
});

const burger = (
  id: string, name: string, description: string, aliases: string[], price: number, leaveOut: Option[],
): MenuItem => ({
  id, category: 'burger', name: { en: name }, description, aliases,
  price: rs(price), adds: BURGER_ADDS, leaveOut,
});

export const MENU: MenuItem[] = [
  // ----- Pizza · Classic -----
  pizza('margherita', 'Margherita', 'Mozzarella cheese & rich tomato sauce', ['margherita', 'margarita', 'marg'], 1450, 1990, []),
  pizza('cheese-onion', 'Cheese & Onion', 'Mozzarella cheese with onion', ['cheese and onion', 'cheese onion', 'cheese'], 1450, 1990, [NO.onion]),
  pizza('veggie', 'Veggie', 'Sweet corn, mushroom, onion, bell pepper & tomato', ['veggie', 'vegetable', 'veg'], 1700, 2500,
    [NO.corn, NO.mushroom, NO.onion, NO.pepper, NO.tomato]),
  // ----- Pizza · Chicken -----
  pizza('sausages', 'Sausages', 'Chicken sausages, onion & bell pepper', ['sausages', 'sausage'], 1650, 2500, [NO.onion, NO.pepper]),
  pizza('devilled-chicken', 'Devilled Chicken', 'Devilled chicken, onion, tomato & capsicum', ['devilled chicken', 'devilled', 'devil', 'dc'], 1650, 2500,
    [NO.onion, NO.tomato, NO.capsicum, NO.spicy]),
  pizza('bbq-chicken', 'BBQ Chicken', 'BBQ chicken, tomato & capsicum', ['bbq chicken'], 1750, 2500, [NO.tomato, NO.capsicum]),
  pizza('bbq-sausages', 'BBQ Sausages', 'Cheese sausages, bell pepper & tomato', ['bbq sausages', 'bbq sausage'], 1750, 2500, [NO.pepper, NO.tomato]),
  pizza('bbq-mix', 'BBQ Mix', 'Chicken, cheese sausages, chicken sausages, bell pepper & tomato', ['bbq mix', 'mix'], 2200, 3200, [NO.pepper, NO.tomato]),
  // ----- Pizza · Seafood -----
  pizza('tonno-cipolla', 'Tonno - Cipolla', 'Tuna, onion & bell pepper', ['tonno cipolla', 'tonno', 'cipolla', 'tuna'], 1850, 2700, [NO.onion, NO.pepper]),
  pizza('seafood', 'Seafood', 'Tuna, prawns, onion, bell pepper & tomato', ['seafood', 'sea food'], 2200, 3200, [NO.onion, NO.pepper, NO.tomato]),
  // ----- Pizza · Pork -----
  pizza('bacon-onion', 'Bacon & Onion', 'Pork bacon, onion & bell pepper', ['bacon and onion', 'bacon onion', 'bacon pizza', 'bacon'], 2200, 3200, [NO.onion, NO.pepper]),
  pizza('bbq-pork', 'BBQ Pork', 'BBQ pork, bell pepper, capsicum & tomato', ['bbq pork'], 2200, 3200, [NO.pepper, NO.capsicum, NO.tomato]),

  // ----- Burgers -----
  burger('chicken-burger', 'Chicken Burger', 'Chicken patty, burger sauce, onion, tomatoes, lettuce', ['chicken burger', 'burger'], 450,
    [NO.sauce, NO.onion, NO.tomato, NO.lettuce]),
  burger('fish-burger', 'Fish Burger', 'Fish patty, burger sauce, onion, tomatoes, lettuce', ['fish burger', 'fish'], 450,
    [NO.sauce, NO.onion, NO.tomato, NO.lettuce]),
  burger('egg-burger', 'Egg Burger', 'Fried egg, burger sauce, onion, tomatoes, lettuce', ['egg burger', 'egg'], 450,
    [NO.sauce, NO.onion, NO.tomato, NO.lettuce]),
  burger('crispy-chicken-burger', 'Crispy Chicken Burger', 'Crispy chicken, burger sauce, tomatoes, lettuce', ['crispy chicken burger', 'crispy burger', 'crispy'], 650,
    [NO.sauce, NO.tomato, NO.lettuce]),
  burger('bacon-egg-burger', 'Bacon & Egg Burger', 'Pork bacon, egg, burger sauce, onion, tomatoes, lettuce', ['bacon and egg burger', 'bacon egg burger', 'bacon and egg'], 650,
    [NO.sauce, NO.onion, NO.tomato, NO.lettuce]),

  // ----- Pasta -----
  {
    id: 'italian-pasta', category: 'pasta', name: { en: 'Italian Pasta' },
    description: 'Rich, cheesy, made with real cheese',
    aliases: ['italian pasta', 'pasta'],
    variants: [
      { id: 'S', label: 'Single', hint: '1 person', price: rs(999) },
      { id: 'M', label: 'Medium', hint: '2 people', price: rs(1899) },
      { id: 'L', label: 'Large', hint: '3 people', price: rs(2650) },
    ],
    adds: [], leaveOut: [],
  },
];

export const CATEGORIES: { id: 'popular' | 'pizza' | 'burger' | 'pasta'; label: string }[] = [
  { id: 'popular', label: 'Popular' },
  { id: 'pizza', label: 'Pizza' },
  { id: 'burger', label: 'Burgers' },
  { id: 'pasta', label: 'Pasta' },
];

/**
 * Until sales history exists, "Popular" is fixed: the menu's four BEST SELLER
 * pizzas first, then the cheap everyday items. Slice 6 replaces this with
 * ranking by real sales and time of day.
 */
export const POPULAR_IDS = [
  'margherita', 'devilled-chicken', 'seafood', 'bacon-onion', 'cheese-onion',
  'bbq-chicken', 'chicken-burger', 'crispy-chicken-burger', 'italian-pasta',
];

export const itemById = (id: string): MenuItem => {
  const item = MENU.find((m) => m.id === id);
  if (!item) throw new Error(`Unknown menu item: ${id}`);
  return item;
};
