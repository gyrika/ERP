import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import {
  addPoint, ASK_BRANDS, asksCamera, brandOf, closePolygon, LIMIT_TEXT, mayUse, normalisePoint, presetPath, RTSP_PRESETS, type Brand,
} from '../../domain/cameraSetup.ts';
import {
  TIMER_LIMITS, timersOf, type CameraSpec, type Point, type TableSpec, type Timers, type VisionSettings, type ZoneSpec,
} from '../../domain/tables.ts';
import type { CameraDraft, CameraLogins } from '../../services/setupClient.ts';
import type { VisionClient } from '../../services/visionClient.ts';
import '../cameras/cameras.css';

/**
 * The setup forms of #vision's side panel (once #cameras, SCRUM-171): one camera (scan or IP,
 * brand, login, Ask the camera, Test, Use for CV), a zone per table drawn on the camera's picture,
 * one table, the timers. Every save is an owner event the shop server records (server/setup.ts);
 * a camera's login stays on the shop server. `withPin` asks the owner's PIN in the panel the first
 * time, then runs the save.
 */
export type WithPin = (what: string, run: (pin: string) => Promise<void>) => Promise<void>;
/** The owner pressed Cancel at the PIN: nothing to say. */
export class PinCancelled extends Error {}

export const newId = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** Runs a save; says why it did not work, unless the PIN was cancelled. */
const attempt = async (run: () => Promise<void>, setError: (s: string) => void): Promise<boolean> => {
  setError('');
  try { await run(); return true; } catch (e) { if (!(e instanceof PinCancelled)) setError(message(e)); return false; }
};
/** What is saved for a camera that is not being edited: where it is; its kept login stays as it is. */
const specOf = ({ id, name, ip, rtspPath, enabled }: CameraSpec): CameraDraft => ({ id, name, ip, rtspPath, enabled });

// ----- one camera -----

interface Draft {
  id: string; name: string; ip: string; brand: Brand; path: string; user: string; password: string; enabled: boolean;
}
type Tested = { jpeg: string } | { error: string } | 'testing';
type Asking = 'asking' | { note: string } | { error: string };
const BRANDS = [...RTSP_PRESETS.map((p) => [p.brand, p.label] as const), ...ASK_BRANDS.map((b) => [b.brand, b.label] as const), ['custom', 'Other'] as const];
const pathOf = (d: Draft) => presetPath(d.brand) ?? d.path.trim();

/**
 * A camera's connection, in the panel: edits the one picked, or a new one (Scan fills its IP).
 * Save keeps the whole list as the shop server wants it, this camera changed or added; a second
 * lens that Ask the camera found is added beside it, sharing its login.
 */
