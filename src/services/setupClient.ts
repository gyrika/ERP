import type { Role } from '../domain/auth.ts';
import type { SyncEvent } from '../domain/sync.ts';
import type { TableSpec, VisionMode, ZoneSpec } from '../domain/tables.ts';

/**
 * The setup wizard's calls to the shop server (server/setup.ts). They work only
 * on the shop PC itself. After setup, changes carry the owner's PIN.
 */
export interface StaffRow { id: string; name: string; role: Role; active: boolean }
export interface SetupState {
  done: boolean;
  shop: { id: string; name: string; place: string } | null;
  printer: string | null;
  printers: string[];
  cloud: boolean;
  /** The CV pack, without a PIN: #vision asks it before showing Activate. */
  cv?: CvStatus | null;
  staff?: StaffRow[];
}

/** The CV pack on the shop server (server/cvPack.ts). */
export type CvStatus = { active: boolean } & (
  | { phase: 'idle' }
  | { phase: 'downloading'; bytes: number; total: number | null }
  | { phase: 'verifying' }
  | { phase: 'ready'; version: string }
  | { phase: 'failed'; reason: string });

export class SetupFailed extends Error {}

const call = async <T>(step: string, body?: unknown): Promise<T> => {
  const r = await fetch(`/api/v1/setup${step}`, body === undefined ? { signal: AbortSignal.timeout(15_000) } : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000),
  });
  const data = (await r.json().catch(() => ({}))) as T & { message?: string };
  if (!r.ok) throw new SetupFailed(data.message ?? `The shop server said ${r.status}.`);
  return data;
};

export const setupClient = {
  state: () => call<SetupState>(''),
  nameShop: (name: string, place: string) => call<{ shopId: string; counterToken?: string }>('/shop', { name, place }),
  setPrinter: (name: string | null, ownerPin?: string) => call<{ printer: string | null }>('/printer', { name, ownerPin }),
  staff: (ownerPin?: string) => call<{ staff: StaffRow[] }>('/staff/list', { ownerPin }),
  addStaff: (name: string, role: Role, pin: string, ownerPin?: string) => call<{ staff: StaffRow[] }>('/staff', { name, role, pin, ownerPin }),
  removeStaff: (id: string, ownerPin?: string) => call<{ staff: StaffRow[] }>('/staff/remove', { id, ownerPin }),
  pair: (kind: 'kitchen' | 'manager' | 'owner', ownerPin?: string, staffId?: string) => call<{ link: string }>('/pair', { kind, ownerPin, staffId }),
  pairCounter: (ownerPin: string) => call<{ counterToken: string; shopId: string }>('/pair', { kind: 'counter', ownerPin }),
  connectCloud: (code: string, ownerPin?: string) => call<{ cloud: boolean }>('/cloud', { code, ownerPin }),
  finish: () => call<{ done: boolean }>('/finish', {}),
  checkUpdate: (ownerPin?: string) => call<{ current: string; latest: string | null; newer: boolean }>('/update/check', { ownerPin }),
  installUpdate: (ownerPin?: string) => call<{ started: boolean; from: string }>('/update/install', { ownerPin }),
  updateStatus: (ownerPin?: string) =>
    call<{ status: { phase: string; percent: number; version: string; at: number } | null }>('/update/status', { ownerPin }),
  cvStatus: (ownerPin: string) => call<CvStatus>('/cv/status', { ownerPin }),
  cvActivate: (ownerPin: string) => call<CvStatus>('/cv/activate', { ownerPin }),
};

/** #cameras (SCRUM-171): what the shop server keeps of each camera's login — never the password. */
export type CameraLogins = Record<string, { user: string; passwordSet: boolean }>;
/** A camera to save: where it is, and its login when typed (the password only when changed). */
/** `loginFrom`: a second lens of a dual-lens camera shares that camera's kept login. */
export interface CameraDraft { id: string; name: string; ip: string; rtspPath: string; enabled: boolean; user?: string; password?: string; loginFrom?: string }
export type CameraTest = { ok: true; jpeg: string } | { ok: false; cause: 'login' | 'rtsp' | 'path' | 'pack' | 'other'; message: string };

/** Ask the camera (ONVIF, SCRUM-180): one stream path per lens. */
export type CameraAsk = { ok: true; streams: { path: string; label: string; width: number; height: number }[] } | { ok: false; cause: string; message: string };

export const cameraClient = {
  setup: (ownerPin: string) => call<{ logins: CameraLogins; packReady: boolean }>('/cv/setup', { ownerPin }),
  scan: (ownerPin: string) => call<{ found: { ip: string; name: string }[] }>('/cv/scan', { ownerPin }),
  test: (ownerPin: string, c: { cameraId?: string; ip: string; rtspPath: string; user?: string; password?: string }) =>
    call<CameraTest>('/cv/test', { ownerPin, ...c }),
  ask: (ownerPin: string, c: { cameraId?: string; ip: string; user?: string; password?: string }) => call<CameraAsk>('/cv/ask', { ownerPin, ...c }),
  saveCameras: (ownerPin: string, cameras: CameraDraft[]) => call<{ events: SyncEvent[]; logins: CameraLogins }>('/cv/cameras', { ownerPin, cameras }),
  saveTables: (ownerPin: string, tables: TableSpec[]) => call<{ events: SyncEvent[] }>('/cv/tables', { ownerPin, tables }),
  saveZones: (ownerPin: string, cameraId: string, zones: ZoneSpec[]) => call<{ events: SyncEvent[] }>('/cv/zones', { ownerPin, cameraId, zones }),
  saveSettings: (ownerPin: string, mode: VisionMode) => call<{ events: SyncEvent[] }>('/cv/settings', { ownerPin, mode }),
};
