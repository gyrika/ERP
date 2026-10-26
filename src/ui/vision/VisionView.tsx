import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from 'react';
import { liveBlocked, unzonedNote } from '../../domain/cameraSetup.ts';
import type { SyncEvent } from '../../domain/sync.ts';
import {
  CPU_LIMIT_STEP, MAX_CPU_LIMIT, MIN_CPU_LIMIT, tablesFromEvents, visionFromEvents, type FloorTable, type TableState, type VisionSettings,
} from '../../domain/tables.ts';
import {
  cameraHealth, parseVisionPick, tablesToday, visionHash, whyState, type TableDay, type VisionPick,
} from '../../domain/visionPage.ts';
import { usesLogin } from '../../services/auth.ts';
import { useShopEvents } from '../../services/ownerData.ts';
import { signedIn, subscribeAuth } from '../../services/serverAuth.ts';
import type { ViewsPerf } from '../../services/cameraViews.ts';
import type { CvStatus } from '../../services/setupClient.ts';
import { visionClient } from '../../services/visionClient.ts';
import { readAll, subscribeEvents } from '../eventLog.ts';
import { useNow } from '../Kitchen.tsx';
import { back, navigate, replace } from '../nav.ts';
import { OwnerNav } from '../OwnerNav.tsx';
import { CvProgress } from '../cameras/CvProgress.tsx';
import { columns, FloorTile, WORD } from '../floor/FloorTile.tsx';
import { setTable, undoTable } from '../tablesStore.ts';
import { PinLine } from './PinLine.tsx';
import { PinCancelled, TableForm, TimerFields, type WithPin } from './setupParts.tsx';
import './vision.css';
import './page.css';

/** Camera views (SCRUM-180): the shop PC only, so the cloud build (owner's phone) leaves the code out. */
const CameraViews = import.meta.env.VITE_SITE === 'cloud' ? null : lazy(() => import('./CameraViews.tsx'));

/**
 * Computer vision (#vision, SCRUM-174), in the owner's sidebar: one screen, no scrolling. Mind:
 * the owner. They know where their tables and cameras are; the single next thing they need is
 * whether CV is on and whether it sees the shop right. At the top, CV on or off (one switch; On is
 * Live: Shadow went 2026-10-27); then every camera in a strip, then the tables. A picked camera
 * opens large in the camera section (zones are drawn there) with its details in the side panel; a
 * table opens in the panel; with nothing picked the panel holds Performance (live while the owner
 * watches), the CPU limit and the timers. What is picked is in the address
 * (#vision/camera-<id>, …), so Esc and Back close it. Managers and the owner's phone see it
 * read-only; the owner changes it with their PIN, asked once, in the page's line.
 */

const LOOK_MS = 1000;
/** The CPU slider records once the owner stops moving it. */
const SETTLE_MS = 700;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const clock = (t: number) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const busy = (s: CvStatus | null) => s?.phase === 'downloading' || s?.phase === 'verifying';

/** The shop's history, with this device's own camera and table changes shown at once (before the server or demo has them). */
function useVisionEvents(): { events: SyncEvent[] | undefined; at: number } {
  const data = useShopEvents();
  const [local, setLocal] = useState(readAll);
  useEffect(() => subscribeEvents(() => setLocal(readAll())), []);
  const remote = data.state === 'ready' ? data.events : data.state === 'error' ? data.events : undefined;
  const events = useMemo(() => {
    if (!remote) return undefined;
    const known = new Set(remote.map((e) => e.id));
    const mine = local.filter((e) => (e.type.startsWith('vision.') || e.type.startsWith('table.')) && !known.has(e.id));
    return mine.length ? [...remote, ...mine] : remote;
  }, [remote, local]);
  return { events, at: (data.state === 'loading' ? undefined : data.at) ?? Date.now() };
}

