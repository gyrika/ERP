import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { MAX_CAMERA_LIST, type CameraSpec, type FloorTable, type TableSpec, type ZoneSpec } from '../../domain/tables.ts';
import type { VisionPick } from '../../domain/visionPage.ts';
import { cameraViewsClient, type CameraViewsClient, type ViewFrame, type ViewsPerf } from '../../services/cameraViews.ts';
import type { CameraLogins, CvStatus } from '../../services/setupClient.ts';
import { demoVideos, type TestVideos, type VisionClient } from '../../services/visionClient.ts';
import { isDemo } from '../storage.ts';
import { CvProgress } from '../cameras/CvProgress.tsx';
import { columns } from '../floor/FloorTile.tsx';
import { useNow } from '../Kitchen.tsx';
import { checkedLine, DetectionOverlay } from './DetectionOverlay.tsx';
import { CameraForm, ZoneEditor, type WithPin } from './setupParts.tsx';
import { TestVideo } from './TestVideo.tsx';

/**
 * Camera views (#vision, SCRUM-180), the strip and the camera panel. Mind: the owner, who wants to
 * see the shop's cameras before trusting any detection. They know where each camera hangs; the
 * single next thing they need is every camera's picture in one row, and one of them close up.
 * A tile per camera (each lens of a dual-lens camera its own): its picture every few seconds, its
 * name and whether it is online. Picking one opens it in the side panel, live at a few frames a
 * second with what detection sees (SCRUM-175), its zones and its connection. The shop server runs
 * ffmpeg only while this is on screen and touched (server/cvLive.ts); after 2 minutes untouched it
 * pauses until the next touch. Shop PC only, behind the owner's PIN: the cloud and owner-phone
 * builds leave this file out.
 */

const TILE_MS = 3000;
const PERF_MS = 2000;
const RETRY_MS = 1000;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const busy = (s: CvStatus | null) => s?.phase === 'downloading' || s?.phase === 'verifying';

type Seen = ViewFrame & { src?: string; seq?: number };

const STATUS: Record<ViewFrame['state'], string> = {
  frame: 'Online', starting: 'Connecting…', offline: 'Offline', busy: 'Open it to watch', paused: 'Paused', pack: 'Needs the CV pack', unknown: 'Save it first',
};
/** Labels; Sinhala and Tamil stay empty until the owner gives them. */
export const VIEW_WORDS = {
  title: { en: 'Cameras', si: '', ta: '' },
  add: { en: 'Add camera', si: '', ta: '' },
};

/** Someone touched the page since the last ask: the shop server keeps the cameras running. */
function useTouches(onTouch: () => void) {
  const touched = useRef(true);
  const cb = useRef(onTouch);
  cb.current = onTouch;
  useEffect(() => {
    const touch = () => { touched.current = true; cb.current(); };
    const kinds = ['keydown', 'pointerdown', 'pointermove', 'wheel', 'touchstart'] as const;
    for (const k of kinds) window.addEventListener(k, touch, { passive: true });
    return () => { for (const k of kinds) window.removeEventListener(k, touch); };
  }, []);
  return useCallback(() => { const t = touched.current; touched.current = false; return t; }, []);
}

