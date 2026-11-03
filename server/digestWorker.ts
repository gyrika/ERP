import { setMenuState } from '../src/domain/menu.ts';
import { menuStateFromEvents } from '../src/domain/menuEdits.ts';
import { withoutTestData } from '../src/domain/freshStart.ts';
import { buildOwnerDigest } from '../src/domain/ownerDigest.ts';
import type { SyncEvent } from '../src/domain/sync.ts';

/**
 * Builds the owner's digest in its own process at below-normal priority (SCRUM-198). A build takes
 * seconds on a year of history; inside the shop server that would hold up receipts, the drawer and
 * the kitchen. It keeps its own copy of the history; the server sends only what is new.
 */
export type ToDigestWorker = { type: 'add'; events: SyncEvent[] } | { type: 'build'; now: number };
export type FromDigestWorker = { type: 'added' } | { type: 'digest'; body: string } | { type: 'failed'; message: string };

const log: SyncEvent[] = [];
const answer = (m: FromDigestWorker) => { try { process.send?.(m); } catch { /* the server is gone: disconnect ends us */ } };

process.on('message', (m: ToDigestWorker) => {
  if (m.type === 'add') {
    for (const e of m.events) log.push(e);
    answer({ type: 'added' });
    return;
  }
  try {
    // Insights name dishes through the shared menu; in this process it is only ever this shop's.
    setMenuState(menuStateFromEvents(log.filter((e) => e.type.startsWith('menu.'))), m.now);
    answer({ type: 'digest', body: JSON.stringify(buildOwnerDigest(withoutTestData(log), m.now)) });
  } catch (e) {
    answer({ type: 'failed', message: e instanceof Error ? e.message : 'build failed' });
  }
});
process.on('disconnect', () => process.exit(0));
