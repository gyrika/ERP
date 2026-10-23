/**
 * How the owner's recipe book (recipeBook.ts) meets this app: which of his
 * recipes is which menu item, and which of his ingredients is which item on his
 * price list (inventoryData.ts). Hand-checked, and only certain matches: the same
 * thing in the same unit. Anything else is left for the owner to answer in the app
 * (costing.ts), never guessed: e.g. our "Sausages" pizza, the Italian Pasta, his
 * "Mozzarella A", ketchup measured in g but bought in ml, boneless chicken
 * against the price list's chicken "with skin and bone".
 */

/** Menu item id + size ('' for no size) → his recipe. */
export const MENU_RECIPES: Readonly<Record<string, string>> = {
  'margherita:M': 'Margherita Pizza 10 inch',
  'margherita:L': 'Margherita Pizza 12 inch',
  'cheese-onion:M': 'Cheese & Onion Pizza 10 inch',
  'cheese-onion:L': 'Cheese & Onion Pizza 12 inch',
  'veggie:M': 'Veggie Pizza 10 inch',
  'veggie:L': 'Veggie Pizza 12 inch',
  'devilled-chicken:M': 'Chicken Devilled Pizza 10 inch',
  'devilled-chicken:L': 'Chicken Devilled Pizza 12 inch',
  'bbq-chicken:M': 'BBQ Chicken Pizza 10 inch',
  'bbq-chicken:L': 'BBQ Chicken Pizza 12 inch',
  'bbq-sausages:M': 'BBQ Sausages Pizza 10 inch',
  'bbq-sausages:L': 'BBQ Sausages Pizza 12 inch',
  'bbq-mix:M': 'BBQ Mix Pizza 10 inch',
  'bbq-mix:L': 'BBQ Mix Pizza 12 inch',
  'tonno-cipolla:M': 'Tonno Cipolla Pizza 10 inch',
  'tonno-cipolla:L': 'Tonno Cipolla Pizza 12 inch',
  'seafood:M': 'Seafood Pizza 10 inch',
  'seafood:L': 'Seafood Pizza 12 inch',
  'bacon-onion:M': 'Bacon & Onion Pizza 10 inch',
  'bacon-onion:L': 'Bacon & Onion Pizza 12 inch',
  'chicken-burger:': 'Chicken Burger',
  'fish-burger:': 'Fish Burger',
  'egg-burger:': 'Egg Burger Bullseye',
  'bacon-egg-burger:': 'Bacon & Egg Burger',
  'crispy-chicken-burger:': 'Crispy Chicken Burger',
};

/**
 * His ingredient name → the price-list item and how many of its base units one of
 * his recipe units is (1 when both are g, ml or pcs).
 */
