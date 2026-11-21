import { useMemo, useState } from 'react';
import { checkCreditSetting, creditOf, daysSince, settingLabel, statement, type CreditSetting } from '../../domain/credit.ts';
import { fmt, parseLKR } from '../../domain/money.ts';
import type { SyncEvent } from '../../domain/sync.ts';
import { setCredit } from '../../services/creditStore.ts';
import { signedIn } from '../../services/serverAuth.ts';
import { shortDate } from './CustomerList.tsx';
import type { Notice } from './CustomersView.tsx';

/**
 * A customer's credit (credit.ts), on their page. Who: the owner, who decides who may eat now and pay
 * at the month's end, and how much; managers see it. What he wants: what they owe, since when, and
 * one place to turn credit on, change the limit or turn it off. Each change is one event with Undo.
 */
type Choice = 'off' | 'limit' | 'none';
const choiceOf = (s: CreditSetting | null): Choice => (!s ? 'off' : s.limit === null ? 'none' : 'limit');
const CHOICES: { id: Choice; label: string }[] = [{ id: 'off', label: 'Off' }, { id: 'limit', label: 'With a limit' }, { id: 'none', label: 'No limit' }];

export function CreditPanel({ customerId, name, events, now, isOwner, onSaved }: {
  customerId: string; name: string; events: readonly SyncEvent[]; now: number; isOwner: boolean; onSaved: (n: Notice) => void;
}) {
  const account = useMemo(() => creditOf(events, customerId), [events, customerId]);
  const rows = useMemo(() => statement(account), [account]);
  const [choice, setChoice] = useState<Choice>(choiceOf(account.setting));
  const [typed, setTyped] = useState(account.setting?.limit ? String(account.setting.limit / 100) : '');
  const [error, setError] = useState('');

  const after: CreditSetting | null | undefined = choice === 'off' ? null : choice === 'none' ? { limit: null }
    : (() => { const c = parseLKR(typed); return c === null ? undefined : { limit: c }; })();
  const same = after !== undefined && JSON.stringify(after) === JSON.stringify(account.setting);

  const save = () => {
    const owner = signedIn();
    if (!owner || owner.role !== 'owner') { setError('Only the owner changes credit.'); return; }
    if (after === undefined) { setError('Type the limit in rupees, like 20000.'); return; }
    const why = checkCreditSetting(after);
    if (why) { setError(`Not saved: ${why}.`); return; }
    setError('');
    const undo = setCredit(customerId, after, owner);
    onSaved({
      message: after === null ? `Credit off for ${name}${account.owes > 0 ? `: they still owe Rs ${fmt(account.owes)}` : ''}.` : `${name}: credit on, ${after.limit === null ? 'no limit' : `limit Rs ${fmt(after.limit)}`}.`,
      undo: async () => undo(),
    });
  };

  const limit = account.setting?.limit ?? null;
  return (
    <section className="crm-credit" aria-label="Credit">
      <h3>Credit</h3>
      <ul className="crm-tiles" aria-label="Their credit">
        <li><b className="num">{account.owes > 0 ? `Rs ${fmt(account.owes)}` : account.owes < 0 ? `Rs ${fmt(-account.owes)} ahead` : '–'}</b><span>owes</span></li>
        <li><b className="num">{settingLabel(account.setting).replace(/^Limit /, '')}</b><span>{!account.setting ? 'credit' : account.isDefault ? 'limit · the shop default' : 'limit'}</span></li>
        <li><b>{account.oldestOpenAt ? `${daysSince(account.oldestOpenAt, now)} days` : '–'}</b><span>oldest unpaid bill</span></li>
        <li><b>{account.lastPaidAt ? shortDate(account.lastPaidAt) : 'Never'}</b><span>last paid back</span></li>
      </ul>
      {limit !== null && account.owes > limit && <p className="crm__muted">Over the limit: no more on credit until they pay below Rs {fmt(limit)}, or a manager allows it.</p>}

      {isOwner ? (
        <form className="crm-credit__set" aria-label="Change credit" onSubmit={(e) => { e.preventDefault(); save(); }}>
          <div className="cats" role="radiogroup" aria-label="Credit for this customer">
            {CHOICES.map((c) => (
              <button key={c.id} type="button" role="radio" className="pill" aria-checked={choice === c.id} aria-pressed={choice === c.id}
                onClick={() => { setChoice(c.id); setError(''); }}>{c.label}</button>
            ))}
          </div>
          {choice === 'limit' && (
            <label className="setup__field crm-credit__limit"><span>Limit, Rs</span>
              <input className="num" inputMode="numeric" autoFocus value={typed} placeholder="20000" maxLength={10}
                onChange={(e) => { setTyped(e.target.value.replace(/[^\d.,]/g, '')); setError(''); }} /></label>
          )}
          <button type="submit" className="inv-page__primary" disabled={same}>Save</button>
          {choice === 'off' && account.owes > 0 && <span className="crm__muted">Turning it off keeps what they owe; they can still pay it back.</span>}
          {error && <p className="setup__error" role="alert">{error}</p>}
        </form>
      ) : <p className="crm__muted">Only the owner turns credit on or off and sets the limit.</p>}

      {rows.length > 0 && (
        <table className="crm-list" aria-label="Credit, newest first">
          <thead><tr><th scope="col">Date</th><th scope="col">What</th><th scope="col" className="crm-list__n">Amount</th><th scope="col" className="crm-list__n">Owes after</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{shortDate(r.at)}</td>
                <td>{r.kind === 'bill' ? `On credit · ${r.text}` : r.text}</td>
                <td className={`num crm-list__n${r.kind === 'paid' ? ' crm-credit__in' : ''}`}>{r.kind === 'paid' ? '− ' : ''}Rs {fmt(Math.abs(r.amount))}</td>
                <td className="num crm-list__n">Rs {fmt(r.owesAfter)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
