/**
 * The counter's button words, in the menu's three languages (types.ts `name: { en, si, ta }`).
 * Sinhala and Tamil stay empty until the owner gives them: never guessed. `label()` falls back
 * to English for a language that has no word yet.
 */
export type Lang = 'en' | 'si' | 'ta';
type Words = { en: string; si: string; ta: string };

export const LABELS = {
  pay: { en: 'Pay', si: '', ta: '' },
  send: { en: 'Send to kitchen', si: '', ta: '' },
  voidItem: { en: 'Void item', si: '', ta: '' },
  changeItem: { en: 'Change item', si: '', ta: '' },
  clearBill: { en: 'Clear bill', si: '', ta: '' },
  newBill: { en: 'New bill', si: '', ta: '' },
  printLast: { en: 'Print last bill', si: '', ta: '' },
  billNo: { en: 'Bill No', si: '', ta: '' },
  takeAway: { en: 'Take away', si: '', ta: '' },
  dineIn: { en: 'Dine in', si: '', ta: '' },
  orderType: { en: 'Order type', si: '', ta: '' },
  deliveryFee: { en: 'Delivery fee', si: '', ta: '' },
  heldBills: { en: 'Held bills', si: '', ta: '' },
  item: { en: 'Item', si: '', ta: '' },
  qty: { en: 'Qty', si: '', ta: '' },
  price: { en: 'Price', si: '', ta: '' },
  total: { en: 'Total', si: '', ta: '' },
  subtotal: { en: 'Subtotal', si: '', ta: '' },
  discount: { en: 'Discount', si: '', ta: '' },
  delivery: { en: 'Delivery', si: '', ta: '' },
  netAmount: { en: 'Net amount', si: '', ta: '' },
  typeOrSearch: { en: 'Type or search… e.g. 2 L pepperoni', si: '', ta: '' },
  emptyBill: { en: 'Tap an item to start the bill', si: '', ta: '' },
  noHeld: { en: 'No held bills', si: '', ta: '' },
  backToBill: { en: 'Back to the bill', si: '', ta: '' },
  remove: { en: 'Remove', si: '', ta: '' },
  void: { en: 'Void', si: '', ta: '' },
  given: { en: 'Given', si: '', ta: '' },
} satisfies Record<string, Words>;

export type LabelKey = keyof typeof LABELS;

let lang: Lang = 'en';
export const setLang = (l: Lang): void => { lang = l; };

export const label = (key: LabelKey): string => LABELS[key][lang] || LABELS[key].en;
