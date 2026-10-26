import type { CvStatus } from '../../services/setupClient.ts';

const mb = (bytes: number) => `${(bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0)} MB`;

/** The CV pack arriving (server/cvPack.ts): #cameras' Activate CV and #vision's first Shadow or Live share it. */
export function CvProgress({ status }: { status: CvStatus }) {
  const downloading = status.phase === 'downloading';
  const percent = downloading && status.total ? Math.min(100, Math.round((status.bytes / status.total) * 100)) : undefined;
  const label = downloading ? 'Downloading the CV pack' : 'Checking every file';
  return (
    <div className="update" role="status" aria-live="polite">
      <div className="update__row">
        <b>{label}</b>
        {downloading && <span className="num">{mb(status.bytes)}{status.total ? ` of ${mb(status.total)}` : ''}</span>}
      </div>
      <div className="update__bar" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
        <span style={{ width: `${percent ?? (downloading ? 5 : 100)}%` }} />
      </div>
      <p className="update__note">The counter keeps working meanwhile.</p>
    </div>
  );
}
