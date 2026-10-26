import { useState, type FormEvent } from 'react';
import { PIN_LENGTH } from '../../domain/auth.ts';

/** The owner's PIN, in the page's line: no dialog. Computer vision's switch and its camera views share it. */
export function PinLine({ what, onPin, onCancel }: { what: string; onPin: (pin: string) => void; onCancel: () => void }) {
  const [pin, setPin] = useState('');
  const submit = (e: FormEvent) => { e.preventDefault(); if (pin.length === PIN_LENGTH) onPin(pin); };
  return (
    <form className="vision__line vision__pin" onSubmit={submit}>
      <label className="setup__field setup__field--pin"><span>The owner's PIN to {what}</span>
        <input type="password" inputMode="numeric" autoFocus autoComplete="off" maxLength={PIN_LENGTH} value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, PIN_LENGTH))}
          onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onCancel(); } }} /></label>
      <button type="submit" className="chip chip--solid" disabled={pin.length !== PIN_LENGTH}>Continue</button>
      <button type="button" className="chip" onClick={onCancel}>Cancel</button>
    </form>
  );
}
