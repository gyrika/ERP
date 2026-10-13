import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { PIN_LENGTH, type Role } from '../domain/auth.ts';
import { pairAsCounter } from '../services/pairing.ts';
import { printReceipt } from '../services/printer.ts';
import { setupClient, type SetupState, type StaffRow } from '../services/setupClient.ts';
import { QrCode } from './QrCode.tsx';
import { samplePaid } from './ReceiptPreview.tsx';
import { restartApp } from './restart.ts';
import { OwnerNav } from './OwnerNav.tsx';

/**
 * Setting up the shop, on the shop PC itself. Serves whoever sets it up,
 * possibly the owner alone: one question per screen, big targets, Enter to go on.
 * - first:   a new shop. Shop → Printer → Staff → Devices → the PIN screen.
 * - manage:  later (#setup, the owner's PIN first): staff, printer, devices.
 * - connect: a screen on this PC that is not the counter yet (the owner's PIN).
 */
type Mode = 'first' | 'manage' | 'connect';
type Step = 'shop' | 'printer' | 'staff' | 'cloud' | 'devices';
const FIRST: Step[] = ['shop', 'printer', 'staff', 'cloud', 'devices'];
const TITLES: Record<Step, string> = {
  shop: 'Name your shop', printer: 'Your receipt printer', staff: 'Your staff', cloud: 'Connect to the cloud', devices: 'Connect your devices',
};
type Tab = Exclude<Step, 'shop'> | 'updates';
const TAB_LABEL: Record<Tab, string> = { staff: 'Staff', printer: 'Printer', cloud: 'Cloud', devices: 'Devices', updates: 'Updates' };
const ROLES: { id: Role; label: string }[] = [
  { id: 'cashier', label: 'Cashier' }, { id: 'manager', label: 'Manager' }, { id: 'owner', label: 'Owner' }, { id: 'kitchen', label: 'Kitchen' },
];
const roleLabel = (r: Role) => ROLES.find((x) => x.id === r)?.label ?? r;

function OwnerPin({ title, onPin, error }: { title: string; onPin: (pin: string) => void; error: string }) {
  const [pin, setPin] = useState('');
  return (
    <form className="setup__form" onSubmit={(e) => { e.preventDefault(); if (pin.length === PIN_LENGTH) onPin(pin); }}>
      <h1>{title}</h1>
      <label className="setup__field">
        <span>The owner's PIN</span>
        <input type="password" inputMode="numeric" autoFocus autoComplete="off" maxLength={PIN_LENGTH} value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, PIN_LENGTH))} />
      </label>
      {error && <p className="setup__error" role="alert">{error}</p>}
      <div className="setup__foot"><button type="submit" className="cta" disabled={pin.length !== PIN_LENGTH}>Continue</button></div>
    </form>
  );
}

function ShopStep({ state, onDone }: { state: SetupState; onDone: () => void }) {
  const [name, setName] = useState(state.shop?.name ?? '');
  const [place, setPlace] = useState(state.shop?.place ?? '');
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const r = await setupClient.nameShop(name, place);
      // The shop PC pairs itself as the counter: no link to open, nothing to type.
      if (r.counterToken) pairAsCounter(r.counterToken, r.shopId);
      onDone();
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };
  return (
    <form className="setup__form" onSubmit={(e) => void submit(e)}>
      <label className="setup__field"><span>Shop name</span>
        <input autoFocus value={name} placeholder="CheesyBeez" onChange={(e) => setName(e.target.value)} /></label>
      <label className="setup__field"><span>Town</span>
        <input value={place} placeholder="Thalwila" onChange={(e) => setPlace(e.target.value)} /></label>
      {error && <p className="setup__error" role="alert">{error}</p>}
      <div className="setup__foot"><button type="submit" className="cta" disabled={!name.trim()}>Next</button></div>
    </form>
  );
}