const dayLine = (d: TableDay | undefined) => {
  if (!d?.seated) return 'Nobody seated today';
  return [`${d.seated} seated`, d.visitMin !== null && `${d.visitMin} min a visit`, d.waitMin !== null && `cleaned in ${d.waitMin} min`].filter(Boolean).join(' · ');
};

export default function VisionView({ hash = '#vision', onRegister, phone = false }: {
  /** The address: what the side panel shows (#vision/camera-<id>, #vision/live, …). */
  hash?: string;
  onRegister?: () => void;
  /** The owner's phone (cloud site): read only, no cameras, no links to the counter's screens. */
  phone?: boolean;
}) {
  const { events, at } = useVisionEvents();
  const now = useNow(1000);
  const role = useSyncExternalStore(subscribeAuth, () => signedIn()?.role ?? null);
  const canChange = !phone && (!usesLogin() || role === 'owner');
  const lockedWhy = phone ? 'Change it on the shop PC.' : 'Only the owner changes this.';
  const client = useMemo(visionClient, []);

  const vision = useMemo(() => (events ? visionFromEvents(events) : null), [events]);
  const tables = useMemo(() => (events ? tablesFromEvents(events) : []), [events]);
  // Heavy over weeks of history: worked out when the history changes, not every second.
  const days = useMemo(() => (events ? tablesToday(events, at) : new Map<string, TableDay>()), [events, at]);
  const health = useMemo(() => (events ? cameraHealth(events) : null), [events]);
  const settings = vision?.settings;
  const blocked = vision ? liveBlocked(tables, vision.cameras, vision.zones) : null;
  const unzoned = vision ? unzonedNote(tables, vision.cameras, vision.zones) : null;
  /** The camera worker's numbers now, from the camera views while the owner watches. */
  const [perf, setPerf] = useState<ViewsPerf | null>(null);

  // ----- what the panel shows: in the address, so Esc and Back close it -----
  const pick = parseVisionPick(hash);
  const go = useCallback((p: VisionPick) => (parseVisionPick(location.hash).kind === 'overview' ? navigate : replace)(visionHash(p)), []);
  const close = useCallback(() => back(), []);
  const [panel, setPanel] = useState<HTMLElement | null>(null);

  // ----- the owner's PIN: asked once, in the page's line, before the first change -----
  const [pin, setPin] = useState<string | null>(null);
  const [asking, setAsking] = useState<{ what: string; run: (pin: string) => Promise<void>; done: (e?: unknown) => void } | null>(null);
  const [pinError, setPinError] = useState('');
  const withPin: WithPin = useCallback((what, run) => {
    if (pin !== null || !client.needsPin) return run(pin ?? '');
    return new Promise<void>((resolve, reject) => {
      setPinError('');
      setAsking((before) => { before?.done(new PinCancelled()); return { what, run, done: (e) => (e ? reject(e) : resolve()) }; });
    });
  }, [pin, client]);
  const unlock = async (typed: string) => {
    if (!asking) return;
    setPinError('');
    try { await client.status(typed); } catch (e) { setPinError(message(e)); return; } // the shop server checks it is the owner's PIN
    setPin(typed);
    const a = asking;
    setAsking(null);
    a.run(typed).then(() => a.done(), (e: unknown) => a.done(e ?? new Error('failed')));
  };
  const cancelPin = () => { asking?.done(new PinCancelled()); setAsking(null); setPinError(''); };

  // ----- the CV pack: the first time, Activate downloads it (its progress here); then the switch -----
  /** undefined: not asked yet; null: no pack here (the cloud, or a server without one): the switch as it is. */
  const [pack, setPack] = useState<CvStatus | null | undefined>(undefined);
  useEffect(() => { client.pack().then(setPack, () => setPack(null)); }, [client]);
  useEffect(() => {
    if (!pack || !busy(pack)) return;
    const t = setTimeout(() => { client.pack().then(setPack, () => {}); }, LOOK_MS);
    return () => clearTimeout(t);
  }, [pack, client]);
  const needsActivate = pack != null && pack.phase !== 'ready';
  const [activateError, setActivateError] = useState('');
  const activate = () => {
    setActivateError('');
    withPin('activate computer vision', async (p) => { setPack(await client.activate(p)); })
      .catch((e: unknown) => { if (!(e instanceof PinCancelled)) setActivateError(message(e)); });
  };

  // ----- On / Off, Shadow / Live and the CPU limit: one `vision.settings_set` each -----
  /** A change waiting for the CV pack. */
  const [waiting, setWaiting] = useState<Partial<VisionSettings> | null>(null);
  const [cv, setCv] = useState<CvStatus | null>(null);
  const [said, setSaid] = useState('');
  const [error, setError] = useState('');

  /** The CV pack before Shadow or Live, with its progress; then the change. */
  const run = useCallback(async (p: string, patch: Partial<VisionSettings>) => {
    if (!settings) return;
    setError('');
    if (patch.mode && patch.mode !== 'off') {
      let st = await client.status(p);
      if (st.phase === 'idle' || st.phase === 'failed') st = await client.activate(p);
      setCv(st);
      setPack(st);
      if (st.phase !== 'ready') { setWaiting(patch); return; }
    }
    setWaiting(null);
    await client.save(p, { ...settings, ...patch });
    setSaid(patch.mode ? (patch.mode === 'off' ? 'Computer vision is off.' : 'Computer vision is on.') : `CPU limit ${patch.cpuLimit}%.`);
  }, [client, settings]);

  const change = (patch: Partial<VisionSettings>) => {
    if (!canChange || !settings) return;
    if (patch.mode === settings.mode && patch.cpuLimit === undefined) return;
    if (patch.mode === 'live' && blocked) return;
    const what = patch.mode ? (patch.mode === 'off' ? 'turn computer vision off' : 'turn computer vision on') : `set the CPU limit to ${patch.cpuLimit}%`;
    withPin(what, (p) => run(p, patch)).catch((e: unknown) => { if (!(e instanceof PinCancelled)) setError(message(e)); });
  };
  const on = settings ? settings.mode !== 'off' : false;
  // On is Live (Shadow is gone, owner 2026-10-27): the cameras set the floor.
  const toggle = () => change({ mode: on ? 'off' : 'live' });

  // The CV pack is on its way: look again each second, then make the change it was waiting for.
  useEffect(() => {
    if (!waiting || !busy(cv)) return;
    const t = setTimeout(() => {
      client.status(pin ?? '').then((st) => {
        setCv(st);
        if (st.phase === 'ready') run(pin ?? '', waiting).catch((e: unknown) => setError(message(e)));
      }, (e: unknown) => setError(message(e)));
    }, LOOK_MS);
    return () => clearTimeout(t);
  }, [waiting, cv, client, pin, run]);

  // ----- a table's state, set from the panel as on the Register's floor: one `table.state_set`, with Undo -----
  const [tableSet, setTableSet] = useState<{ tableId: string; eventId: string; said: string } | null>(null);
  const setState = (t: FloorTable, to: TableState) => {
    if (t.state === to) return;
    setTableSet({ tableId: t.id, eventId: setTable(t, to), said: `Table ${t.label}: ${WORD[to].en.toLowerCase()}.` });
  };

  // ----- the tables: arrows move, Enter (or a tap) opens one in the panel -----
  const grid = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState(0);
  const onGridKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns(grid.current), ArrowDown: columns(grid.current) }[e.key];
    if (step === undefined) return;
    e.preventDefault();
    const next = Math.min(tables.length - 1, Math.max(0, focused + step));
    setFocused(next);
    (grid.current?.children[next] as HTMLElement | undefined)?.focus();
  };

  const head = phone ? (
    <header className="owner__head">
      <button type="button" className="shops__back" onClick={() => { location.hash = ''; }}>Today</button>
      <span className="brand">CheesyBeez</span>
    </header>
  ) : <OwnerNav current="vision" onRegister={onRegister} />;

  if (!events || !settings || !vision) {
    return (
      <div className="setup">
        {head}
        <main className="vpage" aria-label="Computer vision" aria-busy="true">
          <div className="vpage__main"><h1>Computer vision</h1><div className="skeleton vision__skeleton" aria-hidden="true" /></div>
        </main>
      </div>
    );
  }

  let line: ReactNode = null;
  if (asking) line = <PinLine what={asking.what} onPin={(p) => void unlock(p)} onCancel={cancelPin} />;
  else if (waiting && busy(cv) && !needsActivate) line = <CvProgress status={cv!} />; // else the Activate card shows it
  else if (waiting && cv?.phase === 'failed') {
    line = (
      <p className="setup__error cv__failed" role="alert">
        <span>Activating CV did not work: {cv.reason}.</span>
        <button type="button" className="chip chip--solid" onClick={() => void run(pin ?? '', waiting).catch((e: unknown) => setError(message(e)))}>Retry</button>
      </p>
    );
  } else if (said) line = <p className="vision__line" role="status">{said}</p>;

  const ownerCameras = Boolean(CameraViews && !phone && canChange);
  const cameraPick = pick.kind === 'camera' || pick.kind === 'add-camera';
  const table = pick.kind === 'table' ? tables.find((t) => t.id === pick.id) : undefined;
  const camera = pick.kind === 'camera' ? vision.cameras.find((c) => c.id === pick.id) : undefined;

  let body: ReactNode = null;
  if (cameraPick && ownerCameras) body = null; // CameraViews draws its panel here
  else if (camera) {
    const h = health?.cameras.find((c) => c.id === camera.id);
    body = (
      <div className="vpanel__body">
        <PanelTitle title={camera.name} onClose={close} />
        <p className="vpanel__text">{h ? `${h.online ? 'Online' : 'Offline'} · ${h.fps === null ? '–' : `${h.fps} fps`} · ${h.lastSeen === null ? 'not seen yet' : `seen ${clock(h.lastSeen)}`}` : 'No camera data yet.'}</p>
        <p className="setup__hint">{phone ? 'The cameras are watched on the shop PC.' : 'Only the owner watches the cameras, on the shop PC.'}</p>
      </div>
    );
  } else if (table) {
    const zonedOn = vision.cameras.filter((c) => vision.zones[c.id]?.some((z) => z.tableId === table.id));
    body = (
      <div className="vpanel__body">
        <PanelTitle title={`Table ${table.label}`} onClose={close}>
          <span className={`vtable__state vtable__state--${table.noCamera ? 'nocam' : table.state}`}>{WORD[table.state].en}</span>
        </PanelTitle>
        <p className="vision__why" aria-live="polite">{whyState(table, events, settings, now)}</p>
        {!phone && (
          <div className="vpanel__group">
            <span className="vpanel__label" id="vision-table-state">Set it</span>
            <div className="vstates" role="radiogroup" aria-labelledby="vision-table-state">
              {(['occupied', 'needs_cleaning', 'free', 'reserved'] as const).map((to) => (
                <button key={to} type="button" role="radio" aria-checked={table.state === to} className={`vstates__pick vstates__pick--${to}`}
                  onClick={() => setState(table, to)}>{WORD[to].en}</button>
              ))}
            </div>
            {tableSet?.tableId === table.id && (
              <p className="vision__line" role="status">
                <span>{tableSet.said}</span>
                <button type="button" className="chip" onClick={() => { undoTable(tableSet.tableId, tableSet.eventId); setTableSet(null); }}>Undo</button>
              </p>
            )}
          </div>
        )}
        <p className="vpanel__text">{dayLine(days.get(table.id))} · {table.seats} seats</p>
        <div className="vpanel__row">
          {zonedOn.length
            ? <span>Zone on {zonedOn.map((c) => c.name).join(' and ')}</span>
            : <span className="vpanel__warn">No zone yet: the cameras cannot see it.</span>}
          {!phone && (zonedOn.length ? zonedOn : vision.cameras.filter((c) => c.enabled)).slice(0, 2).map((c) => (
            <button key={c.id} type="button" className="chip" onClick={() => go({ kind: 'camera', id: c.id })}>{zonedOn.length ? c.name : `Draw it on ${c.name}`}</button>
          ))}
        </div>
        {canChange && (
          <details className="vpanel__more">
            <summary>Edit the table</summary>
            <TableForm key={table.id} client={client} withPin={withPin} tables={tables} table={table} onSaved={() => {}} onRemoved={close} />
          </details>
        )}
      </div>
    );
  } else if (pick.kind === 'add-table' && canChange) {
    body = (
      <div className="vpanel__body">
        <PanelTitle title="Add a table" onClose={close} />
        <TableForm client={client} withPin={withPin} tables={tables} table={null} onSaved={(id) => go({ kind: 'table', id })} />
      </div>
    );
  } else {
    body = (
      <Overview settings={settings} canChange={canChange} lockedWhy={lockedWhy} blocked={blocked} unzoned={unzoned}
        health={health} perf={perf} phone={phone} client={client} withPin={withPin} onChange={change} cameras={vision.cameras} />
    );
  }

  return (
    <div className="setup">
      {head}
      <main className="vpage" aria-label="Computer vision">
        <div className="vpage__main">
          <header className="vpage__bar">
            <h1>Computer vision</h1>
            {pack !== undefined && !needsActivate && <>
              <button type="button" role="switch" aria-checked={on} className="vtoggle" disabled={!canChange || (!on && blocked !== null)}
                aria-label="Computer vision" title={!on && blocked ? blocked : undefined}
                aria-describedby={!canChange ? 'vision-locked' : undefined} onClick={toggle}>
                <span className="vtoggle__track" aria-hidden="true"><span className="vtoggle__knob" /></span>
                <span className="vtoggle__word">{on ? 'On' : 'Off'}</span>
              </button>
            </>}
          </header>
          {needsActivate && pack && (
            <section className="vactivate" aria-label="Activate computer vision">
              {busy(pack) ? <CvProgress status={pack} /> : <>
                <div className="vactivate__text">
                  <h2>{pack.phase === 'failed' ? 'Activating did not finish' : 'Computer vision is not activated yet'}</h2>
                  <p className="setup__hint">
                    {pack.phase === 'failed' ? `${pack.reason}. Check the internet and try again.`
                      : 'Activate downloads the camera tools once: the video reader and the people detector. No restart; the counter keeps working.'}
                  </p>
                </div>
                <button type="button" className="cta" disabled={!canChange} onClick={activate}>
                  {pack.phase === 'failed' ? 'Try again' : 'Activate computer vision'}
                </button>
              </>}
              {activateError && <p className="setup__error" role="alert">{activateError}</p>}
            </section>
          )}
          {!canChange && <p id="vision-locked" className="setup__hint vpage__locked">{lockedWhy}</p>}
          {(line || pinError || error) && (
            <div className="vpage__line">
              {line}
              {pinError && <p className="setup__error" role="alert">{pinError}</p>}
              {error && <p className="setup__error" role="alert">{error}</p>}
            </div>
          )}

          {CameraViews && !phone && (ownerCameras
            ? <Suspense fallback={<div className="skeleton vstrip__skeleton" aria-hidden="true" />}>
              <CameraViews cameras={vision.cameras} zones={vision.zones} tables={tables} detecting={on} pin={pin} client={client} withPin={withPin}
                pick={pick} onPick={go} onClose={close} panel={panel} onPerf={setPerf} />
            </Suspense>
            : (
              <section className="vision__part vstrip" aria-labelledby="vision-views">
                <div className="vpage__sechead"><h2 id="vision-views">Cameras <span className="vpage__count num">{vision.cameras.length}</span></h2></div>
                <p className="setup__hint">Only the owner watches the cameras, on the shop PC.</p>
              </section>
            ))}

          {/* A camera open large takes the room; Esc brings the tables back. */}
          {!(camera && ownerCameras) && <section className="vision__part vtables" aria-labelledby="vision-tables">
            <div className="vpage__sechead">
              <h2 id="vision-tables">Tables <span className="vpage__count num">{tables.length}</span></h2>
              {canChange && <button type="button" className="chip" aria-pressed={pick.kind === 'add-table'} onClick={() => go({ kind: 'add-table' })}>+ Add table</button>}
            </div>
            {tables.length ? (
              <div ref={grid} className="floor__grid vision__grid" role="listbox" aria-label="Tables by number" onKeyDown={onGridKey}>
                {tables.map((t, i) => {
                  const zoned = vision.cameras.some((c) => c.enabled && vision.zones[c.id]?.some((z) => z.tableId === t.id));
                  return (
                    <FloorTile key={t.id} t={t} now={now} selected={table?.id === t.id || (!table && i === focused)}
                      onPick={() => { setFocused(i); go({ kind: 'table', id: t.id }); }}>
                      {!zoned && <span className="vtable__nozone">no zone</span>}
                    </FloorTile>
                  );
                })}
              </div>
            ) : <p className="setup__hint">No tables yet.{canChange && ' Add one to start.'}</p>}
          </section>}
        </div>
        <aside ref={setPanel} className={`vpanel${pick.kind === 'overview' ? '' : ' vpanel--picked'}`} aria-label="Details">
          {body}
        </aside>
      </main>
    </div>
  );
}