export default function CameraViews({
  cameras, zones = {}, tables = [], detecting = true, pin, client: vc, withPin, pick, onPick, onClose, panel, onPerf, views: given,
}: {
  /** Every camera, used for CV or not. */
  cameras: CameraSpec[];
  /** Each camera's zones and the floor, for the overlay and the zone editor. */
  zones?: Record<string, ZoneSpec[]>;
  tables?: FloorTable[];
  /** CV is on, so the worker checks what the large view shows. */
  detecting?: boolean;
  /** The owner's PIN, once typed on this page. */
  pin: string | null;
  client: VisionClient;
  withPin: WithPin;
  pick: VisionPick;
  onPick: (p: VisionPick) => void;
  onClose: () => void;
  /** The side panel: a camera's details are drawn there. */
  panel: HTMLElement | null;
  /** How the worker is doing now, for the panel's Performance (null: not watching). */
  onPerf?: (p: ViewsPerf | null) => void;
  views?: CameraViewsClient;
}) {
  const names = useRef(new Map<string, string>());
  names.current = new Map(cameras.map((c) => [c.id, c.name]));
  const client = useMemo(() => given ?? cameraViewsClient(() => names.current), [given]);
  const [key, setKey] = useState<string | null>(null);
  const [packReady, setPackReady] = useState(true);
  const [error, setError] = useState('');
  const [seen, setSeen] = useState<Record<string, Seen>>({});
  const [paused, setPaused] = useState(false);
  const [cv, setCv] = useState<CvStatus | null>(null);
  const [logins, setLogins] = useState<CameraLogins>({});
  const [testing, setTesting] = useState<TestVideos>({});
  const [perf, setPerf] = useState<ViewsPerf | null>(null);
  /** Drawing a zone on the large view: the frame it is drawn on, held still. */
  const [drawing, setDrawing] = useState<string | null>(null);
  /** The side panel's place for the zone controls while a zone is drawn. */
  const [zoneSlot, setZoneSlot] = useState<HTMLElement | null>(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const takeTouch = useTouches(() => { if (pausedRef.current) setPaused(false); });
  const known = pin !== null || !client.needsPin;
  const live = pick.kind === 'camera' && cameras.some((c) => c.id === pick.id) ? pick.id : null;
  useEffect(() => { setDrawing(null); }, [live]);

  // Performance: every 2 s while the owner watches (the shop server's memory, never stored).
  const perfCb = useRef(onPerf);
  perfCb.current = onPerf;
  useEffect(() => {
    if (!key || paused) { setPerf(null); perfCb.current?.(null); return; }
    let stop = false;
    const look = () => client.perf(key).then((p) => { if (!stop) { setPerf(p); perfCb.current?.(p); } }, () => {});
    void look();
    const t = setInterval(look, PERF_MS);
    return () => { stop = true; clearInterval(t); };
  }, [key, paused, client]);

  /** The shop server checks the PIN; true when it opened. */
  const open = useCallback(async (p: string) => {
    setError('');
    const r = await client.open(p);
    setKey(r.key); setPackReady(r.packReady);
  }, [client]);

  // Open as soon as the PIN is known (or none is needed); close when the page is left.
  useEffect(() => { if (!key && !error && known) open(pin ?? '').catch((e: unknown) => setError(message(e))); }, [key, error, known, pin, open]);
  useEffect(() => {
    if (!key) return;
    const leave = () => client.close(key);
    window.addEventListener('pagehide', leave);
    return () => { window.removeEventListener('pagehide', leave); leave(); };
  }, [key, client]);
  // What the panel's form and the test video need: the kept logins and which camera plays a video.
  useEffect(() => {
    if (!known) return;
    vc.logins(pin ?? '').then(setLogins, () => {});
    vc.testVideos(pin ?? '').then(setTesting, () => {});
  }, [known, pin, vc]);

  const keep = useCallback((id: string, f: ViewFrame) => setSeen((s) => {
    const before = s[id];
    return { ...s, [id]: f.state === 'frame' ? f : { ...f, src: before?.src, seq: before?.seq } };
  }), []);
  const failed = useCallback((e: unknown) => { setError(message(e)); setKey(null); }, []);

  // The tiles: every few seconds, each camera's latest picture (the one in the panel runs live instead).
  const ids = cameras.map((c) => c.id).filter((id) => id !== live).join(' ');
  useEffect(() => {
    if (!key || !packReady || paused) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const round = async () => {
      const use = takeTouch();
      try {
        const got = await Promise.all(ids.split(' ').filter(Boolean).map(async (id) => [id, await client.frame(key, id, { mode: 'tile', after: 0, use })] as const));
        if (stop) return;
        for (const [id, f] of got) keep(id, f);
        if (got.some(([, f]) => f.state === 'pack')) { setPackReady(false); return; }
        if (got.some(([, f]) => f.state === 'paused')) { setPaused(true); return; }
        timer = setTimeout(() => void round(), TILE_MS);
      } catch (e) { if (!stop) failed(e); }
    };
    void round();
    return () => { stop = true; clearTimeout(timer); };
  }, [key, packReady, paused, ids, client, keep, takeTouch, failed]);

  // The panel's camera: the next frame as soon as there is one (the shop server paces it).
  useEffect(() => {
    if (!key || !live || paused || !packReady) return;
    let stop = false;
    void (async () => {
      let after = 0;
      while (!stop) {
        try {
          const f = await client.frame(key, live, { mode: 'live', after, use: takeTouch() });
          if (stop) return;
          keep(live, f);
          if (f.state === 'paused') { setPaused(true); return; }
          if (f.state === 'pack') { setPackReady(false); return; }
          if (f.state === 'frame') after = f.seq;
          else await new Promise((r) => setTimeout(r, RETRY_MS));
        } catch (e) { if (!stop) failed(e); return; }
      }
    })();
    return () => { stop = true; };
  }, [key, live, paused, packReady, client, keep, takeTouch, failed]);

  // The CV pack, activated here: its progress, then the views.
  const activate = () => withPin('activate CV', async (p) => {
    let st = await vc.status(p);
    if (st.phase === 'idle' || st.phase === 'failed') st = await vc.activate(p);
    setCv(st);
  }).catch((e: unknown) => setError(message(e)));
  useEffect(() => {
    if (!busy(cv)) { if (cv?.phase === 'ready') { setPackReady(true); setCv(null); } return; }
    const t = setTimeout(() => { vc.status(pin ?? '').then(setCv, (e: unknown) => setError(message(e))); }, 1000);
    return () => clearTimeout(t);
  }, [cv, pin, vc]);

  // ----- keys: arrows move between tiles, Enter (or a tap) opens one in the panel -----
  const strip = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState(0);
  const onStripKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns(strip.current), ArrowDown: columns(strip.current) }[e.key];
    if (step === undefined) return;
    e.preventDefault();
    const tiles = [...(strip.current?.querySelectorAll<HTMLElement>('.views__tile') ?? [])];
    const next = Math.min(tiles.length - 1, Math.max(0, focused + step));
    setFocused(next);
    tiles[next]?.focus();
  };

  let line: ReactNode = null;
  if (error) line = <p className="setup__error" role="alert">{error} <button type="button" className="chip" onClick={() => setError('')}>Try again</button></p>;
  else if (!known) {
    line = (
      <p className="vision__line">
        <button type="button" className="chip chip--solid" onClick={() => void withPin('watch the cameras', open).catch(() => {})}>Watch the cameras</button>
        <span className="setup__hint">They run only while you watch.</span>
      </p>
    );
  } else if (!packReady) {
    line = busy(cv) ? <CvProgress status={cv!} /> : (
      <p className="vision__line">
        <span>Camera views need the CV pack.</span>
        <button type="button" className="chip chip--solid" onClick={() => void activate()}>{cv?.phase === 'failed' ? 'Retry' : 'Activate CV'}</button>
        {cv?.phase === 'failed' && <span className="setup__error">Activating CV did not work: {cv.reason}.</span>}
      </p>
    );
  } else if (paused) line = <p className="vision__line setup__hint" role="status">Paused to spare the shop PC. Touch the screen or press a key to watch again.</p>;

  // The list may hold lenses not used for CV too (MAX_CAMERA_LIST); the strip scrolls sideways past four.
  const full = cameras.length >= MAX_CAMERA_LIST;
  const addPicked = pick.kind === 'add-camera';
  const cam = live ? cameras.find((c) => c.id === live)! : null;
  const perfOf = (id: string) => perf?.perf?.cameras.find((c) => c.id === id);

  return (
    <section className={`vision__part vstrip${cam ? ' vstrip--large' : ''}`} aria-labelledby="vision-views">
      <div className="vpage__sechead">
        <h2 id="vision-views">{VIEW_WORDS.title.en} <span className="vpage__count num">{cameras.length}</span></h2>
        {!full && <button type="button" className="chip" aria-pressed={addPicked} onClick={() => onPick({ kind: 'add-camera' })}>+ {VIEW_WORDS.add.en}</button>}
      </div>
      {line}
      {cameras.length ? (
        <div ref={strip} className="views__grid" role="group" aria-label="Every camera; Enter opens one large" onKeyDown={onStripKey}>
          {cameras.map((c, i) => {
            const f = seen[c.id];
            const video = testing[c.id];
            const state = video ? 'Test video' : STATUS[f?.state ?? 'starting'];
            return (
              <button key={c.id} type="button" data-view={c.id} tabIndex={i === Math.min(focused, cameras.length - 1) ? 0 : -1}
                className={`views__tile${f?.state === 'offline' && !video ? ' views__tile--off' : ''}`} aria-pressed={live === c.id}
                aria-label={`${c.name}, ${state}. Open large`}
                onFocus={() => setFocused(i)} onClick={() => onPick({ kind: 'camera', id: c.id })}>
                <span className="views__frame"><Picture id={c.id} f={f} alt="" /></span>
                <span className="views__caption"><b>{c.name}</b><Status f={f} video={video} /></span>
              </button>
            );
          })}
        </div>
      ) : <p className="setup__hint">No cameras yet. Add one: Scan finds the ones on the shop Wi-Fi.</p>}

      {cam && (
        <LargeView key={cam.id} camera={cam} f={seen[cam.id]} zones={zones[cam.id] ?? []} tables={tables} detecting={detecting}
          video={testing[cam.id]} drawing={drawing} onDrawn={() => setDrawing(null)} client={vc} withPin={withPin}
          controls={panel ? zoneSlot : undefined} />
      )}

      {panel && cam && createPortal(
        <CameraDetails key={cam.id} camera={cam} f={seen[cam.id]} zones={zones[cam.id] ?? []} tables={tables}
          cameras={cameras} logins={logins} onLogins={setLogins} client={vc} withPin={withPin} video={testing[cam.id]} onTesting={setTesting}
          perf={perfOf(cam.id)} drawing={drawing !== null} onDraw={() => { const src = seen[cam.id]?.src; if (src) setDrawing(src); }} onZoneSlot={setZoneSlot}
          onClose={onClose} onRemoved={onClose} />, panel)}
      {panel && addPicked && createPortal(
        <div className="vpanel__body">
          <PanelHead title="Add a camera" onClose={onClose} />
          <CameraForm client={vc} withPin={withPin} cameras={cameras} camera={null} logins={logins}
            onSaved={(id, l) => { setLogins(l); onPick({ kind: 'camera', id }); }} />
        </div>, panel)}
    </section>
  );
}