export function CameraForm({ client, withPin, cameras, camera, logins, onSaved, onRemoved }: {
  client: VisionClient; withPin: WithPin; cameras: CameraSpec[];
  /** null: a new camera. */
  camera: CameraSpec | null;
  logins: CameraLogins;
  onSaved: (id: string, logins: CameraLogins) => void;
  onRemoved?: () => void;
}) {
  const fresh = (): Draft => camera
    ? { id: camera.id, name: camera.name, ip: camera.ip, brand: brandOf(camera.rtspPath), path: camera.rtspPath, user: logins[camera.id]?.user ?? '', password: '', enabled: camera.enabled }
    : { id: newId('cam'), name: '', ip: '', brand: 'tapo', path: '/stream2', user: '', password: '', enabled: mayUse(cameras, '') };
  const [d, setD] = useState<Draft>(fresh);
  const [lenses, setLenses] = useState<{ path: string }[]>([]);
  const [dirty, setDirty] = useState(!camera);
  const [found, setFound] = useState<{ ip: string; name: string }[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [tested, setTested] = useState<Tested | undefined>();
  const [asked, setAsked] = useState<Asking | undefined>();
  const [limit, setLimit] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const n = camera ? cameras.findIndex((c) => c.id === camera.id) + 1 : cameras.length + 1;
  const label = d.name || `Camera ${n}`;
  const passwordSet = Boolean(camera && logins[camera.id]?.passwordSet);

  const change = (patch: Partial<Draft>) => { setD((x) => ({ ...x, ...patch })); setDirty(true); setNote(''); setLimit(false); };
  const scan = async () => {
    setScanning(true);
    await attempt(() => withPin('scan for cameras', async (p) => setFound((await client.scan(p)).filter((f) => !cameras.some((c) => c.ip === f.ip)))), setError);
    setScanning(false);
  };
  const test = () => attempt(() => withPin('test the camera', async (p) => {
    setTested('testing');
    try {
      const r = await client.test(p, { cameraId: camera?.id, ip: d.ip, rtspPath: pathOf(d), user: d.user || undefined, password: d.password || undefined });
      setTested(r.ok ? { jpeg: r.jpeg } : { error: r.message });
    } catch (e) { setTested({ error: message(e) }); }
  }), setError);
  const ask = () => attempt(() => withPin('ask the camera', async (p) => {
    setAsked('asking');
    try {
      const r = await client.ask(p, { cameraId: camera?.id, ip: d.ip, user: d.user || undefined, password: d.password || undefined });
      if (!r.ok) { setAsked({ error: r.message }); return; }
      const [one, ...more] = r.streams;
      change({ path: one.path });
      setLenses(more.filter((m) => !cameras.some((c) => c.ip === d.ip && c.rtspPath === m.path)));
      setAsked({ note: r.streams.length > 1
        ? `This camera has ${r.streams.length} lenses: each becomes its own camera when you save.`
        : `The camera streams at ${one.path} (${one.width}×${one.height}). Test it, then save.` });
    } catch (e) { setAsked({ error: message(e) }); }
  }), setError);
  const use = () => {
    if (!d.enabled && !mayUse(cameras, d.id)) { setLimit(true); return; }
    change({ enabled: !d.enabled });
  };
  const save = () => attempt(() => withPin('save the camera', async (p) => {
    const name = d.name.trim() || `Camera ${n}`;
    const mine: CameraDraft = {
      id: d.id, name, ip: d.ip, rtspPath: pathOf(d), enabled: d.enabled,
      ...(d.user ? { user: d.user } : {}), ...(d.password ? { password: d.password } : {}),
    };
    const extra: CameraDraft[] = lenses.map((l, i) => ({
      id: newId('cam'), name: `${name} ${i + 2}`.slice(0, 60), ip: d.ip, rtspPath: l.path, enabled: false,
      ...(d.password ? { user: d.user, password: d.password } : { loginFrom: d.id }),
    }));
    const list = camera ? cameras.map((c) => (c.id === d.id ? mine : specOf(c))) : [...cameras.map(specOf), mine];
    const saved = await client.saveCameras(p, [...list, ...extra]);
    setD((x) => ({ ...x, name, password: '' }));
    setLenses([]); setDirty(false); setNote('Saved.');
    onSaved(d.id, saved);
  }), setError);
  const remove = () => attempt(() => withPin('remove the camera', async (p) => {
    await client.saveCameras(p, cameras.filter((c) => c.id !== d.id).map(specOf));
    onRemoved?.();
  }), setError);

  const ipBox = useRef<HTMLInputElement>(null);
  return (
    <div className="cam cam--panel" aria-label={label} data-cam={d.id}>
      {!camera && (
        <div className="setup__chips">
          <button type="button" className="chip chip--solid" disabled={scanning} onClick={() => void scan()}>{scanning ? 'Scanning…' : 'Scan for cameras'}</button>
          {found && (found.length
            ? found.map((f) => (
              <button key={f.ip} type="button" className="chip" onClick={() => { change({ ip: f.ip, name: d.name || f.name.slice(0, 60) }); setFound(null); }}>
                Add {f.ip}{f.name ? ` · ${f.name}` : ''}
              </button>))
            : <span className="setup__hint" role="status">No new cameras answered. Check the camera is on the shop Wi-Fi, or type its IP.</span>)}
        </div>
      )}
      <label className="setup__field"><span>Name</span>
        <input value={d.name} placeholder={`Camera ${n}`} maxLength={60} onChange={(e) => change({ name: e.target.value })} /></label>
      <label className="setup__field"><span>IP address</span>
        <input ref={ipBox} value={d.ip} inputMode="decimal" placeholder="192.168.1.20" onChange={(e) => change({ ip: e.target.value.trim() })} /></label>
      <div className="cam__brands" role="radiogroup" aria-label={`${label}: brand`}>
        {BRANDS.map(([brand, text]) => (
          <button key={brand} type="button" role="radio" aria-checked={d.brand === brand} className="chip"
            onClick={() => change({ brand, path: presetPath(brand) ?? (presetPath(d.brand) ? '' : d.path) })}>{text}</button>
        ))}
      </div>
      {asksCamera(d.brand) && (
        <label className="setup__field"><span>Stream path{d.brand !== 'custom' && ': Ask the camera fills it'}</span>
          <input value={d.path} placeholder={d.brand === 'custom' ? '/stream2' : ''} onChange={(e) => change({ path: e.target.value })} /></label>
      )}
      <div className="cam__grid">
        <label className="setup__field"><span>Username</span>
          <input value={d.user} autoComplete="off" onChange={(e) => change({ user: e.target.value })} /></label>
        <label className="setup__field"><span>Password</span>
          <input type="password" value={d.password} autoComplete="new-password" placeholder={passwordSet ? 'Password set' : ''}
            onChange={(e) => change({ password: e.target.value })} /></label>
      </div>
      <div className="cam__actions">
        {asksCamera(d.brand) && (
          <button type="button" className={`chip${d.path ? '' : ' chip--solid'}`} disabled={!d.ip || asked === 'asking'} onClick={() => void ask()}>
            {asked === 'asking' ? 'Asking…' : 'Ask the camera'}
          </button>
        )}
        <button type="button" className="chip" disabled={!d.ip || !pathOf(d) || tested === 'testing'} onClick={() => void test()}>
          {tested === 'testing' ? 'Testing…' : 'Test'}
        </button>
        <button type="button" role="switch" aria-checked={d.enabled} className="cam__use" onClick={use}>
          <span className="cam__knob" aria-hidden="true" />Use for CV
        </button>
      </div>
      {limit && <p className="cam__note" role="status">{LIMIT_TEXT}</p>}
      {asked && asked !== 'asking' && ('note' in asked
        ? <p className="setup__hint" role="status">{asked.note}</p>
        : <p className="setup__error" role="alert">{asked.error}</p>)}
      {tested && tested !== 'testing' && ('jpeg' in tested
        ? <img className="cam__shot" src={`data:image/jpeg;base64,${tested.jpeg}`} alt={`What ${label} sees`} />
        : <p className="setup__error" role="alert">{tested.error}</p>)}
      {error && <p className="setup__error" role="alert">{error}</p>}
      <div className="panel-form__foot">
        <button type="button" className="chip chip--solid" disabled={!dirty || !d.ip || !pathOf(d)} onClick={() => void save()}>
          {camera ? 'Save camera' : 'Add camera'}
        </button>
        {note && <span className="setup__hint" role="status">{note}</span>}
        {camera && <button type="button" className="chip chip--danger cam__remove" onClick={() => void remove()}>Remove</button>}
      </div>
    </div>
  );
}

// ----- zones -----

const STEP = 0.02;
const pointsAttr = (ps: readonly Point[]) => ps.map((p) => `${p.x},${p.y}`).join(' ');

/**
 * Click the corners of a table on the camera's picture; Enter closes the zone, then pick its
 * table. Keyboard: arrows move the cross (Shift: further), Space adds a corner, Backspace takes
 * the last one back, Esc starts again.
 */
export function ZoneEditor({ client, withPin, camera, src, zones, tables, onDone }: {
  client: VisionClient; withPin: WithPin; camera: CameraSpec;
  /** The picture to draw on: the camera's latest frame, held still. */
  src: string;
  zones: ZoneSpec[]; tables: TableSpec[];
  onDone: () => void;
}) {
  const [points, setPoints] = useState<Point[]>([]);
  const [closed, setClosed] = useState<Point[] | null>(null);
  const [cross, setCross] = useState<Point>({ x: 0.5, y: 0.5 });
  const [hint, setHint] = useState('');
  const [error, setError] = useState('');
  const frame = useRef<HTMLDivElement>(null);
  useEffect(() => { frame.current?.focus(); }, []);
  const label = (id: string) => tables.find((t) => t.id === id)?.label ?? '?';

  const reset = () => { setPoints([]); setClosed(null); setHint(''); };
  const close = () => {
    const ps = closePolygon(points);
    if (!ps) { setHint('A zone needs at least 3 corners.'); return; }
    setClosed(ps); setHint('');
  };
  const save = (next: ZoneSpec[]) => attempt(() => withPin('save the zone', async (p) => { await client.saveZones(p, camera.id, next); reset(); frame.current?.focus(); }), setError);
  const click = (e: MouseEvent<HTMLDivElement>) => {
    if (closed) return;
    const r = e.currentTarget.getBoundingClientRect();
    if (!r.width || !r.height) return;
    setPoints((ps) => addPoint(ps, normalisePoint(e.clientX, e.clientY, r)));
  };
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? STEP * 5 : STEP;
    const move = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (move) { e.preventDefault(); setCross((c) => ({ x: Math.min(1, Math.max(0, c.x + move[0])), y: Math.min(1, Math.max(0, c.y + move[1])) })); return; }
    if (e.key === 'Escape') {
      // Esc starts the zone again; with nothing drawn it leaves the drawing (and the panel stays).
      e.preventDefault();
      if (closed || points.length) reset(); else onDone();
      return;
    }
    if (closed) return;
    if (e.key === ' ') { e.preventDefault(); setPoints((ps) => addPoint(ps, cross)); }
    else if (e.key === 'Enter') { e.preventDefault(); close(); }
    else if (e.key === 'Backspace') { e.preventDefault(); setPoints((ps) => ps.slice(0, -1)); }
  };
  const used = new Set(zones.map((z) => z.tableId));
  const order = [...tables.filter((t) => !used.has(t.id)), ...tables.filter((t) => used.has(t.id))];

  return (
    <div className="zone">
      <div ref={frame} className="zone__frame" tabIndex={0} role="application"
        aria-label={`${camera.name}: click the corners of a table, Enter to close. Arrows and Space work too; Backspace takes a corner back, Esc starts again.`}
        onClick={click} onKeyDown={key}>
        <img src={src} alt={`What ${camera.name} sees`} draggable={false} />
        <svg viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
          {zones.map((z) => <polygon key={z.id} className="zone__saved" points={pointsAttr(z.points)} />)}
          {closed ? <polygon className="zone__new" points={pointsAttr(closed)} />
            : points.length > 0 && <polyline className="zone__new" points={pointsAttr(points)} />}
          {!closed && points.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r={0.008} className="zone__dot" />)}
          <path className="zone__cross" d={`M${cross.x - 0.02},${cross.y}H${cross.x + 0.02}M${cross.x},${cross.y - 0.02}V${cross.y + 0.02}`} />
        </svg>
        {zones.map((z) => {
          const c = z.points.reduce((a, p) => ({ x: a.x + p.x / z.points.length, y: a.y + p.y / z.points.length }), { x: 0, y: 0 });
          return <span key={z.id} className="zone__tag" style={{ left: `${c.x * 100}%`, top: `${c.y * 100}%` }}>{label(z.tableId)}</span>;
        })}
      </div>
      <p className="setup__hint" role="status">
        {closed ? 'Which table is this?' : hint || `${points.length} ${points.length === 1 ? 'corner' : 'corners'}${points.length >= 3 ? ' · Enter closes the zone' : ''}`}
      </p>
      {closed && (
        <div className="setup__chips" role="group" aria-label="Pick its table">
          {order.map((t) => (
            <button key={t.id} type="button" className="chip chip--solid"
              onClick={() => void save([...zones, { id: newId('z'), tableId: t.id, points: closed }])}>Table {t.label}</button>
          ))}
          <button type="button" className="chip" onClick={reset}>Cancel</button>
        </div>
      )}
      <div className="setup__chips">
        {!closed && points.length > 0 && <>
          <button type="button" className="chip chip--solid" disabled={points.length < 3} onClick={close}>Close zone</button>
          <button type="button" className="chip" onClick={() => setPoints((ps) => ps.slice(0, -1))}>Undo corner</button>
        </>}
        <button type="button" className="chip" onClick={onDone}>Done drawing</button>
      </div>
      {zones.length > 0 && (
        <div className="setup__chips" aria-label={`${camera.name}: zones`}>
          {zones.map((z) => (
            <button key={z.id} type="button" className="chip" onClick={() => void save(zones.filter((x) => x.id !== z.id))}
              aria-label={`Remove the zone of table ${label(z.tableId)}`}>Table {label(z.tableId)} ✕</button>
          ))}
        </div>
      )}
      {error && <p className="setup__error" role="alert">{error}</p>}
    </div>
  );
}

