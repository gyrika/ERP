import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import type { UpdateStep } from '../src/domain/updating.ts';
import { isNewer } from '../src/domain/version.ts';

export { isNewer };

/**
 * "Update now" in Shop setup. CheesyBeez Station keeps its version beside the
 * program (version.txt) and an updater script (station-update.ps1, also run
 * every 5 minutes). This asks GitHub for the latest release and, when the
 * owner says so, runs that updater straight away. In development there is no
 * Station, so there is nothing to update.
 */
const LATEST = 'https://api.github.com/repos/gyrika/ERP/releases/latest';

export interface UpdateCheck {
  current: string;
  latest: string | null;
  newer: boolean;
}

/** Where an update is (station-update.ps1 writes it), for the progress bars. */
export type UpdateStatus = UpdateStep;

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