export function PanelHead({ title, onClose, children }: { title: string; onClose: () => void; children?: ReactNode }) {
  return (
    <header className="vpanel__head">
      <h2>{title}</h2>
      {children}
      <button type="button" className="vpanel__close" aria-label="Close the panel (Esc)" onClick={onClose}>✕</button>
    </header>
  );
}

/** The picture: the camera's latest frame, or (the demo only) the test video playing in this browser. */
function Picture({ id, f, alt, onAspect }: { id: string; f: Seen | undefined; alt: string; onAspect?: (a: number) => void }) {
  const demoVideo = isDemo() ? demoVideos.get(id) : undefined;
  if (demoVideo) {
    return <video src={demoVideo.url} autoPlay loop muted playsInline aria-label={alt || undefined}
      onLoadedMetadata={(e) => { const v = e.currentTarget; if (v.videoWidth && v.videoHeight) onAspect?.(v.videoWidth / v.videoHeight); }} />;
  }
  if (!f?.src) return <span className="skeleton" aria-hidden="true" />;
  return <img src={f.src} alt={alt} onLoad={(e) => { const i = e.currentTarget; if (i.naturalWidth && i.naturalHeight) onAspect?.(i.naturalWidth / i.naturalHeight); }} />;
}

/**
 * The picked camera, large, in the camera section (owner, 2026-10-27): live with what detection
 * sees; while a zone is drawn, the frame held still with the zone editor on it, big enough to
 * place corners on a table. Its details are in the side panel.
 */
