import { isStaffRole, managesRole, mayRecord } from '../src/domain/auth.ts';
import { createWriteStream, mkdirSync, rmSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { extname, join } from 'node:path';
import { networkInterfaces } from 'node:os';
import type { Actor, Role } from '../src/domain/auth.ts';
import { PULL_LIMIT, type SyncEvent } from '../src/domain/sync.ts';
import type { CameraSpec } from '../src/domain/tables.ts';
import { CAUSE_TEXT, hostPort } from '../src/domain/cameraSetup.ts';
import { discover as scanLan, snapshot as takeSnapshot, type FoundCamera } from './cvCameras.ts';
import { liveViews, type LiveViews, type ViewMode } from './cvLive.ts';
import { askCamera as askOnvif } from './onvif.ts';
import type { CvSecrets } from './cvSecrets.ts';
import { validatePush } from './validate.ts';
import { isPin } from './pins.ts';
import { dryRunPrinter, listPrinters, systemPrinter, type RawPrinter } from './printer.ts';
import type { Settings } from './settings.ts';
import { PinTaken, type Device, type EventStore, type StaffMember } from './store.ts';
import type { UpdatesApi } from './updates.ts';
import type { CvPackApi } from './cvPack.ts';
import type { Perf, Seen } from './cv/messages.ts';

/**
 * The setup wizard's side of the server: the shop, the printer, the staff and
 * pairing devices (QR codes). It answers ONLY the shop PC itself (localhost):
 * a tablet on the Wi-Fi, or anyone else, cannot set up or change the shop.
 * While the shop is new, the PC alone is enough; once set up, every change
 * also needs the owner's PIN.
 */
export interface SetupContext {
  store: EventStore;
  settings: Settings;
  usePrinter: (p: RawPrinter) => void;
  printsDir: string;
  port: number;
  /** The cloud copy as it stands now (null: not connected), for owner-phone links. */
  cloud: () => { url: string; token: string } | null;
  /** Where a new shop registers itself with the shop code. */
  cloudUrl: string;
  /** The wizard connected the cloud: start copying, no restart. */
  onCloudConnected?: () => void;
  /** CheesyBeez Station's versions ("Update now"). */
  updates?: UpdatesApi;
  /** The CV pack (server/cvPack.ts), off until the owner activates it on #vision. */
  cv?: CvPackApi;
  /** The cameras' logins (server/cvSecrets.ts), in the data folder. */
  secrets?: CvSecrets;
  /** Stores events and streams them to the shop's devices, as a push would (app.ts `ingest`). */
  ingest?: (device: Device, events: SyncEvent[]) => Promise<number>;
  /** Scan and Test (server/cvCameras.ts); tests give fakes. */
  discover?: () => Promise<FoundCamera[]>;
  snapshot?: typeof takeSnapshot;
  /** Ask the camera (server/onvif.ts) and the camera views (server/cvLive.ts); tests give fakes. */
  askCamera?: typeof askOnvif;
  views?: (source: Parameters<typeof liveViews>[0]['source'], ffmpeg: () => string | null) => LiveViews;
  /**
   * What the camera worker's detection sees (SCRUM-175, server/cvWorker.ts): the large view watches
   * one camera (null: none) and its answer carries the latest people boxes. Memory only.
   */
  detections?: { watch: (cameraId: string | null) => void; seen: (cameraId: string) => Seen | null; perf?: () => ({ at: number } & Perf) | null };
  /**
   * Development cameras (CV_DEV_CAMERAS): camera id -> a looping file the views show instead of the
   * stream. A test video (below) changes it while the server runs; the worker reads the same map.
   */
  dev?: Map<string, string>;
  /**
   * TEMPORARY (owner, 2026-10-27): a test video in place of a camera's stream, from #vision's camera
   * panel. Uploads are kept in `dir` until Stop or the next start; `onChange` tells the worker.
   */
  testVideos?: { dir: string; onChange: () => void };
  fetch?: typeof fetch;
  now?: () => number;
}

export interface SetupState {
  done: boolean;
  shop: { id: string; name: string; place: string } | null;
  printer: string | null;
  printers: string[];
  cloud: boolean;
  /** Computer vision's pack (idle until the owner activates it): #vision shows Activate, its progress, then the switch. */
  cv: ReturnType<CvPackApi['status']> | null;
  /** Only while the shop is new; afterwards the staff list needs the owner's PIN. */
  staff?: StaffMember[];
}

export class SetupError extends Error {
  status: number;
  code: 'forbidden' | 'wrong_pin' | 'too_many' | 'invalid' | 'not_ready';
  constructor(status: number, code: SetupError['code'], message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const LOCAL = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
export const isLocal = (req: IncomingMessage): boolean => LOCAL.has(req.socket.remoteAddress ?? '');

/** "CheesyBeez", "Thalwila" -> "cheesybeez-thalwila". */
export const shopIdFor = (name: string, place: string): string =>
  `${name} ${place}`.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'shop';

/** The address a tablet on the shop's Wi-Fi uses to reach this PC. */
const lanAddress = (): string | null =>
  Object.values(networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal)?.address ?? null;

export function setupApi(ctx: SetupContext) {
  const now = ctx.now ?? Date.now;
  const http = ctx.fetch ?? fetch;
  const wrong = { count: 0, until: 0 };

  const shop = () => {
    const s = ctx.settings.get();
    return s.shopId ? { id: s.shopId, name: s.shopName ?? s.shopId, place: s.place ?? '' } : null;
  };
  const requireShop = () => {
    const s = shop();
    if (!s) throw new SetupError(409, 'not_ready', 'name the shop first');
    return s;
  };

  /** Before setup is done, the PC itself is enough; after, the owner's PIN too. */
  const authorise = async (ownerPin: unknown): Promise<StaffMember | null> => {
    if (!ctx.settings.get().setupDone) return null;
    if (wrong.until > now()) throw new SetupError(429, 'too_many', 'too many wrong PINs: wait a moment');
    const s = shop();
    const who = s && isPin(ownerPin) ? await ctx.store.staffByPin(s.id, ownerPin) : null;
    if (!who || who.role !== 'owner') {
      wrong.count += 1;
      if (wrong.count >= 5) { wrong.count = 0; wrong.until = now() + 30_000; }
      throw new SetupError(401, 'wrong_pin', "that is not the owner's PIN");
    }
    wrong.count = 0;
    return who;
  };

  // ----- #cameras: cameras, tables, zones and the vision settings (SCRUM-171) -----

  /** The owner, by PIN: the actor on every camera-setup event. */
  const owner = async (ownerPin: unknown): Promise<Actor> => {
    const who = await authorise(ownerPin);
    if (!who) throw new SetupError(409, 'not_ready', 'finish the shop setup first');
    return { id: who.id, name: who.name, role: who.role };
  };
  /** The local device the owner's camera setup is filed under: made the first time. */
  const setupDevice = async (shopId: string): Promise<Device> => {
    const id = ctx.settings.get().cvSetupDevice;
    if (id) return { id, tenantId: shopId, kind: 'owner' };
    const { device } = await ctx.store.addDevice(shopId, 'Cameras setup', 'owner');
    ctx.settings.set({ cvSetupDevice: device.id });
    return device;
  };
  /** One owner event, checked as a push would be, then stored and streamed. Returned for the screen. */
  const record = async (actor: Actor, fields: Record<string, unknown> & { type: string }): Promise<SyncEvent[]> => {
    if (!ctx.ingest) throw new SetupError(409, 'not_ready', 'no event store here');
    const s = requireShop();
    const event = { id: randomUUID(), shopId: s.id, at: now(), actor, orderNumber: 0, ...fields } as unknown as SyncEvent;
    const checked = validatePush({ events: [event] }, s.id);
    if ('reason' in checked) throw new SetupError(400, 'invalid', checked.reason);
    if (!mayRecord(actor.role, event.type)) throw new SetupError(403, 'forbidden', 'only the owner sets up the cameras');
    await ctx.ingest(await setupDevice(s.id), [event]);
    return [event];
  };

  // ----- #vision's Camera views (SCRUM-180) -----

  /** The camera list as the shop's events say, read once and then only what is new. */
  const known = { after: 0, cameras: [] as CameraSpec[] };
  const camerasNow = async (): Promise<CameraSpec[]> => {
    const s = requireShop();
    for (;;) {
      const rows = await ctx.store.pull(s.id, known.after, PULL_LIMIT);
      for (const r of rows) if (r.event.type === 'vision.cameras_set') known.cameras = r.event.cameras;
      if (rows.length) known.after = rows[rows.length - 1].seq;
      if (rows.length < PULL_LIMIT) return known.cameras;
    }
  };
  const packFfmpeg = () => { const pack = ctx.cv?.packDir(); return pack ? join(pack, 'ffmpeg.exe') : null; };
  const viewSource = async (id: string) => {
    const cam = (await camerasNow()).find((c) => c.id === id);
    if (!cam) return null;
    const login = ctx.secrets?.get(id);
    return { ip: cam.ip, rtspPath: cam.rtspPath, user: login?.user, password: login?.password, ...(ctx.dev?.has(id) ? { file: ctx.dev.get(id) } : {}) };
  };
  const views = (ctx.views ?? ((source, ffmpeg) => liveViews({ source, ffmpeg })))(viewSource, packFfmpeg);
  /** Who may watch: a random key the owner's PIN opened, alive while it is used. Never the PIN in every poll. */
  const VIEW_KEY_MS = 10 * 60_000;
  const viewKeys = new Map<string, number>();
  const watching = (key: unknown) => {
    const t = now();
    for (const [k, until] of viewKeys) if (until < t) viewKeys.delete(k);
    if (typeof key !== 'string' || !viewKeys.has(key)) throw new SetupError(401, 'wrong_pin', "the owner's PIN is needed again");
    viewKeys.set(key, t + VIEW_KEY_MS);
  };
  /** Where Scan found each camera's ONVIF service, for Ask the camera. */
  const onvifAt = new Map<string, string>();
  const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  /** Where a camera is: never its login, which stays in `secrets`. */
  const cameraOf = (c: Record<string, unknown>) => ({
    id: text(c.id, 64), name: text(c.name, 60), ip: text(c.ip, 253), rtspPath: text(c.rtspPath, 200), enabled: c.enabled === true,
  });

  // ----- TEMPORARY: a test video in place of a camera's stream (owner, 2026-10-27) -----

  /** What CV_DEV_CAMERAS set, put back when a test stops. */
  const fromEnv = new Map(ctx.dev ?? []);
  /** Camera id -> the video's name, for the screen. */
  const testing = new Map<string, string>();
  // A test ends with the server: the last run's uploads go.
  if (ctx.testVideos) rmSync(ctx.testVideos.dir, { recursive: true, force: true });
  const testState = () => ({ testVideos: Object.fromEntries(testing) });
  const testCamera = async (cameraId: unknown): Promise<string> => {
    if (!ctx.testVideos || !ctx.dev) throw new SetupError(409, 'not_ready', 'test videos are not on here');
    const id = typeof cameraId === 'string' ? cameraId : '';
    if (!(await camerasNow()).some((c) => c.id === id)) throw new SetupError(404, 'invalid', 'save the camera first');
    return id;
  };
  const fileFor = (id: string, ext: string) => join(ctx.testVideos!.dir, `${id.replace(/[^\w-]/g, '_')}${ext}`);
  const stopTest = (id: string) => {
    const file = ctx.dev!.get(id);
    if (testing.has(id) && file) rmSync(file, { force: true });
    testing.delete(id);
    if (fromEnv.has(id)) ctx.dev!.set(id, fromEnv.get(id)!); else ctx.dev!.delete(id);
  };
  const testChanged = () => { views.stop(); ctx.testVideos!.onChange(); };

  const choosePrinter = (name: string | null) => {
    ctx.usePrinter(name ? systemPrinter(name) : dryRunPrinter(ctx.printsDir));
    ctx.settings.set({ printer: name ?? undefined });
  };

  return {
    choosePrinter,
    /** The server stops: no ffmpeg is left watching a camera. */
    stopViews: () => views.stop(),

    async state(): Promise<SetupState> {
      const s = ctx.settings.get();
      const current = shop();
      return {
        done: Boolean(s.setupDone),
        shop: current,
        printer: s.printer ?? null,
        printers: await listPrinters(),
        cloud: ctx.cloud() !== null,
        cv: ctx.cv?.status() ?? null,
        ...(!s.setupDone && current ? { staff: await ctx.store.listStaff(current.id) } : {}),
      };
    },

    /** Step 1: name the shop. The first time, this PC also becomes the counter (its token comes back once). */
    async nameShop(body: { name?: unknown; place?: unknown }) {
      if (ctx.settings.get().setupDone) throw new SetupError(409, 'invalid', 'the shop is already set up');
      const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : '';
      const place = typeof body.place === 'string' ? body.place.trim().slice(0, 80) : '';
      if (!name) throw new SetupError(400, 'invalid', 'the shop needs a name');
      const existing = shop();
      // A short random ending: two shops (or a test install) with the same name never mix in the cloud.
      const id = existing?.id ?? `${shopIdFor(name, place)}-${randomBytes(3).toString('hex').slice(0, 4)}`;
      ctx.settings.set({ shopId: id, shopName: name, place });
      if (existing) return { shopId: id };
      const { token } = await ctx.store.addDevice(id, `${name} ${place}`.trim(), 'counter');
      return { shopId: id, counterToken: token };
    },

    async setPrinter(body: { name?: unknown; ownerPin?: unknown }) {
      await authorise(body.ownerPin);
      const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : null;
      if (name && !(await listPrinters()).includes(name)) throw new SetupError(400, 'invalid', `no printer called ${name}`);
      choosePrinter(name);
      return { printer: name };
    },

    async staff(body: { ownerPin?: unknown }) {
      await authorise(body.ownerPin);
      return { staff: await ctx.store.listStaff(requireShop().id) };
    },

    async addStaff(body: { name?: unknown; role?: unknown; pin?: unknown; ownerPin?: unknown }) {
      await authorise(body.ownerPin);
      const s = requireShop();
      const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : '';
      if (!name) throw new SetupError(400, 'invalid', 'a name is needed');
      if (!isStaffRole(body.role)) throw new SetupError(400, 'invalid', 'pick a role');
      if (!isPin(body.pin)) throw new SetupError(400, 'invalid', 'the PIN must be 4 digits');
      try {
        await ctx.store.addStaff(s.id, name, body.role as Role, body.pin);
      } catch (e) {
        if (e instanceof PinTaken) throw new SetupError(409, 'invalid', 'someone already has that PIN: choose another');
        throw e;
      }
      return { staff: await ctx.store.listStaff(s.id) };
    },

    async removeStaff(body: { id?: unknown; ownerPin?: unknown }) {
      await authorise(body.ownerPin);
      const s = requireShop();
      const list = await ctx.store.listStaff(s.id);
      const target = list.find((m) => m.id === body.id && m.active);
      if (!target) throw new SetupError(404, 'invalid', 'no such person');
      if (target.role === 'owner' && list.filter((m) => m.active && m.role === 'owner').length === 1) {
        throw new SetupError(409, 'invalid', 'the shop needs at least one owner');
      }
      await ctx.store.deactivateStaff(s.id, target.id);
      return { staff: await ctx.store.listStaff(s.id) };
    },

    /**
     * A QR code's link. kitchen: a tablet on the shop Wi-Fi becomes the Kitchen screen.
     * owner: a phone gets the Owner view from the cloud. counter: another screen on this PC.
     * manager: a manager's phone app from the cloud, made for one person (SCRUM-94).
     */
    async pair(body: { kind?: unknown; ownerPin?: unknown; staffId?: unknown }) {
      await authorise(body.ownerPin);
      const s = requireShop();
      if (body.kind === 'owner') {
        const cloud = ctx.cloud();
        if (!cloud) throw new SetupError(409, 'not_ready', 'connect the cloud copy first');
        const r = await http(`${cloud.url}/api/v1/devices`, {
          method: 'POST', headers: { authorization: `Bearer ${cloud.token}`, 'content-type': 'application/json' },
          body: '{}', signal: AbortSignal.timeout(15_000),
        });
        if (!r.ok) throw new SetupError(502, 'not_ready', 'the cloud did not answer: is the internet up?');
        const { token } = (await r.json()) as { token: string };
        return { link: `${cloud.url}/?owner=${token}#owner` };
      }
      if (body.kind === 'manager') {
        const cloud = ctx.cloud();
        if (!cloud) throw new SetupError(409, 'not_ready', 'connect the cloud copy first');
        const person = (await ctx.store.listStaff(s.id)).find((m) => m.id === body.staffId && m.active);
        if (!person || !managesRole(person.role)) throw new SetupError(400, 'invalid', 'pick a manager or an owner');
        const r = await http(`${cloud.url}/api/v1/devices`, {
          method: 'POST', headers: { authorization: `Bearer ${cloud.token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ kind: 'manager', actor: { id: person.id, name: person.name, role: person.role } }),
          signal: AbortSignal.timeout(15_000),
        });
        if (!r.ok) throw new SetupError(502, 'not_ready', 'the cloud did not answer: is the internet up?');
        const { token } = (await r.json()) as { token: string };
        return { link: `${cloud.url}/?manager=${token}#manager` };
      }
      if (body.kind === 'kitchen') {
        const host = lanAddress();
        if (!host) throw new SetupError(409, 'not_ready', 'this PC is not on a network: connect it to the shop Wi-Fi');
        const { token } = await ctx.store.addDevice(s.id, s.name, 'kitchen');
        return { link: `http://${host}:${ctx.port}/?pair=${token}&shop=${encodeURIComponent(s.id)}&as=kitchen#kitchen` };
      }
      if (body.kind === 'counter') {
        const { token } = await ctx.store.addDevice(s.id, s.name, 'counter');
        return { counterToken: token, shopId: s.id };
      }
      throw new SetupError(400, 'invalid', 'kind must be kitchen, manager, owner or counter');
    },

    /**
     * The cloud copy, with the shop code the developer gave: this shop server registers
     * itself, keeps its key, and starts copying sales straight away.
     */
    async connectCloud(body: { code?: unknown; ownerPin?: unknown }) {
      await authorise(body.ownerPin);
      const s = requireShop();
      if (typeof body.code !== 'string' || !body.code.trim()) throw new SetupError(400, 'invalid', 'type the shop code');
      // Made once and kept before asking, so a lost answer can simply be tried again.
      const secret = ctx.settings.get().cloudSecret ?? ctx.settings.set({ cloudSecret: randomBytes(32).toString('base64url') }).cloudSecret!;
      let r: Response;
      try {
        r = await http(`${ctx.cloudUrl}/api/v1/enrol`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ code: body.code, shopId: s.id, name: `${s.name} ${s.place}`.trim(), secret }),
          signal: AbortSignal.timeout(20_000),
        });
      } catch {
        throw new SetupError(502, 'not_ready', 'the cloud did not answer: is the internet up?');
      }
      if (r.status === 403) throw new SetupError(403, 'invalid', 'that shop code is not right');
      if (r.status === 409) throw new SetupError(409, 'invalid', 'this shop is already connected to the cloud from another computer');
      if (!r.ok) throw new SetupError(502, 'not_ready', 'the cloud did not answer: try again in a minute');
      const { token } = (await r.json()) as { token: string };
      ctx.settings.set({ cloudUrl: ctx.cloudUrl, cloudToken: token });
      ctx.onCloudConnected?.();
      return { cloud: true };
    },

    /** Shop setup â†’ Updates: the installed version and GitHub's latest. */
    async checkUpdate(body: { ownerPin?: unknown }) {
      await authorise(body.ownerPin);
      if (!ctx.updates) throw new SetupError(409, 'not_ready', 'no updates here');
      try { return await ctx.updates.check(); }
      catch { throw new SetupError(502, 'not_ready', 'GitHub did not answer: is the internet up?'); }
    },

    /** "Update now": the owner asked, so it runs even during service (the nightly one waits). */
    /** The progress bar: the updater's latest step (null when it has not said anything yet). */
    async updateStatus(body: { ownerPin?: unknown }) {
      await authorise(body.ownerPin);
      return { status: ctx.updates?.status() ?? null };
    },

    async installUpdate(body: { ownerPin?: unknown }) {
      await authorise(body.ownerPin);
      if (!ctx.updates) throw new SetupError(409, 'not_ready', 'no updates here');
      try { ctx.updates.install(); } catch (e) { throw new SetupError(409, 'not_ready', e instanceof Error ? e.message : String(e)); }
      return { started: true, from: ctx.updates.current() };
    },

    /** #cameras: where the CV pack is (idle, downloading, verifying, ready, failed). */
    async cvStatus(body: { ownerPin?: unknown }) {
      await authorise(body.ownerPin);
      if (!ctx.cv) throw new SetupError(409, 'not_ready', 'no CV here');
      return ctx.cv.status();
    },

    /** "Activate CV", and Retry: the pack downloads in the background; the screen asks cvStatus as it goes. */
    async cvActivate(body: { ownerPin?: unknown }) {
      await authorise(body.ownerPin);
      if (!ctx.cv) throw new SetupError(409, 'not_ready', 'no CV here');
      return ctx.cv.activate();
    },

    /** #cameras opens: which cameras have a login kept (never the password), and whether Test can run. */
    async cvSetup(body: { ownerPin?: unknown }) {
      await owner(body.ownerPin);
      return { logins: ctx.secrets?.summary() ?? {}, packReady: Boolean(ctx.cv?.packDir()) };
    },

    /** Scan: the ONVIF cameras on the shop's network. */
    async cvScan(body: { ownerPin?: unknown }) {
      await owner(body.ownerPin);
      const found = await (ctx.discover ?? scanLan)();
      for (const f of found) if (f.xaddr) onvifAt.set(f.ip, f.xaddr);
      return { found: found.map(({ ip, name }) => ({ ip, name })) };
    },

    /**
     * Ask the camera (ONVIF): one stream path per lens, from the camera itself. Takes the login
     * typed now, or else the one kept for this camera; the password never leaves this server.
     */
    async cvAsk(body: { ownerPin?: unknown; cameraId?: unknown; ip?: unknown; user?: unknown; password?: unknown }) {
      await owner(body.ownerPin);
      // ONVIF answers on the camera's own address; a port typed for the stream (":8080") is not its.
      const ip = hostPort(text(body.ip, 253)).host;
      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) throw new SetupError(400, 'invalid', 'type the camera’s IP address');
      const kept = typeof body.cameraId === 'string' ? ctx.secrets?.get(body.cameraId) : null;
      const user = typeof body.user === 'string' && body.user ? body.user.slice(0, 80) : kept?.user ?? '';
      const password = typeof body.password === 'string' && body.password ? body.password.slice(0, 200) : kept?.password ?? '';
      return (ctx.askCamera ?? askOnvif)({ ip, login: { user, password }, xaddr: onvifAt.get(ip), fetch: ctx.fetch });
    },

    /** Camera views: the owner's PIN opens a key the screen polls with; nothing runs yet. */
    async cvViewsOpen(body: { ownerPin?: unknown }) {
      await owner(body.ownerPin);
      const key = randomBytes(24).toString('hex');
      viewKeys.set(key, now() + VIEW_KEY_MS);
      return { key, packReady: Boolean(packFfmpeg()) };
    },

    /** One view's latest frame (base64 JPEG, from memory) or why there is none. Starts its ffmpeg if needed. */
    async cvViewsFrame(body: { key?: unknown; cameraId?: unknown; mode?: unknown; after?: unknown; use?: unknown }) {
      watching(body.key);
      if (typeof body.cameraId !== 'string') throw new SetupError(400, 'invalid', 'which camera?');
      const mode: ViewMode = body.mode === 'live' ? 'live' : 'tile';
      const after = typeof body.after === 'number' && Number.isSafeInteger(body.after) ? body.after : 0;
      // The large view also shows what detection sees there (SCRUM-175); tiles stop it.
      ctx.detections?.watch(mode === 'live' ? body.cameraId : null);
      const f = await views.frame(body.cameraId, { mode, after, use: body.use === true });
      if (f.state !== 'frame') return f;
      const seen = mode === 'live' ? ctx.detections?.seen(body.cameraId) ?? null : null;
      return { state: 'frame', seq: f.seq, at: f.at, jpeg: f.jpeg.toString('base64'), ...(seen ? { seen } : {}) };
    },

    /**
     * #vision's Performance, every couple of seconds while the owner watches: the camera worker's
     * numbers now (null while it does not run) and the views' ffmpegs. Memory only, never stored.
     */
    async cvViewsPerf(body: { key?: unknown }) {
      watching(body.key);
      return { perf: ctx.detections?.perf?.() ?? null, views: views.running().length };
    },

    /** The page was left: every view stops now. */
    async cvViewsClose(body: { key?: unknown }) {
      if (typeof body.key === 'string') viewKeys.delete(body.key);
      if (!viewKeys.size) { views.stop(); ctx.detections?.watch(null); }
      return { closed: true };
    },

    /**
     * Test: one frame from the camera, as a JPEG shown on screen and never saved. Takes the
     * password typed now, or else the one kept for this camera.
     */
    async cvTest(body: { ownerPin?: unknown; cameraId?: unknown; ip?: unknown; rtspPath?: unknown; user?: unknown; password?: unknown }) {
      await owner(body.ownerPin);
      const cam = cameraOf({ ...body, id: 'test', name: 'test' });
      const probe = { id: 't', type: 'vision.cameras_set', shopId: 's', at: 0, orderNumber: 0, actor: { id: 'o', name: 'o', role: 'owner' }, cameras: [cam] };
      if ('reason' in validatePush({ events: [probe] }, 's')) throw new SetupError(400, 'invalid', 'type the cameraâ€™s IP address and stream path');
      const pack = ctx.cv?.packDir();
      if (!pack) return { ok: false, cause: 'pack', message: CAUSE_TEXT.pack };
      const kept = typeof body.cameraId === 'string' ? ctx.secrets?.get(body.cameraId) : null;
      const user = typeof body.user === 'string' && body.user ? body.user : kept?.user;
      const password = typeof body.password === 'string' && body.password ? body.password : kept?.password;
      const r = await (ctx.snapshot ?? takeSnapshot)({ ffmpeg: join(pack, 'ffmpeg.exe'), camera: { ip: cam.ip, rtspPath: cam.rtspPath, user, password } });
      return r.ok ? { ok: true, jpeg: r.jpeg.toString('base64') } : r;
    },

    /**
     * TEMPORARY: a video file, streamed from the request to the data folder (never all in memory),
     * plays in place of this camera's stream for the views and the worker until Stop.
     */
    async cvTestVideoUpload(req: IncomingMessage, q: { ownerPin?: unknown; cameraId?: unknown; name?: unknown }) {
      await owner(q.ownerPin);
      const id = await testCamera(q.cameraId);
      const name = text(q.name, 120);
      const ext = extname(name).toLowerCase();
      if (!TEST_VIDEO_TYPES.includes(ext)) throw new SetupError(400, 'invalid', `pick a video (${TEST_VIDEO_TYPES.join(' ')})`);
      const tooBig = () => new SetupError(413, 'invalid', `the video is over ${TEST_VIDEO_MAX_BYTES / 1024 / 1024} MB: pick a shorter one`);
      if (Number(req.headers['content-length'] ?? 0) > TEST_VIDEO_MAX_BYTES) throw tooBig();
      stopTest(id);
      mkdirSync(ctx.testVideos!.dir, { recursive: true });
      const file = fileFor(id, ext);
      let size = 0;
      const count = new Transform({
        transform(chunk: Buffer, _enc, done) {
          size += chunk.length;
          done(size > TEST_VIDEO_MAX_BYTES ? tooBig() : null, chunk);
        },
      });
      try { await pipeline(req, count, createWriteStream(file)); } catch (e) {
        rmSync(file, { force: true });
        throw e instanceof SetupError ? e : new SetupError(400, 'invalid', 'the video did not arrive whole: try again');
      }
      if (!size) { rmSync(file, { force: true }); throw new SetupError(400, 'invalid', 'the video is empty'); }
      ctx.dev!.set(id, file);
      testing.set(id, name);
      testChanged();
      return testState();
    },

    /** TEMPORARY: the camera goes back to its own stream. */
    async cvTestVideoStop(body: { ownerPin?: unknown; cameraId?: unknown }) {
      await owner(body.ownerPin);
      stopTest(await testCamera(body.cameraId));
      testChanged();
      return testState();
    },

    /** TEMPORARY: which cameras play a test video now. */
    async cvTestVideos(body: { ownerPin?: unknown }) {
      await owner(body.ownerPin);
      return testState();
    },

    /** The camera list: where each one is (an event) and its login (kept here, encrypted). */
    async cvCameras(body: { ownerPin?: unknown; cameras?: unknown }) {
      const actor = await owner(body.ownerPin);
      if (!Array.isArray(body.cameras)) throw new SetupError(400, 'invalid', 'no cameras');
      const list = body.cameras.filter((c): c is Record<string, unknown> => typeof c === 'object' && c !== null);
      const events = await record(actor, { type: 'vision.cameras_set', cameras: list.map(cameraOf) });
      if (ctx.secrets) {
        for (const c of list) {
          const user = text(c.user, 80);
          const password = typeof c.password === 'string' && c.password ? c.password.slice(0, 200) : undefined;
          // A second lens of a dual-lens camera shares the first one's login (SCRUM-180).
          const twin = typeof c.loginFrom === 'string' && !password ? ctx.secrets.get(text(c.loginFrom, 64)) : null;
          if (twin && (!user || user === twin.user)) ctx.secrets.set(text(c.id, 64), twin);
          else if (user || password) ctx.secrets.set(text(c.id, 64), { user, password });
        }
        ctx.secrets.keepOnly(list.map((c) => text(c.id, 64)));
      }
      views.stop(); // where a view points, or its login, may have changed
      return { events, logins: ctx.secrets?.summary() ?? {} };
    },

    async cvTables(body: { ownerPin?: unknown; tables?: unknown }) {
      const actor = await owner(body.ownerPin);
      return { events: await record(actor, { type: 'table.layout_set', tables: body.tables }) };
    },

    async cvZones(body: { ownerPin?: unknown; cameraId?: unknown; zones?: unknown }) {
      const actor = await owner(body.ownerPin);
      return { events: await record(actor, { type: 'vision.zones_set', cameraId: body.cameraId, zones: body.zones }) };
    },

    /** The owner's table timers (SCRUM-182: shortVisitS, leftCheckS, autoFreeS), mode and CPU limit; `checkTableEvent` checks them. */
    async cvSettings(body: { ownerPin?: unknown; mode?: unknown; shortVisitS?: unknown; leftCheckS?: unknown; autoFreeS?: unknown; cpuLimit?: unknown }) {
      const actor = await owner(body.ownerPin);
      return { events: await record(actor, {
        type: 'vision.settings_set', mode: body.mode, shortVisitS: body.shortVisitS, leftCheckS: body.leftCheckS, autoFreeS: body.autoFreeS,
        ...(body.cpuLimit === undefined ? {} : { cpuLimit: body.cpuLimit }),
      }) };
    },

    /** Last step: there must be an owner, or nobody could ever change the shop again. */
    async finish() {
      const s = requireShop();
      if (!(await ctx.store.listStaff(s.id)).some((m) => m.active && m.role === 'owner')) {
        throw new SetupError(409, 'invalid', 'add the owner first');
      }
      ctx.settings.set({ setupDone: true });
      return { done: true };
    },
  };
}
export type SetupApi = ReturnType<typeof setupApi>;

/** TEMPORARY test videos: what may be picked, and how big. */
export const TEST_VIDEO_TYPES = ['.mp4', '.mov', '.m4v', '.avi', '.mkv', '.webm'];
export const TEST_VIDEO_MAX_BYTES = 200 * 1024 * 1024;
