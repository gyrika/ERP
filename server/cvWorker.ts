import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants, setPriority } from 'node:os';
import { fileURLToPath } from 'node:url';
import { mayRecord, type Actor } from '../src/domain/auth.ts';
import { rtspUrl } from '../src/domain/cameraSetup.ts';
import { PULL_LIMIT, type SyncEvent } from '../src/domain/sync.ts';
import { MAX_CAMERAS, tablesFromEvents, visionFromEvents } from '../src/domain/tables.ts';
import type { FromWorker, Heartbeat, Seen, ToWorker, VisionFields, WorkerConfig } from './cv/messages.ts';
import { HEARTBEAT_KEEP_MS, restartDelay, STABLE_MS } from './cv/visionCore.ts';
import { cvLog } from './cvLog.ts';
import type { CameraLogin } from './cvSecrets.ts';
import type { Settings } from './settings.ts';
import type { Device, EventStore } from './store.ts';
import { validatePush } from './validate.ts';

/**
 * The camera worker (SCRUM-170), from the shop server's side. While CV is in Shadow or Live and the
 * CV pack is there, the server runs server/cv/worker.ts as a child process: the same node.exe, at
 * below-normal priority, Node IPC both ways (no HTTP, no files between them). The worker never
 * touches storage: it sends what the cameras saw; the server stamps it with the `vision` actor,
 * checks it like a push (shape, and that vision may record it) and stores it through `ingest`, so
 * it streams to the shop's screens and copies to the cloud like any event. Devices still cannot
 * push `vision` events (app.ts `refusal`).
 *
 * Exit: started again after 1 s, doubling to 60 s. Off, no pack (or a new one on its way): stopped.
 */
const WORKER = fileURLToPath(new URL('./cv/worker.ts', import.meta.url));
/** The actor on every camera event: the cloud wants a non-empty id and name. */
export const VISION_ACTOR: Actor = { id: 'vision', name: 'Cameras', role: 'vision' };
/** A worker asked to stop that has not gone in this long is killed. */
const STOP_MS = 2000;
/** The large view polls several times a second; nobody asked for this long: it was closed (as cvLive's IDLE_MS). */
export const WATCH_MS = 8_000;

/** What the worker needs from the shop's events: null while it should not run. */
export const workerConfig = (
  events: readonly SyncEvent[], packDir: string | null, login: (cameraId: string) => CameraLogin | null,
  /** Development cameras (CV_DEV_CAMERAS): a file instead of the stream. */
  dev: ReadonlyMap<string, string> = new Map(),
): WorkerConfig | null => {
  const v = visionFromEvents(events);
  if (v.settings.mode === 'off' || !packDir) return null;
  const cameras = v.cameras.filter((c) => c.enabled).slice(0, MAX_CAMERAS).map((c) => {
    const file = dev.get(c.id);
    if (file) return { id: c.id, url: file, zones: v.zones[c.id] ?? [] };
    const l = login(c.id);
    return { id: c.id, url: rtspUrl({ ip: c.ip, rtspPath: c.rtspPath, user: l?.user, password: l?.password }), zones: v.zones[c.id] ?? [] };
  });
  if (!cameras.length) return null;
  const floor = Object.fromEntries(tablesFromEvents(events).map((t) => [t.id, { state: t.state, since: t.since, alertId: t.alertId }]));
  const { mode, shortVisitS, leftCheckS, autoFreeS, cpuLimit } = v.settings;
  return { packDir, mode, shortVisitS, leftCheckS, autoFreeS, cpuLimit, cameras, floor, offline: [...v.offline] };
};

/** A worker message's fields as a whole event, or why it is refused. */
export const stampEvent = (
  fields: VisionFields | ({ type: 'vision.heartbeat' } & Partial<Heartbeat>), at: number, shopId: string, id: string = randomUUID(),
): { event: SyncEvent } | { reason: string } => {
  const event = { id, shopId, at, orderNumber: 0, actor: VISION_ACTOR, ...fields } as unknown as SyncEvent;
  if (!mayRecord('vision', event.type)) return { reason: `the cameras may not record ${event.type}` };
  const checked = validatePush({ events: [event] }, shopId);
  return 'reason' in checked ? { reason: checked.reason } : { event };
};

/** Heartbeats come every 30 s; the shop keeps one per 5 minutes, and any that says a camera or the pace changed. */
export const keepHeartbeat = (kept: { at: number; beat: Heartbeat } | null, beat: Heartbeat, now: number): boolean => {
  if (!kept || now - kept.at >= HEARTBEAT_KEEP_MS || kept.beat.slowed !== beat.slowed) return true;
  const was = new Map(kept.beat.cameras.map((c) => [c.id, c.online]));
  return beat.cameras.length !== was.size || beat.cameras.some((c) => was.get(c.id) !== c.online);
};

