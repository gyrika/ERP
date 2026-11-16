import { label, type LabelKey } from './labels.ts';

/** One button on the bar: always there, greyed (never hidden) when it cannot be done now. */
export interface BarAction {
  id: 'pay' | 'send' | 'void' | 'clear' | 'new' | 'print';
  /** The button's words; PAY may say what it does instead ("Charge 500 more", "Close · Free"). */
  text?: string;
  run: () => void;
  disabled: boolean;
}

const WORDS: Record<BarAction['id'], { key: LabelKey; f: string; tone: string }> = {
  pay: { key: 'pay', f: 'F2', tone: 'pay' },
  send: { key: 'send', f: 'F3', tone: 'main' },
  void: { key: 'voidItem', f: 'F4', tone: 'danger-line' },
  clear: { key: 'clearBill', f: 'F5', tone: 'danger' },
  new: { key: 'newBill', f: 'F6', tone: 'plain' },
  print: { key: 'printLast', f: 'F8', tone: 'plain' },
};

/** The order the bar keeps, left to right, whatever order the actions are given in. */
const ORDER: BarAction['id'][] = ['pay', 'send', 'void', 'clear', 'new', 'print'];

/**
 * The counter's every-day actions in one bar along the bottom (recognition over recall): each a
 * labelled button with its key printed on it, in the same place on every bill. PAY is the largest.
 */
export function ActionBar({ actions }: { actions: BarAction[] }) {
  const byId = new Map(actions.map((a) => [a.id, a]));
  return (
    <nav className="actbar" aria-label="Bill actions">
      {ORDER.map((id) => {
        const a = byId.get(id);
        if (!a) return null;
        const w = WORDS[id];
        const text = a.text ?? label(w.key);
        return (
          <button
            key={id}
            type="button"
            className={`actbar__btn actbar__btn--${w.tone}`}
            aria-label={text}
            aria-keyshortcuts={w.f}
            disabled={a.disabled}
            onClick={a.run}
          >
            <span className="actbar__text" aria-hidden="true">{text}</span>
            <kbd aria-hidden="true">{w.f}</kbd>
          </button>
        );
      })}
    </nav>
  );
}