function LargeView({ camera, f, zones, tables, detecting, video, drawing, onDrawn, client, withPin, controls }: {
  camera: CameraSpec; f: Seen | undefined; zones: ZoneSpec[]; tables: FloorTable[]; detecting: boolean; video: string | undefined;
  /** The frame a zone is being drawn on, or null. */
  drawing: string | null; onDrawn: () => void;
  client: VisionClient; withPin: WithPin;
  /** Where the zone controls go: the side panel (undefined: no panel, under the picture). */
  controls: HTMLElement | null | undefined;
}) {
  const now = useNow(1000);
  const [aspect, setAspect] = useState(16 / 9);
  const specs: TableSpec[] = tables.map(({ id, label, seats }) => ({ id, label, seats }));
  if (drawing) {
    return (
      <div className="vlarge vlarge--drawing">
        <ZoneEditor client={client} withPin={withPin} camera={camera} src={drawing} zones={zones} tables={specs} onDone={onDrawn} controls={controls} />
      </div>
    );
  }
  return (
    <figure className="vlarge" aria-label={`${camera.name}, large`}>
      <div className="views__frame views__frame--large" style={{ aspectRatio: String(aspect) }}>
        <Picture id={camera.id} f={f} alt={`${camera.name} now`} onAspect={setAspect} />
        {(f?.src || video) && <DetectionOverlay zones={zones} tables={tables} seen={f?.state === 'frame' && !(isDemo() && video) ? f.seen : undefined} aspect={aspect} />}
      </div>
      {f?.state === 'offline' && !video
        ? <figcaption className="setup__error">{f.message}</figcaption>
        : <figcaption className="views__checked num">
          {isDemo() && video ? 'The demo plays the video here; detection runs on the shop server.' : checkedLine(f?.state === 'frame' ? f.seen : undefined, now, detecting)}
        </figcaption>}
    </figure>
  );
}

