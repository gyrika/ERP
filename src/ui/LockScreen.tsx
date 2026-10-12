import { useCallback, useEffect, useState } from 'react';
import { PIN_LENGTH } from '../domain/auth.ts';
import { login, type LoginResult } from '../services/serverAuth.ts';

/**
 * The counter's front door (SCRUM-40). Several people share one PC through a
 * shift, so this is the fastest way in: four digits, typed or tapped, and it
 * checks itself, with no name to pick and no button to press. The PIN alone
 * says who it is.
 */
const MESSAGE: Record<Exclude<LoginResult, 'ok'>, string> = {
  wrong: 'Wrong PIN',
  wait: 'Too many tries · wait 30 seconds',
  offline: 'Can’t reach the server on this PC',
};

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'];

export function LockScreen() {
  const [pin, setPin] = useState('');
  const [error, setError] = useState<Exclude<LoginResult, 'ok'> | null>(null);
  const [checking, setChecking] = useState(false);

  const press = useCallback((key: string) => {
    if (checking) return;
    setError(null);
    if (key === '⌫') { setPin((p) => p.slice(0, -1)); return; }
    if (!/^\d$/.test(key)) return;
    setPin((p) => {
      const next = (p + key).slice(0, PIN_LENGTH);
      if (next.length === PIN_LENGTH) {
        setChecking(true);
        void login(next).then((r) => {
          setChecking(false);
          if (r === 'ok') return; // Root swaps this screen for the register
          setError(r);
          setPin('');
        });
      }
      return next;
    });
  }, [checking]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (/^\d$/.test(e.key)) { e.preventDefault(); press(e.key); }
      else if (e.key === 'Backspace') { e.preventDefault(); press('⌫'); }
      else if (e.key === 'Escape') { e.preventDefault(); setPin(''); setError(null); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [press]);

  return (
    <main className="lock" aria-label="Log in">
      <div className="lock__card">
        <span className="brand">CheesyBeez</span>
        <h1 className="lock__title">Enter your PIN</h1>
        <div className={`lock__dots${error ? ' lock__dots--error' : ''}${checking ? ' lock__dots--checking' : ''}`} aria-hidden>
          {Array.from({ length: PIN_LENGTH }, (_, i) => <span key={i} className={i < pin.length ? 'on' : ''} />)}
        </div>
        <p className="lock__msg" role="status">
          {error ? MESSAGE[error] : <span className="sr-only">{pin.length} of {PIN_LENGTH} digits</span>}
        </p>
        <div className="lock__keys">
          {KEYS.map((k, i) => (k
            ? (
              <button key={i} type="button" className="lock__key num" onClick={() => press(k)}
                aria-label={k === '⌫' ? 'Delete' : k}>
                {k}
              </button>
            )
            : <span key={i} />))}
        </div>
      </div>
      <p className="lock__hint">Kitchen <kbd>F2</kbd></p>
    </main>
  );
}
