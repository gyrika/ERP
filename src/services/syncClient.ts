import { useSyncExternalStore } from 'react';
import {
  PULL_LIMIT, PUSH_BATCH, retryDelayMs, syncStatus,
  type PullResponse, type PushRequest, type PushResponse, type StreamMessage, type SyncStatus, type SyncTransport,
} from '../domain/sync.ts';
import { addEvents, markRejected, markSynced, readAll, readOutbox, subscribeEvents } from '../ui/eventLog.ts';
import { storageKey } from '../ui/storage.ts';

/**
 * Keeps this device's event log in step with the server (docs/sync-contract.md):
 * pushes the outbox, pulls what it missed, then streams. Never blocks a sale;
 * on any failure it backs off (1 s, 2 s, 4 s … 60 s) and tries again.
 * Screens never call this: they read the event log as before.
 */

const LAST_SEQ = () => storageKey('sync.lastSeq');

const get = (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } };
const set = (k: string, v: string): void => { try { localStorage.setItem(k, v); } catch { /* blocked */ } };

export { pairFromUrl, syncToken } from './pairing.ts';

// ----- HTTP + WebSocket transport (same origin: the server also serves the app) -----

export function httpTransport(token: string, origin = location.origin): SyncTransport {
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const ok = async <T>(r: Response): Promise<T> => {
    if (!r.ok) throw new Error(`sync ${r.status}`);
    return r.json() as Promise<T>;
  };
  return {
    push: (req: PushRequest) =>
      fetch(`${origin}/api/v1/events`, { method: 'POST', headers, body: JSON.stringify(req) }).then(ok<PushResponse>),
    pull: (after, limit) =>
      fetch(`${origin}/api/v1/events?after=${after}&limit=${limit}`, { headers }).then(ok<PullResponse>),
    stream(after, onMessage, onClose) {
      const ws = new WebSocket(`${origin.replace(/^http/, 'ws')}/api/v1/stream?after=${after}&token=${encodeURIComponent(token)}`);
      ws.onmessage = (m) => onMessage(JSON.parse(String(m.data)) as StreamMessage);
      ws.onclose = onClose;
      return () => { ws.onclose = null; ws.close(); };
    },
  };
}

// ----- status, for the small offline sign -----

let online = false;
let running = false;
const statusListeners = new Set<() => void>();
const setOnline = (v: boolean) => { if (online !== v) { online = v; statusListeners.forEach((l) => l()); } };

/** How many different orders still have something the server has not confirmed. */
const waitingOrders = (): number => {
  const pending = new Set(readOutbox());
  return new Set(readAll().filter((e) => pending.has(e.id)).map((e) => e.orderNumber)).size;
};

/** null when this device does not sync (no pairing yet, or the demo). */
export function useSyncStatus(): { status: SyncStatus; waitingOrders: number } | null {
  const waiting = useSyncExternalStore(subscribeEvents, waitingOrders);
  const isOnline = useSyncExternalStore((l) => { statusListeners.add(l); return () => statusListeners.delete(l); }, () => online);
  return running ? { status: syncStatus(isOnline, waiting), waitingOrders: waiting } : null;
}

// ----- the loop -----

export function startSync(transport: SyncTransport, deviceId = 'browser'): () => void {
  let stopped = false;
  let closeStream: (() => void) | null = null;
  let pushing = false;
  let pushAgain = false;
  let pushAttempt = 0;
  let pushTimer: ReturnType<typeof setTimeout> | undefined;
  let connectAttempt = 0;
  let connectTimer: ReturnType<typeof setTimeout> | undefined;
  running = true;

  let lastSeq = Number(get(LAST_SEQ()) ?? 0) || 0;
  const applied = (seq: number) => { if (seq > lastSeq) { lastSeq = seq; set(LAST_SEQ(), String(seq)); } };

  /** Sends the outbox, one batch at a time, until it is empty. */
  const push = async () => {
    if (pushing) { pushAgain = true; return; }
    pushing = true;
    clearTimeout(pushTimer);
    try {
      for (;;) {
        const waiting = new Set(readOutbox());
        const batch = readAll().filter((e) => waiting.has(e.id)).slice(0, PUSH_BATCH);
        if (!batch.length) break;
        const res = await transport.push({ deviceId, events: batch });
        if (stopped) return;
        markSynced(res.accepted.map((a) => a.id)); // only what the server confirmed
        // Refused for good (SCRUM-41): retrying would never succeed, and must not block the rest.
        if (res.rejected?.length) {
          console.warn('The server refused these events:', res.rejected);
          markRejected(res.rejected.map((r) => r.id));
        }
        pushAttempt = 0;
        setOnline(true);
      }
    } catch {
      setOnline(false);
      if (!stopped) pushTimer = setTimeout(() => void push(), retryDelayMs(pushAttempt++));
    } finally {
      pushing = false;
      if (pushAgain && !stopped) { pushAgain = false; void push(); }
    }
  };

  /** Pull what was missed, then stream from there. Reconnects with back-off. */
  const connect = async () => {
    try {
      for (;;) {
        const page = await transport.pull(lastSeq, PULL_LIMIT);
        if (stopped) return;
        addEvents(page.events.map((s) => s.event));
        applied(page.lastSeq);
        if (!page.more) break;
      }
      closeStream = transport.stream(lastSeq, (m) => {
        if (m.type === 'hello') { setOnline(true); connectAttempt = 0; void push(); return; }
        addEvents([m.data.event]);
        applied(m.data.seq);
      }, () => {
        closeStream = null;
        setOnline(false);
        if (!stopped) connectTimer = setTimeout(() => void connect(), retryDelayMs(connectAttempt++));
      });
    } catch {
      setOnline(false);
      if (!stopped) connectTimer = setTimeout(() => void connect(), retryDelayMs(connectAttempt++));
    }
  };

  // Push straight after every new local event (and when another tab wrote one).
  const unsubscribe = subscribeEvents(() => { if (readOutbox().length) void push(); });
  // The browser says the network is back: do not sit out the rest of a back-off.
  const onOnline = () => {
    pushAttempt = 0;
    void push();
    if (!closeStream) { clearTimeout(connectTimer); connectAttempt = 0; void connect(); }
  };
  // A dead socket can take a long time to notice: drop it, so reconnecting starts at once.
  const onOffline = () => { setOnline(false); closeStream?.(); closeStream = null; clearTimeout(connectTimer); connectTimer = setTimeout(() => void connect(), retryDelayMs(connectAttempt++)); };
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);
  void push();
  void connect();

  return () => {
    stopped = true;
    running = false;
    unsubscribe();
    window.removeEventListener('online', onOnline);
    window.removeEventListener('offline', onOffline);
    clearTimeout(pushTimer);
    clearTimeout(connectTimer);
    closeStream?.();
    setOnline(false);
  };
}
