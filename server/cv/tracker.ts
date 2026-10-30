// The only place the camera worker calls the table rules in src/domain/tables.ts (SCRUM-182:
// occupied on the first frame, left on the first empty one, a short visit frees the table, one of
// 3 minutes or more needs cleaning, which frees itself after 20 seconds).
import { cameraLost, newTracker, observe, staffSet, timersOf, type Change, type TableState, type TableTracker, type Timers, type VisionMode } from '../../src/domain/tables.ts';
import type { FloorState } from './visionCore.ts';

export type Tracker = TableTracker;
/** The owner's timers, as the config carries them. */
export type Rules = Timers;

export const startTracker = (state: TableState, since: number): Tracker => newTracker(state, since);

/** One frame's presence (and the detector's best score there); the change to record as `table.state_changed`, if any. */
export const sample = (t: Tracker, at: number, present: boolean, confidence: number, rules: Rules): { tracker: Tracker; change: Change | null } =>
  observe(t, { at, present, confidence }, timersOf(rules));

/** Every camera on the table is offline: it keeps its state and starts afresh with the next frame. */
export const lost = (t: Tracker): Tracker => cameraLost(t);

/**
 * Live: staff changed the table (a newer state than the tracker's), so the tracker takes it and
 * holds until presence flips. Shadow: the floor follows staff only, the cameras keep their own count.
 */
export const followFloor = (t: Tracker, floor: FloorState | undefined, mode: VisionMode): Tracker =>
  mode === 'live' && floor && floor.state !== t.state && floor.since > t.since ? staffSet(t, floor.state, floor.since) : t;
