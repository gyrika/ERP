// The messages between the shop server and the camera worker (SCRUM-170), over Node IPC only.
// The worker never touches storage: it says what the cameras saw; the server stamps, checks and stores it.
import type { Seen, TableState, ZoneSpec } from '../../src/domain/tables.ts';
import type { FloorState } from './visionCore.ts';

/** A camera the worker watches. `url` carries the login: it lives in the two processes' memory only. */
export interface WorkerCamera { id: string; url: string; zones: ZoneSpec[] }

export interface WorkerConfig {
  /** The CV pack (ffmpeg.exe, onnxruntime-node, the model). */
  packDir: string;
  mode: 'shadow' | 'live';
  /** The owner's table rules (SCRUM-182), seconds. */
  shortVisitS: number;
  leftCheckS: number;
  autoFreeS: number;
  /** The owner's CPU limit, percent of the PC. */
  cpuLimit: number;
  cameras: WorkerCamera[];
  /** The floor as the shop's events fold it (Live follows staff changes). */
  floor: Record<string, FloorState>;
  /** Cameras the shop last heard were offline. */
  offline: string[];
}

/** `watch`: the owner opened this camera large on #vision (SCRUM-175): send what each check sees; null: stop. */
export type ToWorker = { type: 'config'; config: WorkerConfig } | { type: 'watch'; cameraId: string | null } | { type: 'stop' };

export type { Seen, SeenBox } from '../../src/domain/tables.ts';

/** An event's own fields; the server adds id, shopId, actor (role vision) and orderNumber 0. */
export type VisionFields =
  | { type: 'table.state_changed'; tableId: string; from: TableState; to: TableState; confidence: number }
  | { type: 'vision.camera_offline' | 'vision.camera_online'; cameraId: string };

export interface Heartbeat { cameras: { id: string; online: boolean; fps: number }[]; cpu: number; slowed: boolean }

/** How the worker is doing now (PERF_MS), for #vision's Performance: never stored. */
export interface Perf {
  /** The worker's CPU share of the PC, whole percent, and the owner's limit. */
  cpu: number;
  cpuLimit: number;
  slowed: boolean;
  /** Each camera: frames read and checks made a second, and a detection's average time (null: none lately; the motion gate reused). */
  cameras: { id: string; online: boolean; fps: number; checksPerS: number; detectMs: number | null }[];
}

export type FromWorker =
  | { type: 'ready' }
  | { type: 'event'; at: number; fields: VisionFields }
  | ({ type: 'heartbeat'; at: number } & Heartbeat)
  | ({ type: 'perf'; at: number } & Perf)
  /** Only for the watched camera, only to the owner's open view: never stored, logged or sent to the cloud. */
  | ({ type: 'seen'; cameraId: string } & Seen)
  /** A line for cv.log: never an image or a password (the server masks logins again). */
  | { type: 'log'; text: string };
