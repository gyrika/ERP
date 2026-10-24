/**
 * Opening a page by voice (SCRUM-145): the pages a person may open, said in their words. Only
 * pages the person could already open with a key or the address are offered, so neither the
 * words nor the language model can take anyone further. Pure: Root decides who may open what.
 */

export interface VoicePage {
  id: string;
  /** What the model reads: what the page is for, in the shop's words. */
  label: string;
  /** Where it opens ('' = the Register). */
  hash: string;
  /** What staff call it, for the quick match that needs no model. */
  words: string[];
}

/** Who may open what, as Root already decides it. */
export interface PageAccess {
  seesOwner: boolean;
  managesStock: boolean;
  owner: boolean;
  setup: boolean;
}

type Need = keyof PageAccess | null;

const PAGES: (VoicePage & { need: Need })[] = [
  { id: 'register', label: 'Register: take and charge orders', hash: '', words: ['register', 'till', 'counter'], need: null },
  { id: 'kitchen', label: 'Kitchen screen: tickets to cook', hash: '#kitchen', words: ['kitchen', 'tickets'], need: null },
  { id: 'owner', label: "Owner view: today's takings, sales and what needs attention", hash: '#owner', words: ['owner', 'takings', 'sales'], need: 'seesOwner' },
  { id: 'menu', label: 'Menu: dishes, prices, names, sold out', hash: '#items/finished', words: ['menu', 'prices', 'sold out'], need: 'seesOwner' },
  { id: 'items', label: 'Stock: raw materials like cheese, flour, sauce and how much is left', hash: '#items', words: ['stock', 'inventory', 'raw materials'], need: 'managesStock' },
  { id: 'semi', label: 'Semi-processed items the kitchen makes: dough, sauce batches', hash: '#items/semi', words: ['semi', 'semi-processed', 'batches'], need: 'managesStock' },
  { id: 'receive', label: 'Receive a delivery from a supplier', hash: '#receive', words: ['receive', 'delivery', 'grn'], need: 'managesStock' },
  { id: 'order', label: 'Order stock: what to buy from suppliers', hash: '#order', words: ['purchase order', 'what to buy'], need: 'managesStock' },
  { id: 'count', label: 'Count the shelves (stock count)', hash: '#count', words: ['count', 'stock count'], need: 'managesStock' },
  { id: 'suppliers', label: 'Suppliers: their phones and what they sell', hash: '#suppliers', words: ['supplier', 'suppliers'], need: 'managesStock' },
  { id: 'recipes', label: 'Recipes and food cost of each dish', hash: '#items/recipe', words: ['recipe', 'recipes', 'food cost'], need: 'owner' },
  { id: 'setup', label: 'Shop setup: staff, printer, devices, updates', hash: '#setup', words: ['setup', 'settings', 'staff', 'printer', 'updates'], need: 'setup' },
];

/** The pages this person may open. */
export const voicePages = (access: PageAccess): VoicePage[] =>
  PAGES.filter((p) => p.need === null || access[p.need]).map(({ need: _need, ...page }) => page);

const normal = (s: string) => ` ${s.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').replace(/\s+/g, ' ').trim()} `;

/** The page the words name plainly ("open stock", "suppliers please"), or null when it takes the model. */
export const matchPage = (text: string, pages: readonly VoicePage[]): VoicePage | null => {
  const said = normal(text);
  const named = pages.filter((p) => p.words.some((w) => said.includes(normal(w))));
  return named.length === 1 ? named[0] : null;
};
