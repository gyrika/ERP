import { useEffect, useState, type ReactNode } from 'react';
import type { NameMatch } from '../domain/customers.ts';
import { crmClient } from '../services/crmClient.ts';

/** Letters in what was typed: a name, not a mobile. */
export const isNameTyped = (text: string): boolean => /\p{L}/u.test(text);

export type NameSearch =
  | { at: 'none' } | { at: 'looking' } | { at: 'found'; matches: NameMatch[] } | { at: 'away' };

const WAIT_MS = 150;

/**
 * A name typed into the Mobile field (at Charge, or the Customer field on the order): who on the
 * list it may be, asked of the shop PC a moment after the last key. `sel` is the highlighted match
 * (↑/↓ move it, Enter takes it).
 */
export function useNameSearch(text: string, on: boolean) {
  // Only the letters count: the 0 that opened the field on the Register is not part of a name.
  const letters = text.replace(/[^\p{L}\s'.-]/gu, '').trim();
  const q = on && letters.length >= 2 ? letters : '';
  const [found, setFound] = useState<NameSearch>({ at: 'none' });
  const [sel, setSel] = useState(0);
  useEffect(() => {
    setSel(0);
    if (!q) { setFound({ at: 'none' }); return; }
    let live = true;
    setFound((f) => (f.at === 'found' ? f : { at: 'looking' })); // the last matches stay while the next ones come
    const t = setTimeout(() => {
      crmClient.search(q).then(
        (r) => { if (live) setFound({ at: 'found', matches: r.matches }); },
        () => { if (live) setFound({ at: 'away' }); },
      );
    }, WAIT_MS);
    return () => { live = false; clearTimeout(t); };
  }, [q]);
  const matches = found.at === 'found' ? found.matches : [];
  /** ↑/↓ in the field: true when it moved the highlight. */
  const move = (key: string): boolean => {
    if (!matches.length || (key !== 'ArrowDown' && key !== 'ArrowUp')) return false;
    setSel((i) => (i + (key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length);
    return true;
  };
  return { byName: on && isNameTyped(text), found, matches, sel: Math.min(sel, Math.max(matches.length - 1, 0)), move };
}

/** A customer's full name, and the nickname the shop knows them by beside it. */
export function CustomerName({ name, nickname, fallback = 'Customer' }: { name: string | null; nickname?: string | null; fallback?: string }) {
  return <><b>{name ?? nickname ?? fallback}</b>{name && nickname && <span className="cust__nick">“{nickname}”</span>}</>;
}

/** The customers a name may be: a tap (or Enter on the highlighted one) takes one. */
export function NameMatches({ matches, sel, onPick, keyLabel = 'Enter', extra }: {
  matches: NameMatch[]; sel: number; onPick: (m: NameMatch) => void; keyLabel?: string;
  /** Beside a match: e.g. Take payment for someone who owes credit (CustomerBar). */
  extra?: (m: NameMatch) => ReactNode;
}) {
  if (!matches.length) return null;
  return (
    <ul className="namematches" aria-label="Customers by that name">
      {matches.map((m, i) => (
        <li key={m.id}>
          <button
            type="button" className={`cust__pick${i === sel ? ' cust__pick--sel' : ''}`} aria-current={i === sel || undefined}
            aria-label={`${m.name}${m.nickname ? `, known as ${m.nickname}` : ''}, mobile ending ${m.ends}`} onMouseDown={(e) => e.preventDefault()} onClick={() => onPick(m)}
          >
            <span className="cust__who"><span className="cust__names"><CustomerName name={m.name} nickname={m.nickname} /></span><span className="num">…{m.ends}</span></span>
            {i === sel && <kbd>{keyLabel}</kbd>}
          </button>
          {extra?.(m)}
        </li>
      ))}
    </ul>
  );
}
