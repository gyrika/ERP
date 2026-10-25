import { useState } from 'react';
import { releaseText } from '../domain/scheduler.ts';
import { useRecentReleases } from '../services/inventoryStore.ts';

/**
 * "Culture is ready. Dough sent to the kitchen automatically.": batches the shop server released
 * in the last half hour, on Items and Visual Flow alike, until read. The kitchen hears them as new tickets.
 */
export function ReleaseNotices() {
  const releases = useRecentReleases();
  const [read, setRead] = useState<ReadonlySet<string>>(() => new Set());
  const shown = releases.filter((e) => !read.has(e.id)).slice(0, 3);
  if (!shown.length) return null;
  return (
    <>
      {shown.map((e) => (
        <div key={e.id} className="inv-notice" role="status">
          {releaseText(e)}
          <button type="button" onClick={() => setRead((r) => new Set(r).add(e.id))}>OK</button>
        </div>
      ))}
    </>
  );
}
