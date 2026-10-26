// The only place the camera worker calls the table rules in src/domain/tables.ts. New rules
// (SCRUM-182) change this file and the config's timers, not the engine.
import { cameraLost, newTracker, observe, staffSet, type Change, type TableState, type TableTracker, type VisionMode } from '../../src/domain/tables.ts';
import type { FloorState } from './visionCore.ts';

export type Tracker = TableTracker;
/** The owner's timers, as the config carries them. */
export interface Rules { seatS: number; leaveS: number }

export const startTracker = (state: TableState, since: number): Tracker => newTracker(state, since);

/** One presence sample; the change to record as `table.state_changed`, if any. */
export const sample = (t: Tracker, at: number, present: boolean, rules: Rules): { tracker: Tracker; change: Change | null } =>
  observe(t, { at, present }, { seatS: rules.seatS, leaveS: rules.leaveS });

/** Every camera on the table is offline: it keeps its state and starts afresh with the next sample. */
export const lost = (t: Tracker): Tracker => cameraLost(t);

/**
 * Live: staff changed the table (a newer state than the tracker's), so the tracker takes it and
 * holds until presence flips. Shadow: the floor follows staff only, the cameras keep their own count.
 */
export const followFloor = (t: Tracker, floor: FloorState | undefined, mode: VisionMode): Tracker =>
  mode === 'live' && floor && floor.state !== t.state && floor.since > t.since ? staffSet(t, floor.state, floor.since) : t;
