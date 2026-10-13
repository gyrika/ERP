import type { IncomingMessage } from 'node:http';
import { randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import type { Role } from '../src/domain/auth.ts';
import { isPin } from './pins.ts';
import { dryRunPrinter, listPrinters, systemPrinter, type RawPrinter } from './printer.ts';
import type { Settings } from './settings.ts';
import { PinTaken, type EventStore, type StaffMember } from './store.ts';
import type { UpdatesApi } from './updates.ts';

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
  fetch?: typeof fetch;
  now?: () => number;
}

export interface SetupState {
  done: boolean;
  shop: { id: string; name: string; place: string } | null;
  printer: string | null;
  printers: string[];
  cloud: boolean;
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

const ROLES: Role[] = ['cashier', 'manager', 'owner', 'kitchen'];
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
  const authorise = async (ownerPin: unknown): Promise<void> => {
    if (!ctx.settings.get().setupDone) return;
    if (wrong.until > now()) throw new SetupError(429, 'too_many', 'too many wrong PINs: wait a moment');
    const s = shop();
    const who = s && isPin(ownerPin) ? await ctx.store.staffByPin(s.id, ownerPin) : null;
    if (!who || who.role !== 'owner') {
      wrong.count += 1;
      if (wrong.count >= 5) { wrong.count = 0; wrong.until = now() + 30_000; }
      throw new SetupError(401, 'wrong_pin', "that is not the owner's PIN");
    }
    wrong.count = 0;
  };

  const choosePrinter = (name: string | null) => {
    ctx.usePrinter(name ? systemPrinter(name) : dryRunPrinter(ctx.printsDir));
    ctx.settings.set({ printer: name ?? undefined });
  };

  return {
    choosePrinter,

    async state(): Promise<SetupState> {
      const s = ctx.settings.get();
      const current = shop();
      return {
        done: Boolean(s.setupDone),
        shop: current,
        printer: s.printer ?? null,
        printers: await listPrinters(),
        cloud: ctx.cloud() !== null,
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
      if (!ROLES.includes(body.role as Role)) throw new SetupError(400, 'invalid', 'pick a role');
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
     */
    async pair(body: { kind?: unknown; ownerPin?: unknown }) {
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
      throw new SetupError(400, 'invalid', 'kind must be kitchen, owner or counter');
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

    /** Shop setup → Updates: the installed version and GitHub's latest. */
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