function PrinterStep({ state, ownerPin, onNext }: { state: SetupState; ownerPin?: string; onNext?: () => void }) {
  const [chosen, setChosen] = useState<string | null>(state.printer);
  const [test, setTest] = useState<'' | 'printing' | 'printed' | 'failed'>('');
  const [error, setError] = useState('');
  const choose = async (name: string | null) => {
    setError('');
    try { await setupClient.setPrinter(name, ownerPin); setChosen(name); setTest(''); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const printTest = async () => {
    setTest('printing');
    const r = await printReceipt(samplePaid(), 'Setup', { reprint: true }); // marked COPY, never opens the drawer
    setTest(r === 'printed' ? 'printed' : 'failed');
  };
  const options: (string | null)[] = [...state.printers, null];
  return (
    <div className="setup__form">
      <div className="setup__choices" role="radiogroup" aria-label="Receipt printer">
        {options.map((p) => (
          <button key={p ?? 'none'} type="button" role="radio" aria-checked={chosen === p} className="setup__choice" onClick={() => void choose(p)}>
            {p ?? 'No printer yet (receipts are saved as files)'}
          </button>
        ))}
      </div>
      {state.printers.length === 0 && <p className="setup__hint">No printer found. Plug it in, install its Windows driver, then come back here.</p>}
      {chosen && (
        <p className="setup__row">
          <button type="button" className="chip" onClick={() => void printTest()} disabled={test === 'printing'}>Print a test receipt</button>
          <span role="status">{test === 'printed' ? 'Sent to the printer.' : test === 'failed' ? 'The printer did not take it.' : ''}</span>
        </p>
      )}
      {error && <p className="setup__error" role="alert">{error}</p>}
      {onNext && <div className="setup__foot"><button type="button" className="cta" onClick={onNext}>Next</button></div>}
    </div>
  );
}

function StaffStep({ initial, ownerPin, onNext }: { initial: StaffRow[]; ownerPin?: string; onNext?: () => void }) {
  const [staff, setStaff] = useState(initial);
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>(initial.some((m) => m.active && m.role === 'owner') ? 'cashier' : 'owner');
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const active = staff.filter((m) => m.active);
  const hasOwner = active.some((m) => m.role === 'owner');
  const add = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      setStaff((await setupClient.addStaff(name.trim(), role, pin, ownerPin)).staff);
      setName(''); setPin(''); setRole('cashier');
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };
  const remove = async (id: string) => {
    setError('');
    try { setStaff((await setupClient.removeStaff(id, ownerPin)).staff); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };
  return (
    <div className="setup__form">
      {active.length > 0 && (
        <ul className="setup__staff" aria-label="Staff">
          {active.map((m) => (
            <li key={m.id}>
              <span className="setup__who">{m.name}</span>
              <span className="setup__role">{roleLabel(m.role)}</span>
              <button type="button" className="linkbtn" onClick={() => void remove(m.id)} aria-label={`Remove ${m.name}`}>Remove</button>
            </li>
          ))}
        </ul>
      )}
      <form className="setup__add" onSubmit={(e) => void add(e)} aria-label="Add a person">
        <label className="setup__field"><span>{hasOwner ? 'Add a person' : 'First, the owner'}</span>
          <input autoFocus value={name} placeholder={hasOwner ? 'Name' : 'Nisal Vimukthi'} onChange={(e) => setName(e.target.value)} /></label>
        <div className="setup__chips" role="radiogroup" aria-label="Role">
          {ROLES.map((r) => (
            <button key={r.id} type="button" role="radio" aria-checked={role === r.id} className="chip" onClick={() => setRole(r.id)}>{r.label}</button>
          ))}
        </div>
        <label className="setup__field setup__field--pin"><span>Their own 4-digit PIN</span>
          <input type="password" inputMode="numeric" autoComplete="off" maxLength={PIN_LENGTH} value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, PIN_LENGTH))} /></label>
        <button type="submit" className="chip chip--solid" disabled={!name.trim() || pin.length !== PIN_LENGTH}>Add</button>
      </form>
      {error && <p className="setup__error" role="alert">{error}</p>}
      {onNext && (
        <div className="setup__foot">
          {!hasOwner && <span className="setup__hint">Add the owner to go on.</span>}
          <button type="button" className="cta" disabled={!hasOwner} onClick={onNext}>Next</button>
        </div>
      )}
    </div>
  );
}

/**
 * The cloud copy: sales kept off-site, and the owner's phone. The developer gives
 * the shop code; the shop server registers itself and starts copying at once.
 */
