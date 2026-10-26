import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { liveBlocked } from '../../domain/cameraSetup.ts';
import type { SyncEvent } from '../../domain/sync.ts';
import {
  CPU_LIMIT_STEP, MAX_CPU_LIMIT, MIN_CPU_LIMIT, tablesFromEvents, visionFromEvents, type VisionMode, type VisionSettings,
} from '../../domain/tables.ts';
import { cameraHealth, tablesToday, whyState, type TableDay } from '../../domain/visionPage.ts';
import { usesLogin } from '../../services/auth.ts';
import { useShopEvents } from '../../services/ownerData.ts';
import { signedIn, subscribeAuth } from '../../services/serverAuth.ts';
import type { CvStatus } from '../../services/setupClient.ts';
import { visionClient } from '../../services/visionClient.ts';
import { readAll, subscribeEvents } from '../eventLog.ts';
import { useNow } from '../Kitchen.tsx';
import { OwnerNav } from '../OwnerNav.tsx';
import { CvProgress } from '../cameras/CvProgress.tsx';
import { columns, FloorTile } from '../floor/FloorTile.tsx';
import { PinLine } from './PinLine.tsx';
import './vision.css';

/** Camera views (SCRUM-180): the shop PC only, so the cloud build (owner's phone) leaves the code out. */
const CameraViews = import.meta.env.VITE_SITE === 'cloud' ? null : lazy(() => import('./CameraViews.tsx'));

/**
 * Computer vision (#vision, SCRUM-174), in the owner's sidebar. Mind: the owner. They know where
 * their tables and cameras are; the single next thing they need is whether CV is on and right,
 * and why it thinks a table is taken. One switch (Off / Shadow / Live), the tables now with why
 * each is in its state and its day, the cameras' health and the CPU limit. The cameras, tables,
 * zones and timers are set up on #cameras. Managers and the owner's phone see it read-only; the
 * owner changes it with their PIN, as on #cameras. Every change is one `vision.settings_set`, with Undo.
 */

const MODES: { mode: VisionMode; label: string; hint: string }[] = [
  { mode: 'off', label: 'Off', hint: 'The cameras are not used.' },
  { mode: 'shadow', label: 'Shadow', hint: 'The cameras watch and learn; the floor changes only when staff set it.' },
  { mode: 'live', label: 'Live', hint: 'The cameras set the floor: occupied, needs cleaning.' },
];
const LOOK_MS = 1000;
/** The CPU slider records once the owner stops moving it. */
const SETTLE_MS = 700;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const clock = (t: number) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const busy = (s: CvStatus | null) => s?.phase === 'downloading' || s?.phase === 'verifying';

/** The shop's history, with this device's own settings changes shown at once (before the server or demo has them). */
function useVisionEvents(): { events: SyncEvent[] | undefined; at: number } {
  const data = useShopEvents();
  const [local, setLocal] = useState(readAll);
  useEffect(() => subscribeEvents(() => setLocal(readAll())), []);
  const remote = data.state === 'ready' ? data.events : data.state === 'error' ? data.events : undefined;
  const events = useMemo(() => {
    if (!remote) return undefined;
    const known = new Set(remote.map((e) => e.id));
    const mine = local.filter((e) => e.type === 'vision.settings_set' && !known.has(e.id));
    return mine.length ? [...remote, ...mine] : remote;
  }, [remote, local]);
  return { events, at: (data.state === 'loading' ? undefined : data.at) ?? Date.now() };
}

const dayLine = (d: TableDay | undefined) => {
  if (!d?.seated) return 'Nobody seated today';
  return [`${d.seated} seated`, d.visitMin !== null && `${d.visitMin} min a visit`, d.waitMin !== null && `cleaned in ${d.waitMin} min`].filter(Boolean).join(' · ');
};

