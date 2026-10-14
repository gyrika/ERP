import { canHalve, leaveOutsOf } from './halves.ts';
import type { LineSpec, MenuItem, OrderDraft, OrderInterpreter, SizeId } from './types.ts';

const SIZE_WORDS: Record<string, SizeId> = {
  s: 'S', single: 'S', small: 'S', m: 'M', med: 'M', medium: 'M', l: 'L', large: 'L', big: 'L',
};
const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
};
const MOD_WORD = /\b(no|without|extra|add|with)\b/;

/**
 * Rule-based interpreter for typed shorthand:
 *   "2 L devilled chicken no onion, 1 margherita extra bacon, burger"
 * Half-and-half: "L half devilled chicken half bbq chicken" or "devilled chicken / bbq chicken L".
 * Deterministic, offline, instant. A voice or LLM interpreter can implement
 * the same OrderInterpreter interface and be swapped in without touching UI.
 */
export class ShorthandInterpreter implements OrderInterpreter {
  private readonly aliasIndex: { alias: string; item: MenuItem }[];
  private readonly byNumber: Map<number, MenuItem>;
  /** Menu names containing "and" ("bacon and onion") must survive splitting on "and". */
  private readonly protectedNames: RegExp[];
  private readonly byId: Map<string, MenuItem>;

  constructor(menu: MenuItem[]) {
    // Longest alias first so "crispy chicken burger" wins over "burger".
    this.aliasIndex = menu
      .flatMap((item) => [...new Set([...item.aliases, item.name.en.toLowerCase()])].map((alias) => ({ alias, item })))
      .sort((a, b) => b.alias.length - a.alias.length);
    this.byNumber = new Map(menu.filter((m) => m.number).map((m) => [m.number!, m]));
    this.byId = new Map(menu.map((m) => [m.id, m]));
    this.protectedNames = this.aliasIndex
      .filter(({ alias }) => alias.includes(' and '))
      .map(({ alias }) => new RegExp(`\\b${alias}\\b`, 'g'));
  }

  interpret(input: string): OrderDraft {
    const lines: LineSpec[] = [];
    const unresolved: string[] = [];

    let protectedInput = input.toLowerCase();
    for (const re of this.protectedNames) protectedInput = protectedInput.replace(re, (m) => m.replace(/ and /g, ' & '));
    for (const raw of protectedInput.split(/,|;|\+|\band\b|\n/)) {
      const segment = raw.trim().replace(/ & /g, ' and ');
      if (!segment) continue;
      const line = this.parseHalves(segment) ?? this.parseSegment(segment);
      if (line) lines.push(line);
      else unresolved.push(segment);
    }
    return { lines, unresolved };
  }

  /** "2 L half devilled chicken half bbq chicken no onion" → one pizza, two halves; null if it is not one. */
  private parseHalves(segment: string): LineSpec | null {
    const m = segment.match(/^(.*?)\bhalf\s+(.+?)\s+half\s+(.+)$/) ?? segment.match(/^(.+?)\s*\/\s*(.+)$/)?.slice(0, 3).concat('');
    if (!m) return null;
    const [, before, first, after] = m.length === 4 && m[3] !== '' ? m : [m[0], '', m[1], m[2]];
    const a = this.parseSegment(`${before} ${first}`.trim());
    const b = this.parseSegment(after.trim());
    if (!a || !b) return null;
    const itemA = this.byId.get(a.itemId)!;
    const itemB = this.byId.get(b.itemId)!;
    if (!canHalve(itemA, itemB)) return null;
    // A size typed anywhere counts; otherwise Medium, as for any pizza.
    const typed = segment.split(/\s+/).map((t) => SIZE_WORDS[t]).find(Boolean);
    const size = (itemA.variants?.find((v) => v.id === typed) ?? itemA.variants?.find((v) => v.id === 'M') ?? itemA.variants?.[0])?.id;
    // Extras and leave-outs typed after either half apply to the whole pizza.
    const modText = [`${before} ${first}`, after].map((t) => { const i = t.search(MOD_WORD); return i >= 0 ? t.slice(i) : ''; }).join(' ');
    const { adds, outs, note } = parseMods(modText, { ...itemA, leaveOut: leaveOutsOf(itemA, itemB) });
    return { itemId: itemA.id, half: itemB.id, qty: a.qty, size, adds, outs, ...(note ? { note } : {}) };
  }

  private parseSegment(segment: string): LineSpec | null {
    const modMatch = segment.match(MOD_WORD);
    const head = modMatch ? segment.slice(0, modMatch.index).trim() : segment;
    const modText = modMatch ? segment.slice(modMatch.index) : '';

    let qty = 1;
    let qtyGiven = false;
    let qtyIsDigits = false;
    let menuNo: number | undefined;
    let size: SizeId | undefined;
    const rest: string[] = [];
    for (const t of head.split(/\s+/).filter(Boolean)) {
      if (/^#\d+$/.test(t)) { menuNo = Number(t.slice(1)); continue; }
      const n = /^\d+$/.test(t) ? Number(t) : /^\d+x$/.test(t) ? Number(t.slice(0, -1)) : NUMBER_WORDS[t];
      if (n && rest.length === 0 && !qtyGiven) { qty = n; qtyGiven = true; qtyIsDigits = /^\d+$/.test(t); }
      else if (/^\d+$/.test(t) && rest.length === 0 && menuNo === undefined) menuNo = Number(t);
      else if (SIZE_WORDS[t] && !size) size = SIZE_WORDS[t];
      else if (t !== 'number' && t !== 'x') rest.push(t);
    }

    // No name typed: a lone number is the printed menu number ("5 L"), and with
    // two numbers the first is the quantity ("2 5 L", "2x 5 L").
    const name = rest.join(' ');
    let item: MenuItem | undefined;
    if (name) {
      item = this.aliasIndex.find(
        ({ alias }) => name === alias || name === alias + 's' || name.startsWith(alias + ' '),
      )?.item;
    } else {
      if (menuNo === undefined && qtyIsDigits) { menuNo = qty; qty = 1; }
      item = menuNo === undefined ? undefined : this.byNumber.get(menuNo);
    }
    if (!item) return null;

    let resolvedSize: SizeId | undefined;
    if (item.variants) {
      const wanted = item.variants.find((v) => v.id === size);
      resolvedSize = (wanted ?? item.variants.find((v) => v.id === 'M') ?? item.variants[0]).id;
    }

    const { adds, outs, note } = parseMods(modText, item);
    return { itemId: item.id, qty, size: resolvedSize, adds, outs, ...(note ? { note } : {}) };
  }
}

const parseMods = (text: string, item: MenuItem) => {
  const adds: string[] = [];
  const outs: string[] = [];
  const unmatched: string[] = [];
  const re = /\b(no|without|extra|add|with)\s+([a-z ]+?)(?=\s+\b(?:no|without|extra|add|with)\b|$)/g;

  for (const m of text.matchAll(re)) {
    const negative = m[1] === 'no' || m[1] === 'without';
    const phrase = m[2].trim();
    const pool = negative ? item.leaveOut : item.adds;
    // "extra cheese" → "Full cheese": match on any shared word with the option label.
    const words = phrase.split(/\s+/);
    const option = pool.find((o) => o.label.toLowerCase().includes(phrase)) ??
      pool.find((o) => words.some((w) => w.length > 2 && o.label.toLowerCase().split(/\s+/).includes(w)));
    if (option) (negative ? outs : adds).push(option.id);
    else unmatched.push(`${negative ? 'no' : 'extra'} ${phrase}`);
  }
  return { adds, outs, note: unmatched.length ? unmatched.join(', ') : undefined };
};