function CloudStep({ connected, ownerPin, onConnected, onNext }: {
  connected: boolean; ownerPin?: string; onConnected: () => void; onNext?: () => void;
}) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const connect = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try { await setupClient.connectCloud(code, ownerPin); onConnected(); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };
  return (
    <div className="setup__form">
      <p className="setup__lead">A copy of every sale is kept safe on the internet, and the owner sees the shop on their phone from anywhere. Selling never needs the internet.</p>
      {connected ? (
        <p className="setup__done" role="status">Connected: sales are copied to the cloud.</p>
      ) : (
        <form className="setup__form" onSubmit={(e) => void connect(e)}>
          <label className="setup__field"><span>Shop code</span>
            <input autoFocus value={code} placeholder="CB-XXXX-XXXX" autoComplete="off" spellCheck={false}
              onChange={(e) => setCode(e.target.value.toUpperCase())} /></label>
          <p className="setup__hint">You get it from whoever set up CheesyBeez for you. The internet must be on.</p>
          {error && <p className="setup__error" role="alert">{error}</p>}
          <p className="setup__row"><button type="submit" className="chip chip--solid" disabled={!code.trim() || busy}>{busy ? 'Connecting…' : 'Connect'}</button></p>
        </form>
      )}
      {onNext && (
        <div className="setup__foot">
          {!connected && <button type="button" className="linkbtn" onClick={onNext}>Skip for now</button>}
          <button type="button" className="cta" onClick={onNext} disabled={!connected}>Next</button>
        </div>
      )}
    </div>
  );
}

/**
 * Shop setup → Updates: the installed version, GitHub's latest, and "Update now"
 * (it runs even during service: the owner chose to; the nightly update waits).
 * The POS restarts by itself; this screen waits for it and reloads. If the new version does not
 * start, the updater puts the old one back (station-update.ps1), and this screen says so.
 */
const STEP_LABEL: Record<string, string> = {
  checking: 'Getting ready', downloading: 'Downloading', backup: 'Backing up your sales', installing: 'Installing',
  starting: 'Starting the new version', done: 'Done', 'going-back': 'The new version did not start: going back',
};

/**
 * Where the update is. From the updater's own steps while the shop server can pass them on
 * (with the real download percentage), and moving on by itself while the server restarts,
 * so the bar never stands still and never goes backwards.
 */
function UpdateProgress({ percent, label }: { percent: number; label: string }) {
  const p = Math.round(percent);
  return (
    <div className="update" role="status" aria-live="polite">
      <div className="update__row"><b>{label}</b><span className="num">{p}%</span></div>
      <div className="update__bar" role="progressbar" aria-label="Update progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={p}>
        <span style={{ width: `${p}%` }} />
      </div>
      <p className="update__note">Please don’t turn the PC off. The POS comes back by itself.</p>
    </div>
  );
}

/** Eases from `from` towards `to`: quick at first, slower as it gets close (never quite there). */
const ease = (from: number, to: number, ms: number, over: number) => from + (to - from) * (1 - Math.exp(-ms / over));

