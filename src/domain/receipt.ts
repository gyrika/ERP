import type { ReceiptOffer } from './campaigns.ts';
import { boxesIn, opensBox } from './combos.ts';
import { itemById } from './menu.ts';
import { fmt } from './money.ts';
import { discountLabel, lineAdjustment, lineGross, totals } from './totals.ts';
import type { Cents, LineSpec, PaidOrder, Tender } from './types.ts';
import type { DeliveryPin } from './online.ts';
import { lineItemName } from './halves.ts';
import { RECEIPT_LOGO } from './receiptLogo.ts';

/**
 * The customer receipt for the Xprinter XP-80T (80 mm, ESC/POS), in two
 * steps, both pure: `receipt()` lays the paper out as text lines, `escpos()`
 * turns them into the printer's bytes. The same lines feed the on-screen
 * preview, so what the owner approves is what prints.
 * The kitchen never gets paper (CLAUDE.md): this is the customer's receipt only, and the
 * delivery bill that goes in the customer's bag (`deliveryBill`).
 */

/** Font A on 80 mm paper: 48 characters a line (24 when printed double width). */
export const RECEIPT_WIDTH = 48;

export interface ShopHeader {
  name: string;
  /** The logo's tagline, printed as text under the logo (SCRUM-254) so it stays sharp. */
  tagline?: string;
  /** Lines under the name. Only what the owner has confirmed; phone etc. come from the owner. */
  lines: string[];
  footer: string;
}

export const SHOP_HEADER: ShopHeader = { name: 'CheesyBeez', tagline: 'A taste worth finding', lines: ['Thalwila'], footer: 'Thank you!' };

export interface ReceiptLine {
  text: string;
  center?: boolean;
  bold?: boolean;
  /** Print the shop's logo (receiptLogo.ts) instead of the text; the text stays for plain-text views. */
  logo?: boolean;
  /** Double width and height: the shop name and the total. Half as many characters fit. */
  big?: boolean;
  /** A QR code of this, printed above the line's text (the text stays, for whoever cannot scan). */
  qr?: string;
}

/**
 * Where the receipt's QR code goes: the offers sign-up on cheesybeez.com (src/order/Offers.tsx), so
 * campaigns can reach the customer through the app. Printed only while the CRM is on.
 */
export const OFFERS_URL = 'https://cheesybeez.com/#offers';

