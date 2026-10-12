import { itemById } from './menu.ts';
import { fmt } from './money.ts';
import { discountLabel, lineAdjustment, lineGross, totals } from './totals.ts';
import type { PaidOrder, Tender } from './types.ts';

/**
 * The customer receipt for the Xprinter XP-80T (80 mm, ESC/POS), in two
 * steps, both pure: `receipt()` lays the paper out as text lines, `escpos()`
 * turns them into the printer's bytes. The same lines feed the on-screen
 * preview, so what the owner approves is what prints.
 * The kitchen never gets paper (CLAUDE.md): this is the customer's receipt only.
 */

/** Font A on 80 mm paper: 48 characters a line (24 when printed double width). */
export const RECEIPT_WIDTH = 48;

export interface ShopHeader {
  name: string;
  /** Lines under the name. Only what the owner has confirmed; phone etc. come from the owner. */
  lines: string[];
  footer: string;
}

export const SHOP_HEADER: ShopHeader = { name: 'CheesyBeez', lines: ['Thalwila'], footer: 'Thank you!' };

export interface ReceiptLine {
  text: string;
  center?: boolean;
  bold?: boolean;
  /** Double width and height: the shop name and the total. Half as many characters fit. */
  big?: boolean;
}

const TENDER_LABEL: Record<Tender, string> = {
  cash: 'Cash', transfer: 'Bank transfer', card: 'Card', qr: 'QR', comp: 'Free',
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad2 = (n: number) => String(n).padStart(2, '0');
/** "12 Oct 2026 19:42", in the device's local time. */
export const receiptTime = (at: number): string => {
  const d = new Date(at);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

/** Left text and right text on one line; the left side is cut short rather than pushing the amount off. */
export const twoCols = (left: string, right: string, width = RECEIPT_WIDTH): string => {
  const room = width - right.length - 1;
  const l = left.length > room ? left.slice(0, room) : left;
  return l + ' '.repeat(width - l.length - right.length) + right;
};

/** Wraps on spaces; a word longer than the line is split. */
export const wrap = (text: string, width: number): string[] => {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    let w = word;
    while (w.length > width) { if (line) { out.push(line); line = ''; } out.push(w.slice(0, width)); w = w.slice(width); }
    if (!line) line = w;
    else if (line.length + 1 + w.length <= width) line += ` ${w}`;
    else { out.push(line); line = w; }
  }
  if (line) out.push(line);
  return out;
};

const rule = (width: number): ReceiptLine => ({ text: '-'.repeat(width) });
const minus = (cents: number) => `-${fmt(cents)}`;

export function receipt(
  paid: PaidOrder, opts: { cashier: string; shop?: ShopHeader; width?: number; copy?: boolean },
): ReceiptLine[] {
  const { cashier, shop = SHOP_HEADER, width = RECEIPT_WIDTH, copy = false } = opts;
  const t = totals(paid);
  const out: ReceiptLine[] = [
    { text: shop.name, center: true, bold: true, big: true },
    ...shop.lines.map((text) => ({ text, center: true })),
    // A reprint says so, so one sale can never look like two.
    ...(copy ? [{ text: 'COPY', center: true, bold: true }] : []),
    rule(width),
    { text: twoCols(`Order ${paid.number}`, receiptTime(paid.paidAt), width) },
    { text: `Cashier: ${cashier}` },
    ...(paid.online ? [{ text: 'Online order: collected' }] : []),
    rule(width),
  ];

  for (const l of paid.lines) {
    const item = itemById(l.itemId);
    const size = item.variants?.find((v) => v.id === l.size)?.label;
    const name = `${l.qty} x ${item.name.en}${size ? ` ${size}` : ''}`;
    const [first, ...rest] = wrap(name, width - 12);
    out.push({ text: twoCols(first, fmt(lineGross(l)), width) });
    rest.forEach((text) => out.push({ text: `    ${text}` }));
    // Paid extras explain the price; leave-outs and notes are for the kitchen, not the receipt.
    for (const id of l.adds) {
      const label = item.adds.find((o) => o.id === id)?.label;
      if (label) out.push({ text: `    + ${label}` });
    }
    const adj = lineAdjustment(paid, l);
    if (adj > 0) out.push({ text: twoCols('    Price adjusted', minus(adj), width) });
  }

  out.push(rule(width));
  if (t.lineAdjust > 0 || t.orderDiscount > 0) out.push({ text: twoCols('Subtotal', fmt(t.subtotal - t.lineAdjust), width) });
  const d = paid.adjust?.discount;
  if (d && t.orderDiscount > 0) out.push({ text: twoCols(discountLabel(d), minus(t.orderDiscount), width) });
  out.push({ text: twoCols('TOTAL', `Rs ${fmt(paid.total)}`, width / 2), bold: true, big: true });
  if (paid.tender === 'cash') {
    out.push({ text: twoCols('Cash', fmt(paid.tendered), width) });
    out.push({ text: twoCols('Change', fmt(paid.change), width), bold: true });
  } else if (paid.tender !== 'comp') { // Free already has its own line above
    out.push({ text: twoCols('Paid by', TENDER_LABEL[paid.tender], width) });
  }
  out.push(rule(width), { text: shop.footer, center: true });
  return out;
}

/** Plain text, for the preview and dry-run files. Big lines are shown at half width, as on paper. */
export const receiptText = (lines: ReceiptLine[], width = RECEIPT_WIDTH): string =>
  lines.map((l) => {
    const text = l.big ? l.text.split('').join(' ') : l.text;
    return l.center ? ' '.repeat(Math.max(0, Math.floor((width - text.length) / 2))) + text : text;
  }).join('\n');

// ----- ESC/POS -----

const ESC = 0x1b;
const GS = 0x1d;
export const CMD = {
  init: [ESC, 0x40],
  /** Cash drawer on the printer's RJ11 port, pin 2: 50 ms on, 500 ms off. */
  kick: [ESC, 0x70, 0x00, 0x19, 0xfa],
  left: [ESC, 0x61, 0x00],
  center: [ESC, 0x61, 0x01],
  boldOn: [ESC, 0x45, 0x01],
  boldOff: [ESC, 0x45, 0x00],
  big: [GS, 0x21, 0x11],
  normal: [GS, 0x21, 0x00],
  /** Feed 4 lines past the tear bar, then a partial cut. */
  feedCut: [GS, 0x56, 0x42, 0x04],
} as const;

/** The printer's default code page is ASCII-safe; anything else becomes '?' rather than garbage. */
const ascii = (s: string): number[] =>
  [...s.replace(/×/g, 'x').replace(/[·•]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"')]
    .map((c) => { const n = c.charCodeAt(0); return n >= 0x20 && n < 0x7f ? n : 0x3f; });

/**
 * Printer bytes for a receipt. The drawer (cash only) opens first, so the
 * cashier can count change while the paper prints.
 */
export const escpos = (lines: ReceiptLine[], { openDrawer = false } = {}): Uint8Array => {
  const out: number[] = [...CMD.init];
  if (openDrawer) out.push(...CMD.kick);
  for (const l of lines) {
    out.push(...(l.center ? CMD.center : CMD.left));
    if (l.bold) out.push(...CMD.boldOn);
    if (l.big) out.push(...CMD.big);
    out.push(...ascii(l.text), 0x0a);
    if (l.big) out.push(...CMD.normal);
    if (l.bold) out.push(...CMD.boldOff);
  }
  out.push(...CMD.left, ...CMD.feedCut);
  return Uint8Array.from(out);
};

/** Cash in the drawer changes only for cash; everything else prints without opening it. */
export const opensDrawer = (paid: PaidOrder): boolean => paid.tender === 'cash';