// ----- one table -----

/** A table's label and seats, in the panel: the one picked, or a new one with the next number. */
export function TableForm({ client, withPin, tables, table, onSaved, onRemoved }: {
  client: VisionClient; withPin: WithPin; tables: TableSpec[];
  /** null: a new table. */
  table: TableSpec | null;
  onSaved: (id: string) => void;
  onRemoved?: () => void;
}) {
  const next = String(Math.max(0, ...tables.map((t) => Number(t.label) || 0)) + 1);
  const spec = ({ id, label, seats }: TableSpec): TableSpec => ({ id, label, seats });
  const [row, setRow] = useState(() => {
    const t = table ? spec(table) : { id: newId('t'), label: next, seats: 4 };
    return { ...t, seatsText: String(t.seats) };
  });
  const seats = Math.round(Number(row.seatsText));
  const seatsOk = Number.isFinite(seats) && seats >= 1 && seats <= 50;
  const [dirty, setDirty] = useState(!table);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const edit = (patch: Partial<typeof row>) => { setRow((r) => ({ ...r, ...patch })); setDirty(true); setNote(''); };
  const save = () => attempt(() => withPin('save the table', async (p) => {
    const mine = { id: row.id, label: row.label.trim(), seats };
    await client.saveTables(p, table ? tables.map((t) => (t.id === mine.id ? mine : spec(t))) : [...tables.map(spec), mine]);
    setDirty(false); setNote('Saved.');
    onSaved(mine.id);
  }), setError);
  const remove = () => attempt(() => withPin('remove the table', async (p) => {
    await client.saveTables(p, tables.filter((t) => t.id !== row.id).map(spec));
    onRemoved?.();
  }), setError);
  return (
    <div className="panel-form">
      <div className="cam__grid">
        <label className="setup__field"><span>Table</span>
          <input value={row.label} maxLength={40} autoFocus={!table} onChange={(e) => edit({ label: e.target.value })} /></label>
        <label className="setup__field"><span>Seats</span>
          <input type="number" inputMode="numeric" min={1} max={50} value={row.seatsText} onChange={(e) => edit({ seatsText: e.target.value })} /></label>
      </div>
      {error && <p className="setup__error" role="alert">{error}</p>}
      <div className="panel-form__foot">
        <button type="button" className="chip chip--solid" disabled={!dirty || !row.label.trim() || !seatsOk} onClick={() => void save()}>{table ? 'Save table' : 'Add table'}</button>
        {note && <span className="setup__hint" role="status">{note}</span>}
        {table && <button type="button" className="chip chip--danger cam__remove" onClick={() => void remove()}>Remove</button>}
      </div>
    </div>
  );
}

