// The messages between the shop server and the camera worker (SCRUM-170), over Node IPC only.
// The worker never touches storage: it says what the cameras saw; the server stamps, checks and stores it.
import type { TableState, ZoneSpec } from '../../src/domain/tables.ts';
import type { AlertFields, FloorState } from './visionCore.ts';

/** A camera the worker watches. `url` carries the login: it lives in the two processes' memory only. */
export interface WorkerCamera { id: string; url: string; zones: ZoneSpec[] }

export interface WorkerConfig {
  /** The CV pack (ffmpeg.exe, onnxruntime-node, the model). */
  packDir: string;
  mode: 'shadow' | 'live';
  seatS: number;
  leaveS: number;
  cleanAlertS: number;
  /** The owner's CPU limit, percent of the PC. */
  cpuLimit: number;
  cameras: WorkerCamera[];
  /** The floor as the shop's events fold it (Live follows staff changes; alerts). */
  floor: Record<string, FloorState>;
  /** Cameras the shop last heard were offline. */
  offline: string[];
}

export type ToWorker = { type: 'config'; config: WorkerConfig } | { type: 'stop' };

/** An event's own fields; the server adds id, shopId, actor (role vision) and orderNumber 0. */
export type VisionFields =
  | { type: 'table.state_changed'; tableId: string; from: TableState; to: TableState; confidence: number }
  | AlertFields
  | { type: 'vision.camera_offline' | 'vision.camera_online'; cameraId: string };

export interface Heartbeat { cameras: { id: string; online: boolean; fps: number }[]; cpu: number; slowed: boolean }

export type FromWorker =
  | { type: 'ready' }
  | { type: 'event'; at: number; fields: VisionFields }
  | ({ type: 'heartbeat'; at: number } & Heartbeat)
  /** A line for cv.log: never an image or a password (the server masks logins again). */
  | { type: 'log'; text: string };
