import { useState, type FormEvent } from 'react';
import {
  checkAnswer, prepOf, questionSubject, recipeChoices, recipeUnit, type Answer, type CostContext, type OpenQuestion,
} from '../domain/costing.ts';
import type { Actor } from '../domain/auth.ts';
import { itemById } from '../domain/menu.ts';
import { fmt, parseLKR } from '../domain/money.ts';
import { answerQuestion } from '../services/inventoryStore.ts';
import { NumberInput } from './NumberInput.tsx';

/**
 * Serves the owner, who knows his kitchen: his recipes are in, and the app asks
 * only what his sheets left open, one question at a time, on the Recipes screen.
 * Each answer is saved at once (audited, with Undo). Nothing is filled in for him.
 */
const amount = (raw: string): number | null => (/^\d+(\.\d{1,3})?$/.test(raw.trim()) ? Number(raw.trim()) : null);
const words = (s: string) => s.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 3);

/** One question, asked in full, inline on the Recipes screen (actor: the owner who opened it). */
export function Question({ q, ctx, actor, autoFocus = true, onAnswered, onSkip }: {
  q: Pick<OpenQuestion, 'id' | 'kind'> & { blocks?: string[] }; ctx: CostContext; actor?: Actor; autoFocus?: boolean;
  onAnswered: (message: string, undo: () => void) => void; onSkip?: () => void;
}) {
  const subject = questionSubject(q.id);
  const unit = recipeUnit(subject) ?? 'g';
  const [qty, setQty] = useState('');
  const [rupees, setRupees] = useState('');
  const [chosen, setChosen] = useState<string | null>(null);
  /** How many base units of the chosen item one recipe unit takes (raw chicken for cooked cubes). */
  const [per, setPer] = useState('1');
  const [error, setError] = useState('');

  const [itemId, size] = subject.split(':');
  const menuItem = q.kind === 'recipe' ? itemById(itemId) : null;
  const sizeLabel = menuItem?.variants?.find((v) => v.id === size)?.label ?? '';
  // Ingredients: price-list items in the same unit that share a word with it come first.
  const sameUnit = ctx.items.filter((i) => i.baseUnit === unit && words(i.name).some((w) => words(subject).includes(w)));
  const otherUnit = ctx.items.filter((i) => i.baseUnit !== unit && words(i.name).some((w) => words(subject).includes(w)));
  const asked = q.kind === 'yield' ? `${subject}: how much does one batch make?`
    : q.kind === 'recipe' ? `${menuItem!.name.en}${sizeLabel ? ` ${sizeLabel}` : ''}: which of your recipes is it?`
      : sameUnit.length ? `${subject}: which item on your price list is it?` : `${subject}: what does it cost?`;

  const save = (event: FormEvent) => {
    event.preventDefault();
    let answer: Answer;
    let said: string;
    if (q.kind === 'yield') {
      const n = amount(qty);
      if (!n) return setError(`Type how many ${unit} one batch makes.`);
      answer = { kind: 'yield', qty: n };
      said = `${subject} makes ${n.toLocaleString('en-US')} ${unit} a batch.`;
    } else if (q.kind === 'recipe') {
      if (!chosen) return setError('Choose one of your recipes.');
      answer = { kind: 'recipe', product: chosen };
      said = `${menuItem!.name.en}${sizeLabel ? ` ${sizeLabel}` : ''} is made as ${chosen}.`;
    } else if (chosen) {
      const n = amount(per);
      if (!n) return setError('Type how much of the item one unit takes (1 when it goes in as it is).');
      const item = ctx.items.find((i) => i.id === chosen);
      answer = { kind: 'source', inventoryId: chosen, per: n };
      said = n === 1 ? `${subject} is ${item?.name}.` : `1 ${unit} of ${subject} takes ${n.toLocaleString('en-US')} ${item?.baseUnit} of ${item?.name}.`;
    } else {
      const cents = parseLKR(rupees);
      const n = amount(qty);
      if (cents === null || !n) return setError(`Choose an item above, or type a price and how many ${unit} it buys.`);
      answer = { kind: 'price', cents, qty: n };
      said = `${subject}: Rs ${fmt(cents)} for ${n.toLocaleString('en-US')} ${unit}.`;
    }
    const wrong = checkAnswer(q.id, answer);
    if (wrong) return setError(wrong);
    onAnswered(said, answerQuestion(q.id, answer, ctx.answers.get(q.id) ?? null, actor));
  };

  return (
    <form className="costq__q" onSubmit={save} aria-label={asked}>
      <h2 className="costq__ask">{asked}</h2>
      {q.blocks && (
        <p className="costq__blocks">
          Holds back {q.blocks.length} {q.blocks.length === 1 ? 'item' : 'items'}: {q.blocks.slice(0, 4).join(', ')}{q.blocks.length > 4 ? ` and ${q.blocks.length - 4} more` : ''}.
        </p>
      )}

      {q.kind === 'yield' && (
        <>
          <p className="costq__hint">Your recipe for one batch: {prepOf(subject, ctx.answers)?.lines.map((l) => `${l.qty.toLocaleString('en-US')} ${l.unit} ${l.name}`).join(', ')}.</p>
          <label className="costq__field">
            <span>One batch makes ({unit})</span>
            <NumberInput autoFocus={autoFocus}  value={qty} onText={(text) => { setQty(text); setError(''); }} />
          </label>
        </>
      )}

      {q.kind === 'recipe' && (
        <>
          <div className="chips" role="group" aria-label="Your recipes">
            {recipeChoices(menuItem!, size).map((name) => (
              <button key={name} type="button" className="chip" aria-pressed={chosen === name} onClick={() => { setChosen(name); setError(''); }}>{name}</button>
            ))}
          </div>
          <p className="costq__hint">Not one of these? <a href="#recipes">Write it in Recipes</a>.</p>
        </>
      )}

      {q.kind === 'ingredient' && (
        <>
          {sameUnit.length > 0 && (
            <div className="chips" role="group" aria-label="On your price list">
              {sameUnit.map((i) => (
                <button key={i.id} type="button" className="chip" aria-pressed={chosen === i.id}
                  onClick={() => { setChosen(chosen === i.id ? null : i.id); setError(''); }}>
                  {i.name}
                </button>
              ))}
            </div>
          )}
          {chosen !== null && (
            <label className="costq__field">
              <span>1 {unit} of {subject} takes ({ctx.items.find((i) => i.id === chosen)?.baseUnit} of it; 1 when it goes in as it is)</span>
              <NumberInput value={per} onText={(text) => { setPer(text); setError(''); }} />
            </label>
          )}
          <p className="costq__hint">
            {sameUnit.length > 0 ? 'Or type its price' : 'Type its price'} (your recipes use it in {unit}).
            {otherUnit.length > 0 && ` On your price list: ${otherUnit.map((i) => `${i.name}, Rs ${fmt(i.workingPriceCents)} for ${i.packQty.toLocaleString('en-US')} ${i.baseUnit}`).join('; ')}.`}
          </p>
          <div className="costq__price">
            <label className="costq__field"><span>Rs</span>
              <NumberInput decimals={2} value={rupees} disabled={chosen !== null} onText={(text) => { setRupees(text); setError(''); }} />
            </label>
            <label className="costq__field"><span>for ({unit})</span>
              <NumberInput value={qty} disabled={chosen !== null} onText={(text) => { setQty(text); setError(''); }} />
            </label>
          </div>
        </>
      )}

      {error && <p className="costq__error" role="alert">{error}</p>}
      <div className="costq__actions">
        {onSkip && <button type="button" className="linkbtn" onClick={onSkip}>Skip</button>}
        <button type="submit" className="cta">Save</button>
      </div>
    </form>
  );
}
