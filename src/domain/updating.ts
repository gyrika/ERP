/**
 * What the counter shows while CheesyBeez Station updates itself (station-update.ps1).
 * The updater writes its step to update-status.json; the shop server passes it on in its health
 * check; this decides what a cashier walking up to the counter sees, so nobody is left wondering
 * why the screen stopped answering. Pure: the screen (src/ui/UpdateScreen.tsx) only draws it.
 */

/** The updater's steps, as station-update.ps1 writes them. */
export type UpdatePhase =
  | 'checking' | 'downloading' | 'backup' | 'installing' | 'starting' | 'done'
  | 'going-back' | 'back' | 'up-to-date' | 'failed'
  /** Downloaded, held back until the PC next starts or late at night (nothing on the counter). */
  | 'waiting';

export interface UpdateStep {
  phase: UpdatePhase;
  percent: number;
  /** The version being installed. */
  version: string;
  /** When the updater wrote it (ms). */
  at: number;
}

/** A step older than this is a leftover (a crashed updater, a PC switched off mid-way): ignored. */
export const UPDATE_STALE_MS = 15 * 60_000;

/** The steps a cashier needs to know about; the rest (done, up to date, failed, back, waiting) need nothing on screen. */
const ACTIVE: readonly UpdatePhase[] = ['checking', 'downloading', 'backup', 'installing', 'starting', 'going-back'];

/** The step the health check passes on, or null when no update is under way right now. */
export const activeUpdate = (step: UpdateStep | null, now: number): UpdateStep | null =>
  step && ACTIVE.includes(step.phase) && now - step.at < UPDATE_STALE_MS ? step : null;

export type CounterUpdate =
  /** Nothing to show. */
  | { kind: 'none' }
  /** Downloading and backing up: the counter still works; a small notice says a restart is coming. */
  | { kind: 'preparing'; version: string; percent: number }
  /** Installing and starting: the server is (or is about to be) down; the whole screen says so. */
  | { kind: 'installing'; version: string; percent: number; step: 'installing' | 'starting' }
  /** The new version did not start; the old one is being put back. */
  | { kind: 'going-back'; version: string }
  /** A different version answers now: load its screens. */
  | { kind: 'reload'; version: string };

/** What the health check said: its answer, or that the server did not answer. */
export type HealthSeen = { version?: string; update?: UpdateStep | null } | 'unreachable';

/**
 * The next screen state from the last one and the latest health check. `pageVersion` is the
 * version the screen was loaded from (null until the first answer).
 */
export const nextCounterUpdate = (prev: CounterUpdate, seen: HealthSeen, pageVersion: string | null): CounterUpdate => {
  if (seen === 'unreachable') {
    // The installer stops the server: keep saying what is happening until it answers again.
    if (prev.kind === 'preparing') return { kind: 'installing', version: prev.version, percent: Math.max(prev.percent, 65), step: 'installing' };
    if (prev.kind === 'installing' || prev.kind === 'going-back') return prev;
    return { kind: 'none' }; // just down (power, a crash): not an update, the sync sign covers it
  }
  if (seen.version && pageVersion && seen.version !== pageVersion) return { kind: 'reload', version: seen.version };
  const u = seen.update;
  if (!u) return { kind: 'none' };
  if (u.phase === 'going-back') return { kind: 'going-back', version: u.version };
  if (u.phase === 'installing' || u.phase === 'starting') return { kind: 'installing', version: u.version, percent: u.percent, step: u.phase };
  if (u.phase === 'checking' || u.phase === 'downloading' || u.phase === 'backup') return { kind: 'preparing', version: u.version, percent: u.percent };
  return { kind: 'none' };
};
