/** Money is always integer LKR cents (1 LKR = 100). Never floats. */
export type Cents = number;

export type SizeId = 'S' | 'M' | 'L';
export type Category = 'pizza' | 'burger' | 'pasta';

export interface Variant {
  id: SizeId;
  label: string; // "Medium", "Single"
  /** Shown beside the label in the sheet: '10"', '2 people'. */
  hint?: string;
  price: Cents;
}

export interface Option {
  id: string;
  label: string;
  /** Added to the unit price. 0 for "leave out" options. */
  price: Cents;
}

export interface MenuItem {
  id: string;
  name: { en: string; si?: string; ta?: string };
  description: string;
  category: Category;
  /** Number on the printed menu (pizzas 1-12); customers order by it ("5 L"). */
  number?: number;
  /** Typed/spoken shorthand that resolves to this item. */
  aliases: string[];
  /** Sized items (pizza, pasta). */
  variants?: Variant[];
  /** Single-price items (burgers). */
  price?: Cents;
  adds: Option[];
  leaveOut: Option[];
}

export interface OrderLine {
  /** Stable id so a line can be edited/removed. */
  id: string;
  itemId: string;
  qty: number;
  size?: SizeId;
  adds: string[]; // option ids
  outs: string[]; // option ids
  note?: string;
  /** Already on a kitchen ticket. Sent lines are locked: the kitchen may be cooking them. */
  sent?: boolean;
}

export type LineSpec = Omit<OrderLine, 'id'>;

export interface OrderDraft {
  lines: LineSpec[];
  /** Fragments we could not resolve; the UI shows them as one fixable hint. */
  unresolved: string[];
}

/**
 * The seam for voice / language models: anything that turns raw input into an
 * OrderDraft. Screens only ever depend on this interface.
 */
export interface OrderInterpreter {
  interpret(input: string): OrderDraft | Promise<OrderDraft>;
}

/** 'comp' = the order was made free by a manager; nothing is collected. */
export type Tender = 'cash' | 'transfer' | 'card' | 'qr' | 'comp';

/** Manager discount on the whole order. Percentages round once, at the order level. */
export type Discount = { kind: 'percent'; pct: number } | { kind: 'comp' };

export interface Adjustments {
  /** Per-line price adjustment, in cents off that line. Never changes the menu price. */
  lines?: Record<string, Cents>;
  discount?: Discount;
}

export interface Order {
  number: number;
  lines: OrderLine[];
  /** When the order first went to the kitchen. Customers eat first and pay after. */
  sentAt?: number;
  adjust?: Adjustments;
  /** Latest manager change, shown on the order as "Edited by <name>, <time>". */
  edited?: { by: string; at: number };
}

export interface PaidOrder extends Order {
  total: Cents;
  tender: Tender;
  tendered: Cents;
  change: Cents;
  paidAt: number;
}
