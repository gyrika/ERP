import { useState, type FormEvent } from 'react';
import {
  checkAnswer, questionSubject, recipeChoices, recipeUnit, type Answer, type CostContext, type OpenQuestion,
} from '../domain/costing.ts';
import { itemById } from '../domain/menu.ts';
import { fmt, parseLKR } from '../domain/money.ts';
import { PREPS } from '../domain/recipeBook.ts';
import { answerQuestion } from '../services/inventoryStore.ts';

/**
 * Serves the owner, who knows his kitchen: his recipes are in, and the app asks
 * only what his sheets left open, one question at a time, those that hold back
 * the most menu items first. Each answer is saved at once (audited, with Undo);
 * Skip moves on. Nothing is filled in for him.
 */
const amount = (raw: string): number | null => (/^\d+(\.\d{1,3})?$/.test(raw.trim()) ? Number(raw.trim()) : null);
const words = (s: string) => s.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 3);

export function CostQuestions({ questions, ctx, onClose }: { questions: OpenQuestion[]; ctx: CostContext; onClose: () => void }) {
  const [skipped, setSkipped] = useState<string[]>([]);
  const [last, setLast] = useState<{ message: string; undo: () => void } | null>(null);
  const open = questions.filter((q) => !skipped.includes(q.id));
  const q = open[0] ?? null;

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <section className="sheet costq" role="dialog" aria-modal="true" aria-label="Costs: answer the gaps">
        <div className="sheet__body">
          <div className="sheet__title">
            <h1>Costs</h1>
            <span>{q ? `${open.length} ${open.length === 1 ? 'question' : 'questions'} left` : 'Nothing left to answer'}</span>
          </div>
          {last && (
            <p className="costq__saved" role="status">
              {last.message}
              <button type="button" className="linkbtn" onClick={() => { last.undo(); setLast(null); }}>Undo</button>
            </p>
          )}
          {q ? (
            <Question
              key={q.id} q={q} ctx={ctx}
              onAnswered={(message, undo) => setLast({ message, undo })}
              onSkip={() => { setSkipped([...skipped, q.id]); setLast(null); }}
            />
          ) : (
            <p className="costq__done">
              {skipped.length ? `You skipped ${skipped.length}. They stay in the list for later.` : 'Every menu item now has its full cost.'}
            </p>
          )}
        </div>
        <div className="sheet__foot">
          <button type="button" className="linkbtn" onClick={onClose}>Close</button>
        </div>
      </section>
    </>
  );
}

function Question({ q, ctx, onAnswered, onSkip }: {
  q: OpenQuestion; ctx: CostContext; onAnswered: (message: string, undo: () => void) => void; onSkip: () => void;
}) {
  const subject = questionSubject(q.id);
  const unit = recipeUnit(subject) ?? 'g';
  const [qty, setQty] = useState('');
  const [rupees, setRupees] = useState('');
  const [chosen, setChosen] = useState<string | null>(null);
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
      answer = { kind: 'source', inventoryId: chosen, per: 1 };
      said = `${subject} is ${ctx.items.find((i) => i.id === chosen)?.name}.`;
    } else {
      const cents = parseLKR(rupees);
      const n = amount(qty);
      if (cents === null || !n) return setError(`Choose an item above, or type a price and how many ${unit} it buys.`);
      answer = { kind: 'price', cents, qty: n };
      said = `${subject}: Rs ${fmt(cents)} for ${n.toLocaleString('en-US')} ${unit}.`;
    }
    const wrong = checkAnswer(q.id, answer);
    if (wrong) return setError(wrong);
    onAnswered(said, answerQuestion(q.id, answer, ctx.answers.get(q.id) ?? null));
  };

  return (
    <form className="costq__q" onSubmit={save} aria-label={asked}>
      <h2 className="costq__ask">{asked}</h2>
      <p className="costq__blocks">
        Holds back {q.blocks.length} {q.blocks.length === 1 ? 'item' : 'items'}: {q.blocks.slice(0, 4).join(', ')}{q.blocks.length > 4 ? ` and ${q.blocks.length - 4} more` : ''}.
      </p>

      {q.kind === 'yield' && (
        <>
          <p className="costq__hint">Your recipe for one batch: {PREPS[subject]?.lines.map((l) => `${l.qty.toLocaleString('en-US')} ${l.unit} ${l.name}`).join(', ')}.</p>
          <label className="costq__field">
            <span>One batch makes ({unit})</span>
            <input autoFocus className="num" inputMode="decimal" value={qty} onChange={(e) => { setQty(e.target.value); setError(''); }} />
          </label>
        </>
      )}

      {q.kind === 'recipe' && (
        <div className="chips" role="group" aria-label="Your recipes">
          {recipeChoices(menuItem!, size).map((name) => (
            <button key={name} type="button" className="chip" aria-pressed={chosen === name} onClick={() => { setChosen(name); setError(''); }}>{name}</button>
          ))}
        </div>
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
          <p className="costq__hint">
            {sameUnit.length > 0 ? 'Or type its price' : 'Type its price'} (your recipes use it in {unit}).
            {otherUnit.length > 0 && ` On your price list: ${otherUnit.map((i) => `${i.name}, Rs ${fmt(i.workingPriceCents)} for ${i.packQty.toLocaleString('en-US')} ${i.baseUnit}`).join('; ')}.`}
          </p>
          <div className="costq__price">
            <label className="costq__field"><span>Rs</span>
              <input className="num" inputMode="decimal" value={rupees} disabled={chosen !== null} onChange={(e) => { setRupees(e.target.value); setError(''); }} />
            </label>
            <label className="costq__field"><span>for ({unit})</span>
              <input className="num" inputMode="decimal" value={qty} disabled={chosen !== null} onChange={(e) => { setQty(e.target.value); setError(''); }} />
            </label>
          </div>
        </>
      )}

      {error && <p className="costq__error" role="alert">{error}</p>}
      <div className="costq__actions">
        <button type="button" className="linkbtn" onClick={onSkip}>Skip</button>
        <button type="submit" className="cta">Save</button>
      </div>
    </form>
  );
}
