import { useSyncStatus } from '../services/syncClient.ts';

/**
 * Nothing while synced (SCRUM-32). Offline: one quiet line, never an error:
 * sales keep working, and the waiting orders go up by themselves once the
 * link is back, at which point the sign disappears.
 */
export function SyncSign() {
  const sync = useSyncStatus();
  if (sync?.status !== 'offline') return null;
  const n = sync.waitingOrders;
  return (
    <span className="syncsign" role="status">
      Offline{n > 0 && <> · <span className="num">{n}</span> {n === 1 ? 'order' : 'orders'} waiting</>}
    </span>
  );
}
