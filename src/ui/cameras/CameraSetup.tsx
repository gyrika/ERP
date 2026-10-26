import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import {
  addPoint, ASK_BRANDS, asksCamera, brandOf, closePolygon, cornerAt, LIMIT_TEXT, mayUse, MIN_ZONE_POINTS, movePoint, normalisePoint,
  presetPath, RTSP_PRESETS, type Brand,
} from '../../domain/cameraSetup.ts';
import {
  DEFAULT_VISION_SETTINGS, TIMER_LIMITS, tablesFromEvents, timersOf, visionFromEvents, type CameraSpec, type Point, type TableSpec, type Timers,
  type VisionSettings, type ZoneSpec,
} from '../../domain/tables.ts';
import type { SyncEvent } from '../../domain/sync.ts';
import { cameraClient, type CameraLogins } from '../../services/setupClient.ts';
import { addEvents, readAll, subscribeEvents } from '../eventLog.ts';
import './cameras.css';

/**
 * #cameras, under Activate CV (SCRUM-171). Serves the owner, once, at setup: they know their
 * tables and roughly where each camera points; the one thing they need is each camera seeing its
 * tables. Cameras (scan or IP, brand, login, Test, Use for CV), tables, a zone per table drawn on
 * the camera's snapshot, the timers. Off / Shadow / Live is on Computer vision (#vision, SCRUM-174),
 * in one place only. Every save is an owner event the
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

interface Draft {
  id: string; name: string; ip: string; brand: Brand; path: string; user: string; password: string; enabled: boolean; limit?: boolean;
  /** A dual-lens camera's second lens: the first one's kept login (SCRUM-180). */
  loginFrom?: string;
}
type Tested = { jpeg: string } | { error: string } | 'testing';
/** Ask the camera: what it said, while asking, or why it could not. */
type Asking = 'asking' | { note: string } | { error: string };
const BRANDS = [...RTSP_PRESETS.map((p) => [p.brand, p.label] as const), ...ASK_BRANDS.map((b) => [b.brand, b.label] as const), ['custom', 'Other'] as const];

const draftOf = (c: CameraSpec, logins: CameraLogins): Draft =>
  ({ id: c.id, name: c.name, ip: c.ip, brand: brandOf(c.rtspPath), path: c.rtspPath, user: logins[c.id]?.user ?? '', password: '', enabled: c.enabled });
const pathOf = (d: Draft) => presetPath(d.brand) ?? d.path.trim();

