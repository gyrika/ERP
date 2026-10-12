import { useSyncStatus } from '../services/syncClient.ts';

/**
 * Nothing while synced (SCRUM-32). Offline: one quiet line, so nobody worries
 * and nobody is surprised: sales keep working and go up when the link is back.
 */
export function SyncSign() {
  const status = useSyncStatus();
  if (status !== 'offline') return null;
  return <span className="syncsign" role="status">Offline · saved here</span>;
}