/** The child process: start, restart with backoff, send it the config, stop. */
export function workerProcess(o: {
  script?: string;
  env?: Record<string, string>;
  onMessage: (m: FromWorker) => void;
  log: (text: string) => void;
  backoff?: (failures: number) => number;
}) {
  const backoff = o.backoff ?? restartDelay;
  let child: ChildProcess | null = null;
  let wanted: WorkerConfig | null = null;
  let ready = false;
  let sent = '';
  let failures = 0;
  let startedAt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const send = (m: ToWorker) => { try { child?.send(m); } catch { /* exiting: it gets the config when it is back */ } };
  const sendConfig = () => {
    const key = JSON.stringify(wanted);
    if (!child || !ready || !wanted || key === sent) return;
    sent = key;
    send({ type: 'config', config: wanted });
  };

  const launch = () => {
    timer = null;
    if (!wanted || child) return;
    const c = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', o.script ?? WORKER], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true, env: { ...process.env, ...o.env },
    });
    child = c;
    ready = false;
    sent = '';
    startedAt = Date.now();
    // The Register comes first: the worker (and the ffmpegs it starts, which inherit it) runs below normal.
    try { if (c.pid) setPriority(c.pid, constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* gone already */ }
    let err = '';
    c.stderr?.on('data', (d: Buffer) => { err = (err + d.toString('utf8')).slice(-2000); });
    c.on('message', (m: FromWorker) => {
      if (m?.type === 'ready') { ready = true; sendConfig(); }
      o.onMessage(m);
    });
    c.on('error', (e) => o.log(`worker could not start: ${e.message}`));
    c.on('exit', (code) => {
      if (child !== c) return;
      child = null;
      ready = false;
      if (!wanted) return;
      failures = Date.now() - startedAt >= STABLE_MS ? 0 : failures;
      const wait = backoff(failures++);
      o.log(`worker stopped (exit ${code ?? 'killed'})${err.trim() ? `: ${err.trim().split('\n').at(-1)}` : ''}; again in ${Math.round(wait / 100) / 10} s`);
      timer = setTimeout(launch, wait);
    });
  };

  const halt = (): Promise<void> => {
    if (timer) { clearTimeout(timer); timer = null; }
    const c = child;
    child = null;
    if (!c || c.exitCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      const kill = setTimeout(() => { try { c.kill(); } catch { /* gone */ } }, STOP_MS);
      c.once('exit', () => { clearTimeout(kill); resolve(); });
      try { c.send({ type: 'stop' } satisfies ToWorker); } catch { c.kill(); }
    });
  };

  return {
    /** What the worker should be doing now; null stops it (Off, no pack). */
    set(config: WorkerConfig | null) {
      if (!config) {
        if (wanted) o.log('stopped');
        wanted = null;
        failures = 0;
        void halt();
        return;
      }
      if (!wanted) o.log(`starting (${config.mode}, ${config.cameras.length} camera${config.cameras.length === 1 ? '' : 's'})`);
      wanted = config;
      if (!child && !timer) launch();
      else sendConfig();
    },
    /** A message for the running worker (dropped while it restarts). */
    send: (m: ToWorker) => { if (ready) send(m); },
    running: () => child !== null,
    pid: () => child?.pid ?? null,
    /** The server stops. */
    stop: () => { wanted = null; return halt(); },
  };
}

