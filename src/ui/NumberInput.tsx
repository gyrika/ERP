import type { InputHTMLAttributes, Ref } from 'react';

/**
 * What a number box keeps of what was typed or pasted (SCRUM-137): digits and one
 * decimal point, at most `decimals` after it. Letters never appear, so the counter's
 * keyboard can't put "two" or "2 packs" where a number belongs ("2 packs" keeps "2",
 * "Rs 1,250.50" keeps "1250.50").
 */
export const numberText = (raw: string, decimals: number): string => {
  const kept = raw.replace(/[^\d.]/g, '');
  const dot = kept.indexOf('.');
  if (dot < 0 || decimals === 0) return dot < 0 ? kept : kept.slice(0, dot);
  return `${kept.slice(0, dot)}.${kept.slice(dot + 1).replace(/\./g, '').slice(0, decimals)}`;
};

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'type' | 'inputMode' | 'value'> & {
  value: string;
  /** The cleaned text, never anything but a number in the making. */
  onText: (text: string) => void;
  /** Places after the point: 2 for rupees, 0 for whole numbers. Default 3 (kg, half packs). */
  decimals?: number;
  ref?: Ref<HTMLInputElement>;
  /** What the number counts, shown inside the box: "packs", "Rs", "g". */
  unit?: string;
};

/** The one number box (SCRUM-137): only a number can go in, and it says what it counts. */
export function NumberInput({ onText, decimals = 3, unit, className, ...rest }: Props) {
  const input = (
    <input
      {...rest}
      className={`${className ?? ''} num`.trim()}
      inputMode={decimals === 0 ? 'numeric' : 'decimal'}
      autoComplete="off"
      onChange={(e) => onText(numberText(e.target.value, decimals))}
    />
  );
  if (!unit) return input;
  return (
    <span className="numfield">
      {input}
      <span className="numfield__unit" aria-hidden="true">{unit}</span>
    </span>
  );
}
