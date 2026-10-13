/**
 * CheesyBeez ERP — Bill of Materials (BOM) & Recipe Definitions.
 *
 * Maps MenuItem.id strings to raw inventory consumption lines, defining the
 * physical ingredients required to prepare each menu item.
 *
 * Designed for offline-first, event-sourced stock deduction:
 * - Quantities (qtyBaseUnits) are expressed strictly in the inventory item's
 *   normalised baseUnit ('g', 'ml', 'pcs', 'sheets') as defined in SEED_INVENTORY.
 * - variantOverrides allows size-specific ingredient scaling (e.g. Medium 'M' vs
 *   Large 'L' pizza flour and cheese dough amounts, or Single/Medium/Large pasta).
 */

export interface RecipeLine {
  inventoryId: string;
  qtyBaseUnits: number;
}

export interface Recipe {
  baseIngredients: RecipeLine[];
  variantOverrides?: Record<string, RecipeLine[]>;
}

export const RECIPES: Record<string, Recipe> = {
  // ----- Pizza: Margherita (id: 'margherita') -----
  margherita: {
    baseIngredients: [
      { inventoryId: 'inv-0009', qtyBaseUnits: 120 }, // Peeled Tomato / Sugo (g)
      { inventoryId: 'inv-0004', qtyBaseUnits: 3 },   // Salt (g)
      { inventoryId: 'inv-0005', qtyBaseUnits: 2 },   // Instant yeast (g)
      { inventoryId: 'inv-0054', qtyBaseUnits: 1 },   // Oil Paper (sheets)
    ],
    variantOverrides: {
      M: [
        { inventoryId: 'inv-0001', qtyBaseUnits: 180 }, // Pizza Flour (g) - 10" Medium
        { inventoryId: 'inv-0006', qtyBaseUnits: 150 }, // Mozzarella (g) - 10" Medium
      ],
      L: [
        { inventoryId: 'inv-0001', qtyBaseUnits: 260 }, // Pizza Flour (g) - 12" Large
        { inventoryId: 'inv-0006', qtyBaseUnits: 220 }, // Mozzarella (g) - 12" Large
      ],
    },
  },

  // ----- Pizza: Cheese & Onion (id: 'cheese-onion') -----
  'cheese-onion': {
    baseIngredients: [
      { inventoryId: 'inv-0009', qtyBaseUnits: 120 }, // Peeled Tomato / Sugo (g)
      { inventoryId: 'inv-0024', qtyBaseUnits: 60 },  // Onion (g)
      { inventoryId: 'inv-0004', qtyBaseUnits: 3 },   // Salt (g)
      { inventoryId: 'inv-0005', qtyBaseUnits: 2 },   // Instant yeast (g)
      { inventoryId: 'inv-0054', qtyBaseUnits: 1 },   // Oil Paper (sheets)
    ],
    variantOverrides: {
      M: [
        { inventoryId: 'inv-0001', qtyBaseUnits: 180 }, // Pizza Flour (g)
        { inventoryId: 'inv-0006', qtyBaseUnits: 150 }, // Mozzarella (g)
      ],
      L: [
        { inventoryId: 'inv-0001', qtyBaseUnits: 260 }, // Pizza Flour (g)
        { inventoryId: 'inv-0006', qtyBaseUnits: 220 }, // Mozzarella (g)
      ],
    },
  },

  // ----- Pizza: Devilled Chicken (id: 'devilled-chicken') -----
  'devilled-chicken': {
    baseIngredients: [
      { inventoryId: 'inv-0009', qtyBaseUnits: 120 }, // Peeled Tomato / Sugo (g)
      { inventoryId: 'inv-0011', qtyBaseUnits: 100 }, // Raw Chicken (g)
      { inventoryId: 'inv-0024', qtyBaseUnits: 40 },  // Onion (g)
      { inventoryId: 'inv-0025', qtyBaseUnits: 40 },  // Tomato (g)
      { inventoryId: 'inv-0034', qtyBaseUnits: 5 },   // Chilli Powder (g)
      { inventoryId: 'inv-0004', qtyBaseUnits: 3 },   // Salt (g)
      { inventoryId: 'inv-0005', qtyBaseUnits: 2 },   // Instant yeast (g)
      { inventoryId: 'inv-0054', qtyBaseUnits: 1 },   // Oil Paper (sheets)
    ],
    variantOverrides: {
      M: [
        { inventoryId: 'inv-0001', qtyBaseUnits: 180 }, // Pizza Flour (g)
        { inventoryId: 'inv-0006', qtyBaseUnits: 150 }, // Mozzarella (g)
      ],
      L: [
        { inventoryId: 'inv-0001', qtyBaseUnits: 260 }, // Pizza Flour (g)
        { inventoryId: 'inv-0006', qtyBaseUnits: 220 }, // Mozzarella (g)
      ],
    },
  },

  // ----- Burger: Chicken Burger (id: 'chicken-burger') -----
  'chicken-burger': {
    baseIngredients: [
      { inventoryId: 'inv-0052', qtyBaseUnits: 1 },  // Burger Bun (pcs)
      { inventoryId: 'inv-0018', qtyBaseUnits: 1 },  // Chicken Patty (pcs)
      { inventoryId: 'inv-0032', qtyBaseUnits: 25 }, // Mayonnaise (ml)
      { inventoryId: 'inv-0030', qtyBaseUnits: 15 }, // Ketchup (ml)
      { inventoryId: 'inv-0024', qtyBaseUnits: 20 }, // Onion (g)
      { inventoryId: 'inv-0025', qtyBaseUnits: 30 }, // Tomato (g)
      { inventoryId: 'inv-0026', qtyBaseUnits: 20 }, // Lettuce (g)
      { inventoryId: 'inv-0054', qtyBaseUnits: 1 },  // Oil Paper (sheets)
    ],
  },

  // ----- Pasta: Italian Pasta (id: 'italian-pasta') -----
  'italian-pasta': {
    baseIngredients: [
      { inventoryId: 'inv-0009', qtyBaseUnits: 80 }, // Peeled Tomato / Sugo (g)
      { inventoryId: 'inv-0004', qtyBaseUnits: 3 },  // Salt (g)
      { inventoryId: 'inv-0021', qtyBaseUnits: 15 }, // Butter (g)
    ],
    variantOverrides: {
      S: [
        { inventoryId: 'inv-0047', qtyBaseUnits: 100 }, // Penne (g) - Single
        { inventoryId: 'inv-0006', qtyBaseUnits: 50 },  // Mozzarella (g) - Single
      ],
      M: [
        { inventoryId: 'inv-0047', qtyBaseUnits: 200 }, // Penne (g) - Medium
        { inventoryId: 'inv-0006', qtyBaseUnits: 100 }, // Mozzarella (g) - Medium
      ],
      L: [
        { inventoryId: 'inv-0047', qtyBaseUnits: 300 }, // Penne (g) - Large
        { inventoryId: 'inv-0006', qtyBaseUnits: 150 }, // Mozzarella (g) - Large
      ],
    },
  },
};
