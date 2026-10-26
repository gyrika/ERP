import type { SyncEvent } from '../domain/sync.ts';
import type { TableSpec, VisionSettings, ZoneSpec } from '../domain/tables.ts';
import { FAKE_CV_STATUS, FAKE_SHOP_ID, FAKE_STAFF } from '../fake/data.ts';
import { addEvents } from '../ui/eventLog.ts';
import { isDemo } from '../ui/storage.ts';
import {
  cameraClient, SetupFailed, setupClient, type CameraAsk, type CameraDraft, type CameraLogins, type CameraTest, type CvStatus,
} from './setupClient.ts';

/**
 * The Computer vision page's calls (#vision, SCRUM-174), its side panel's setup included (cameras,
 * tables, zones, timers: once #cameras). On the shop PC they go to the shop server with the
 * owner's PIN: it checks the PIN and records the owner's events (server/setup.ts). The demo has
 * no shop server: the pack is there and every change is recorded in this browser as the demo owner.
 */
/** TEMPORARY: camera id -> the test video's name, playing in place of that camera's stream. */
export type TestVideos = Record<string, string>;

export interface VisionClient {
  /** The owner's PIN is asked before the first change. */
  needsPin: boolean;
  status(pin: string): Promise<CvStatus>;
  activate(pin: string): Promise<CvStatus>;
  /** Records the settings; returns the event, already in this device's log. */
  save(pin: string, s: VisionSettings): Promise<SyncEvent[]>;
  /** Which cameras have a login kept (never the password). */
  logins(pin: string): Promise<CameraLogins>;
  scan(pin: string): Promise<{ ip: string; name: string }[]>;
  test(pin: string, c: { cameraId?: string; ip: string; rtspPath: string; user?: string; password?: string }): Promise<CameraTest>;
  ask(pin: string, c: { cameraId?: string; ip: string; user?: string; password?: string }): Promise<CameraAsk>;
  /** The whole camera list (the shop server keeps it as one event). */
  saveCameras(pin: string, cameras: CameraDraft[]): Promise<CameraLogins>;
  saveTables(pin: string, tables: TableSpec[]): Promise<void>;
  saveZones(pin: string, cameraId: string, zones: ZoneSpec[]): Promise<void>;
  /** TEMPORARY test videos (owner, 2026-10-27). */
  testVideos(pin: string): Promise<TestVideos>;
  uploadTestVideo(pin: string, cameraId: string, file: File, onProgress: (share: number) => void): Promise<TestVideos>;
  stopTestVideo(pin: string, cameraId: string): Promise<TestVideos>;
}

/** The upload itself, with its progress (fetch cannot tell it). */
const upload = (pin: string, cameraId: string, file: File, onProgress: (share: number) => void): Promise<TestVideos> =>
  new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/v1/setup/cv/test-video/upload?cameraId=${encodeURIComponent(cameraId)}&name=${encodeURIComponent(file.name)}`);
    xhr.setRequestHeader('x-owner-pin', pin);
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      let data: { testVideos?: TestVideos; message?: string } = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* not JSON: said below */ }
      if (xhr.status === 200 && data.testVideos) resolve(data.testVideos);
      else reject(new SetupFailed(data.message ?? `The shop server said ${xhr.status}.`));
    };
    xhr.onerror = () => reject(new SetupFailed('The video did not reach the shop server: is it running?'));
    xhr.send(file);
  });

const post = async <T>(step: string, body: unknown): Promise<T> => {
  const r = await fetch(`/api/v1/setup${step}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000),
  });
  const data = (await r.json().catch(() => ({}))) as T & { message?: string };
  if (!r.ok) throw new SetupFailed(data.message ?? `The shop server said ${r.status}.`);
  return data;
};

