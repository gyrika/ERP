import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import {
  addPoint, brandOf, closePolygon, LIMIT_TEXT, liveBlocked, mayUse, normalisePoint, presetPath, RTSP_PRESETS, type Brand,
} from '../../domain/cameraSetup.ts';
import {
  DEFAULT_VISION_SETTINGS, tablesFromEvents, visionFromEvents, type CameraSpec, type Point, type TableSpec, type VisionMode, type VisionSettings, type ZoneSpec,
} from '../../domain/tables.ts';
import type { SyncEvent } from '../../domain/sync.ts';
import { cameraClient, type CameraLogins } from '../../services/setupClient.ts';
import { addEvents, readAll, subscribeEvents } from '../eventLog.ts';
import './cameras.css';

/**
 * #cameras, under Activate CV (SCRUM-171). Serves the owner, once, at setup: they know their
 * tables and roughly where each camera points; the one thing they need is each camera seeing its
 * tables. Cameras (scan or IP, brand, login, Test, Use for CV), tables, a zone per table drawn on
 * the camera's snapshot, the timers, then Off / Shadow / Live. Every save is an owner event the
 * shop server records (server/setup.ts); the login stays on the shop server, the snapshot only
 * in this screen's memory.
 */

const newId = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function useLog(): SyncEvent[] {
  const [events, setEvents] = useState(readAll);
  useEffect(() => subscribeEvents(() => setEvents(readAll())), []);
  return events;
}

// ----- Cameras -----

interface Draft { id: string; name: string; ip: string; brand: Brand; path: string; user: string; password: string; enabled: boolean; limit?: boolean }
type Tested = { jpeg: string } | { error: string } | 'testing';

const draftOf = (c: CameraSpec, logins: CameraLogins): Draft =>
  ({ id: c.id, name: c.name, ip: c.ip, brand: brandOf(c.rtspPath), path: c.rtspPath, user: logins[c.id]?.user ?? '', password: '', enabled: c.enabled });
const pathOf = (d: Draft) => (d.brand === 'custom' ? d.path.trim() : presetPath(d.brand)!);

function CameraCard({ d, n, passwordSet, tested, onChange, onTest, onRemove, onUse }: {
  d: Draft; n: number; passwordSet: boolean; tested: Tested | undefined;
  onChange: (patch: Partial<Draft>) => void; onTest: () => void; onRemove: () => void; onUse: () => void;
}) {
  const label = d.name || `Camera ${n}`;
  return (
    <li className="cam" aria-label={label} data-cam={d.id}>
      <div className="cam__grid">
        <label className="setup__field"><span>Name</span>
          <input value={d.name} placeholder={`Camera ${n}`} onChange={(e) => onChange({ name: e.target.value })} /></label>
        <label className="setup__field"><span>IP address</span>
          <input value={d.ip} inputMode="decimal" placeholder="192.168.1.20" onChange={(e) => onChange({ ip: e.target.value.trim() })} /></label>
      </div>
      <div className="cam__brands" role="radiogroup" aria-label={`${label}: brand`}>
        {[...RTSP_PRESETS.map((p) => [p.brand, p.label] as const), ['custom', 'Other'] as const].map(([brand, text]) => (
          <button key={brand} type="button" role="radio" aria-checked={d.brand === brand} className="chip"
            onClick={() => onChange({ brand, path: brand === 'custom' ? d.path : presetPath(brand)! })}>{text}</button>
        ))}
      </div>
      {d.brand === 'custom' && (
        <label className="setup__field"><span>Stream path</span>
          <input value={d.path} placeholder="/stream2" onChange={(e) => onChange({ path: e.target.value })} /></label>
      )}
      <div className="cam__grid">
        <label className="setup__field"><span>Username</span>
          <input value={d.user} autoComplete="off" onChange={(e) => onChange({ user: e.target.value })} /></label>
        <label className="setup__field"><span>Password</span>
          <input type="password" value={d.password} autoComplete="new-password" placeholder={passwordSet ? 'Password set' : ''}
            onChange={(e) => onChange({ password: e.target.value })} /></label>
      </div>
      <div className="cam__actions">
        <button type="button" className="chip chip--solid" disabled={!d.ip || tested === 'testing'} onClick={onTest}>
          {tested === 'testing' ? 'Testing…' : 'Test'}
        </button>
        <button type="button" role="switch" aria-checked={d.enabled} className="cam__use" onClick={onUse}>
          <span className="cam__knob" aria-hidden="true" />Use for CV
        </button>
        <button type="button" className="chip chip--danger cam__remove" onClick={onRemove}>Remove</button>
      </div>
      {d.limit && <p className="cam__note" role="status">{LIMIT_TEXT}</p>}
      {tested && tested !== 'testing' && ('jpeg' in tested
        ? <img className="cam__shot" src={`data:image/jpeg;base64,${tested.jpeg}`} alt={`What ${label} sees`} />
        : <p className="setup__error" role="alert">{tested.error}</p>)}
    </li>
  );
}

