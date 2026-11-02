import { spawn, type ChildProcess } from 'node:child_process';
import { constants, setPriority } from 'node:os';
import { fileURLToPath } from 'node:url';
import { PULL_LIMIT, type SyncEvent } from '../src/domain/sync.ts';
import type { FromDigestWorker, ToDigestWorker } from './digestWorker.ts';
import type { EventStore } from './store.ts';

/**
 * Keeps the cloud's copy of the owner's digest fresh for his ChatGPT (SCRUM-198). It asks the cloud
 * first and does nothing else unless ChatGPT is connected, so a shop without it never reads its
 * history for this and runs no extra process. Connected: at most every 10 minutes when something
 * new happened, and at least every half hour, because "usual by this time" and "lasts N days" move
 * with the clock. The build itself runs in server/digestWorker.ts, away from the Register's server.
 */
export interface DigestBuilder {
  add(events: SyncEvent[]): Promise<void>;
  /** The digest as JSON. */
  build(now: number): Promise<string>;
  stop(): void;
}

export interface OwnerDigestOptions {
  url: string;
  token: string;
  tenantId: string;
  store: Pick<EventStore, 'pull'>;
  now?: () => number;
  fetch?: typeof fetch;
  every?: number;
  builder?: () => DigestBuilder;
}

const MIN_GAP_MS = 10 * 60_000;
const REFRESH_MS = 30 * 60_000;
/** Far longer than any shop's build; a stuck worker is thrown away and the next pass starts over. */
const WORKER_TIMEOUT_MS = 3 * 60_000;
const WORKER = fileURLToPath(new URL('./digestWorker.ts', import.meta.url));

export const forkBuilder = (script = WORKER, timeoutMs = WORKER_TIMEOUT_MS): DigestBuilder => {
  const child: ChildProcess = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', script], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    windowsHide: true,
  });
  try { if (child.pid) setPriority(child.pid, constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* gone already */ }
  child.on('error', () => { /* answered by the timeout or exit below */ });

  /** One question at a time: the loop below awaits each answer. */
  const ask = (m: ToDigestWorker) => new Promise<FromDigestWorker>((resolve, reject) => {
    const done = () => { clearTimeout(timer); child.off('message', heard); child.off('exit', died); };
    const heard = (a: unknown) => { done(); resolve(a as FromDigestWorker); };
    const died = () => { done(); reject(new Error('owner digest: the worker stopped')); };
    const timer = setTimeout(() => { done(); child.kill(); reject(new Error('owner digest: the worker took too long')); }, timeoutMs);
    child.once('message', heard);
    child.once('exit', died);
    child.send(m, (e) => { if (e) died(); });
  });

  return {
    add: async (events) => { await ask({ type: 'add', events }); },
    build: async (now) => {
      const a = await ask({ type: 'build', now });
      if (a.type !== 'digest') throw new Error(`owner digest: ${a.type === 'failed' ? a.message : 'no digest'}`);
      return a.body;
    },
    stop: () => { child.kill(); },
  };
};

export function startOwnerDigest(o: OwnerDigestOptions) {
  const http = o.fetch ?? fetch;
  const now = o.now ?? Date.now;
  const every = o.every ?? 5 * 60_000;
  const newBuilder = o.builder ?? forkBuilder;
  const headers = { authorization: `Bearer ${o.token}`, 'content-type': 'application/json' };
  let builder: DigestBuilder | null = null;
  let cursor = 0;
  let waiting = false; // something new since the last upload
  let sentAt: number | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const rest = () => { builder?.stop(); builder = null; cursor = 0; waiting = false; sentAt = null; };

  const catchUp = async (to: DigestBuilder) => {
    for (;;) {
      const rows = await o.store.pull(o.tenantId, cursor, PULL_LIMIT);
      if (rows.length) {
        await to.add(rows.map((r) => r.event));
        cursor = rows[rows.length - 1].seq;
        waiting = true;
      }
      if (rows.length < PULL_LIMIT) return;
    }
  };

  /** One pass. Returns whether a digest was uploaded. */
  const poll = async (): Promise<boolean> => {
    const asked = await http(`${o.url}/api/v1/mcp/wanted`, { headers, signal: AbortSignal.timeout(15_000) });
    // 404: this cloud has ChatGPT switched off, or is older than this shop.
    if (asked.status === 404) { rest(); return false; }
    if (!asked.ok) throw new Error(`owner digest: cloud answered ${asked.status}`);
    const { wanted } = await asked.json() as { wanted?: unknown };
    if (wanted !== true) { rest(); return false; }

    try {
      builder ??= newBuilder();
      await catchUp(builder);
      const t = now();
      const age = sentAt === null ? Infinity : t - sentAt;
      if (age < MIN_GAP_MS || (!waiting && age < REFRESH_MS)) return false;
      const body = await builder.build(t);
      const sent = await http(`${o.url}/api/v1/mcp/digest`, {
        method: 'PUT', headers, body: JSON.stringify({ digest: JSON.parse(body) }), signal: AbortSignal.timeout(20_000),
      });
      if (!sent.ok) throw new Error(`owner digest: cloud answered ${sent.status}`);
      sentAt = t;
      waiting = false;
      return true;
    } catch (e) {
      if (/worker/.test(e instanceof Error ? e.message : '')) rest(); // its copy of the history is gone: start over
      throw e;
    }
  };

  const loop = async () => {
    if (stopped) return;
    try { await poll(); } catch { /* the internet is down: next time */ }
    if (!stopped) timer = setTimeout(() => void loop(), every);
  };
  // Not at start-up: the counter is waiting for this server then.
  timer = setTimeout(() => void loop(), Math.min(every, 60_000));
  return { poll, stop: () => { stopped = true; clearTimeout(timer); rest(); } };
}
