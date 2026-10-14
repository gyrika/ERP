import { useEffect, useRef, useState } from 'react';
import { menuItems, itemById } from '../domain/menu.ts';
import { ShorthandInterpreter } from '../domain/parser.ts';
import type { LineSpec, OrderDraft, OrderInterpreter } from '../domain/types.ts';
import { useMenu } from './menuStore.ts';
import { leaveOutsOf, lineItemName, secondHalf } from '../domain/halves.ts';

/**
 * The screen only knows OrderInterpreter. Swap this implementation for a voice or
 * LLM implementation later; nothing else in the UI changes.
 */
export const describe = (l: LineSpec): string => {
  const item = itemById(l.itemId);
  const size = item.variants?.find((v) => v.id === l.size)?.label;
  const outs = leaveOutsOf(item, secondHalf(l));
  const mods = [
    ...l.adds.map((id) => item.adds.find((o) => o.id === id)?.label),
    ...l.outs.map((id) => outs.find((o) => o.id === id)?.label),
    l.note,
  ].filter(Boolean);
  return [`${l.qty > 1 ? `${l.qty} × ` : ''}${lineItemName(l)}`, size, ...mods].filter(Boolean).join(' · ');
};

interface Props {
  initial: string;
  onSubmit: (specs: LineSpec[]) => void;
  onClose: () => void;
}

/** Appears the moment the cashier starts typing; one-glance preview before Enter. */
export function ShorthandBar({ initial, onSubmit, onClose }: Props) {
  const menuVersion = useMenu();
  const [text, setText] = useState(initial);
  const [draft, setDraft] = useState<OrderDraft>({ lines: [], unresolved: [] });
  const inputRef = useRef<HTMLInputElement>(null);
  const latest = useRef(0);

  useEffect(() => {
    const el = inputRef.current;
    if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
  }, []);

  useEffect(() => {
    const id = ++latest.current;
    const interpreter: OrderInterpreter = new ShorthandInterpreter(menuItems());
    Promise.resolve(interpreter.interpret(text)).then((d) => { if (id === latest.current) setDraft(d); });
  }, [text, menuVersion]);

  const offered = (line: LineSpec) => {
    return [line.itemId, ...(line.half ? [line.half] : [])].map(itemById).every((item) => !item.soldOut && !item.hidden);
  };
  const availableLines = draft.lines.filter(offered);
  const unavailableLines = draft.lines.filter((line) => !offered(line));

  const submit = () => {
    if (!availableLines.length) return;
    onSubmit(availableLines);
    if (draft.unresolved.length) setText(draft.unresolved.join(', ')); // keep only what needs fixing
    else onClose();
  };

  return (
    <div className="typebar">
      <div className="typebar__field">
        <input
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
            if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
          }}
          placeholder="5 L, 2 margherita, burger no tomato…"
          aria-label="Type an order"
          spellCheck={false}
          autoComplete="off"
        />
      </div>
      <div className="typebar__preview" aria-live="polite">
        {availableLines.map((l, i) => <span key={i}>{describe(l)}</span>)}
        {unavailableLines.map((l, i) => (
          <span key={`blocked${i}`} className="typebar__bad">
            {itemById(l.itemId).name.en}: {itemById(l.itemId).hidden ? 'not on the menu' : 'sold out'}
          </span>
        ))}
        {draft.unresolved.map((u, i) => <span key={`u${i}`} className="typebar__bad">? {u}</span>)}
      </div>
    </div>
  );
}