const TENDER_LABEL: Record<Tender, string> = {
  cash: 'Cash', transfer: 'Bank transfer', card: 'Card', qr: 'QR', comp: 'Free', uber: 'Uber Eats',
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

/** The top of a bill (SCRUM-254): the logo, its tagline, then where the shop is. */
const billTop = (shop: ShopHeader): ReceiptLine[] => [
  { text: shop.name, center: true, logo: true },
  ...(shop.tagline ? [{ text: shop.tagline, center: true }] : []),
  ...shop.lines.map((text) => ({ text, center: true })),
];
const minus = (cents: number) => `-${fmt(cents)}`;

export function receipt(
  paid: PaidOrder, opts: { cashier: string; shop?: ShopHeader; width?: number; copy?: boolean; offers?: ReceiptOffer | null },
): ReceiptLine[] {
  const { cashier, shop = SHOP_HEADER, width = RECEIPT_WIDTH, copy = false, offers = null } = opts;
  const t = totals(paid);
  const out: ReceiptLine[] = [
    ...billTop(shop),
    // A reprint says so, so one sale can never look like two.
    ...(copy ? [{ text: 'COPY', center: true, bold: true }] : []),
    rule(width),
    { text: twoCols(`Order ${paid.number}`, receiptTime(paid.paidAt), width) },
    { text: `Cashier: ${cashier}` },
    ...(paid.online ? [{ text: paid.online.delivery ? 'Online order: delivered' : 'Online order: collected' }] : []),
    rule(width),
  ];

  const boxes = boxesIn(paid.lines);
  for (const [i, l] of paid.lines.entries()) {
    if (l.box) {
      // A combo box (SCRUM-231): its price once, its dishes under it, a price only where one was added.
      const box = boxes.get(l.box.id)!;
      if (opensBox(paid.lines, i)) out.push({ text: twoCols(box.name, fmt(box.price), width) });
      out.push(...itemLines(l, lineGross(l) - l.box.share, width, '  '));
    } else {
      out.push(...itemLines(l, lineGross(l), width));
    }
    const adj = lineAdjustment(paid, l);
    if (adj > 0) out.push({ text: twoCols('    Price adjusted', minus(adj), width) });
  }

  out.push(rule(width));
  if (t.lineAdjust > 0 || t.orderDiscount > 0) out.push({ text: twoCols('Subtotal', fmt(t.subtotal - t.lineAdjust), width) });
  const d = paid.adjust?.discount;
  if (d && t.orderDiscount > 0) out.push({ text: twoCols(discountLabel(d), minus(t.orderDiscount), width) });
  if (t.deliveryFee > 0) out.push({ text: twoCols('Delivery', fmt(t.deliveryFee), width) });
  out.push({ text: twoCols('TOTAL', `Rs ${fmt(paid.total)}`, width / 2), bold: true, big: true });
  if (paid.parts?.length) {
    // A split bill: each part, how it was paid, and any change it got.
    for (const p of paid.parts) {
      out.push({ text: twoCols(`Paid ${TENDER_LABEL[p.tender]}`, fmt(p.amount), width) });
      if (p.tender === 'cash' && p.tendered > p.amount) out.push({ text: twoCols('  Cash / change', `${fmt(p.tendered)} / ${fmt(p.tendered - p.amount)}`, width) });
    }
  } else if (paid.tender === 'cash') {
    out.push({ text: twoCols('Cash', fmt(paid.tendered), width) });
    out.push({ text: twoCols('Change', fmt(paid.change), width), bold: true });
  } else if (paid.tender !== 'comp') { // Free already has its own line above
    out.push({ text: twoCols('Paid by', TENDER_LABEL[paid.tender], width) });
  }
  for (const box of boxes.values()) {
    if (box.saved > 0) out.push({ text: `You saved Rs ${fmt(box.saved)} with the ${box.name}` });
  }
  out.push(rule(width));
  // The CRM's way in (customers.ts): a scan signs the phone up for the shop's offers, in the browser,
  // no app. The owner's words say why to scan (campaigns.ts receiptOfferFromEvents). Never on a reprint.
  if (offers && !copy) {
    out.push(
      { text: offers.headline, center: true, bold: true },
      ...(offers.line ? [{ text: offers.line, center: true }] : []),
      { text: OFFERS_URL.replace(/^https:\/\//, ''), center: true, qr: OFFERS_URL },
      { text: 'No app needed', center: true },
      rule(width),
    );
  }
  out.push({ text: shop.footer, center: true });
  return out;
}

/** One item on paper: "2 x Devilled Chicken Large" and its price, then its paid extras. */
const itemLines = (
  l: Pick<LineSpec, 'itemId' | 'qty' | 'size' | 'adds' | 'half'>, price: Cents, width: number, indent = '',
): ReceiptLine[] => {
  const item = itemById(l.itemId);
  const size = item.variants?.find((v) => v.id === l.size)?.label;
  // In a box (indented) a dish is always one, and has no price of its own unless something was added.
  const name = `${indent ? '' : `${l.qty} x `}${lineItemName(l).replace(/½/g, '1/2')}${size ? ` ${size}` : ''}`; // the printer has no ½
  const [head, ...rest] = wrap(name, width - 12 - indent.length);
  const first = `${indent}${head}`;
  const out: ReceiptLine[] = [
    { text: indent && price === 0 ? first : twoCols(first, fmt(price), width) }, ...rest.map((text) => ({ text: `    ${text}` })),
  ];
  // Paid extras explain the price; leave-outs and notes are for the kitchen, not the receipt.
  for (const id of l.adds) {
    const label = item.adds.find((o) => o.id === id)?.label;
    if (label) out.push({ text: `    + ${label}` });
  }
  return out;
};

/** What the delivery bill needs from the online order (src/domain/online.ts). */
export interface DeliveryBillOrder {
  orderNumber: number | null;
  name: string;
  phone: string;
  address: string | null;
  pin: DeliveryPin | null;
  note: string;
  lines: Pick<LineSpec, 'itemId' | 'qty' | 'size' | 'adds'>[];
  deliveryFee: Cents;
  distanceKm: number | null;
  total: Cents;
}

/**
 * The delivery bill (SCRUM-193), printed when the rider leaves and put in the customer's bag:
 * who and where for the rider, what is in the bag, and the cash to collect at the door.
 * `prices`: each line's price, in the order's order (the counter's sent prices).
 */
export function deliveryBill(
  o: DeliveryBillOrder, prices: Cents[], opts: { at: number; shop?: ShopHeader; width?: number },
): ReceiptLine[] {
  const { at, shop = SHOP_HEADER, width = RECEIPT_WIDTH } = opts;
  const out: ReceiptLine[] = [
    ...billTop(shop),
    { text: 'DELIVERY', center: true, bold: true },
    rule(width),
    { text: twoCols(`Order ${o.orderNumber ?? ''}`, receiptTime(at), width) },
    { text: o.name, bold: true },
    { text: `${o.phone.slice(0, 3)} ${o.phone.slice(3, 6)} ${o.phone.slice(6)}`, bold: true },
    ...wrap(o.address ?? '', width).map((text) => ({ text })),
    // Paper cannot be tapped and a link would wrap: the location as two numbers Maps understands when typed.
    ...(o.pin ? [{ text: `Location: ${o.pin.lat}, ${o.pin.lng}` }] : []),
    ...(o.note ? wrap(`Note: ${o.note}`, width).map((text) => ({ text })) : []),
    rule(width),
  ];
  o.lines.forEach((l, i) => out.push(...itemLines(l, prices[i] ?? 0, width)));
  out.push(rule(width));
  if (o.deliveryFee > 0) out.push({ text: twoCols(`Delivery${o.distanceKm !== null ? ` ${o.distanceKm} km` : ''}`, fmt(o.deliveryFee), width) });
  out.push(
    { text: twoCols('COLLECT', `Rs ${fmt(o.total)}`, width / 2), bold: true, big: true },
    { text: 'Cash on delivery', center: true },
    rule(width), { text: shop.footer, center: true },
  );
  return out;
}

/**
 * A paid order changed afterwards (SCRUM-242): a short slip for the difference, printed with the
 * drawer opening. `amount` > 0 the customer paid more; < 0 the shop gave it back. `changes`
 * (paidChanges.ts): what came off and went on, so the customer sees why (SCRUM-247).
 */
export function changeSlip(
  o: { number: number; amount: Cents; tender: Tender; tendered: Cents; total: Cents; changes?: string[] },
  opts: { at: number; cashier: string; shop?: ShopHeader; width?: number },
): ReceiptLine[] {
  const { at, cashier, shop = SHOP_HEADER, width = RECEIPT_WIDTH } = opts;
  const back = o.amount < 0;
  const out: ReceiptLine[] = [
    { text: shop.name, center: true, bold: true, big: true },
    { text: 'ORDER CHANGED', center: true, bold: true },
    rule(width),
    { text: twoCols(`Order ${o.number}`, receiptTime(at), width) },
    { text: `Cashier ${cashier}` },
    rule(width),
  ];
  if (o.changes?.length) out.push(...o.changes.flatMap((c) => wrap(c, width).map((text) => ({ text }))), rule(width));
  out.push({ text: twoCols(back ? 'GIVEN BACK' : 'PAID MORE', `Rs ${fmt(Math.abs(o.amount))}`, width / 2), bold: true, big: true });
  if (back) {
    out.push({ text: o.tender === 'transfer' ? 'By bank transfer' : 'Cash from the drawer' });
  } else {
    out.push({ text: twoCols(TENDER_LABEL[o.tender], fmt(o.tendered), width) });
    if (o.tender === 'cash' && o.tendered > o.amount) out.push({ text: twoCols('Change', fmt(o.tendered - o.amount), width) });
  }
  out.push({ text: twoCols('Order total now', fmt(o.total), width) }, rule(width), { text: shop.footer, center: true });
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

/**
 * A QR code (GS ( k, as on the XP-80T and most ESC/POS printers): model 2, small 4-dot modules
 * (about 1.3 cm for the short offers link: the owner wants it small, and phones still read it),
 * error correction M, store the data, print it.
 */
export const QR_MODULE_DOTS = 4;
export const qrBytes = (data: string): number[] => {
  const bytes = ascii(data);
  const len = bytes.length + 3;
  return [
    GS, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00, // model 2
    GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, QR_MODULE_DOTS, // module size
    GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x31, // error correction M
    GS, 0x28, 0x6b, len & 0xff, len >> 8, 0x31, 0x50, 0x30, ...bytes, // store
    GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30, // print
  ];
};

/**
 * A picture (GS v 0, raster bit image), sent in bands of at most 64 rows so no printer's buffer
 * overflows. `bits`: base64, 1 bit a dot, rows top to bottom, 1 = black, high bit leftmost.
 */
export const rasterBytes = ({ width, height, bits }: { width: number; height: number; bits: string }): number[] => {
  const raw = atob(bits);
  const row = Math.ceil(width / 8);
  const out: number[] = [];
  for (let y = 0; y < height; y += 64) {
    const h = Math.min(64, height - y);
    out.push(GS, 0x76, 0x30, 0x00, row & 0xff, row >> 8, h & 0xff, h >> 8);
    for (let i = y * row; i < (y + h) * row; i++) out.push(raw.charCodeAt(i));
  }
  return out;
};

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
    if (l.logo) { out.push(...rasterBytes(RECEIPT_LOGO)); continue; }
    if (l.qr) out.push(...qrBytes(l.qr), 0x0a);
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
export const opensDrawer = (paid: PaidOrder): boolean =>
  paid.parts?.length ? paid.parts.at(-1)!.tender === 'cash' : paid.tender === 'cash'; // earlier parts opened it at their time

/**
 * One part of a split bill: a short slip for that person, printed with the drawer opening for cash.
 * The full receipt prints when the last part is paid.
 */
export function partSlip(
  o: { number: number; amount: Cents; tender: Tender; tendered: Cents; left: Cents; lines: string[] },
  opts: { at: number; cashier: string; shop?: ShopHeader; width?: number },
): ReceiptLine[] {
  const { at, cashier, shop = SHOP_HEADER, width = RECEIPT_WIDTH } = opts;
  const out: ReceiptLine[] = [
    { text: shop.name, center: true, bold: true, big: true },
    { text: 'PART PAYMENT', center: true, bold: true },
    rule(width),
    { text: twoCols(`Order ${o.number}`, receiptTime(at), width) },
    { text: `Cashier ${cashier}` },
    rule(width),
    ...o.lines.map((text) => ({ text })),
    rule(width),
    { text: twoCols('PAID', `Rs ${fmt(o.amount)}`, width / 2), bold: true, big: true },
    { text: twoCols(TENDER_LABEL[o.tender], fmt(o.tendered), width) },
  ];
  if (o.tender === 'cash' && o.tendered > o.amount) out.push({ text: twoCols('Change', fmt(o.tendered - o.amount), width), bold: true });
  out.push({ text: twoCols('Still to pay on the order', fmt(o.left), width) }, rule(width), { text: shop.footer, center: true });
  return out;
}
