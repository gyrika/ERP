import { useMemo, useState } from 'react';

export function AutoSuggestPills({
  options,
  selectedIds,
  onToggle,
  placeholder,
  label,
}: {
  options: { id: string; name: string }[];
  selectedIds: string[];
  onToggle: (id: string) => void;
  placeholder: string;
  label: string;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const filtered = useMemo(() => {
    const matches = query
      ? options.filter((option) => option.name.toLowerCase().includes(query.toLowerCase()))
      : options;
    return matches.filter((option) => !selectedIds.includes(option.id)).slice(0, 5);
  }, [options, query, selectedIds]);

  return (
    <div
      className="inv-suggest"
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (!(next instanceof Node) || !event.currentTarget.contains(next)) setOpen(false);
      }}
    >
      <input
        type="search"
        className="inv-modal__input"
        placeholder={placeholder}
        aria-label={label}
        aria-expanded={open && filtered.length > 0}
        aria-controls={`${label.replace(/\s+/g, '-')}-options`}
        value={query}
        onFocus={() => setOpen(true)}
        onChange={(event) => { setQuery(event.target.value); setOpen(true); }}
      />
      {selectedIds.length > 0 && (
        <div className="inv-suggest__selected" aria-label={`Selected ${label.toLowerCase()}`}>
          {selectedIds.map((id) => {
            const option = options.find((candidate) => candidate.id === id);
            if (!option) return null;
            return (
              <button
                key={id}
                type="button"
                className="inv-suggest__pill"
                aria-label={`Remove ${option.name}`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onToggle(id)}
              >
                {option.name} <span aria-hidden="true">×</span>
              </button>
            );
          })}
        </div>
      )}
      {open && filtered.length > 0 && (
        <div className="inv-suggest__options" id={`${label.replace(/\s+/g, '-')}-options`}>
          {filtered.map((option) => (
            <button
              key={option.id}
              type="button"
              className="inv-suggest__option"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => { onToggle(option.id); setQuery(''); }}
            >
              + {option.name}
            </button>
          ))}
        </div>
      )}
      {open && query && filtered.length === 0 && (
        <p className="inv-suggest__empty">No matches.</p>
      )}
    </div>
  );
}
