import { PUSH_BATCH, retryDelayMs } from '../src/domain/sync.ts';
import type { EventStore } from './store.ts';

/**
 * Copies this shop's events to the cloud (SCRUM-61) whenever the internet is
 * up. The shop server stays the truth for selling; the cloud copy only follows.
 *
 * Keeps no bookmark of its own: it asks the cloud which event it has last
 * (by the shop's own seq), then sends everything newer in batches. So a
 * restart, a power cut or a lost reply can never skip or double anything.
 * Runs straight after new sales (nudge) and every 30 s; on failure it backs off
 * up to 5 minutes, and the shop never notices. Each pass also says which version
 * runs here and how its last update went, so the admin view sees every shop.
 */
export interface ReplicatorOptions {
  store: EventStore;
  tenantId: string;
  /** e.g. https://cheesybeez-cloud.<account>.workers.dev */
  url: string;
  token: string;
  fetch?: typeof fetch;
  every?: number;
  now?: () => number;
  /** What this Station runs and where its last update is, told to the cloud on every pass (the admin view). */
  about?: () => { version: string; update: unknown };
}

export interface ReplicaStatus {
  /** Last time the cloud confirmed it had everything (server clock, ms), or null. */
  upToDateAt: number | null;
  lastError: string | null;
}

const MAX_BACKOFF_MS = 5 * 60_000;

export function startReplicator(o: ReplicatorOptions) {
  const http = o.fetch ?? fetch;
  const every = o.every ?? 30_000;
  const now = o.now ?? Date.now;
  const headers = (): Record<string, string> => {
    const about = o.about?.();
    return {
      authorization: `Bearer ${o.token}`,
      'content-type': 'application/json',
      ...(about ? { 'x-station-version': about.version, 'x-station-update': JSON.stringify(about.update ?? null) } : {}),
    };
  };
  const status: ReplicaStatus = { upToDateAt: null, lastError: null };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | null = null;
  let again = false;
  let stopped = false;
  let failures = 0;

  const call = async (method: 'GET' | 'POST', body?: unknown): Promise<{ lastSourceSeq: number }> => {
    const r = await http(`${o.url}/api/v1/replica`, {
      method, headers: headers(), body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) throw new Error(`cloud answered ${r.status}`);
    return r.json() as Promise<{ lastSourceSeq: number }>;
  };

  const schedule = (ms: number) => {
    clearTimeout(timer);
    if (!stopped) timer = setTimeout(() => void cycle(), ms);
  };

  const cycle = (): Promise<void> => {
    if (running) { again = true; return running; }
    running = pass().finally(() => {
      running = null;
      if (again && !stopped) { again = false; void cycle(); }
    });
    return running;
  };

  const pass = async (): Promise<void> => {
    try {
      let { lastSourceSeq: last } = await call('GET');
      for (;;) {
        const batch = await o.store.pull(o.tenantId, last, PUSH_BATCH);
        if (!batch.length) break;
        ({ lastSourceSeq: last } = await call('POST', { events: batch }));
        if (batch.length < PUSH_BATCH) break;
      }
      status.upToDateAt = now();
      status.lastError = null;
      failures = 0;
      schedule(every);
    } catch (e) {
      status.lastError = e instanceof Error ? e.message : String(e);
      if (failures === 0) console.warn(`Cloud copy paused (${status.lastError}); retrying quietly.`);
      schedule(Math.min(MAX_BACKOFF_MS, retryDelayMs(failures++)));
    }
  };

  void cycle();
  return {
    /** New events were stored: copy them soon (a short pause gathers a burst into one batch). */
    nudge() { if (failures === 0) schedule(2_000); },
    status: (): ReplicaStatus => ({ ...status }),
    /** One full pass now, after any pass already running (tests, status checks). */
    async syncNow() { while (running) await running; await cycle(); },
    stop() { stopped = true; clearTimeout(timer); },
  };
}
