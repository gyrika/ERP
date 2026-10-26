import { useCallback, useEffect, useState } from 'react';
import { setupClient, type CvStatus } from '../services/setupClient.ts';
import { OwnerNav } from './OwnerNav.tsx';
import { OwnerPin } from './SetupWizard.tsx';
import { CameraSetup } from './cameras/CameraSetup.tsx';
import { CvProgress } from './cameras/CvProgress.tsx';

/**
 * #cameras (SCRUM-169), the owner's, on the shop PC. Serves the owner switching table detection
 * on: they know they want it; the one thing they need is to press Activate and see it arrive.
 * CV is off until then. Activate makes the shop server fetch the CV pack (server/cvPack.ts) in
 * the background; this screen shows its progress and, if it fails, why, with Retry beside it.
 * No restart. Below it (SCRUM-171, cameras/CameraSetup.tsx): the cameras, tables, zones and timers;
 * Off / Shadow / Live is on the Computer vision page (#vision, SCRUM-174).
 * Lazy-loaded from Root, so the Register's bundle does not carry it.
 */
const LOOK_MS = 1000;

export default function CamerasView({ onRegister }: { onRegister?: () => void }) {
  const [ownerPin, setOwnerPin] = useState<string | null>(null);
  const [status, setStatus] = useState<CvStatus | null>(null);
  const [error, setError] = useState('');

  const unlock = async (pin: string) => {
    setError('');
    try { setStatus(await setupClient.cvStatus(pin)); setOwnerPin(pin); } // proves the PIN is the owner's
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const activate = useCallback(async () => {
    if (!ownerPin) return;
    setError('');
    try { setStatus(await setupClient.cvActivate(ownerPin)); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [ownerPin]);

  const busy = status?.phase === 'downloading' || status?.phase === 'verifying';
  useEffect(() => {
    if (!ownerPin || !busy) return;
    const t = setTimeout(() => {
      setupClient.cvStatus(ownerPin).then(setStatus, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    }, LOOK_MS);
    return () => clearTimeout(t);
  }, [ownerPin, busy, status]);

  let body;
  if (!ownerPin || !status) body = <OwnerPin title="Cameras" onPin={(p) => void unlock(p)} error={error} />;
  else {
    body = (
      <div className="setup__form">
        <h1>Cameras</h1>
        {status.phase === 'idle' && <>
          <p className="setup__lead">Table detection is off. Activating it downloads the CV pack once (the video reader and the detection model). No restart.</p>
          <div className="setup__foot"><button type="button" className="cta" autoFocus onClick={() => void activate()}>Activate CV</button></div>
        </>}
        {busy && <CvProgress status={status} />}
        {status.phase === 'ready' && <p className="setup__lead" role="status">Table detection is ready (CV pack {status.version}).</p>}
        {status.phase === 'failed' && (
          <p className="setup__error cv__failed" role="alert">
            <span>Activating CV did not work: {status.reason}.</span>
            <button type="button" className="chip chip--solid" autoFocus onClick={() => void activate()}>Retry</button>
          </p>
        )}
        {error && <p className="setup__error" role="alert">{error}</p>}
        <CameraSetup pin={ownerPin} />
      </div>
    );
  }

  return (
    <div className="setup">
      <OwnerNav current="setup" onRegister={onRegister} />
      <main className="setup__main" aria-label="Cameras">{body}</main>
    </div>
  );
}