function Cameras({ pin, cameras, logins, onLogins, shots, onShot }: {
  pin: string; cameras: CameraSpec[]; logins: CameraLogins; onLogins: (l: CameraLogins) => void;
  shots: Record<string, Tested>; onShot: (id: string, t: Tested) => void;
}) {
  const [drafts, setDrafts] = useState<Draft[]>(() => cameras.map((c) => draftOf(c, logins)));
  const [dirty, setDirty] = useState(false);
  const [found, setFound] = useState<{ ip: string; name: string }[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const ipFocus = useRef<string | null>(null);

  const change = (id: string, patch: Partial<Draft>) => {
    setDrafts((ds) => ds.map((d) => (d.id === id ? { ...d, ...patch, limit: false } : d)));
    setDirty(true); setNote('');
  };
  const add = (ip = '', name = '') => {
    const id = newId('cam');
    if (!ip) ipFocus.current = id;
    setDrafts((ds) => [...ds, { id, name: name.slice(0, 60), ip, brand: 'tapo', path: '/stream2', user: '', password: '', enabled: false }]);
    setDirty(true); setNote('');
  };
  useEffect(() => {
    if (!ipFocus.current) return;
    document.querySelector<HTMLInputElement>(`[data-cam="${ipFocus.current}"] input[inputmode="decimal"]`)?.focus();
    ipFocus.current = null;
  });
  const use = (d: Draft) => {
    if (!d.enabled && !mayUse(drafts, d.id)) { setDrafts((ds) => ds.map((x) => (x.id === d.id ? { ...x, limit: true } : x))); return; }
    change(d.id, { enabled: !d.enabled });
  };
  const scan = async () => {
    setScanning(true); setError('');
    try { setFound((await cameraClient.scan(pin)).found); } catch (e) { setError(message(e)); } finally { setScanning(false); }
  };
  const test = async (d: Draft) => {
    onShot(d.id, 'testing');
    try {
      const r = await cameraClient.test(pin, { cameraId: d.id, ip: d.ip, rtspPath: pathOf(d), user: d.user || undefined, password: d.password || undefined });
      onShot(d.id, r.ok ? { jpeg: r.jpeg } : { error: r.message });
    } catch (e) { onShot(d.id, { error: message(e) }); }
  };
  const save = async () => {
    setError('');
    const list = drafts.map((d, i) => ({
      id: d.id, name: d.name.trim() || `Camera ${i + 1}`, ip: d.ip, rtspPath: pathOf(d), enabled: d.enabled,
      ...(d.user ? { user: d.user } : {}), ...(d.password ? { password: d.password } : {}),
    }));
    try {
      const r = await cameraClient.saveCameras(pin, list);
      addEvents(r.events);
      onLogins(r.logins);
      setDrafts((ds) => ds.map((d, i) => ({ ...d, name: list[i].name, password: '' })));
      setDirty(false); setNote('Cameras saved.');
    } catch (e) { setError(message(e)); }
  };
  const fresh = (found ?? []).filter((f) => !drafts.some((d) => d.ip === f.ip));

  return (
    <section className="cvs" aria-labelledby="cvs-cameras">
      <h2 id="cvs-cameras">Cameras</h2>
      <p className="setup__hint">Up to 4 cameras watch the tables. Scan finds the ones on the shop Wi-Fi; or add one by its IP address.</p>
      <div className="setup__chips">
        <button type="button" className="chip chip--solid" disabled={scanning} onClick={() => void scan()}>{scanning ? 'Scanning…' : 'Scan for cameras'}</button>
        <button type="button" className="chip" onClick={() => add()}>Add by IP</button>
      </div>
      {found && (fresh.length
        ? <div className="setup__chips" aria-label="Cameras found">{fresh.map((f) => (
          <button key={f.ip} type="button" className="chip" onClick={() => add(f.ip, f.name)}>Add {f.ip}{f.name ? ` · ${f.name}` : ''}</button>))}</div>
        : <p className="setup__hint" role="status">No new cameras answered. Check the camera is on the shop Wi-Fi, or add it by IP.</p>)}
      {drafts.length > 0 && (
        <ul className="cams">
          {drafts.map((d, i) => (
            <CameraCard key={d.id} d={d} n={i + 1} passwordSet={logins[d.id]?.passwordSet ?? false} tested={shots[d.id]}
              onChange={(p) => change(d.id, p)} onTest={() => void test(d)} onUse={() => use(d)}
              onRemove={() => { setDrafts((ds) => ds.filter((x) => x.id !== d.id)); setDirty(true); setNote(''); }} />
          ))}
        </ul>
      )}
      {error && <p className="setup__error" role="alert">{error}</p>}
      <div className="setup__foot">
        {note && <span className="setup__hint" role="status">{note}</span>}
        <button type="button" className="cta" disabled={!dirty} onClick={() => void save()}>Save cameras</button>
      </div>
    </section>
  );
}

// ----- Tables -----

function Tables({ pin, tables }: { pin: string; tables: TableSpec[] }) {
  const [rows, setRows] = useState(tables);
  const [dirty, setDirty] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const edit = (next: TableSpec[]) => { setRows(next); setDirty(true); setNote(''); };
  const nextLabel = () => String(Math.max(0, ...rows.map((r) => Number(r.label) || 0)) + 1);
  const save = async () => {
    setError('');
    const list = rows.map((r) => ({ ...r, label: r.label.trim() })).filter((r) => r.label);
    try { addEvents((await cameraClient.saveTables(pin, list)).events); setRows(list); setDirty(false); setNote('Tables saved.'); }
    catch (e) { setError(message(e)); }
  };
  return (
    <section className="cvs" aria-labelledby="cvs-tables">
      <h2 id="cvs-tables">Tables</h2>
      {rows.length > 0 && (
        <ul className="cvs__tables">
          {rows.map((t) => (
            <li key={t.id} aria-label={`Table ${t.label}`}>
              <label className="setup__field"><span>Table</span>
                <input value={t.label} maxLength={40} onChange={(e) => edit(rows.map((r) => (r.id === t.id ? { ...r, label: e.target.value } : r)))} /></label>
              <label className="setup__field"><span>Seats</span>
                <input type="number" min={1} max={50} value={t.seats}
                  onChange={(e) => edit(rows.map((r) => (r.id === t.id ? { ...r, seats: Math.min(50, Math.max(1, Math.round(Number(e.target.value) || 1))) } : r)))} /></label>
              <button type="button" className="chip chip--danger" onClick={() => edit(rows.filter((r) => r.id !== t.id))}>Remove</button>
            </li>
          ))}
        </ul>
      )}
      <div className="setup__chips"><button type="button" className="chip chip--solid" onClick={() => edit([...rows, { id: newId('t'), label: nextLabel(), seats: 4 }])}>Add table</button></div>
      {error && <p className="setup__error" role="alert">{error}</p>}
      <div className="setup__foot">
        {note && <span className="setup__hint" role="status">{note}</span>}
        <button type="button" className="cta" disabled={!dirty} onClick={() => void save()}>Save tables</button>
      </div>
    </section>
  );
}

// ----- Zones -----

const STEP = 0.02;
const pointsAttr = (ps: readonly Point[]) => ps.map((p) => `${p.x},${p.y}`).join(' ');

/**
 * Click the corners of a table on the picture; Enter closes the zone, then pick its table.
 * Keyboard: arrows move the cross (Shift: further), Space adds a corner, Backspace takes the last
 * one back, Esc starts again.
 */
function ZoneEditor({ pin, camera, jpeg, zones, tables }: { pin: string; camera: CameraSpec; jpeg: string | null; zones: ZoneSpec[]; tables: TableSpec[] }) {
  const [points, setPoints] = useState<Point[]>([]);
  const [closed, setClosed] = useState<Point[] | null>(null);
  const [cross, setCross] = useState<Point>({ x: 0.5, y: 0.5 });
  const [hint, setHint] = useState('');
  const [error, setError] = useState('');
  const frame = useRef<HTMLDivElement>(null);
  const label = (id: string) => tables.find((t) => t.id === id)?.label ?? '?';

  const reset = () => { setPoints([]); setClosed(null); setHint(''); };
  const close = () => {
    const ps = closePolygon(points);
    if (!ps) { setHint('A zone needs at least 3 corners.'); return; }
    setClosed(ps); setHint('');
  };
  const save = async (next: ZoneSpec[]) => {
    setError('');
    try { addEvents((await cameraClient.saveZones(pin, camera.id, next)).events); reset(); } catch (e) { setError(message(e)); }
  };
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
    if (closed) { if (e.key === 'Escape') { e.preventDefault(); reset(); } return; }
    if (e.key === ' ') { e.preventDefault(); setPoints((ps) => addPoint(ps, cross)); }
    else if (e.key === 'Enter') { e.preventDefault(); close(); }
    else if (e.key === 'Backspace') { e.preventDefault(); setPoints((ps) => ps.slice(0, -1)); }
    else if (e.key === 'Escape') { e.preventDefault(); reset(); }
  };
  const used = new Set(zones.map((z) => z.tableId));
  const order = [...tables.filter((t) => !used.has(t.id)), ...tables.filter((t) => used.has(t.id))];

  if (!jpeg) return <p className="setup__hint">Press Test on {camera.name} above to see its picture, then draw its tables on it.</p>;
  return (
    <div className="zone">
      <div ref={frame} className="zone__frame" tabIndex={0} role="application"
        aria-label={`${camera.name}: click the corners of a table, Enter to close. Arrows and Space work too; Backspace takes a corner back, Esc starts again.`}
        onClick={click} onKeyDown={key}>
        <img src={`data:image/jpeg;base64,${jpeg}`} alt={`What ${camera.name} sees`} draggable={false} />
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
      {!closed && points.length > 0 && (
        <div className="setup__chips">
          <button type="button" className="chip chip--solid" disabled={points.length < 3} onClick={close}>Close zone</button>
          <button type="button" className="chip" onClick={() => setPoints((ps) => ps.slice(0, -1))}>Undo corner</button>
        </div>
      )}
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

function Zones({ pin, cameras, zones, tables, shots }: {
  pin: string; cameras: CameraSpec[]; zones: Record<string, ZoneSpec[]>; tables: TableSpec[]; shots: Record<string, Tested>;
}) {
  const [pick, setPick] = useState<string | null>(null);
  const current = cameras.find((c) => c.id === pick) ?? cameras[0];
  const shot = current ? shots[current.id] : undefined;
  return (
    <section className="cvs" aria-labelledby="cvs-zones">
      <h2 id="cvs-zones">Where each table is</h2>
      {!cameras.length || !tables.length
        ? <p className="setup__hint">Save the cameras and the tables first; then draw each table on its camera’s picture.</p>
        : <>
          {cameras.length > 1 && (
            <div className="setup__chips" role="radiogroup" aria-label="Camera">
              {cameras.map((c) => <button key={c.id} type="button" role="radio" aria-checked={c.id === current.id} className="chip" onClick={() => setPick(c.id)}>{c.name}</button>)}
            </div>
          )}
          <ZoneEditor key={current.id} pin={pin} camera={current} jpeg={shot && shot !== 'testing' && 'jpeg' in shot ? shot.jpeg : null}
            zones={zones[current.id] ?? []} tables={tables} />
        </>}
    </section>
  );
}

// ----- Timers and mode -----

const MODES: { mode: VisionMode; label: string; hint: string }[] = [
  { mode: 'off', label: 'Off', hint: 'The cameras are not used.' },
  { mode: 'shadow', label: 'Shadow', hint: 'The cameras watch and learn; the floor still changes only when staff set it.' },
  { mode: 'live', label: 'Live', hint: 'The cameras set the floor: occupied, needs cleaning.' },
];
const TIMERS: { key: 'seatS' | 'leaveS' | 'cleanAlertS'; label: string; min: number }[] = [
  { key: 'seatS', label: 'Seated after (seconds of people at the table)', min: 10 },
  { key: 'leaveS', label: 'Left after (seconds of an empty table)', min: 10 },
  { key: 'cleanAlertS', label: 'Cleaning alert after (seconds; 0 never)', min: 0 },
];

function Mode({ pin, settings, blocked }: { pin: string; settings: VisionSettings; blocked: string | null }) {
  const [timers, setTimers] = useState({ seatS: settings.seatS, leaveS: settings.leaveS, cleanAlertS: settings.cleanAlertS });
  const [dirty, setDirty] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const save = async (next: VisionSettings, saved: string) => {
    setError('');
    try { addEvents((await cameraClient.saveSettings(pin, next)).events); setDirty(false); setNote(saved); } catch (e) { setError(message(e)); }
  };
  const valid = TIMERS.every((t) => Number.isSafeInteger(timers[t.key]) && timers[t.key] >= t.min && timers[t.key] <= (t.key === 'cleanAlertS' ? 7200 : 3600));
  return (
    <section className="cvs" aria-labelledby="cvs-mode">
      <h2 id="cvs-mode">Timers</h2>
      <div className="cvs__timers">
        {TIMERS.map((t) => (
          <label key={t.key} className="setup__field"><span>{t.label}</span>
            <input type="number" min={t.min} value={timers[t.key]}
              onChange={(e) => { setTimers((v) => ({ ...v, [t.key]: Math.round(Number(e.target.value)) })); setDirty(true); setNote(''); }} /></label>
        ))}
      </div>
      <div className="setup__foot">
        <button type="button" className="chip chip--solid" disabled={!dirty || !valid} onClick={() => void save({ ...settings, ...timers }, 'Timers saved.')}>Save timers</button>
      </div>
      <h2>Table detection</h2>
      <div className="cvs__modes" role="radiogroup" aria-label="Table detection">
        {MODES.map((m) => {
          const off = m.mode === 'live' && blocked !== null;
          return (
            <button key={m.mode} type="button" role="radio" aria-checked={settings.mode === m.mode} className="setup__choice cvs__mode" disabled={off}
              aria-describedby={off ? 'cvs-live-why' : undefined}
              onClick={() => void save({ ...settings, ...(valid ? timers : {}), mode: m.mode }, `Table detection: ${m.label}.`)}>
              <b>{m.label}</b><span>{m.hint}</span>
            </button>
          );
        })}
      </div>
      {blocked && <p id="cvs-live-why" className="cam__note">Live: {blocked}</p>}
      {note && <p className="setup__hint" role="status">{note}</p>}
      {error && <p className="setup__error" role="alert">{error}</p>}
    </section>
  );
}

export function CameraSetup({ pin }: { pin: string }) {
  const events = useLog();
  const vision = useMemo(() => visionFromEvents(events), [events]);
  const tables = useMemo(() => tablesFromEvents(events).map(({ id, label, seats }) => ({ id, label, seats })), [events]);
  const [logins, setLogins] = useState<CameraLogins | null>(null);
  const [shots, setShots] = useState<Record<string, Tested>>({});
  const [error, setError] = useState('');
  useEffect(() => { cameraClient.setup(pin).then((r) => setLogins(r.logins), (e: unknown) => setError(message(e))); }, [pin]);
  const settings = vision.settings ?? DEFAULT_VISION_SETTINGS;

  if (error) return <p className="setup__error" role="alert">{error}</p>;
  if (!logins) return <div className="skeleton setup__skeleton" aria-hidden="true" />;
  return (
    <>
      <Cameras pin={pin} cameras={vision.cameras} logins={logins} onLogins={setLogins} shots={shots} onShot={(id, t) => setShots((s) => ({ ...s, [id]: t }))} />
      <Tables pin={pin} tables={tables} />
      <Zones pin={pin} cameras={vision.cameras.filter((c) => c.enabled)} zones={vision.zones} tables={tables} shots={shots} />
      <Mode key={`${settings.seatS}-${settings.leaveS}-${settings.cleanAlertS}`} pin={pin} settings={settings} blocked={liveBlocked(tables, vision.cameras, vision.zones)} />
    </>
  );
}
