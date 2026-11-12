import { useMemo, useRef, useState } from 'react';
import type { ImportPlan, RowPlan } from '../../domain/customerImport.ts';
import { formatLkMobile } from '../../domain/phone.ts';
import { crmClient } from '../../services/crmClient.ts';

/**
 * Import: the owner's list in. Who: the owner (or a manager) with a spreadsheet of names and mobile
 * numbers. The one next thing: pick the file. Then the page says what would happen, row by row where
 * it matters, and Save does exactly that. Nothing is saved before Save; the same file twice adds nobody.
 */
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-GB')} ${n === 1 ? one : many}`;

type Step =
  | { at: 'pick' }
  | { at: 'reading'; file: File }
  | { at: 'preview'; file: File; plan: ImportPlan }
  | { at: 'saving'; file: File; plan: ImportPlan }
  | { at: 'saved'; added: number; updated: number; plan: ImportPlan };

/** The rows that need the owner's eye: what will not go in, and why. Fine rows are only counted. */
const attention = (rows: readonly RowPlan[]) => rows.filter((r) =>
  r.kind === 'invalid' || r.kind === 'duplicate' || (r.kind === 'unchanged' && r.fileName && r.keptName && r.fileName !== r.keptName)
  || ('notes' in r && r.notes.length > 0));

const say = (r: RowPlan): { what: string; why: string } => {
  switch (r.kind) {
    case 'invalid': return { what: r.raw || '(no number)', why: r.reason };
    case 'duplicate': return { what: formatLkMobile(r.phone), why: `the same number as row ${r.sameAs}` };
    case 'unchanged': return { what: formatLkMobile(r.phone), why: `already on the list as “${r.keptName}”; the file says “${r.fileName}”` };
    default: return { what: formatLkMobile(r.phone), why: r.notes.join('; ') };
  }
};

export function ImportPanel({ count, onSaved }: { count: number | null; onSaved: () => Promise<void> }) {
  const [step, setStep] = useState<Step>({ at: 'pick' });
  const [rename, setRename] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);

  const read = async (file: File, withRename: boolean) => {
    setError('');
    setStep({ at: 'reading', file });
    try {
      const { plan } = await crmClient.preview(file, withRename);
      if (plan.error) { setError(`${file.name}: ${plan.error}.`); setStep({ at: 'pick' }); return; }
      setStep({ at: 'preview', file, plan });
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); setStep({ at: 'pick' }); }
  };
  const pick = (file: File | undefined) => { if (file) { setRename(false); void read(file, false); } };
  const save = async () => {
    if (step.at !== 'preview') return;
    setError('');
    setStep({ at: 'saving', file: step.file, plan: step.plan });
    try {
      const r = await crmClient.save(step.file, rename);
      setStep({ at: 'saved', ...r.saved, plan: r.plan });
      await onSaved();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); setStep({ at: 'preview', file: step.file, plan: step.plan }); }
  };
  const again = () => { setStep({ at: 'pick' }); setRename(false); if (input.current) input.current.value = ''; };

  const plan = step.at === 'preview' || step.at === 'saving' || step.at === 'saved' ? step.plan : null;
  const toCheck = useMemo(() => (plan ? attention(plan.rows) : []), [plan]);
  const r = plan?.report;
  const willSave = r ? r.added + r.updated : 0;

  return (
    <>
      <p className="crm__lead" aria-live="polite">
        {count === null ? <span className="skeleton crm__line" /> : count === 0 ? 'No customers yet. Bring in your list: a spreadsheet of names and mobile numbers.' : `${plural(count, 'customer')} on the list.`}
      </p>
      <section className="crm-import" aria-label="Import customers">
        <h2>Import a list</h2>
        <input ref={input} type="file" accept=".xlsx,.csv,.txt" hidden onChange={(e) => pick(e.target.files?.[0])} aria-label="Customer file" />
        {(step.at === 'pick' || step.at === 'saved') && (
          <div className="crm-import__pick">
            <button type="button" className="inv-page__primary" onClick={() => input.current?.click()}>
              {step.at === 'saved' ? 'Import another file' : 'Choose file'}
            </button>
            <span className="crm__hint">Excel (.xlsx) or CSV. A column of mobile numbers; names beside them if you have them.</span>
          </div>
        )}
        {step.at === 'reading' && <div className="skeleton crm-import__skeleton" aria-label={`Reading ${step.file.name}`} />}

        {plan && r && (
          <>
            {'file' in step && <p className="crm-import__file">In <b>{step.file.name}</b></p>}
            {step.at === 'saved' ? (
              <p className="setup__done" role="status">
                {step.added || step.updated
                  ? `${plural(step.added, 'customer')} added${step.updated ? `, ${plural(step.updated, 'name')} filled in or changed` : ''}.`
                  : 'Nothing new: everyone in the file is already on the list.'}
              </p>
            ) : (
              <ul className="crm-import__counts" aria-label="What importing would do">
                <li><b className="num">{r.added}</b> new{r.noName ? ` (${r.noName} without a name)` : ''}</li>
                {r.updated > 0 && <li><b className="num">{r.updated}</b> names filled in{rename ? ' or changed' : ''}</li>}
                <li><b className="num">{r.unchanged}</b> already on the list</li>
                {r.duplicates > 0 && <li><b className="num">{r.duplicates}</b> the same number again</li>}
                {r.invalid > 0 && <li className="crm-import__bad"><b className="num">{r.invalid}</b> cannot be used</li>}
              </ul>
            )}
            {plan.warnings.map((w) => <p key={w} className="setup__error" role="alert">{w}</p>)}
            {step.at === 'preview' && r.nameConflicts > 0 && (
              <label className="crm-import__rename">
                <input type="checkbox" checked={rename} onChange={(e) => { setRename(e.target.checked); void read(step.file, e.target.checked); }} />
                <span>Use the file’s names for {plural(r.nameConflicts, 'customer')} already on the list under another name</span>
              </label>
            )}
            {step.at !== 'saved' && (
              <div className="crm-import__actions">
                <button type="button" className="inv-page__primary" onClick={() => void save()} disabled={step.at === 'saving' || willSave === 0}>
                  {willSave === 0 ? 'Nothing to save' : `Save ${plural(willSave, 'customer')}`}
                </button>
                <button type="button" className="linkbtn" onClick={again} disabled={step.at === 'saving'}>Choose another file</button>
              </div>
            )}
            {toCheck.length > 0 && (
              <table className="crm-import__rows">
                <caption>{step.at === 'saved' ? 'Left out or worth a look' : 'Will be left out, or worth a look'}</caption>
                <thead><tr><th scope="col">Row</th><th scope="col">Number</th><th scope="col">Why</th></tr></thead>
                <tbody>
                  {toCheck.map((row) => {
                    const s = say(row);
                    return <tr key={row.row} className={row.kind === 'invalid' ? 'crm-import__bad' : undefined}><td className="num">{row.row}</td><td className="num">{s.what}</td><td>{s.why}</td></tr>;
                  })}
                </tbody>
              </table>
            )}
          </>
        )}
        {error && <p className="setup__error" role="alert">{error}</p>}
      </section>
    </>
  );
}