function UpdatesTab({ ownerPin }: { ownerPin?: string }) {
  const [info, setInfo] = useState<{ current: string; latest: string | null; newer: boolean } | null>(null);
  const [phase, setPhase] = useState<'checking' | 'idle' | 'updating' | 'slow' | 'back'>('checking');
  const [progress, setProgress] = useState({ percent: 0, label: STEP_LABEL.checking });
  const [error, setError] = useState('');
  const check = useCallback(async () => {
    setPhase('checking');
    setError('');
    try { setInfo(await setupClient.checkUpdate(ownerPin)); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    setPhase('idle');
  }, [ownerPin]);
  useEffect(() => { void check(); }, [check]);

  const updateNow = async () => {
    setError('');
    try { await setupClient.installUpdate(ownerPin); } catch (e) { setError(e instanceof Error ? e.message : String(e)); return; }
    setPhase('updating');
    const started = Date.now();
    let wentDown = false; // the installer stopped the server: from now on, the old version answering means it went back
    let downAt = 0;
    let shown = 2;
    let label = STEP_LABEL.checking;
    let heard = false; // this updater reports its steps (versions before 1.0.3 do not)
    const show = (percent: number, text: string, allowBack = false) => {
      shown = allowBack ? percent : Math.max(shown, percent);
      label = text;
      setProgress({ percent: shown, label });
    };
    const wait = async () => {
      const now = Date.now();
      let up = false;
      try {
        const h = (await (await fetch('/api/v1/health', { signal: AbortSignal.timeout(2500) })).json()) as { version?: string };
        up = true;
        if (info?.latest && h.version === info.latest) {
          show(100, 'Done: opening the new version');
          setTimeout(restartApp, 1200);
          return;
        }
        if (wentDown && h.version === info?.current) { setPhase('back'); return; }
      } catch {
        if (!wentDown) downAt = now;
        wentDown = true;
      }
      if (up) {
        const s = (await setupClient.updateStatus(ownerPin).catch(() => ({ status: null }))).status;
        if (s && s.at >= started - 5_000) {
          heard = true;
          if (s.phase === 'failed') { setError('The update did not work. Nothing changed: the POS is as it was.'); setPhase('idle'); return; }
          if (s.phase === 'back') { setPhase('back'); return; }
          if (s.phase === 'up-to-date') { setPhase('idle'); void check(); return; }
          const text = s.phase === 'downloading' ? `Downloading version ${s.version}` : STEP_LABEL[s.phase] ?? label;
          show(s.percent, text, s.phase === 'going-back');
        } else if (!heard) {
          show(ease(2, 60, now - started, 40_000), 'Downloading the new version'); // an older updater: by time
        }
      } else {
        // The server is restarting while the installer works: keep moving, a little slower near the end.
        show(Math.max(65, ease(65, 92, now - downAt, 30_000)), shown < 84 ? STEP_LABEL.installing : STEP_LABEL.starting);
      }
      // Going back can take a while: 3 minutes of waiting for the new version, then the old one again.
      if (now - started > 10 * 60_000) { setPhase('slow'); return; }
      setTimeout(() => void wait(), 1000);
    };
    setProgress({ percent: 2, label: STEP_LABEL.checking });
    setTimeout(() => void wait(), 800);
  };

  return (
    <div className="setup__form">
      <p className="setup__lead">Installed: <b>{info?.current ?? '…'}</b>. New versions install by themselves within minutes, once the counter has been quiet for 15 minutes.</p>
      {phase === 'updating' && <UpdateProgress percent={progress.percent} label={progress.label} />}
      {phase === 'back' && (
        <p className="setup__error" role="alert">Version {info?.latest} did not start on this PC, so CheesyBeez went back to {info?.current}. All sales are safe. Tell whoever looks after your POS.</p>
      )}
      {phase === 'slow' && (
        <p className="setup__error" role="alert">This is taking longer than expected. Leave the PC on; if the POS does not come back, restart the PC.</p>
      )}
      {phase === 'idle' && info && !info.newer && <p className="setup__done" role="status">You have the latest version.</p>}
      {phase === 'idle' && info?.newer && (
        <>
          <p className="setup__lead" role="status">Version <b>{info.latest}</b> is ready.</p>
          <p className="setup__row"><button type="button" className="cta" onClick={() => void updateNow()}>Update now</button></p>
        </>
      )}
      {error && <p className="setup__error" role="alert">{error}</p>}
      {(phase === 'idle' || phase === 'checking') && (
        <p className="setup__row"><button type="button" className="chip" disabled={phase === 'checking'} onClick={() => void check()}>
          {phase === 'checking' ? 'Checking…' : 'Check again'}
        </button></p>
      )}
    </div>
  );
}

function DevicesStep({ state, ownerPin, onFinish }: { state: SetupState; ownerPin?: string; onFinish?: () => void }) {
  const [links, setLinks] = useState<{ kitchen?: string; owner?: string }>({});
  const [error, setError] = useState('');
  const show = async (kind: 'kitchen' | 'owner') => {
    setError('');
    try { const { link } = await setupClient.pair(kind, ownerPin); setLinks((l) => ({ ...l, [kind]: link })); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const card = (kind: 'kitchen' | 'owner', title: string, how: string, available: boolean, why: string) => (
    <section className="setup__device" aria-label={title}>
      <h2>{title}</h2>
      {links[kind]
        ? <><QrCode text={links[kind]!} label={`QR code for the ${title.toLowerCase()}`} /><p className="setup__hint">{how}</p></>
        : available
          ? <button type="button" className="chip chip--solid" onClick={() => void show(kind)}>Show QR code</button>
          : <p className="setup__hint">{why}</p>}
    </section>
  );
  return (
    <div className="setup__form">
      <div className="setup__devices">
        {card('kitchen', 'Kitchen tablet', "Scan it with the tablet's camera. The tablet must be on the shop's Wi-Fi.", true, '')}
        {card('owner', "Owner's phone", "Scan it with the owner's phone. It then shows the Owner view, from anywhere.", state.cloud,
          'Connect to the cloud first (the step before), then come back here.')}
      </div>
      <p className="setup__hint">You can do this later too: Manager mode → Ctrl+K → Shop setup.</p>
      {error && <p className="setup__error" role="alert">{error}</p>}
      {onFinish && <div className="setup__foot"><button type="button" className="cta" onClick={onFinish}>Finish</button></div>}
    </div>
  );
}

export function SetupWizard({ mode, onClose }: { mode: Mode; onClose?: () => void }) {
  const [state, setState] = useState<SetupState | null>(null);
  const [step, setStep] = useState<Step>('shop');
  const [ownerPin, setOwnerPin] = useState<string | undefined>(undefined);
  const [staff, setStaff] = useState<StaffRow[] | null>(null);
  const [tab, setTab] = useState<Tab>('staff');
  const connected = () => { setState((st) => (st ? { ...st, cloud: true } : st)); };
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    try { setState(await setupClient.state()); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  const finish = async () => {
    try { await setupClient.finish(); restartApp(); } // fresh start: syncing and the PIN screen
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  const unlock = async (pin: string) => {
    setError('');
    try {
      if (mode === 'connect') {
        const r = await setupClient.pairCounter(pin);
        pairAsCounter(r.counterToken, r.shopId);
        restartApp();
        return;
      }
      setStaff((await setupClient.staff(pin)).staff); // proves the PIN is the owner's
      setOwnerPin(pin);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  let body;
  if (!state) body = <div className="setup__form"><div className="skeleton setup__skeleton" aria-label="Loading" /></div>;
  else if (mode === 'connect') body = <OwnerPin title="Connect this screen as the counter" onPin={(p) => void unlock(p)} error={error} />;
  else if (mode === 'manage' && !ownerPin) body = <OwnerPin title="Shop setup" onPin={(p) => void unlock(p)} error={error} />;
  else if (mode === 'manage') {
    body = (
      <>
        <nav className="cats setup__tabs" aria-label="Shop setup">
          {(['staff', 'printer', 'cloud', 'devices', 'updates'] as const).map((t) => (
            <button key={t} type="button" className="pill" aria-pressed={tab === t} onClick={() => setTab(t)}>{TAB_LABEL[t]}</button>
          ))}
        </nav>
        {tab === 'staff' && <StaffStep initial={staff ?? []} ownerPin={ownerPin} />}
        {tab === 'printer' && <PrinterStep state={state} ownerPin={ownerPin} />}
        {tab === 'cloud' && <CloudStep connected={state.cloud} ownerPin={ownerPin} onConnected={connected} />}
        {tab === 'devices' && <DevicesStep state={state} ownerPin={ownerPin} />}
        {tab === 'updates' && <UpdatesTab ownerPin={ownerPin} />}
      </>
    );
  } else {
    const i = FIRST.indexOf(step);
    const next = () => { void reload(); setStep(FIRST[i + 1]); };
    body = (
      <>
        <p className="setup__step">Step {i + 1} of {FIRST.length}</p>
        <h1>{TITLES[step]}</h1>
        {step === 'shop' && <ShopStep state={state} onDone={next} />}
        {step === 'printer' && <PrinterStep state={state} onNext={next} />}
        {step === 'staff' && <StaffStep initial={state.staff ?? []} onNext={next} />}
        {step === 'cloud' && <CloudStep connected={state.cloud} onConnected={connected} onNext={next} />}
        {step === 'devices' && <DevicesStep state={state} onFinish={() => void finish()} />}
        {error && <p className="setup__error" role="alert">{error}</p>}
        {i > 0 && <button type="button" className="linkbtn setup__back" onClick={() => setStep(FIRST[i - 1])}>Back</button>}
      </>
    );
  }

  return (
    <div className="setup">
      {mode === 'manage' ? <OwnerNav current="setup" onRegister={onClose} /> : (
        <header className="setup__head">
          <span className="brand">CheesyBeez</span>
        </header>
      )}
      <main className="setup__main" aria-label="Shop setup">{body}</main>
    </div>
  );
}
