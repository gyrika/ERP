import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

/**
 * Reads the owner's .xlsx files for one-off imports (scripts only, never shipped).
 * An .xlsx is a zip of XML parts; Node unzips, so no library is needed. Values are
 * the cached results Excel/Sheets saved, as text; formulas are not evaluated. Tags may
 * carry a namespace prefix (<x:sheet>, from some exporters) or none.
 */

/** The files inside a zip, by name. */
const unzip = (buf: Buffer): Map<string, Buffer> => {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    files.set(name, method === 8 ? inflateRawSync(raw) : raw);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
};

const decode = (s: string): string => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&');

const textOf = (xml: string): string => [...xml.matchAll(/<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g)].map((m) => decode(m[1])).join('');

/** "A" → 0, "AB" → 27 */
const column = (ref: string): number => [...ref.replace(/\d+/g, '')].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

/** Every sheet in a workbook, by name: rows of cell text (empty cells are ''). */
export const readWorkbook = (path: string): Map<string, string[][]> => {
  const files = unzip(readFileSync(path));
  const part = (name: string) => files.get(name)?.toString('utf8') ?? '';
  const shared = [...part('xl/sharedStrings.xml').matchAll(/<(?:\w+:)?si>([\s\S]*?)<\/(?:\w+:)?si>/g)].map((m) => textOf(m[1]));
  const rels = new Map([...part('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b[^>]*>/g)].map((m) => [
    /Id="([^"]+)"/.exec(m[0])![1], /Target="([^"]+)"/.exec(m[0])![1],
  ]));
  const sheets = new Map<string, string[][]>();
  for (const m of part('xl/workbook.xml').matchAll(/<(?:\w+:)?sheet\b[^>]*>/g)) {
    const name = decode(/name="([^"]+)"/.exec(m[0])![1]);
    const target = rels.get(/r:id="([^"]+)"/.exec(m[0])![1])!.replace(/^\//, '');
    const xml = part(target.startsWith('xl/') ? target : `xl/${target}`);
    const rows: string[][] = [];
    for (const row of xml.matchAll(/<(?:\w+:)?row\b[^>]*>([\s\S]*?)<\/(?:\w+:)?row>/g)) {
      const cells: string[] = [];
      for (const c of row[1].matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
        const attrs = c[1];
        const body = c[2] ?? '';
        const v = /<(?:\w+:)?v>([\s\S]*?)<\/(?:\w+:)?v>/.exec(body)?.[1];
        const type = /\bt="([^"]+)"/.exec(attrs)?.[1];
        const value = type === 's' && v !== undefined ? shared[Number(v)]
          : type === 'inlineStr' ? textOf(body)
            : v !== undefined ? decode(v) : '';
        cells[column(/\br="([A-Z]+\d+)"/.exec(attrs)![1])] = value;
      }
      rows.push(Array.from(cells, (x) => x ?? ''));
    }
    sheets.set(name, rows);
  }
  return sheets;
};

/** A sheet as objects keyed by its header row (the first row with text), blank rows dropped. */
export const records = (rows: string[][]): Record<string, string>[] => {
  const head = rows.findIndex((r) => r.some((x) => x.trim()));
  if (head < 0) return [];
  const keys = rows[head].map((k) => k.trim());
  return rows.slice(head + 1)
    .filter((r) => r.some((x) => x.trim()))
    .map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? '').trim()])));
};
