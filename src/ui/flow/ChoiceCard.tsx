import type { ReactNode } from 'react';

/**
 * One big card to tap: a name, a plain-words line, and optionally a tag and a badge.
 * Borderless, with a stripe on the left for how it stands (green fine, orange needs a
 * look, red wrong), the way the Owner feed's cards read.
 */
export function ChoiceCard({ name, line, tag, corner, badge, tone, pressed, disabled, label, onClick, children }: {
  name: string;
  line?: string;
  tag?: string;
  /** A quiet fact in the top right corner ("Approved by Ravi"). */
  corner?: string;
  badge?: string | number;
  tone?: 'ok' | 'warn' | 'bad';
  /** For a choice between options: this one is picked. */
  pressed?: boolean;
  disabled?: boolean;
  /** The button's name when it should be shorter than what is shown. */
  label?: string;
  onClick: () => void;
  children?: ReactNode;
}) {
  return (
    <button type="button" className={`flow-card flow-card--tap${tone ? ` flow-card--${tone}` : ''}`} aria-label={label} aria-pressed={pressed}
      disabled={disabled} onClick={onClick}>
      <span className="flow-card__text">
        <span className="flow-card__name">{name}</span>
        {line && <span className="flow-card__line">{line}</span>}
        {tag && <span className="flow-card__tag">{tag}</span>}
        {children}
      </span>
      {corner && <span className="flow-card__corner">{corner}</span>}
      {badge !== undefined && badge !== '' && <span className="flow-card__badge">{badge}</span>}
    </button>
  );
}

/** The same card, not tappable: a line of a summary. */
export function InfoCard({ name, line, tone, aside, label, children }: {
  name: string; line?: string; tone?: 'ok' | 'warn' | 'bad'; aside?: string; label?: string; children?: ReactNode;
}) {
  return (
    <div className={`flow-card${tone ? ` flow-card--${tone}` : ''}`} aria-label={label} role={label ? 'group' : undefined}>
      <span className="flow-card__text">
        <span className="flow-card__name">{name}</span>
        {line && <span className="flow-card__line">{line}</span>}
        {children}
      </span>
      {aside && <span className="flow-card__badge">{aside}</span>}
    </div>
  );
}
