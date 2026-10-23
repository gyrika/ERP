import { useMemo, useState } from 'react';

export interface Command {
  id: string;
  label: string;
  /** Shown on the right, e.g. the direct key for it. */
  hint?: string;
  run: () => void;
}

interface Props {
  commands: Command[];
  onClose: () => void;
  /** What the box says before anything is typed. */
  placeholder?: string;
}

/**
 * Ctrl+K. Type to filter, arrows to move, Enter to run. Esc is handled by the
 * caller (it leaves manager mode from any state, the palette included).
 */
export function CommandPalette({ commands, onClose, placeholder = 'Type a command' }: Props) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? commands.filter((c) => c.label.toLowerCase().includes(q)) : commands;
  }, [commands, query]);
  const current = Math.min(active, Math.max(0, shown.length - 1));

  const run = (c: Command | undefined) => {
    if (!c) return;
    onClose();
    c.run();
  };

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="palette" role="dialog" aria-modal="true" aria-label="Commands">
        <input
          className="palette__input"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setActive(0); }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive((current + 1) % Math.max(1, shown.length)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setActive((current - 1 + shown.length) % Math.max(1, shown.length)); }
            if (e.key === 'Enter') { e.preventDefault(); run(shown[current]); }
          }}
          placeholder={placeholder}
          aria-label={placeholder}
          aria-controls="palette-list"
          aria-activedescendant={shown[current] ? `cmd-${shown[current].id}` : undefined}
          autoFocus
        />
        <ul className="palette__list" id="palette-list" role="listbox" aria-label="Commands">
          {shown.length === 0 && <li className="palette__empty">No matching command</li>}
          {shown.map((c, i) => (
            <li
              key={c.id}
              id={`cmd-${c.id}`}
              role="option"
              aria-selected={i === current}
              className="palette__item"
              onPointerEnter={() => setActive(i)}
              onClick={() => run(c)}
            >
              <span>{c.label}</span>
              {c.hint && <kbd>{c.hint}</kbd>}
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
