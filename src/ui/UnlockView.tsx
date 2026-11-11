import { useEffect, useState, type FormEvent } from 'react';
import { MODULE_LABEL } from '../domain/modules.ts';
import { setupClient, type ModulesState } from '../services/setupClient.ts';
import { addEvents } from './eventLog.ts';

/**
 * #unlock: the developers' page, on the shop PC (over AnyDesk), never in the sidebar or the palette.
 * Who: a developer. What they know: the module to turn on, and that a code is made for one shop.
 * The one next thing: read the shop's id, make the code, paste it here. The code is the only
 * authority (signed by the developers' key, once, for a week): no PIN, no confirmation.
 */
const since = (ms: number) => new Date(ms).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });

export default function UnlockView({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<ModulesState | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const [copied, setCopied] = useState(false);

  const load = async () => {
    try { setState(await setupClient.modules()); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  useEffect(() => { void load(); }, []);

  const use = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setDone('');
    setBusy(true);
    try {
      const r = await setupClient.unlockModule(code);
      addEvents(r.events);
      setDone(`${MODULE_LABEL[r.module]} is ${r.on ? 'on' : 'off'}.`);
      setCode('');
      await load();
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    setBusy(false);
  };

  const copy = async () => {
    if (!state) return;
    try { await navigator.clipboard.writeText(state.shopId); setCopied(true); } catch { /* select it by hand */ }
  };

  return (
    <div className="setup">
      <header className="setup__head">
        <span className="brand">CheesyBeez</span>
        <button type="button" className="linkbtn" onClick={onClose}>Close</button>
      </header>
      <main className="setup__main" aria-label="Modules">
        <h1>Modules</h1>
        <p className="setup__lead">Turned on and off by the CheesyBeez developers, with a one-time code made for this shop.</p>
        {!state && !error && <div className="skeleton setup__skeleton" aria-label="Loading" />}
        {state && (
          <div className="setup__form">
            <p className="unlock__shop">
              <span>This shop</span>
              <code className="num">{state.shopId}</code>
              <button type="button" className="linkbtn" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy'}</button>
            </p>
            <ul className="unlock__list" aria-label="Modules">
              {state.modules.map((m) => (
                <li key={m.id}>
                  <span>{MODULE_LABEL[m.id]}</span>
                  <span className={m.on ? 'unlock__on' : 'unlock__off'}>
                    {m.on ? 'On' : 'Off'}{m.since !== null && <> · since {since(m.since)}</>}
                  </span>
                </li>
              ))}
            </ul>
            {state.keyed ? (
              <form className="setup__add unlock__form" onSubmit={(e) => void use(e)} aria-label="Use a developer code">
                <label className="setup__field"><span>Developer code</span>
                  <textarea value={code} onChange={(e) => setCode(e.target.value)} rows={3} spellCheck={false} autoComplete="off" autoFocus /></label>
                <button type="submit" className="chip chip--solid" disabled={busy || !code.trim()}>Use code</button>
              </form>
            ) : (
              <p className="setup__lead">This version carries no developer key, so no module can be changed here.</p>
            )}
            {done && <p className="setup__done" role="status">{done}</p>}
          </div>
        )}
        {error && <p className="setup__error" role="alert">{error}</p>}
      </main>
    </div>
  );
}