export const INGREDIENT_SOURCES: Readonly<Record<string, { inventoryId: string; per: number }>> = {
  'Pizza Flour': { inventoryId: 'inv-0001', per: 1 },
  'A/P Flour': { inventoryId: 'inv-0002', per: 1 },
  Sugar: { inventoryId: 'inv-0003', per: 1 },
  Salt: { inventoryId: 'inv-0004', per: 1 },
  'Salt for Breading': { inventoryId: 'inv-0004', per: 1 },
  'Salt for Egg': { inventoryId: 'inv-0004', per: 1 },
  Yeast: { inventoryId: 'inv-0005', per: 1 },
  'Peeled Tomato': { inventoryId: 'inv-0009', per: 1 },
  'Tomato Paste': { inventoryId: 'inv-0010', per: 1 },
  // His cheese blend (2026-10-15): A is Prabhat from Eastwest, B is Margarita's own.
  'Mozzarella A': { inventoryId: 'inv-0006', per: 1 },
  'Mozzarella B': { inventoryId: 'inv-0007', per: 1 },
  Tuna: { inventoryId: 'inv-0013', per: 1 },
  'Bacon Ends': { inventoryId: 'inv-0014', per: 1 },
  'Keells Cheese & Onion Sausage': { inventoryId: 'inv-0017', per: 1 },
  'Chicken Patty 50g': { inventoryId: 'inv-0018', per: 1 },
  'Fish Cake Patty 50g': { inventoryId: 'inv-0019', per: 1 },
  Egg: { inventoryId: 'inv-0020', per: 1 },
  Butter: { inventoryId: 'inv-0021', per: 1 },
  'Sunflower Oil': { inventoryId: 'inv-0022', per: 1 },
  'Palm Oil': { inventoryId: 'inv-0023', per: 1 },
  Onion: { inventoryId: 'inv-0024', per: 1 },
  'Fresh Onion': { inventoryId: 'inv-0024', per: 1 },
  Tomato: { inventoryId: 'inv-0025', per: 1 },
  Lettuce: { inventoryId: 'inv-0026', per: 1 },
  'Bell Pepper': { inventoryId: 'inv-0027', per: 1 },
  // His price list sells mushrooms as a 200 g packet; his recipes count packets.
  'Mushroom Packet': { inventoryId: 'inv-0028', per: 200 },
  'BBQ Sauce': { inventoryId: 'inv-0031', per: 1 },
  Pepper: { inventoryId: 'inv-0033', per: 1 },
  'Chili Powder': { inventoryId: 'inv-0034', per: 1 },
  Oregano: { inventoryId: 'inv-0036', per: 1 },
  // Not on his March price list; its own stock item since 2026-10-23 (inventoryData.ts).
  Basil: { inventoryId: 'inv-0060', per: 1 },
  'Oregano for Breading': { inventoryId: 'inv-0036', per: 1 },
  'Garlic Powder': { inventoryId: 'inv-0037', per: 1 },
  'Ginger Powder': { inventoryId: 'inv-0038', per: 1 },
  Paprika: { inventoryId: 'inv-0039', per: 1 },
  Parmesan: { inventoryId: 'inv-0045', per: 1 },
  'Dry Spaghetti': { inventoryId: 'inv-0046', per: 1 },
  'Dry Penne': { inventoryId: 'inv-0047', per: 1 },
  Thyme: { inventoryId: 'inv-0048', per: 1 },
  'Bay Leaf': { inventoryId: 'inv-0049', per: 1 },
  Rosemary: { inventoryId: 'inv-0050', per: 1 },
  Turmeric: { inventoryId: 'inv-0051', per: 1 },
  'Burger Bun': { inventoryId: 'inv-0052', per: 1 },
  'Hotdog Bun': { inventoryId: 'inv-0053', per: 1 },
};

/** Costs nothing: his own sheet prices water at 0 ("Water · In-house · 0.0"). */
export const FREE_INGREDIENTS: ReadonlySet<string> = new Set(['Water']);

/**
 * A menu extra → his add-on recipe (same thing by name). Pizza toppings added as
 * extras (chicken, sausages, bacon...) have no add-on recipe in his sheet, so they
 * take nothing from stock until he adds one.
 */
export const ADD_RECIPES: Readonly<Record<string, string>> = {
  'full-cheese': 'Extra Cheese Full Add-on',
  'half-cheese': 'Extra Cheese Half Add-on',
  'cheese-slice': 'Extra Cheese Slice',
  bullseye: 'Extra Bullseye',
  'chicken-patty': 'Extra Chicken Patty',
  'bacon-egg': 'Extra Bacon and Egg',
};

/**
 * A leave-out → the lines of his recipe it removes (the item's own lines, not those
 * inside a batch). Only certain ones: "No capsicum" (his recipes say Bell Pepper,
 * the menu has both), "No burger sauce", "No sweet corn" and "Less spicy" leave the
 * recipe as it is.
 */
export const LEAVE_OUT_LINES: Readonly<Record<string, readonly string[]>> = {
  'no-onion': ['Onion', 'Fresh Onion'],
  'no-bell-pepper': ['Bell Pepper'],
  'no-tomato': ['Tomato', 'Tomato Slice'],
  'no-mushroom': ['Mushroom Packet'],
  'no-lettuce': ['Lettuce'],
};

/**
 * How much one batch makes, as the owner confirmed it outside his sheet (2026-10-23, asked by
 * Anton). His sheet left these open ("Confirm batch output qty"); his own answer in the app,
 * if he later weighs again, wins over these.
 * - Mozzarella Blend: 1,000 g A + 1,000 g B make 2,000 g.
 * - Pizza Sauce Batch: what goes in is what comes out (the sum of its lines, all in g).
 */
export const CONFIRMED_BATCHES: Readonly<Record<string, { qty: number; unit: string } | 'sum'>> = {
  'Mozzarella Blend': { qty: 2000, unit: 'g' },
  'Pizza Sauce Batch': 'sum',
};
