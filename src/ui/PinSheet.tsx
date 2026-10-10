import { useEffect, useState } from 'react';
import { requireManager, type Actor } from '../domain/auth.ts';

const PIN_LENGTH = 4;

interface Props {
  onUnlock: (manager: Actor) => void;
  onClose: () => void;
}

/**
 * "Ask manager": one key opens this, the manager types the PIN, done. The
 * field is focused at once (number pad on tablets) and checks itself at four
 * digits, so there is no extra button to press.
 */
export function PinSheet({ onUnlock, onClose }: Props) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState(false);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const check = async (value: string) => {
    setChecking(true);
    const manager = await requireManager(value);
    setChecking(false);
    if (manager) { onUnlock(manager); return; }
    setError(true);
    setPin('');
  };

  const onChange = (raw: string) => {
    const value = raw.replace(/\D/g, '').slice(0, PIN_LENGTH);
    setPin(value);
    setError(false);
    if (value.length === PIN_LENGTH) void check(value);
  };

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="sheet sheet--pin" role="dialog" aria-modal="true" aria-label="Manager PIN">
        <div className="sheet__body">
          <div className="sheet__title">
            <h1>Manager PIN</h1>
            <span>To change or cancel sent items</span>
          </div>
          <input
            className={`pin${error ? ' pin--error' : ''}`}
            type="password"
            inputMode="numeric"
            autoComplete="off"
            value={pin}
            readOnly={checking}
            onChange={(e) => onChange(e.target.value)}
            aria-label="Manager PIN"
            aria-invalid={error}
            aria-describedby="pin-msg"
            autoFocus
          />
          <p id="pin-msg" className="pin__msg" role={error ? 'alert' : undefined}>
            {error ? 'PIN not accepted. Only a manager or owner can do this.' : ' '}
          </p>
        </div>
        <div className="sheet__foot" />
      </div>
    </>
  );
}
