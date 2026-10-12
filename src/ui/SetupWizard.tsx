import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { PIN_LENGTH, type Role } from '../domain/auth.ts';
import { pairAsCounter } from '../services/pairing.ts';
import { printReceipt } from '../services/printer.ts';
import { setupClient, type SetupState, type StaffRow } from '../services/setupClient.ts';
import { QrCode } from './QrCode.tsx';
import { samplePaid } from './ReceiptPreview.tsx';
import { restartApp } from './restart.ts';

/**
 * Setting up the shop, on the shop PC itself. Serves whoever sets it up,
 * possibly the owner alone: one question per screen, big targets, Enter to go on.
 * - first:   a new shop. Shop → Printer → Staff → Devices → the PIN screen.
 * - manage:  later (#setup, the owner's PIN first): staff, printer, devices.
 * - connect: a screen on this PC that is not the counter yet (the owner's PIN).
 */
type Mode = 'first' | 'manage' | 'connect';
type Step = 'shop' | 'printer' | 'staff' | 'devices';
const FIRST: Step[] = ['shop', 'printer', 'staff', 'devices'];
const TITLES: Record<Step, string> = { shop: 'Name your shop', printer: 'Your receipt printer', staff: 'Your staff', devices: 'Connect your devices' };
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
          'Needs the cloud copy: set it up first (docs/cloud.md).')}
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
  const [tab, setTab] = useState<Exclude<Step, 'shop'>>('staff');
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
          {(['staff', 'printer', 'devices'] as const).map((t) => (
            <button key={t} type="button" className="pill" aria-pressed={tab === t} onClick={() => setTab(t)}>{TITLES[t].replace('Your ', '').replace('Connect your ', '')}</button>
          ))}
        </nav>
        {tab === 'staff' && <StaffStep initial={staff ?? []} ownerPin={ownerPin} />}
        {tab === 'printer' && <PrinterStep state={state} ownerPin={ownerPin} />}
        {tab === 'devices' && <DevicesStep state={state} ownerPin={ownerPin} />}
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
        {step === 'devices' && <DevicesStep state={state} onFinish={() => void finish()} />}
        {error && <p className="setup__error" role="alert">{error}</p>}
        {i > 0 && <button type="button" className="linkbtn setup__back" onClick={() => setStep(FIRST[i - 1])}>Back</button>}
      </>
    );
  }

  return (
    <div className="setup">
      <header className="setup__head">
        <span className="brand">CheesyBeez</span>
        {mode === 'manage' && onClose && <button type="button" className="corner__key" onClick={onClose}>Done</button>}
      </header>
      <main className="setup__main" aria-label="Shop setup">{body}</main>
    </div>
  );
}
