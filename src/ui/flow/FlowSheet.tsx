import { useEffect, useId, useRef, type ReactNode } from 'react';

/**
 * The shell of a guided flow (Purchase orders, GRN, Stock rules): the app's bottom sheet,
 * a title, a thin progress bar, ONE big button at the foot, and a way back one step.
 * Keyboard first: Enter does the big button (unless focus is on a button, link or list),
 * Esc goes back one step, then closes.
 */
export interface FlowPrimary {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

export function FlowSheet({ title, sub, step, onBack, onClose, primary, extra, error, keys = true, inline = false, className, children }: {
  /** The dialog's name: also what screen readers announce. */
  title: string;
  /** A quiet line after the title (a supplier, a PO). */
  sub?: string;
  /** Where the person is: "Step 2 of 4 · Check each item". Omit for a single screen. */
  step?: { index: number; of: number; label?: string };
  /** Back one step. Without it, Back is not shown and Esc closes. */
  onBack?: () => void;
  onClose: () => void;
  /** The one main button. Omit on a screen that only informs. */
  primary?: FlowPrimary;
  /** A quiet extra at the foot, left of the main button (a link, not another big button). */
  extra?: ReactNode;
  error?: string;
  /** Turn the keys off while something sits on top (the PIN sheet). */
  keys?: boolean;
  /**
   * In the page itself (the Receive and Order pages, in the panel beside the menu) instead of
   * a sheet over it: no backdrop, no Close; closing starts the flow over.
   */
  inline?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const titleId = useId();
  const latest = useRef({ onBack, onClose, primary });
  const sheet = useRef<HTMLElement>(null);
  const stepKey = step ? `${step.index}-${step.label ?? ''}` : 'one';
  latest.current = { onBack, onClose, primary };

  // The sheet takes the keyboard when it opens and at each step (unless focus is already inside it),
  // so Enter means this sheet's big button, not whatever was focused behind it.
  useEffect(() => {
    const el = sheet.current;
    if (el && keys && !el.contains(document.activeElement)) el.focus({ preventScroll: true });
  }, [stepKey, keys]);

  useEffect(() => {
    if (!keys) return;
    const onKey = (e: KeyboardEvent) => {
      const { onBack: back, onClose: close, primary: main } = latest.current;
      if (e.key === 'Escape') { e.preventDefault(); (back ?? close)(); return; }
      if (e.key !== 'Enter' || e.defaultPrevented || !main || main.disabled) return;
      const t = e.target as HTMLElement | null;
      // Enter on a button, link or select already means something; in a text box it means "next".
      if (t && (t.closest('button, a, select, textarea') || t.getAttribute('role') === 'listbox')) return;
      e.preventDefault();
      main.onClick();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [keys]);

  const Frame = inline ? 'section' : 'div';
  return (
    <>
      {!inline && <div className="scrim" onClick={keys ? onClose : undefined} />}
      <Frame ref={sheet as never} tabIndex={-1} className={`${inline ? 'flow flow--inline' : 'sheet flow'}${className ? ` ${className}` : ''}`}
        role={inline ? 'region' : 'dialog'} aria-modal={inline ? undefined : true} aria-labelledby={titleId}>
        <div className="sheet__body flow__body">
          <div className="sheet__title">
            <h1 id={titleId}>{title}</h1>
            {sub && <span>{sub}</span>}
            {!inline && <button type="button" className="linkbtn" onClick={onClose}>Close</button>}
          </div>
          {step && (
            <div className="flow__where">
              <div className="flow__progress" role="progressbar" aria-label="Progress" aria-valuemin={1} aria-valuemax={step.of} aria-valuenow={step.index}>
                <span style={{ width: `${(step.index / step.of) * 100}%` }} />
              </div>
              <p className="flow__step">Step {step.index} of {step.of}{step.label ? ` · ${step.label}` : ''}</p>
            </div>
          )}
          {/* A new key per step makes each one slide in. */}
          <div className="flow__content" key={stepKey}>{children}</div>
          {error && <p className="reason-msg" role="alert">{error}</p>}
        </div>
        {(primary || onBack || extra) && (
          <div className="sheet__foot flow__foot">
            {onBack && <button type="button" className="linkbtn flow__back" onClick={onBack}>Back</button>}
            {extra}
            {primary && <button type="button" className="cta flow__cta" disabled={primary.disabled} onClick={primary.onClick}>{primary.label}</button>}
          </div>
        )}
      </Frame>
    </>
  );
}
