import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { maskLogins } from '../src/domain/cameraSetup.ts';

/**
 * The camera worker's log (SCRUM-170): <data>\logs\cv.log (C:\ProgramData\CheesyBeez\logs on the
 * shop PC), for support over AnyDesk. One line an entry, logins masked, never an image. A new file
 * each day (yesterday's becomes cv-YYYY-MM-DD.log); KEEP_DAYS days are kept. Written by the server
 * only: the worker sends its lines over IPC.
 */
export const KEEP_DAYS = 14;
const MAX_LINE = 500;

/** The shop's calendar day of a time, YYYY-MM-DD (the PC's own time zone). */
export const dayOf = (t: number): string => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export function cvLog(o: { dir: string; now?: () => number }) {
  const now = o.now ?? Date.now;
  const file = join(o.dir, 'cv.log');
  /** The day cv.log holds; read from the file's first line once, then kept. */
  let day: string | null = null;
  const fileDay = (): string | null => {
    if (!existsSync(file)) return null;
    const first = /^(\d{4}-\d{2}-\d{2})/.exec(readFileSync(file, 'utf8').slice(0, 40))?.[1];
    return first ?? dayOf(statSync(file).mtimeMs);
  };

  const rotate = (today: string) => {
    day ??= fileDay();
    if (day && day !== today && existsSync(file)) {
      const to = join(o.dir, `cv-${day}.log`);
      if (existsSync(to)) { appendFileSync(to, readFileSync(file)); rmSync(file); } else renameSync(file, to);
    }
    day = today;
    const oldest = dayOf(now() - KEEP_DAYS * 86_400_000);
    for (const name of readdirSync(o.dir)) {
      const d = /^cv-(\d{4}-\d{2}-\d{2})\.log$/.exec(name)?.[1];
      if (d && d < oldest) rmSync(join(o.dir, name), { force: true });
    }
  };

  return {
    write(text: string): void {
      try {
        mkdirSync(o.dir, { recursive: true });
        const t = now();
        const today = dayOf(t);
        if (day !== today) rotate(today);
        const time = new Date(t).toTimeString().slice(0, 8);
        const line = maskLogins(text).replace(/\s*[\r\n]+\s*/g, ' | ').slice(0, MAX_LINE);
        appendFileSync(file, `${today} ${time} ${line}\n`);
      } catch {
        // A full or locked disk must never stop the cameras, let alone the Register.
      }
    },
  };
}
export type CvLog = ReturnType<typeof cvLog>;