const shopServer: VisionClient = {
  needsPin: true,
  status: (pin) => setupClient.cvStatus(pin),
  activate: (pin) => setupClient.cvActivate(pin),
  async save(pin, s) {
    const { events } = await cameraClient.saveSettings(pin, s);
    addEvents(events);
    return events;
  },
  logins: async (pin) => (await cameraClient.setup(pin)).logins,
  scan: async (pin) => (await cameraClient.scan(pin)).found,
  test: (pin, c) => cameraClient.test(pin, c),
  ask: (pin, c) => cameraClient.ask(pin, c),
  async saveCameras(pin, cameras) {
    const r = await cameraClient.saveCameras(pin, cameras);
    addEvents(r.events);
    return r.logins;
  },
  async saveTables(pin, tables) { addEvents((await cameraClient.saveTables(pin, tables)).events); },
  async saveZones(pin, cameraId, zones) { addEvents((await cameraClient.saveZones(pin, cameraId, zones)).events); },
  testVideos: async (pin) => (await post<{ testVideos: TestVideos }>('/cv/test-video', { ownerPin: pin })).testVideos,
  uploadTestVideo: upload,
  stopTestVideo: async (pin, cameraId) => (await post<{ testVideos: TestVideos }>('/cv/test-video/stop', { ownerPin: pin, cameraId })).testVideos,
};

// ----- the demo: no shop server; the owner's changes are this browser's events -----

const demoOwner = () => FAKE_STAFF.find((f) => f.actor.role === 'owner')!.actor;
const record = (fields: Record<string, unknown> & { type: string }): SyncEvent[] => {
  const event = { id: crypto.randomUUID(), shopId: FAKE_SHOP_ID, at: Date.now(), actor: demoOwner(), orderNumber: 0, ...fields } as unknown as SyncEvent;
  addEvents([event]);
  return [event];
};
/** A picture to draw zones on: the demo's test picture, made where the views make it. */
const DEMO_JPEG = '/9j/2Q==';
const demoLogins: CameraLogins = {};
/**
 * TEMPORARY: the demo plays a test video in this browser (no shop server, so no detection):
 * camera id -> its name and a blob URL the views show instead of the test picture.
 */
export const demoVideos = new Map<string, { name: string; url: string }>();
const demoVideoState = (): TestVideos => Object.fromEntries([...demoVideos].map(([id, v]) => [id, v.name]));

const demo: VisionClient = {
  needsPin: false,
  status: async () => FAKE_CV_STATUS,
  activate: async () => FAKE_CV_STATUS,
  save: async (_pin, s) => record({ type: 'vision.settings_set', ...s }),
  logins: async () => demoLogins,
  scan: async () => [{ ip: '192.168.1.40', name: 'TP-IPC C200' }],
  test: async () => ({ ok: true, jpeg: DEMO_JPEG }),
  ask: async () => ({ ok: true, streams: [{ path: '/stream2', label: 'Lens 1', width: 640, height: 360 }] }),
  async saveCameras(_pin, cameras) {
    for (const c of cameras) if (c.user) demoLogins[c.id] = { user: c.user, passwordSet: Boolean(c.password) || Boolean(demoLogins[c.id]?.passwordSet) };
    record({ type: 'vision.cameras_set', cameras: cameras.map(({ id, name, ip, rtspPath, enabled }) => ({ id, name, ip, rtspPath, enabled })) });
    return demoLogins;
  },
  async saveTables(_pin, tables) { record({ type: 'table.layout_set', tables }); },
  async saveZones(_pin, cameraId, zones) { record({ type: 'vision.zones_set', cameraId, zones }); },
  testVideos: async () => demoVideoState(),
  async uploadTestVideo(_pin, cameraId, file, onProgress) {
    const before = demoVideos.get(cameraId);
    if (before) URL.revokeObjectURL(before.url);
    demoVideos.set(cameraId, { name: file.name, url: URL.createObjectURL(file) });
    onProgress(1);
    return demoVideoState();
  },
  async stopTestVideo(_pin, cameraId) {
    const v = demoVideos.get(cameraId);
    if (v) URL.revokeObjectURL(v.url);
    demoVideos.delete(cameraId);
    return demoVideoState();
  },
};

export const visionClient = (): VisionClient => (isDemo() ? demo : shopServer);
