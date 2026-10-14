import { useEffect, useRef, useState } from 'react';
import { nextCounterUpdate, type CounterUpdate, type HealthSeen } from '../domain/updating.ts';
import { isCloudSite } from '../services/pairing.ts';

/**
 * Serves whoever walks up to the counter (or looks at the kitchen screen) while CheesyBeez updates
 * itself: they already know the POS; the one thing they need is why it stopped answering and when
 * it is back. Downloading: a small notice, the counter still works. Installing, starting or going
 * back: the whole screen says so. The new version answering: the screens reload into it, then
 * "Updated to 1.0.10" for a moment. Driven by the shop server's health check (src/domain/updating.ts).
 */
const UPDATED = 'cb.updatedTo';
const LOOK_IDLE_MS = 10_000;
const LOOK_ACTIVE_MS = 3_000;

const readUpdated = (): string | null => {
  try { const v = sessionStorage.getItem(UPDATED); sessionStorage.removeItem(UPDATED); return v; } catch { return null; }
};

export function UpdateScreen({ reload = () => location.reload(), idleMs = LOOK_IDLE_MS, activeMs = LOOK_ACTIVE_MS }: {
  reload?: () => void; idleMs?: number; activeMs?: number;
}) {
  const [state, setState] = useState<CounterUpdate>({ kind: 'none' });
  const [updated, setUpdated] = useState<string | null>(readUpdated);
  const page = useRef<string | null>(null);

  useEffect(() => {
    if (isCloudSite()) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    let prev: CounterUpdate = { kind: 'none' };
    const look = async () => {
      let seen: HealthSeen;
      try {
        const r = await fetch('/api/v1/health', { cache: 'no-store', signal: AbortSignal.timeout(4_000) });
        seen = r.ok ? ((await r.json()) as Exclude<HealthSeen, 'unreachable'>) : 'unreachable';
      } catch { seen = 'unreachable'; }
      if (stop) return;
      if (seen !== 'unreachable' && seen.version && page.current === null) page.current = seen.version;
      prev = nextCounterUpdate(prev, seen, page.current);
      setState(prev);
      // Shop setup's "Update now" has its own progress and restarts the app itself.
      if (prev.kind === 'reload' && location.hash !== '#setup') {
        try { sessionStorage.setItem(UPDATED, prev.version); } catch { /* private mode: no "Updated" note */ }
        reload();
        return;
      }
      timer = setTimeout(() => void look(), prev.kind === 'none' ? idleMs : activeMs);
    };
    void look();
    return () => { stop = true; clearTimeout(timer); };
  }, [reload, idleMs, activeMs]);

  useEffect(() => {
    if (!updated) return;
    const t = setTimeout(() => setUpdated(null), 5_000);
    return () => clearTimeout(t);
  }, [updated]);

  if (location.hash === '#setup') return null;

  if (state.kind === 'preparing') {
    return (
      <div className="upd-note" role="status">
        <span className="upd-note__dot" aria-hidden />
        {state.percent >= 61
          ? `Saving a backup before update ${state.version}. The POS restarts in about a minute.`
          : `Update ${state.version} is downloading (${Math.max(0, Math.round(((state.percent - 5) / 55) * 100))}%). The POS restarts in about a minute.`}
      </div>
    );
  }

  if (state.kind === 'installing' || state.kind === 'going-back') {
    const back = state.kind === 'going-back';
    return (
      <div className="upd" role="dialog" aria-modal="true" aria-labelledby="upd-title">
        <div className="upd__card">
          <h1 id="upd-title">{back ? 'Going back to the previous version' : 'Updating CheesyBeez'}</h1>
          <p className="upd__sub" role="status">
            {back
              ? `Version ${state.version} did not start. This takes a few minutes.`
              : `${state.step === 'starting' ? 'Starting' : 'Installing'} version ${state.version}`}
          </p>
          <div className={`upd__bar${back ? ' upd__bar--busy' : ''}`} role="progressbar" aria-label="Update progress"
            aria-valuemin={0} aria-valuemax={100} aria-valuenow={back ? undefined : state.percent}>
            <i style={back ? undefined : { width: `${state.percent}%` }} />
          </div>
          <p className="upd__safe">Back in {back ? 'a few minutes' : 'about a minute'}. Orders already taken are safe; please wait before taking the next one.</p>
        </div>
      </div>
    );
  }

  if (updated) return <div className="toast upd-done" role="status"><span>Updated to {updated}</span></div>;
  return null;
}