export default function VisionView({ onRegister, phone = false, focusLive = false }: {
  onRegister?: () => void;
  /** The owner's phone (cloud site): read only, no links to the counter's screens. */
  phone?: boolean;
  /** From the Shadow week card: Live is picked, Enter switches. */
  focusLive?: boolean;
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

  const [pin, setPin] = useState<string | null>(null);
  /** A change waiting for the owner's PIN, or for the CV pack. */
  const [asking, setAsking] = useState<Partial<VisionSettings> | null>(null);
  const [waiting, setWaiting] = useState<Partial<VisionSettings> | null>(null);
  const [cv, setCv] = useState<CvStatus | null>(null);
  const [undo, setUndo] = useState<{ to: VisionSettings; said: string } | null>(null);
  const [error, setError] = useState('');

  const save = useCallback(async (p: string, patch: Partial<VisionSettings>, said: string) => {
    if (!settings) return;
    const before = settings;
    await client.save(p, { ...settings, ...patch });
    setUndo({ to: before, said });
  }, [client, settings]);

  /** One change: the PIN first if it is not known yet; the CV pack before Shadow or Live, with its progress. */
  const run = useCallback(async (p: string, patch: Partial<VisionSettings>) => {
    setError('');
    const said = patch.mode ? `${MODES.find((m) => m.mode === patch.mode)!.label} on.` : `CPU limit ${patch.cpuLimit}%.`;
    try {
      if (patch.mode && patch.mode !== 'off') {
        let st = await client.status(p);
        if (st.phase === 'idle' || st.phase === 'failed') st = await client.activate(p);
        setCv(st);
        if (st.phase !== 'ready') { setWaiting(patch); return; }
      }
      setWaiting(null);
      await save(p, patch, said);
    } catch (e) { setError(message(e)); }
  }, [client, save]);

  const change = (patch: Partial<VisionSettings>) => {
    if (!canChange || !settings) return;
    if (patch.mode === settings.mode && patch.cpuLimit === undefined) return;
    if (patch.mode === 'live' && blocked) return;
    if (client.needsPin && !pin) { setAsking(patch); return; }
    void run(pin ?? '', patch);
  };

  const unlock = async (typed: string) => {
    setError('');
    try {
      await client.status(typed); // the shop server checks it is the owner's PIN
      setPin(typed);
      const patch = asking;
      setAsking(null);
      if (patch) await run(typed, patch);
    } catch (e) { setError(message(e)); }
  };

  // The CV pack is on its way: look again each second, then make the change it was waiting for.
  useEffect(() => {
    if (!waiting || !busy(cv)) return;
    const t = setTimeout(() => {
      client.status(pin ?? '').then((st) => {
        setCv(st);
        if (st.phase === 'ready') void run(pin ?? '', waiting);
      }, (e: unknown) => setError(message(e)));
    }, LOOK_MS);
    return () => clearTimeout(t);
  }, [waiting, cv, client, pin, run]);

  const undoIt = async () => {
    if (!undo) return;
    setError('');
    try { await client.save(pin ?? '', undo.to); setUndo(null); } catch (e) { setError(message(e)); }
  };

  // ----- the switch: arrows move, Enter (or a tap) chooses -----
  const modes = useRef<HTMLDivElement>(null);
  const [focusMode, setFocusMode] = useState<number>(focusLive ? 2 : -1);
  const current = settings ? MODES.findIndex((m) => m.mode === settings.mode) : 0;
  const tab = focusMode >= 0 ? focusMode : current;
  const loaded = settings !== undefined;
  useEffect(() => {
    if (focusLive && loaded) (modes.current?.children[2] as HTMLElement | undefined)?.focus();
  }, [focusLive, loaded]);
  const onModeKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -1, ArrowDown: 1 }[e.key];
    if (step === undefined) return;
    e.preventDefault();
    const next = (tab + step + MODES.length) % MODES.length;
    setFocusMode(next);
    (modes.current?.children[next] as HTMLElement | undefined)?.focus();
  };

  // ----- the CPU limit: the slider settles, then one event -----
  const [cpuDraft, setCpuDraft] = useState<number | null>(null);
  const commitCpu = useRef((_: number) => {});
  commitCpu.current = (value) => { if (value !== settings?.cpuLimit) change({ cpuLimit: value }); setCpuDraft(null); };
  useEffect(() => {
    if (cpuDraft === null) return;
    const t = setTimeout(() => commitCpu.current(cpuDraft), SETTLE_MS);
    return () => clearTimeout(t);
  }, [cpuDraft]);

  // ----- the tables: arrows pick one, its "why" shows below -----
  const grid = useRef<HTMLDivElement>(null);
  const [picked, setPicked] = useState(0);
  const pick = Math.min(picked, Math.max(0, tables.length - 1));
  const table = tables[pick];
  const onGridKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns(grid.current), ArrowDown: columns(grid.current) }[e.key];
    if (step === undefined) return;
    e.preventDefault();
    const next = Math.min(tables.length - 1, Math.max(0, pick + step));
    setPicked(next);
    (grid.current?.children[next] as HTMLElement | undefined)?.focus();
  };

  const head = phone ? (
    <header className="owner__head">
      <button type="button" className="shops__back" onClick={() => { location.hash = ''; }}>Today</button>
      <span className="brand">CheesyBeez</span>
    </header>
  ) : <OwnerNav current="vision" onRegister={onRegister} />;

  if (!events || !settings) {
    return (
      <div className="setup">
        {head}
        <main className="setup__main vision" aria-label="Computer vision" aria-busy="true">
          <h1>Computer vision</h1>
          <div className="skeleton vision__skeleton" aria-hidden="true" />
        </main>
      </div>
    );
  }

  const live = MODES[2];
  let line;
  if (asking) {
    line = (
      <PinLine
        what={asking.mode ? `switch to ${MODES.find((m) => m.mode === asking.mode)!.label}` : `set the CPU limit to ${asking.cpuLimit}%`}
        onPin={(p) => void unlock(p)} onCancel={() => { setAsking(null); setError(''); }} />
    );
  } else if (waiting && busy(cv)) line = <CvProgress status={cv!} />;
  else if (waiting && cv?.phase === 'failed') {
    line = (
      <p className="setup__error cv__failed" role="alert">
        <span>Activating CV did not work: {cv.reason}.</span>
        <button type="button" className="chip chip--solid" onClick={() => void run(pin ?? '', waiting)}>Retry</button>
      </p>
    );
  } else if (undo) {
    line = (
      <p className="vision__line" role="status">
        <span>{undo.said}</span>
        <button type="button" className="chip chip--solid" onClick={() => void undoIt()}>Undo</button>
      </p>
    );
  } else {
    line = <p className="vision__line setup__hint" role="status">{focusLive && settings.mode !== 'live' && canChange && !blocked ? 'Enter switches to Live.' : MODES[current].hint}</p>;
  }

  return (
    <div className="setup">
      {head}
      <main className="setup__main vision" aria-label="Computer vision">
        <header className="vision__head">
          <h1>Computer vision</h1>
          <div ref={modes} className="vision__modes" role="radiogroup" aria-label="Computer vision mode" onKeyDown={onModeKey}
            aria-describedby={!canChange ? 'vision-locked' : undefined}>
            {MODES.map((m, i) => {
              const off = !canChange || (m === live && blocked !== null);
              return (
                <button key={m.mode} type="button" role="radio" aria-checked={settings.mode === m.mode} tabIndex={i === tab ? 0 : -1}
                  aria-disabled={off || undefined} aria-describedby={m === live && blocked ? 'vision-live-why' : undefined}
                  className="vision__mode" onFocus={() => setFocusMode(i)} onClick={() => !off && change({ mode: m.mode })}>
                  {m.label}
                </button>
              );
            })}
          </div>
        </header>
        {!canChange && <p id="vision-locked" className="setup__hint">{lockedWhy}</p>}
        {blocked && (
          <p id="vision-live-why" className="vision__line vision__note">
            <span>Live: {blocked}</span>
            {!phone && <a href="#cameras" className="vision__link">Set up zones</a>}
          </p>
        )}
        {line}
        {error && <p className="setup__error" role="alert">{error}</p>}

        {CameraViews && !phone && (canChange
          ? <Suspense fallback={<div className="skeleton vision__skeleton" aria-hidden="true" />}>
            <CameraViews cameras={vision?.cameras ?? []} pin={pin} onPin={setPin} />
          </Suspense>
          : (
            <section className="vision__part" aria-labelledby="vision-views">
              <h2 id="vision-views">Camera views</h2>
              <p className="setup__hint">Only the owner watches the cameras, on the shop PC.</p>
            </section>
          ))}

        <section className="vision__part" aria-labelledby="vision-tables">
          <h2 id="vision-tables">Tables now</h2>
          {tables.length ? <>
            <div ref={grid} className="floor__grid vision__grid" role="listbox" aria-label="Tables by number" onKeyDown={onGridKey}>
              {tables.map((t, i) => (
                <FloorTile key={t.id} t={t} now={now} selected={i === pick} onPick={() => setPicked(i)}>
                  <span className="vision__day">{dayLine(days.get(t.id))}</span>
                </FloorTile>
              ))}
            </div>
            {table && <p className="vision__why" aria-live="polite"><b>Table {table.label}</b> {whyState(table, events, settings)}</p>}
          </> : <p className="setup__hint">No tables yet.{!phone && <> <a href="#cameras" className="vision__link">Set up tables</a></>}</p>}
        </section>

        <section className="vision__part" aria-labelledby="vision-cameras">
          <h2 id="vision-cameras">Cameras</h2>
          {!health ? <p className="setup__hint">No camera data yet.</p> : (
            <ul className="vision__cams">
              {health.cameras.map((c) => (
                <li key={c.id} className={`vision__cam${c.online ? '' : ' vision__cam--off'}`}>
                  <b>{c.name}</b>
                  <span>{c.online ? 'Online' : 'Offline'}</span>
                  <span className="num">{c.fps === null ? '–' : `${c.fps} fps`}</span>
                  <span className="num">{c.lastSeen === null ? 'not seen yet' : `seen ${clock(c.lastSeen)}`}</span>
                </li>
              ))}
            </ul>
          )}
          <label className="vision__cpu">
            <span>CPU limit <b className="num">{cpuDraft ?? settings.cpuLimit}%</b>
              {health?.cpu != null && <span className="setup__hint"> · using {health.cpu}% now</span>}</span>
            <input type="range" min={MIN_CPU_LIMIT} max={MAX_CPU_LIMIT} step={CPU_LIMIT_STEP} value={cpuDraft ?? settings.cpuLimit}
              disabled={!canChange} aria-valuetext={`${cpuDraft ?? settings.cpuLimit}% of the shop PC`}
              onChange={(e) => setCpuDraft(Number(e.target.value))} />
          </label>
          <p className="setup__hint">How much of the shop PC the cameras may use. More reads more frames; the counter comes first.</p>
        </section>
      </main>
    </div>
  );
}
