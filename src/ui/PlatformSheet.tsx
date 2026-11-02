import { useEffect, useState, type FormEvent } from 'react';
import { cleanCode, type Platform, type PlatformMark } from '../domain/platforms.ts';

/**
 * A delivery app's order at the counter (SCRUM-195). Serves the cashier: the app's tablet has just
 * chimed, the app's rider will come for the food. What they know: the app's order code on that
 * tablet. The one thing next: type the code (Enter), then the items as for any order. The code is
 * what the rider says at the counter and what the kitchen ticket shows.
 */
export function PlatformSheet({ platform, onMark, onClose }: {
  platform: Platform; onMark: (m: PlatformMark) => void; onClose: () => void;
}) {
  const [raw, setRaw] = useState('');
  const code = cleanCode(raw);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (code) onMark({ id: platform.id, code });
  };
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="sheet" role="dialog" aria-modal="true" aria-label={`${platform.name} order`}>
        <form className="sheet__body platform" onSubmit={submit}>
          <h1>{platform.name} order</h1>
          <label className="platform__field">
            <span>{platform.name} order code</span>
            <input
              className="num" value={raw} onChange={(e) => setRaw(e.target.value)} autoFocus autoComplete="off" spellCheck={false}
              placeholder="4F2A9" maxLength={21} aria-invalid={raw !== '' && !code}
            />
          </label>
          <p className="platform__hint">The code on the {platform.name} tablet. Then add the items as usual.</p>
          <button type="submit" className="cta" disabled={!code}>Start order <kbd>Enter</kbd></button>
        </form>
      </div>
    </>
  );
}