/** The shop server's side, wired to the store, the settings, the CV pack and the camera logins. */
export function startVision(o: {
  store: EventStore;
  settings: Settings;
  /** The CV pack folder; null while CV is not activated, or a new pack is on its way. */
  packDir: () => string | null;
  login: (cameraId: string) => CameraLogin | null;
  /** Development cameras (CV_DEV_CAMERAS): camera id -> a looping video or image file. */
  dev?: ReadonlyMap<string, string>;
  /** Stores events and streams them, as a push would (app.ts `ingest`). */
  ingest: (device: Device, events: SyncEvent[]) => Promise<number>;
  /** <data>\logs: cv.log is written here. */
  logDir: string;
  script?: string;
  /** How often the pack and the shop are looked at again. */
  checkMs?: number;
  /** The large view's detections expire after this long without a poll. */
  watchMs?: number;
  now?: () => number;
}) {
  const now = o.now ?? Date.now;
  const log = cvLog({ dir: o.logDir, now });
  /** The shop's table and vision events: all the worker's config is folded from. */
  let shop: string | null = null;
  let history: Promise<SyncEvent[]> | null = null;
  let kept: { at: number; beat: Heartbeat } | null = null;
  let writes: Promise<unknown> = Promise.resolve();
  let stopped = false;
  /** The camera the owner watches large (SCRUM-175) and its latest detections: memory only, while it is watched. */
  let watching: { cameraId: string; until: number; told: number; seen: Seen | null } | null = null;
  const watchMs = o.watchMs ?? WATCH_MS;
  const unwatch = () => { if (watching) { watching = null; worker.send({ type: 'watch', cameraId: null }); } };

  const ours = (e: SyncEvent) => e.type.startsWith('table.') || e.type.startsWith('vision.');
  const load = async (tenantId: string): Promise<SyncEvent[]> => {
    const out: SyncEvent[] = [];
    for (let after = 0;;) {
      const rows = await o.store.pull(tenantId, after, PULL_LIMIT);
      out.push(...rows.map((r) => r.event).filter(ours));
      if (rows.length < PULL_LIMIT) return out;
      after = rows[rows.length - 1].seq;
    }
  };
  const device = async (tenantId: string): Promise<Device> => {
    const id = o.settings.get().cvWorkerDevice;
    if (id) return { id, tenantId, kind: 'owner' };
    const { device: d } = await o.store.addDevice(tenantId, 'Camera worker', 'owner');
    o.settings.set({ cvWorkerDevice: d.id });
    return d;
  };

  const store = (fields: Parameters<typeof stampEvent>[0], at: number) => {
    const tenantId = shop;
    if (!tenantId) return;
    const r = stampEvent(fields, at, tenantId);
    if ('reason' in r) { log.write(`refused ${fields.type}: ${r.reason}`); return; }
    writes = writes.then(async () => { await o.ingest(await device(tenantId), [r.event]); })
      .catch((e: unknown) => log.write(`could not store ${fields.type}: ${e instanceof Error ? e.message : String(e)}`));
  };

  const worker = workerProcess({
    script: o.script,
    log: (text) => log.write(text),
    onMessage(m) {
      if (m.type === 'log') log.write(`worker: ${m.text}`);
      else if (m.type === 'seen') {
        if (watching?.cameraId === m.cameraId) watching.seen = { at: m.at, detectedAt: m.detectedAt, persons: m.persons };
      }
      else if (m.type === 'event') store(m.fields, m.at);
      else if (m.type === 'heartbeat') {
        const beat: Heartbeat = { cameras: m.cameras, cpu: m.cpu, slowed: m.slowed };
        if (!keepHeartbeat(kept, beat, m.at)) return;
        kept = { at: m.at, beat };
        store({ type: 'vision.heartbeat', cameras: beat.cameras, cpu: beat.cpu, ...(beat.slowed ? { slowed: true } : {}) }, m.at);
      }
    },
  });

  /** Looks again at the shop, the pack and the events: starts, reconfigures or stops the worker. */
  const refresh = async () => {
    if (stopped) return;
    const s = o.settings.get();
    const tenantId = s.setupDone && s.shopId ? s.shopId : null;
    if (tenantId !== shop) { shop = tenantId; history = tenantId ? load(tenantId) : null; }
    const events = history ? await history.catch(() => { history = null; return null; }) : null;
    if (stopped) return;
    worker.set(events ? workerConfig(events, o.packDir(), o.login, o.dev) : null);
    if (watching && now() > watching.until) unwatch();
  };
  let checking: Promise<void> = Promise.resolve();
  const check = () => { checking = checking.then(refresh).catch((e: unknown) => log.write(`check failed: ${e instanceof Error ? e.message : String(e)}`)); };
  const timer = setInterval(check, o.checkMs ?? 5000);
  timer.unref?.();
  check();

  return {
    /** New events were stored for a shop: the worker hears of a new mode, camera, zone or floor at once. */
    onStored(tenantId: string, events: readonly SyncEvent[]) {
      if (tenantId !== shop || !history || !events.some(ours)) return;
      const h = history;
      history = h.then((log) => {
        const known = new Set(log.map((e) => e.id));
        return [...log, ...events.filter((e) => ours(e) && !known.has(e.id))];
      });
      check();
    },
    /**
     * The owner's large view asks for a frame (null: it closed). The worker sends each check's
     * people for this camera until no poll came for WATCH_MS. Told again now and then, in case
     * the worker restarted.
     */
    watch(cameraId: string | null) {
      if (!cameraId) { unwatch(); return; }
      const t = now();
      if (watching?.cameraId !== cameraId) watching = { cameraId, until: 0, told: 0, seen: null };
      watching.until = t + watchMs;
      if (t - watching.told >= 2000) { watching.told = t; worker.send({ type: 'watch', cameraId }); }
    },
    /** The latest detections on the watched camera, or null. */
    seen(cameraId: string): Seen | null {
      if (watching && now() > watching.until) unwatch();
      return watching?.cameraId === cameraId ? watching.seen : null;
    },
    running: () => worker.running(),
    async stop() {
      stopped = true;
      clearInterval(timer);
      await worker.stop();
      await writes;
    },
  };
}
export type Vision = ReturnType<typeof startVision>;
