import { useEffect, useState } from 'react';

/** Under this a message types out; longer ones type faster, so none takes more than about a second. */
const MAX_MS = 1100;
const CHAR_MS = 16;

const reduced = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function'
  && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Text that types itself out, letter by letter, each time it changes. A screen reader gets the
 * whole text at once; with reduced motion it simply appears.
 */
export function TypeOut({ text, className }: { text: string; className?: string }) {
  const [shown, setShown] = useState(() => (reduced() ? text.length : 0));
  useEffect(() => {
    if (reduced()) { setShown(text.length); return; }
    setShown(0);
    const step = Math.max(1, Math.ceil(text.length / (MAX_MS / CHAR_MS)));
    const id = setInterval(() => setShown((n) => {
      if (n + step >= text.length) clearInterval(id);
      return Math.min(text.length, n + step);
    }), CHAR_MS);
    return () => clearInterval(id);
  }, [text]);
  const typing = shown < text.length;
  return (
    <p className={className}>
      <span aria-hidden="true">{text.slice(0, shown)}{typing && <span className="typeout__caret" />}</span>
      <span className="sr-only">{text}</span>
    </p>
  );
}
