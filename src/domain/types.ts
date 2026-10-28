/** Money is always integer LKR cents (1 LKR = 100). Never floats. */
export type Cents = number;

export type SizeId = 'S' | 'M' | 'L';
export type Category = 'pizza' | 'burger' | 'pasta';
/** Small labels on cheesybeez.com's cards. Each must come from the owner: never inferred. */
export type MenuTag = 'popular' | 'veg';

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
  /** Labels for the ordering page (`popular` = a BEST SELLER on the printed menu). */
  tags?: MenuTag[];
  /** Typed/spoken shorthand that resolves to this item. */
  aliases: string[];
  /** Sized items (pizza, pasta). */
  variants?: Variant[];
  /** Single-price items (burgers). */
  price?: Cents;
  adds: Option[];
  leaveOut: Option[];
  /** The owner took it off the menu (src/domain/menuEdits.ts): kept for old orders, not offered. */
  hidden?: boolean;
  /** Sold out for today: shown greyed, cannot be ordered. */
  soldOut?: boolean;
  /** The owner changed it from the printed menu. */
  edited?: boolean;
  /** The owner added it himself (not on the printed menu). */
  added?: boolean;
  /** An added item the owner took back: kept for orders that have it, never offered or listed. */
  removed?: boolean;
}

export interface OrderLine {
  /** Stable id so a line can be edited/removed. */
  id: string;
  itemId: string;
  qty: number;
  size?: SizeId;
  adds: string[]; // option ids
  outs: string[]; // option ids
  /** Half-and-half pizza: the other half's item id (itemId is the first half; same size). See halves.ts. */
  half?: string;
  note?: string;
  /** Already on a kitchen ticket. Sent lines are locked: the kitchen may be cooking them. */
  sent?: boolean;
  /**
   * Unit price (size + extras) when the line went to the kitchen. A later menu price
   * change never alters an order already sent, its receipt, or past sales.
   */
  unit?: Cents;
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
  /** Came from cheesybeez.com: the customer collects it, or the rider takes it, by the time the counter promised. */
  online?: OnlineMark;
}

/**
 * An online order's mark, carried by the order, its kitchen ticket and its send event.
 * `pickupBy`: when it is ready (to collect, or for the rider). `delivery`: the rider takes it;
 * its fee is part of the order's total (totals.ts).
 */
export interface OnlineMark { pickupBy: number; delivery?: { fee: Cents } }

export interface PaidOrder extends Order {
  total: Cents;
  tender: Tender;
  tendered: Cents;
  change: Cents;
  paidAt: number;
}
