/**
 * A big − number + for the one number a step asks for: easy to hit with a thumb, easy to
 * read from arm's length. The number can also be typed (kg, half packs). Orange when it
 * is not what was expected.
 */
export function BigStepper({ value, unit, label, tone, compact, onText, onBump, lessLabel, moreLabel }: {
  /** What is in the box, as typed. */
  value: string;
  /** What the number counts: "packs", "kg". Shown under it. */
  unit: string;
  /** Names the number box for screen readers (the item and its unit). */
  label: string;
  tone?: 'ok' | 'warn';
  /** Smaller, for a stepper on each card of a list. */
  compact?: boolean;
  onText: (text: string) => void;
  /** One more or one less. */
  onBump: (by: 1 | -1) => void;
  lessLabel: string;
  moreLabel: string;
}) {
  return (
    <div className={`bigstep${tone ? ` bigstep--${tone}` : ''}${compact ? ' bigstep--compact' : ''}`}>
      <button type="button" className="bigstep__btn" aria-label={lessLabel} onClick={() => onBump(-1)}>−</button>
      <div className="bigstep__mid">
        <input className="bigstep__num num" inputMode="decimal" aria-label={label} placeholder="0" value={value} onChange={(e) => onText(e.target.value)}
          onFocus={(e) => e.currentTarget.select()} />
        <span className="bigstep__unit">{unit}</span>
      </div>
      <button type="button" className="bigstep__btn" aria-label={moreLabel} onClick={() => onBump(1)}>+</button>
    </div>
  );
}
