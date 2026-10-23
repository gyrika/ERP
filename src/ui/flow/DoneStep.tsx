import type { ReactNode } from 'react';

/** The finish of a flow: a green tick, one sentence, and what to do next. */
export function DoneStep({ title, line, children }: { title: string; line?: string; children?: ReactNode }) {
  return (
    <div className="flow-done" role="status">
      <span className="flow-tick" aria-hidden>
        <svg viewBox="0 0 24 24" width="44" height="44" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 12.5l4.5 4.5L19 7.5" />
        </svg>
      </span>
      <strong className="flow-done__title">{title}</strong>
      {line && <p className="flow-done__line">{line}</p>}
      {children && <div className="flow-done__actions">{children}</div>}
    </div>
  );
}
