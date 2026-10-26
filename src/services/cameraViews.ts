import type { Seen } from '../domain/tables.ts';

/** How the camera worker is doing now (server/cv/messages.ts `Perf`), and how many views run: memory only. */
export interface ViewsPerf {
  perf: {
    at: number; cpu: number; cpuLimit: number; slowed: boolean;
    cameras: { id: string; online: boolean; fps: number; checksPerS: number; detectMs: number | null }[];
  } | null;
  views: number;
}
import { FAKE_DETECTIONS } from '../fake/data.ts';
import { isDemo } from '../ui/storage.ts';

/**
 * Camera views on #vision (SCRUM-180). On the shop PC: the owner's PIN opens a key, then each view
 * is polled for its latest frame; the shop server runs ffmpeg only while it is asked
 * (server/cvLive.ts). The picture is a data URL in this screen's memory, never stored. The large
 * view's answer also carries what detection sees there, when the camera worker runs (SCRUM-175).
 * The demo has no shop server: it draws a test picture per camera, and its back camera is offline.
 */
export type ViewMode = 'tile' | 'live';
export type ViewFrame =
  | { state: 'frame'; seq: number; at: number; src: string; seen?: Seen }
  | { state: 'starting' | 'busy' | 'paused' | 'pack' | 'unknown' }
  | { state: 'offline'; message: string };

export interface CameraViewsClient {
  needsPin: boolean;
  open(pin: string): Promise<{ key: string; packReady: boolean }>;
  frame(key: string, cameraId: string, q: { mode: ViewMode; after: number; use: boolean }): Promise<ViewFrame>;
  /** The page was left: every view stops. Also works while the page unloads. */
  close(key: string): void;
  /** #vision's Performance, polled while the owner watches. */
  perf(key: string): Promise<ViewsPerf>;
}

class ViewsFailed extends Error {}

const post = async <T>(step: string, body: unknown): Promise<T> => {
  const r = await fetch(`/api/v1/setup${step}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
  });
  const data = (await r.json().catch(() => ({}))) as T & { message?: string };
  if (!r.ok) throw new ViewsFailed(data.message ?? `The shop server said ${r.status}.`);
  return data;
};

const shopServer: CameraViewsClient = {
  needsPin: true,
  open: (pin) => post('/cv/views/open', { ownerPin: pin }),
  async frame(key, cameraId, q) {
    const f = await post<{ state: string; seq?: number; at?: number; jpeg?: string; message?: string; seen?: Seen }>('/cv/views/frame', { key, cameraId, ...q });
    if (f.state === 'frame') return { state: 'frame', seq: f.seq!, at: f.at!, src: `data:image/jpeg;base64,${f.jpeg}`, ...(f.seen ? { seen: f.seen } : {}) };
    if (f.state === 'offline') return { state: 'offline', message: f.message ?? '' };
    return { state: f.state as Exclude<ViewFrame['state'], 'frame' | 'offline'> };
  },
  perf: (key) => post<ViewsPerf>('/cv/views/perf', { key }),
  close(key) {
    const body = JSON.stringify({ key });
    if (!navigator.sendBeacon?.('/api/v1/setup/cv/views/close', new Blob([body], { type: 'application/json' }))) {
      void fetch('/api/v1/setup/cv/views/close', { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true }).catch(() => {});
    }
  },
};

const DEMO_OFFLINE = new Set(['demo-cam-back']);
const HUES = [205, 150, 30, 280, 0, 95];
let demoSeq = 0;

/** A test picture: colour bars, the camera's name and the time, so the demo shows it is live. */
export const testPicture = (cameraId: string, name: string, at: number, mode: ViewMode): string => {
  const hue = HUES[[...cameraId].reduce((a, c) => a + c.charCodeAt(0), 0) % HUES.length];
  const bars = Array.from({ length: 7 }, (_, i) => `<rect x="${i * 92}" y="0" width="92" height="250" fill="hsl(${(hue + i * 40) % 360} 45% ${30 + i * 6}%)"/>`).join('');
  const time = new Date(at).toLocaleTimeString('en-GB');
  const x = 40 + ((at / (mode === 'live' ? 40 : 400)) % 560);
  const esc = (s: string) => s.replace(/[<&>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360"><rect width="640" height="360" fill="#111"/>${bars}`
    + `<circle cx="${x.toFixed(0)}" cy="300" r="18" fill="#fff" opacity="0.85"/>`
    + `<text x="24" y="342" font-family="DM Sans, sans-serif" font-size="22" fill="#fff">${esc(name)} · test picture · ${time}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
};

const demo = (names: () => Map<string, string>): CameraViewsClient => ({
  needsPin: false,
  open: async () => ({ key: 'demo', packReady: true }),
  async frame(_key, cameraId, q) {
    if (DEMO_OFFLINE.has(cameraId)) return { state: 'offline', message: 'The camera did not answer: check the IP address, and turn RTSP on in the camera’s app.' };
    if (q.mode === 'live') await new Promise((r) => setTimeout(r, 250)); // 4 frames a second, as the shop's
    const at = Date.now();
    const src = testPicture(cameraId, names().get(cameraId) ?? cameraId, at, q.mode);
    const persons = q.mode === 'live' ? FAKE_DETECTIONS[cameraId] : undefined;
    // Detected afresh every 12 s; in between the motion gate reuses it, so "last checked" grows.
    return { state: 'frame', seq: ++demoSeq, at, src, ...(persons ? { seen: { at, detectedAt: at - (at % 12_000), persons } } : {}) };
  },
  close: () => {},
  // The demo: the front camera works (5 fps, a check a second), the back one is offline; numbers wobble so it reads live.
  async perf() {
    const w = (n: number, by: number) => Math.round((n + (Math.random() - 0.5) * by) * 10) / 10;
    return { views: 2, perf: { at: Date.now(), cpu: Math.round(w(11, 4)), cpuLimit: 15, slowed: false, cameras: [
      { id: 'demo-cam-front', online: true, fps: w(5, 0.4), checksPerS: 1, detectMs: Math.round(w(42, 10)) },
      { id: 'demo-cam-back', online: false, fps: 0, checksPerS: 0, detectMs: null },
    ] } };
  },
});

export const cameraViewsClient = (names: () => Map<string, string>): CameraViewsClient => (isDemo() ? demo(names) : shopServer);