// ----- the timers -----

/** The owner's three timers (2026-10-26), in plain words; minutes where minutes are meant. */
const TIMERS: { key: keyof Timers; label: string; unit: 'min' | 's' }[] = [
  { key: 'shortVisitS', label: 'A visit shorter than this needs no cleaning', unit: 'min' },
  { key: 'leftCheckS', label: 'Empty this long counts as left', unit: 's' },
  { key: 'autoFreeS', label: 'Free again by itself after', unit: 'min' },
];
const per = (unit: 'min' | 's') => (unit === 'min' ? 60 : 1);

export function TimerFields({ client, withPin, settings, disabled }: { client: VisionClient; withPin: WithPin; settings: VisionSettings; disabled: boolean }) {
  const [timers, setTimers] = useState<Timers>(() => timersOf(settings));
  const [dirty, setDirty] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const save = () => attempt(() => withPin('save the timers', async (p) => {
    await client.save(p, { ...settings, ...timers });
    setDirty(false); setNote('Saved.');
  }), setError);
  const valid = TIMERS.every((t) => Number.isSafeInteger(timers[t.key]) && timers[t.key] >= TIMER_LIMITS[t.key][0] && timers[t.key] <= TIMER_LIMITS[t.key][1]);
  return (
    <div className="panel-form">
      {TIMERS.map((t) => (
        <label key={t.key} className="setup__field panel-form__row"><span>{t.label}</span>
          <span className="panel-form__unit">
            <input type="number" inputMode="decimal" disabled={disabled} min={TIMER_LIMITS[t.key][0] / per(t.unit)} max={TIMER_LIMITS[t.key][1] / per(t.unit)}
              step={t.unit === 'min' ? 0.5 : 1} value={timers[t.key] / per(t.unit)}
              onChange={(e) => { setTimers((v) => ({ ...v, [t.key]: Math.round(Number(e.target.value) * per(t.unit)) })); setDirty(true); setNote(''); }} />
            {t.unit}
          </span>
        </label>
      ))}
      {error && <p className="setup__error" role="alert">{error}</p>}
      {!disabled && (
        <div className="panel-form__foot">
          <button type="button" className="chip chip--solid" disabled={!dirty || !valid} onClick={() => void save()}>Save timers</button>
          {note && <span className="setup__hint" role="status">{note}</span>}
        </div>
      )}
    </div>
  );
}