function CameraCard({ d, n, passwordSet, tested, asked, onChange, onTest, onAsk, onRemove, onUse }: {
  d: Draft; n: number; passwordSet: boolean; tested: Tested | undefined; asked: Asking | undefined;
  onChange: (patch: Partial<Draft>) => void; onTest: () => void; onAsk: () => void; onRemove: () => void; onUse: () => void;
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
        {BRANDS.map(([brand, text]) => (
          <button key={brand} type="button" role="radio" aria-checked={d.brand === brand} className="chip"
            onClick={() => onChange({ brand, path: presetPath(brand) ?? (presetPath(d.brand) ? '' : d.path) })}>{text}</button>
        ))}
      </div>
      {asksCamera(d.brand) && (
        <label className="setup__field"><span>Stream path{d.brand !== 'custom' && ': Ask the camera fills it'}</span>
          <input value={d.path} placeholder={d.brand === 'custom' ? '/stream2' : ''} onChange={(e) => onChange({ path: e.target.value })} /></label>
      )}
      <div className="cam__grid">
        <label className="setup__field"><span>Username</span>
          <input value={d.user} autoComplete="off" onChange={(e) => onChange({ user: e.target.value })} /></label>
        <label className="setup__field"><span>Password</span>
          <input type="password" value={d.password} autoComplete="new-password" placeholder={passwordSet ? 'Password set' : ''}
            onChange={(e) => onChange({ password: e.target.value })} /></label>
      </div>
      <div className="cam__actions">
        {asksCamera(d.brand) && (
          <button type="button" className={`chip${d.path ? '' : ' chip--solid'}`} disabled={!d.ip || asked === 'asking'} onClick={onAsk}>
            {asked === 'asking' ? 'Asking…' : 'Ask the camera'}
          </button>
        )}
        <button type="button" className={`chip${pathOf(d) ? ' chip--solid' : ''}`} disabled={!d.ip || !pathOf(d) || tested === 'testing'} onClick={onTest}>
          {tested === 'testing' ? 'Testing…' : 'Test'}
        </button>
        <button type="button" role="switch" aria-checked={d.enabled} className="cam__use" onClick={onUse}>
          <span className="cam__knob" aria-hidden="true" />Use for CV
        </button>
        <button type="button" className="chip chip--danger cam__remove" onClick={onRemove}>Remove</button>
      </div>
      {d.limit && <p className="cam__note" role="status">{LIMIT_TEXT}</p>}
      {asked && asked !== 'asking' && ('note' in asked
        ? <p className="setup__hint" role="status">{asked.note}</p>
        : <p className="setup__error" role="alert">{asked.error}</p>)}
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
  const [asked, setAsked] = useState<Record<string, Asking>>({});
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
      const r = await cameraClient.test(pin, { cameraId: d.loginFrom ?? d.id, ip: d.ip, rtspPath: pathOf(d), user: d.user || undefined, password: d.password || undefined });
      onShot(d.id, r.ok ? { jpeg: r.jpeg } : { error: r.message });
    } catch (e) { onShot(d.id, { error: message(e) }); }
  };
  /** Ask the camera (ONVIF) for its stream: the first lens here, any other lens as its own camera. */
  const ask = async (d: Draft) => {
    setAsked((a) => ({ ...a, [d.id]: 'asking' }));
    try {
      const r = await cameraClient.ask(pin, { cameraId: d.loginFrom ?? d.id, ip: d.ip, user: d.user || undefined, password: d.password || undefined });
      if (!r.ok) { setAsked((a) => ({ ...a, [d.id]: { error: r.message } })); return; }
      const [one, ...more] = r.streams;
      change(d.id, { path: one.path });
      const name = d.name.trim() || `Camera ${drafts.indexOf(d) + 1}`;
      const fresh = more.filter((m) => !drafts.some((x) => x.ip === d.ip && x.path === m.path));
      if (fresh.length) {
        setDrafts((ds) => [...ds, ...fresh.map((m, i) => ({
          id: newId('cam'), name: `${name} ${i + 2}`.slice(0, 60), ip: d.ip, brand: d.brand, path: m.path, user: d.user, password: d.password,
          enabled: false, ...(d.password ? {} : { loginFrom: d.loginFrom ?? d.id }),
        }))]);
      }
      const lenses = r.streams.length;
      setAsked((a) => ({ ...a, [d.id]: { note: lenses > 1
        ? `This camera has ${lenses} lenses: each is its own camera${fresh.length ? ' (added below)' : ''}. Save cameras to keep them.`
        : `The camera streams at ${one.path} (${one.width}×${one.height}). Test it, then save.` } }));
    } catch (e) { setAsked((a) => ({ ...a, [d.id]: { error: message(e) } })); }
  };
  const save = async () => {
    setError('');
    const list = drafts.map((d, i) => ({
      id: d.id, name: d.name.trim() || `Camera ${i + 1}`, ip: d.ip, rtspPath: pathOf(d), enabled: d.enabled,
      ...(d.user ? { user: d.user } : {}), ...(d.password ? { password: d.password } : {}), ...(d.loginFrom ? { loginFrom: d.loginFrom } : {}),
    }));
    try {
      const r = await cameraClient.saveCameras(pin, list);
      addEvents(r.events);
      onLogins(r.logins);
      setDrafts((ds) => ds.map((d, i) => ({ ...d, name: list[i].name, password: '', loginFrom: undefined })));
      setDirty(false); setNote('Cameras saved.');
    } catch (e) { setError(message(e)); }
  };
  const fresh = (found ?? []).filter((f) => !drafts.some((d) => d.ip === f.ip));

  return (
    <section className="cvs" aria-labelledby="cvs-cameras">
      <h2 id="cvs-cameras">Cameras</h2>
      <p className="setup__hint">Up to 4 cameras watch the tables; every camera shows on Computer vision. Scan finds the ones on the shop Wi-Fi; or add one by its IP address.</p>
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
            <CameraCard key={d.id} d={d} n={i + 1} passwordSet={(logins[d.id] ?? (d.loginFrom ? logins[d.loginFrom] : undefined))?.passwordSet ?? false}
              tested={shots[d.id]} asked={asked[d.id]}
              onChange={(p) => change(d.id, p)} onTest={() => void test(d)} onAsk={() => void ask(d)} onUse={() => use(d)}
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
const centre = (ps: readonly Point[]) => ps.reduce((a, p) => ({ x: a.x + p.x / ps.length, y: a.y + p.y / ps.length }), { x: 0, y: 0 });

/**
 * The picture on the left, its controls in a panel on the right. Click the corners of a table;
 * the next edge follows the mouse, and a click on the first corner (or a double click, or Enter)
 * closes the zone, then pick its table. Drag a corner to move it; right click takes the last one
 * back. Keyboard: arrows move the cross (Shift: further), Space adds a corner, Backspace takes the
 * last one back, Esc starts again.
 */
function ZoneEditor({ pin, camera, jpeg, zones, tables }: { pin: string; camera: CameraSpec; jpeg: string | null; zones: ZoneSpec[]; tables: TableSpec[] }) {
  const [points, setPoints] = useState<Point[]>([]);
  const [closed, setClosed] = useState<Point[] | null>(null);
  const [cross, setCross] = useState<Point>({ x: 0.5, y: 0.5 });
  const [hover, setHover] = useState<{ p: Point; size: { width: number; height: number } } | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const [lit, setLit] = useState<string | null>(null);
  const [hint, setHint] = useState('');
  const [error, setError] = useState('');
  const drag = useRef<{ i: number; from: Point; moved: boolean } | null>(null);
  const label = (id: string) => tables.find((t) => t.id === id)?.label ?? '?';

  const reset = () => { setPoints([]); setClosed(null); setHint(''); };
  const undo = () => { setPoints((ps) => ps.slice(0, -1)); setHint(''); };
  const close = () => {
    const zone = closePolygon(points);
    if (!zone) { setHint('A zone needs at least 3 corners.'); return; }
    setClosed(zone); setHint('');
  };
  const save = async (next: ZoneSpec[]) => {
    setError('');
    try { addEvents((await cameraClient.saveZones(pin, camera.id, next)).events); reset(); } catch (e) { setError(message(e)); }
  };

  /** Where the pointer is on the picture (0-1) and the picture's shown size; null before it is laid out. */
  const at = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return r.width && r.height ? { p: normalisePoint(e.clientX, e.clientY, r), size: { width: r.width, height: r.height } } : null;
  };
  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (closed || e.button !== 0) return;
    const hit = at(e);
    if (!hit) return;
    const i = cornerAt(points, hit.p, hit.size);
    if (i >= 0) {
      drag.current = { i, from: hit.p, moved: false };
      setDragging(i);
      e.currentTarget.setPointerCapture?.(e.pointerId);
    } else setPoints((ps) => addPoint(ps, hit.p));
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const hit = at(e);
    if (!hit) return;
    setCross(hit.p); setHover(hit);
    const d = drag.current;
    if (d && (d.moved || hit.p.x !== d.from.x || hit.p.y !== d.from.y)) { d.moved = true; setPoints((ps) => movePoint(ps, d.i, hit.p)); }
  };
  const up = () => {
    const d = drag.current;
    drag.current = null; setDragging(null);
    if (d && !d.moved && d.i === 0 && points.length >= MIN_ZONE_POINTS) close(); // a click on the first corner
  };
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? STEP * 5 : STEP;
    const arrow = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (arrow) {
      e.preventDefault(); setHover(null);
      setCross((c) => ({ x: Math.min(1, Math.max(0, c.x + arrow[0])), y: Math.min(1, Math.max(0, c.y + arrow[1])) }));
      return;
    }
    if (closed) { if (e.key === 'Escape') { e.preventDefault(); reset(); } return; }
    if (e.key === ' ') { e.preventDefault(); setPoints((ps) => addPoint(ps, cross)); }
    else if (e.key === 'Enter') { e.preventDefault(); close(); }
    else if (e.key === 'Backspace') { e.preventDefault(); undo(); }
    else if (e.key === 'Escape') { e.preventDefault(); reset(); }
  };

  const used = new Set(zones.map((z) => z.tableId));
  const order = [...tables.filter((t) => !used.has(t.id)), ...tables.filter((t) => used.has(t.id))];
  const canClose = points.length >= MIN_ZONE_POINTS;
  const pointer = hover && !closed ? hover.p : null;
  const onCorner = hover && pointer && dragging === null ? cornerAt(points, pointer, hover.size) : -1;
  const onFirst = onCorner === 0 && canClose;
  const last = points.at(-1);
  const cursor = dragging !== null ? ' zone__frame--dragging' : onFirst ? ' zone__frame--closing' : onCorner >= 0 ? ' zone__frame--corner' : '';

  if (!jpeg) return <p className="setup__hint">Press Test on {camera.name} above to see its picture, then draw its tables on it.</p>;
  const status = closed ? 'Which table is this?'
    : hint || (onFirst ? 'Click the first corner to close the zone'
      : points.length ? `${points.length} ${points.length === 1 ? 'corner' : 'corners'}${canClose ? ' · Enter closes the zone' : ''}`
        : 'Click the first corner of a table');
  return (
    <div className="zone">
      <div className={`zone__frame${cursor}`} tabIndex={0} role="application"
        aria-label={`${camera.name}: click the corners of a table, Enter to close. Arrows and Space work too; Backspace takes a corner back, Esc starts again.`}
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
        onPointerLeave={() => { if (!drag.current) setHover(null); }}
        onDoubleClick={() => { if (!closed) close(); }}
        onContextMenu={(e) => { e.preventDefault(); if (!closed) undo(); }}
        onKeyDown={key}>
        <img src={`data:image/jpeg;base64,${jpeg}`} alt={`What ${camera.name} sees`} draggable={false} />
        <svg viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
          {zones.map((z) => <polygon key={z.id} className={`zone__saved${lit === z.id ? ' zone__saved--lit' : ''}`} points={pointsAttr(z.points)} />)}
          {closed ? <polygon className="zone__new" points={pointsAttr(closed)} />
            : points.length > 0 && <polyline className="zone__new" points={pointsAttr(points)} />}
          {last && pointer && dragging === null && (onFirst
            ? <line className="zone__next" x1={last.x} y1={last.y} x2={points[0].x} y2={points[0].y} />
            : <>
              <line className="zone__next" x1={last.x} y1={last.y} x2={pointer.x} y2={pointer.y} />
              {points.length >= 2 && <line className="zone__shut" x1={pointer.x} y1={pointer.y} x2={points[0].x} y2={points[0].y} />}
            </>)}
        </svg>
        {/* Corners and the cross in HTML, so they stay round and sharp whatever shape the picture is shown at. */}
        {!closed && points.map((p, i) => (
          <span key={i} aria-hidden="true" style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }}
            className={`zone__dot${i === 0 && canClose ? ' zone__dot--first' : ''}${i === onCorner || i === dragging ? ' zone__dot--on' : ''}`} />
        ))}
        {!pointer && <span className="zone__cross" aria-hidden="true" style={{ left: `${cross.x * 100}%`, top: `${cross.y * 100}%` }} />}
        {zones.map((z) => {
          const c = centre(z.points);
          return <span key={z.id} className="zone__tag" style={{ left: `${c.x * 100}%`, top: `${c.y * 100}%` }}>{label(z.tableId)}</span>;
        })}
      </div>

      <aside className="zone__panel" aria-label={`${camera.name}: drawing`}>
        <p className="zone__status" role="status">{status}</p>
        {closed ? (
          <div className="zone__tools" role="group" aria-label="Pick its table">
            {order.map((t) => (
              <button key={t.id} type="button" className="chip chip--solid"
                onClick={() => void save([...zones, { id: newId('z'), tableId: t.id, points: closed }])}>Table {t.label}</button>
            ))}
            <button type="button" className="chip" aria-label="Cancel" aria-keyshortcuts="Escape" onClick={reset}>Cancel<kbd aria-hidden="true">Esc</kbd></button>
          </div>
        ) : (
          <div className="zone__tools">
            <button type="button" className="chip chip--solid" aria-label="Close zone" aria-keyshortcuts="Enter" disabled={!canClose} onClick={close}>
              Close zone<kbd aria-hidden="true">Enter</kbd>
            </button>
            <button type="button" className="chip" aria-label="Undo corner" aria-keyshortcuts="Backspace" disabled={!points.length} onClick={undo}>
              Undo corner<kbd aria-hidden="true">⌫</kbd>
            </button>
            <button type="button" className="chip" aria-label="Start again" aria-keyshortcuts="Escape" disabled={!points.length} onClick={reset}>
              Start again<kbd aria-hidden="true">Esc</kbd>
            </button>
            <p className="zone__help">Drag a corner to move it. Double click closes; right click takes a corner back.</p>
          </div>
        )}
        {zones.length > 0 && (
          <div className="zone__list">
            <h3 id={`zones-${camera.id}`}>Zones</h3>
            <ul aria-labelledby={`zones-${camera.id}`}>
              {zones.map((z) => (
                <li key={z.id} className={lit === z.id ? 'is-lit' : undefined} onMouseEnter={() => setLit(z.id)} onMouseLeave={() => setLit(null)}>
                  <span>Table {label(z.tableId)}</span>
                  <button type="button" className="zone__remove" onFocus={() => setLit(z.id)} onBlur={() => setLit(null)}
                    onClick={() => void save(zones.filter((x) => x.id !== z.id))} aria-label={`Remove the zone of table ${label(z.tableId)}`}>✕</button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {error && <p className="setup__error" role="alert">{error}</p>}
      </aside>
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

// ----- Timers -----

/** The owner's three timers (2026-10-26), in plain words; minutes where minutes are meant. */
const TIMERS: { key: keyof Timers; label: string; unit: 'min' | 's' }[] = [
  { key: 'shortVisitS', label: 'A visit shorter than this needs no cleaning', unit: 'min' },
  { key: 'leftCheckS', label: 'Empty this long counts as left', unit: 's' },
  { key: 'autoFreeS', label: 'Free again by itself after', unit: 'min' },
];
const per = (unit: 'min' | 's') => (unit === 'min' ? 60 : 1);

function TimerFields({ pin, settings }: { pin: string; settings: VisionSettings }) {
  const [timers, setTimers] = useState<Timers>(() => timersOf(settings));
  const [dirty, setDirty] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const save = async (next: VisionSettings, saved: string) => {
    setError('');
    try { addEvents((await cameraClient.saveSettings(pin, next)).events); setDirty(false); setNote(saved); } catch (e) { setError(message(e)); }
  };
  const valid = TIMERS.every((t) => Number.isSafeInteger(timers[t.key]) && timers[t.key] >= TIMER_LIMITS[t.key][0] && timers[t.key] <= TIMER_LIMITS[t.key][1]);
  return (
    <section className="cvs" aria-labelledby="cvs-timers">
      <h2 id="cvs-timers">Timers</h2>
      <p className="setup__hint">Someone at a table makes it occupied at once. After a visit, these decide the rest.</p>
      <div className="cvs__timers">
        {TIMERS.map((t) => (
          <label key={t.key} className="setup__field"><span>{t.label} ({t.unit})</span>
            <input type="number" inputMode="decimal" min={TIMER_LIMITS[t.key][0] / per(t.unit)} max={TIMER_LIMITS[t.key][1] / per(t.unit)}
              step={t.unit === 'min' ? 0.5 : 1} value={timers[t.key] / per(t.unit)}
              onChange={(e) => { setTimers((v) => ({ ...v, [t.key]: Math.round(Number(e.target.value) * per(t.unit)) })); setDirty(true); setNote(''); }} /></label>
        ))}
      </div>
      <div className="setup__foot">
        <button type="button" className="chip chip--solid" disabled={!dirty || !valid} onClick={() => void save({ ...settings, ...timers }, 'Timers saved.')}>Save timers</button>
      </div>
      {note && <p className="setup__hint" role="status">{note}</p>}
      <p className="setup__hint">Off, Shadow and Live are on <a href="#vision">Computer vision</a>.</p>
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
      <TimerFields key={`${settings.shortVisitS}-${settings.leftCheckS}-${settings.autoFreeS}`} pin={pin} settings={settings} />
    </>
  );
}
