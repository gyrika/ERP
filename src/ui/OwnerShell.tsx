import { useEffect, useRef, useState, type ReactNode } from 'react';
import { OwnerMenu, SECTIONS, useSections, type Section } from './OwnerNav.tsx';

/**
 * The owner area's frame: the menu on the left, the chosen tab's screen on the right.
 * Wide screens (the counter PC, a tablet across) keep the menu open; narrow ones get a
 * Menu button that slides it in from the left (Esc, the dark side or choosing a tab closes
 * it). The menu stays still while the right side changes. Ctrl+1…7 jumps to a tab.
 */
export function OwnerShell({ current, onRegister, onSwitch, children }: {
  current: Section;
  onRegister?: () => void;
  onSwitch?: () => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLElement>(null);
  const sections = useSections();
  const label = SECTIONS.find((s) => s.id === current)?.label ?? '';

  // A new tab: the drawer has done its job.
  useEffect(() => setOpen(false), [current]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const inDialog = e.target instanceof HTMLElement && e.target.closest('[role="dialog"]');
      if (e.key === 'Escape' && open) { e.preventDefault(); setOpen(false); return; }
      if (inDialog || !e.ctrlKey || e.altKey || e.metaKey || !/^[1-9]$/.test(e.key)) return;
      const s = sections[Number(e.key) - 1];
      if (!s) return;
      e.preventDefault();
      location.hash = `#${s.id}`;
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, sections]);

  // Opening the drawer puts the keyboard on the current tab.
  useEffect(() => {
    if (open) menu.current?.querySelector<HTMLAnchorElement>('a[aria-current="page"], a')?.focus();
  }, [open]);

  return (
    <div className="oshell" data-open={open}>
      <aside ref={menu} id="owner-menu" className="oshell__menu" aria-label="Owner menu">
        <OwnerMenu current={current} onRegister={onRegister} onSwitch={onSwitch} onPick={() => setOpen(false)} />
      </aside>
      <div className="oshell__scrim" onClick={() => setOpen(false)} aria-hidden />
      <div className="oshell__panel">
        <div className="oshell__bar">
          <button type="button" className="oshell__toggle" aria-expanded={open} aria-controls="owner-menu" onClick={() => setOpen(!open)}>
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="M4 6h16M4 12h16M4 18h16" /></svg>
            <span className="sr-only">Open menu</span>
          </button>
          <span className="oshell__where">{label}</span>
        </div>
        {children}
      </div>
    </div>
  );
}