/** One camera's details in the side panel: how it is doing now, its zones, its test video, its connection. */
function CameraDetails({ camera, f, zones, tables, cameras, logins, onLogins, client, withPin, video, onTesting, perf, drawing, onDraw, onZoneSlot, onClose, onRemoved }: {
  camera: CameraSpec; f: Seen | undefined; zones: ZoneSpec[]; tables: FloorTable[];
  cameras: CameraSpec[]; logins: CameraLogins; onLogins: (l: CameraLogins) => void;
  client: VisionClient; withPin: WithPin;
  video: string | undefined; onTesting: (t: TestVideos) => void;
  /** This camera's numbers now (undefined: the worker is not running or does not watch it). */
  perf: { fps: number; checksPerS: number; detectMs: number | null } | undefined;
  drawing: boolean; onDraw: () => void;
  /** While a zone is drawn the panel holds only its controls (Close zone, Undo corner, its table): the editor puts them here. */
  onZoneSlot: (el: HTMLElement | null) => void;
  onClose: () => void; onRemoved: () => void;
}) {
  const label = (id: string) => tables.find((t) => t.id === id)?.label ?? '?';
  const picture = isDemo() && demoVideos.has(camera.id) ? null : f?.src ?? null;
  if (drawing) {
    return (
      <div className="vpanel__body">
        <PanelHead title={camera.name} onClose={onClose}><Status f={f} video={video} live /></PanelHead>
        <div ref={onZoneSlot} className="vpanel__zone" />
      </div>
    );
  }
  return (
    <div className="vpanel__body">
      <PanelHead title={camera.name} onClose={onClose}><Status f={f} video={video} live /></PanelHead>
      <dl className="vperf" aria-label={`${camera.name}: performance now`}>
        <div><dt>Frames</dt><dd className="num">{perf ? `${perf.fps} fps` : '–'}</dd></div>
        <div><dt>Checks</dt><dd className="num">{perf ? `${perf.checksPerS}/s` : '–'}</dd></div>
        <div><dt>Detection</dt><dd className="num">{perf?.detectMs != null ? `${perf.detectMs} ms` : '–'}</dd></div>
      </dl>
      {!perf && <p className="setup__hint">Turn CV on, with Use for CV on this camera, to see how it is doing.</p>}
      <div className="vpanel__group">
        <div className="vpanel__row">
          <span className="vpanel__label">Zones</span>
          <button type="button" className="chip chip--solid" disabled={drawing || !picture || !tables.length} onClick={onDraw}
            title={!tables.length ? 'Add the tables first' : !picture ? 'Wait for the picture' : undefined}>{drawing ? 'Drawing on the picture…' : 'Draw a zone'}</button>
        </div>
        <p className="vpanel__text">{zones.length ? zones.map((z) => `Table ${label(z.tableId)}`).join(', ') : 'No zones yet: draw one around each table this camera sees.'}</p>
      </div>
      <TestVideo client={client} withPin={withPin} camera={camera} playing={video} onChange={onTesting} detecting={Boolean(perf)} />
      <details className="vpanel__more">
        <summary>Connection</summary>
        <CameraForm key={`${camera.id}-${logins[camera.id]?.user ?? ''}`} client={client} withPin={withPin} cameras={cameras} camera={camera} logins={logins}
          onSaved={(_id, l) => onLogins(l)} onRemoved={onRemoved} />
      </details>
    </div>
  );
}

function Status({ f, live = false, video }: { f: Seen | undefined; live?: boolean; video?: string }) {
  if (video) return <span className="views__status views__status--test">Test video</span>;
  const state = f?.state ?? 'starting';
  const tone = state === 'frame' ? 'ok' : state === 'offline' ? 'bad' : 'wait';
  return <span className={`views__status views__status--${tone}`}>{live && state === 'frame' ? 'Live' : STATUS[state]}</span>;
}
