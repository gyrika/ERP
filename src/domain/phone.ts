/**
 * Sri Lankan mobile numbers for the customer list (CRM). One customer is one mobile number,
 * kept in one form, +947XXXXXXXX, whatever way it was typed at the counter or written in a
 * spreadsheet. Landlines are refused: a customer's number is how the shop finds them again and,
 * later, how a push sign-up is tied to them, so it must be the phone in their pocket.
 *
 * The online order page keeps its own everyday form (normalisePhone in online.ts, 07…); this
 * is stricter on purpose and leaves that one alone.
 */

/** Mobile prefixes in use (070 Mobitel … 078 Hutch). 073 and 079 are not given out. */
export const LK_MOBILE_PREFIXES = ['70', '71', '72', '74', '75', '76', '77', '78'] as const;

/** A checked number, or why it is not one (said to the owner as it is). */
export type MobileCheck =
  | { phone: string; others?: string[] }
  | { reason: string };

/** Spaces of every kind, dashes, dots, brackets and the invisible marks spreadsheets carry. */
const NOISE = /[\s ​-‏⁠﻿()\-.‐-―'"]/g;
/** What separates two numbers written in one cell: "077… / 071…", "077…, 071…", "077… or 071…". */
const SPLIT = /\s*(?:[/,;|&]|\bor\b)\s*/i;

const one = (raw: string): MobileCheck => {
  // An Excel number column shown as 9.47712E+10: the last digits are already lost. (Before the
  // noise goes: the dot is part of it.)
  if (/^\d(\.\d+)?e\+?\d+$/i.test(raw.trim())) return { reason: 'the number was saved as 9.47712E+10 and lost its last digits: format the column as Text' };
  let d = raw.replace(NOISE, '');
  if (!d) return { reason: 'no number' };
  if (d.startsWith('+')) d = d.slice(1);
  if (!/^\d+$/.test(d)) return { reason: 'not a number' };
  if (d.startsWith('0094')) d = d.slice(4);
  else if (d.startsWith('94') && d.length === 11) d = d.slice(2);
  else if (d.startsWith('0') && d.length === 10) d = d.slice(1);
  if (d.length < 9) return { reason: 'too short' };
  if (d.length > 9) return { reason: 'too long' };
  if (!d.startsWith('7')) return { reason: 'a landline, not a mobile' };
  if (!(LK_MOBILE_PREFIXES as readonly string[]).includes(d.slice(0, 2))) return { reason: `no mobile number starts with 0${d.slice(0, 2)}` };
  return { phone: `+94${d}` };
};

/**
 * A mobile number in its one form (+947XXXXXXXX), or why not.
 * Accepts 07X…, 7X… (a spreadsheet dropped the 0), +94…, 94…, 0094…, with spaces, dashes,
 * dots or brackets, and a number cell from Excel. Two numbers in one cell: the first good one
 * is taken and the others are given back, so the owner can be told.
 */
export const toLkMobile = (input: unknown): MobileCheck => {
  if (typeof input === 'number') {
    if (!Number.isSafeInteger(input) || input <= 0) return { reason: 'not a number' };
    return one(String(input));
  }
  if (typeof input !== 'string') return { reason: 'no number' };
  const parts = input.split(SPLIT).filter((p) => p.replace(NOISE, '') !== '');
  if (parts.length <= 1) return one(input);
  const checked = parts.map(one);
  const good = checked.filter((c): c is { phone: string } => 'phone' in c);
  if (!good.length) return checked[0];
  const others = [...new Set(good.slice(1).map((c) => c.phone))].filter((p) => p !== good[0].phone);
  return others.length ? { phone: good[0].phone, others } : { phone: good[0].phone };
};

/** Is this already the one form? (What the server stores and an event may point at.) */
export const isLkMobile = (v: unknown): v is string => typeof v === 'string' && /^\+947\d{8}$/.test(v) && 'phone' in one(v);

/** +94771234567 → 077 123 4567, the way people say it. */
export const formatLkMobile = (phone: string): string =>
  isLkMobile(phone) ? `0${phone.slice(3, 5)} ${phone.slice(5, 8)} ${phone.slice(8)}` : phone;