function PanelTitle({ title, onClose, children }: { title: string; onClose: () => void; children?: ReactNode }) {
  return (
    <header className="vpanel__head">
      <h2>{title}</h2>
      {children}
      <button type="button" className="vpanel__close" aria-label="Close the panel (Esc)" onClick={onClose}>✕</button>
    </header>
  );
}

/** The panel with nothing picked: how CV is doing now (Performance), the CPU limit, the timers. */
function Overview({ settings, canChange, lockedWhy, blocked, unzoned, health, perf, phone, client, withPin, onChange, cameras }: {
  settings: VisionSettings; canChange: boolean; lockedWhy: string;
  /** Why CV cannot be turned on yet, and the tables the cameras cannot see. */
  blocked: string | null; unzoned: string | null;
  health: ReturnType<typeof cameraHealth>;
  /** The worker's numbers now, while the owner watches (null: not watching, or the worker is not running). */
  perf: ViewsPerf | null;
  phone: boolean;
  client: ReturnType<typeof visionClient>; withPin: WithPin;
  onChange: (patch: Partial<VisionSettings>) => void;
  cameras: ReturnType<typeof visionFromEvents>['cameras'];
}) {
  // ----- the CPU limit: the slider settles, then one event -----
  const [cpuDraft, setCpuDraft] = useState<number | null>(null);
  const commitCpu = useRef((_: number) => {});
  commitCpu.current = (value) => { if (value !== settings.cpuLimit) onChange({ cpuLimit: value }); setCpuDraft(null); };
  useEffect(() => {
    if (cpuDraft === null) return;
    const t = setTimeout(() => commitCpu.current(cpuDraft), SETTLE_MS);
    return () => clearTimeout(t);
  }, [cpuDraft]);

  const name = (id: string) => cameras.find((c) => c.id === id)?.name ?? id;
  const now = perf?.perf ?? null;
  // Now (live, every 2 s) when the owner watches; else the last heartbeat the shop kept.
  const rows = now
    ? now.cameras.map((c) => ({ id: c.id, online: c.online, fps: c.fps, checks: c.checksPerS, ms: c.detectMs }))
    : (health?.cameras ?? []).map((c) => ({ id: c.id, online: c.online, fps: c.fps, checks: null, ms: null }));
  const cpu = now ? now.cpu : health?.cpu ?? null;
  const slowed = now ? now.slowed : health?.slowed ?? false;
  const share = cpu === null ? 0 : Math.min(100, Math.round((cpu / Math.max(1, settings.cpuLimit)) * 100));

  return (
    <div className="vpanel__body">
      <header className="vpanel__head"><h2>Settings</h2></header>
      {settings.mode === 'off' && (blocked
        ? <p className="vision__line vision__note">{blocked}</p>
        : <p className="setup__hint">Turn CV on: the cameras set the floor (occupied, needs cleaning).</p>)}
      {unzoned && <p className="setup__hint">{unzoned}</p>}

      <section className="vpanel__group" aria-labelledby="vision-perf">
        <div className="vpanel__row">
          <h3 id="vision-perf" className="vpanel__label">Performance</h3>
          <span className="vperf__when">{now ? <><span className="vperf__live" aria-hidden="true" />Live</> : health?.at ? `at ${clock(health.at)}` : ''}</span>
        </div>
        {cpu === null && !rows.length ? <p className="setup__hint">{settings.mode === 'off' ? 'CV is off: nothing runs.' : 'No numbers yet: the cameras start in a few seconds.'}</p> : <>
          <div className="vperf__cpu">
            <span>CPU <b className="num">{cpu ?? '–'}%</b> of {settings.cpuLimit}%{slowed && ' · slowed to protect the Register'}</span>
            <span className={`vperf__bar${share >= 100 ? ' vperf__bar--over' : ''}`} aria-hidden="true"><span style={{ width: `${share}%` }} /></span>
          </div>
          <table className="vperf__table">
            <thead><tr><th scope="col">Camera</th><th scope="col">fps</th><th scope="col">checks/s</th><th scope="col">detect</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={r.online ? '' : 'vperf__off'}>
                  <th scope="row"><span className={`views__status views__status--${r.online ? 'ok' : 'bad'}`}>{name(r.id)}</span></th>
                  <td className="num">{r.fps}</td>
                  <td className="num">{r.checks ?? '–'}</td>
                  <td className="num">{r.ms === null ? '–' : `${r.ms} ms`}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {now && perf && <p className="setup__hint">{perf.views} {perf.views === 1 ? 'view' : 'views'} open on this page.</p>}
        </>}
      </section>

      <label className="vpanel__group vision__cpu">
        <span className="vpanel__label">CPU limit <b className="num">{cpuDraft ?? settings.cpuLimit}%</b></span>
        <input type="range" min={MIN_CPU_LIMIT} max={MAX_CPU_LIMIT} step={CPU_LIMIT_STEP} value={cpuDraft ?? settings.cpuLimit}
          disabled={!canChange} aria-valuetext={`${cpuDraft ?? settings.cpuLimit}% of the shop PC`}
          onChange={(e) => setCpuDraft(Number(e.target.value))} />
        <span className="setup__hint">More reads more frames; the counter comes first.</span>
      </label>

      <details className="vpanel__more">
        <summary>Timers</summary>
        <TimerFields key={`${settings.shortVisitS}-${settings.leftCheckS}-${settings.autoFreeS}`} client={client} withPin={withPin} settings={settings} disabled={!canChange} />
      </details>

      {!canChange && <p className="setup__hint">{lockedWhy}</p>}
      {phone && health && (
        <ul className="vision__cams" aria-label="Cameras">
          {health.cameras.map((c) => (
            <li key={c.id} className={`vision__cam${c.online ? '' : ' vision__cam--off'}`}>
              <b>{c.name}</b><span>{c.online ? 'Online' : 'Offline'}</span>
              <span className="num">{c.lastSeen === null ? 'not seen yet' : `seen ${clock(c.lastSeen)}`}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
