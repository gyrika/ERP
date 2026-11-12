import { useEffect, useState } from 'react';
import { MODULE_LABEL, type ModuleId } from '../domain/modules.ts';
import { setupClient, type ModulesState } from '../services/setupClient.ts';
import { addEvents } from './eventLog.ts';

/**
 * #unlock: the developers' page, on the shop PC, never in the sidebar or the palette.
 * Who: a developer. What they know: the developers' password and which module to switch.
 * The one next thing: type the password, then Turn on (or off) beside the module. The shop
 * server checks the password (it keeps only its hash); no owner's PIN, no confirmation.
 */
const since = (ms: number) => new Date(ms).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });

export default function UnlockView({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<ModulesState | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');

  const load = async () => {
    try { setState(await setupClient.modules()); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  useEffect(() => { void load(); }, []);

  const turn = async (module: ModuleId, on: boolean) => {
    setError('');
    setDone('');
    if (!password) { setError('Type the developers’ password first.'); return; }
    setBusy(true);
    try {
      const r = await setupClient.unlockModule(password, module, on);
      addEvents(r.events);
      setDone(`${MODULE_LABEL[r.module]} is ${r.on ? 'on' : 'off'}.`);
      setPassword('');
      await load();
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    setBusy(false);
  };

  return (
    <div className="setup">
      <header className="setup__head">
        <span className="brand">CheesyBeez</span>
        <button type="button" className="linkbtn" onClick={onClose}>Close</button>
      </header>
      <main className="setup__main" aria-label="Modules">
        <h1>Modules</h1>
        <p className="setup__lead">Turned on and off by the CheesyBeez developers, with their password.</p>
        {!state && !error && <div className="skeleton setup__skeleton" aria-label="Loading" />}
        {state && (
          <div className="setup__form">
            <label className="setup__field"><span>Developers’ password</span>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" autoFocus /></label>
            <ul className="unlock__list" aria-label="Modules">
              {state.modules.map((m) => (
                <li key={m.id}>
                  <span className="unlock__name">
                    {MODULE_LABEL[m.id]}
                    <span className={m.on ? 'unlock__on' : 'unlock__off'}>{m.on ? 'On' : 'Off'}{m.since !== null && <> · since {since(m.since)}</>}</span>
                  </span>
                  <button type="button" className={m.on ? 'chip' : 'chip chip--solid'} disabled={busy} onClick={() => void turn(m.id, !m.on)}>
                    {m.on ? 'Turn off' : 'Turn on'}
                  </button>
                </li>
              ))}
            </ul>
            {done && <p className="setup__done" role="status">{done}</p>}
          </div>
        )}
        {error && <p className="setup__error" role="alert">{error}</p>}
      </main>
    </div>
  );
}
