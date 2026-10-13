import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

/**
 * "Update now" in Shop setup. CheesyBeez Station keeps its version beside the
 * program (version.txt) and an updater script (station-update.ps1, also run
 * every night at 4 am). This asks GitHub for the latest release and, when the
 * owner says so, runs that updater straight away. In development there is no
 * Station, so there is nothing to update.
 */
const LATEST = 'https://api.github.com/repos/gyrika/ERP/releases/latest';

export interface UpdateCheck {
  current: string;
  latest: string | null;
  newer: boolean;
}

/** "1.0.10" > "1.0.9", part by part; anything that is not a version is never newer. */
export const isNewer = (latest: string, current: string): boolean => {
  const parse = (v: string) => (/^\d+(\.\d+){0,3}$/.test(v) ? v.split('.').map(Number) : null);
  const a = parse(latest);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
};

/** Where an update is (station-update.ps1 writes it), for the progress bar. */
export interface UpdateStatus {
  phase: 'checking' | 'downloading' | 'backup' | 'installing' | 'starting' | 'done' | 'going-back' | 'back' | 'up-to-date' | 'failed';
  percent: number;
  version: string;
  /** When it was written (ms). */
  at: number;
}

export interface UpdatesOptions {
  versionFile: string;
  updaterScript: string;
  /** update-status.json beside the shop's data. */
  statusFile?: string;
  fetch?: typeof fetch;
  platform?: NodeJS.Platform;
  run?: (command: string, args: string[]) => void;
}

export function updatesApi(o: UpdatesOptions) {
  const http = o.fetch ?? fetch;
  const platform = o.platform ?? process.platform;
  const run = o.run ?? ((command, args) => {
    // Detached: the installer stops this very server while it replaces the files.
    spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  });
  const current = (): string => {
    try { return existsSync(o.versionFile) ? readFileSync(o.versionFile, 'utf8').trim() || 'development' : 'development'; }
    catch { return 'development'; }
  };
  const installable = () => platform === 'win32' && existsSync(o.updaterScript) && current() !== 'development';

  return {
    current,

    async check(): Promise<UpdateCheck> {
      const r = await http(LATEST, { headers: { 'user-agent': 'CheesyBeez-Station', accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15_000) });
      if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
      const latest = String(((await r.json()) as { tag_name?: string }).tag_name ?? '').replace(/^v/, '') || null;
      const now = current();
      return { current: now, latest, newer: latest !== null && isNewer(latest, now) };
    },

    /** The updater's latest step, or null (none yet, or an older updater that does not say). */
    status(): UpdateStatus | null {
      try {
        if (!o.statusFile || !existsSync(o.statusFile)) return null;
        const s = JSON.parse(readFileSync(o.statusFile, 'utf8').replace(/^\uFEFF/, '')) as UpdateStatus;
        return typeof s.phase === 'string' && Number.isFinite(s.percent) ? s : null;
      } catch {
        return null; // being written right now: the next look gets it
      }
    },

    /** Starts the updater now (it downloads the latest release and installs it quietly). */
    install(): void {
      if (!installable()) throw new Error('updates are installed by CheesyBeez Station on Windows');
      // A moment later, so the reply reaches the screen before the installer stops this server.
      setTimeout(() => run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', o.updaterScript, '-Force']), 500);
    },
  };
}
export type UpdatesApi = ReturnType<typeof updatesApi>;
