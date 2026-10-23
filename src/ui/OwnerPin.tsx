import { useState } from 'react';
import { PIN_LENGTH, type Actor } from '../domain/auth.ts';
import { requireOwner } from '../services/auth.ts';

/** The owner's PIN, asked every time; anyone else's PIN is refused. */
export function OwnerPin({ onOpen, onCancel, refusal = 'Only the owner can change this.' }: {
  onOpen: (owner: Actor) => void; onCancel: () => void;
  /** Said when someone else's PIN is typed. */
  refusal?: string;
}) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState(false);
  const [checking, setChecking] = useState(false);

  const onChange = async (raw: string) => {
    const value = raw.replace(/\D/g, '').slice(0, PIN_LENGTH);
    setPin(value);
    setError(false);
    if (value.length !== PIN_LENGTH) return;
    setChecking(true);
    const owner = await requireOwner(value);
    setChecking(false);
    if (owner) return onOpen(owner);
    setError(true);
    setPin('');
  };

  return (
    <div className="mgr__pin">
      <span id="mgr-pin-msg" className={`mgr__pin-msg${error ? ' mgr__pin-msg--error' : ''}`} role={error ? 'alert' : undefined}>
        {error ? refusal : 'Owner PIN'}
      </span>
      <input
        className={`pin${error ? ' pin--error' : ''}`} type="password" inputMode="numeric" autoComplete="off"
        value={pin} readOnly={checking} autoFocus aria-label="Owner PIN" aria-invalid={error} aria-describedby="mgr-pin-msg"
        onChange={(e) => void onChange(e.target.value.replace(/\D/g, ''))} onKeyDown={(e) => { if (e.key === 'Escape') onCancel(); }}
      />
      <button type="button" className="linkbtn" onClick={onCancel}>Cancel</button>
    </div>
  );
}
