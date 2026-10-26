import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { CameraSpec, FloorTable, ZoneSpec } from '../../domain/tables.ts';
import { cameraViewsClient, type CameraViewsClient, type ViewFrame } from '../../services/cameraViews.ts';
import type { CvStatus } from '../../services/setupClient.ts';
import { visionClient } from '../../services/visionClient.ts';
import { CvProgress } from '../cameras/CvProgress.tsx';
import { columns } from '../floor/FloorTile.tsx';
import { useNow } from '../Kitchen.tsx';
import { checkedLine, DetectionOverlay } from './DetectionOverlay.tsx';
import { PinLine } from './PinLine.tsx';

/**
 * Camera views (#vision, SCRUM-180). Mind: the owner, who wants to see the shop's cameras before
 * trusting any detection. They know where each camera hangs; the single next thing they need is
 * every camera's picture, live, in one place. A tile per camera (every one in Cameras setup, each
 * lens of a dual-lens camera its own), its name and whether it is online, a picture every few
 * seconds; Enter or a tap opens one large at a few frames a second, Esc goes back. The shop
 * server runs ffmpeg only while this is on screen and touched (server/cvLive.ts); after 2 minutes
 * untouched it pauses until the next touch. Shop PC only, behind the owner's PIN: the cloud and
 * owner-phone builds leave this file out. The large view also draws what detection sees there
 * (SCRUM-175): the zones in their table's colour, people boxes, scores and foot points.
 */

const TILE_MS = 3000;
const RETRY_MS = 1000;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const busy = (s: CvStatus | null) => s?.phase === 'downloading' || s?.phase === 'verifying';

type Seen = ViewFrame & { src?: string; seq?: number };

const STATUS: Record<ViewFrame['state'], string> = {
  frame: 'Online', starting: 'Connecting…', offline: 'Offline', busy: 'Open it to watch', paused: 'Paused', pack: 'Needs the CV pack', unknown: 'Save it in Cameras setup first',
};
/** Labels; Sinhala and Tamil stay empty until the owner gives them. */
export const VIEW_WORDS = {
  title: { en: 'Camera views', si: '', ta: '' },
  back: { en: 'Back', si: '', ta: '' },
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

export default function CameraViews({ cameras, zones = {}, tables = [], pin, onPin, client: given }: {
  /** Every camera in Cameras setup, used for CV or not. */
  cameras: CameraSpec[];
  /** Each camera's zones and the floor, for the large view's overlay. */
  zones?: Record<string, ZoneSpec[]>;
  tables?: FloorTable[];
  /** The owner's PIN, once typed on this page (shared with the Off / Shadow / Live switch). */
  pin: string | null;
  onPin: (pin: string) => void;
  client?: CameraViewsClient;
}) {
  const names = useRef(new Map<string, string>());
  names.current = new Map(cameras.map((c) => [c.id, c.name]));
  const client = useMemo(() => given ?? cameraViewsClient(() => names.current), [given]);
  const [key, setKey] = useState<string | null>(null);
  const [packReady, setPackReady] = useState(true);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState('');
  const [seen, setSeen] = useState<Record<string, Seen>>({});
  const [large, setLarge] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [cv, setCv] = useState<CvStatus | null>(null);
  const [aspect, setAspect] = useState(16 / 9);
  const now = useNow(1000);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const takeTouch = useTouches(() => { if (pausedRef.current) setPaused(false); });

  /** The shop server checks the PIN; true when it opened. */
  const open = useCallback(async (p: string): Promise<boolean> => {
    setError('');
    try {
      const r = await client.open(p);
      setKey(r.key); setPackReady(r.packReady);
      return true;
    } catch (e) { setError(message(e)); return false; }
  }, [client]);

  // Open as soon as the PIN is known (or none is needed); close when the page is left.
  useEffect(() => { if (!key && !error && (pin !== null || !client.needsPin)) void open(pin ?? ''); }, [key, error, pin, client, open]);
  useEffect(() => {
    if (!key) return;
    const leave = () => client.close(key);
    window.addEventListener('pagehide', leave);
    return () => { window.removeEventListener('pagehide', leave); leave(); };
  }, [key, client]);

  const keep = useCallback((id: string, f: ViewFrame) => setSeen((s) => {
    const before = s[id];
    return { ...s, [id]: f.state === 'frame' ? f : { ...f, src: before?.src, seq: before?.seq } };
  }), []);
  const failed = useCallback((e: unknown) => { setError(message(e)); setKey(null); }, []);

  // The tiles: every few seconds, each camera's latest picture.
  const ids = cameras.map((c) => c.id).join(' ');
  useEffect(() => {
    if (!key || !packReady || large || paused) return;
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
  }, [key, packReady, large, paused, ids, client, keep, takeTouch, failed]);

  // The large view: the next frame as soon as there is one (the shop server paces it).
  useEffect(() => {
    if (!key || !large || paused) return;
    let stop = false;
    void (async () => {
      let after = 0;
      while (!stop) {
        try {
          const f = await client.frame(key, large, { mode: 'live', after, use: takeTouch() });
          if (stop) return;
          keep(large, f);
          if (f.state === 'paused') { setPaused(true); return; }
          if (f.state === 'pack') { setPackReady(false); return; }
          if (f.state === 'frame') after = f.seq;
          else await new Promise((r) => setTimeout(r, RETRY_MS));
        } catch (e) { if (!stop) failed(e); return; }
      }
    })();
    return () => { stop = true; };
  }, [key, large, paused, client, keep, takeTouch, failed]);

  // The CV pack, activated here as on #cameras: its progress, then the views.
  const activate = async () => {
    setError('');
    const vc = visionClient();
    try {
      let st = await vc.status(pin ?? '');
      if (st.phase === 'idle' || st.phase === 'failed') st = await vc.activate(pin ?? '');
      setCv(st);
    } catch (e) { setError(message(e)); }
  };
  useEffect(() => {
    if (!busy(cv)) { if (cv?.phase === 'ready') { setPackReady(true); setCv(null); } return; }
    const t = setTimeout(() => { visionClient().status(pin ?? '').then(setCv, (e: unknown) => setError(message(e))); }, 1000);
    return () => clearTimeout(t);
  }, [cv, pin]);

  // ----- keys: arrows move between tiles, Enter opens, Esc goes back -----
  const grid = useRef<HTMLDivElement>(null);
  const [picked, setPicked] = useState(0);
  const back = useRef<HTMLButtonElement>(null);
  const returnTo = useRef<string | null>(null);
  const close = useCallback(() => { returnTo.current = large; setLarge(null); }, [large]);
  useEffect(() => {
    if (large) { back.current?.focus(); return; }
    if (!returnTo.current) return;
    const id = returnTo.current;
    ([...(grid.current?.children ?? [])] as HTMLElement[]).find((t) => t.dataset.view === id)?.focus();
    returnTo.current = null;
  }, [large]);
  useEffect(() => {
    if (!large) return;
    const esc = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [large, close]);
  const onGridKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns(grid.current), ArrowDown: columns(grid.current) }[e.key];
    if (step === undefined) return;
    e.preventDefault();
    const next = Math.min(cameras.length - 1, Math.max(0, picked + step));
    setPicked(next);
    (grid.current?.children[next] as HTMLElement | undefined)?.focus();
  };

  let body;
  if (!cameras.length) {
    body = <p className="setup__hint">No cameras yet. <a href="#cameras" className="vision__link">Set up cameras</a></p>;
  } else if (!key) {
    body = asking
      ? <PinLine what="watch the cameras" onPin={(p) => { setAsking(false); void open(p).then((ok) => { if (ok) onPin(p); }); }} onCancel={() => setAsking(false)} />
      : (
        <p className="vision__line">
          <button type="button" className="chip chip--solid" onClick={() => (pin === null && client.needsPin ? setAsking(true) : void open(pin ?? ''))}>Watch the cameras</button>
          <span className="setup__hint">{cameras.length} {cameras.length === 1 ? 'view' : 'views'}. They run only while you watch.</span>
        </p>
      );
  } else if (!packReady) {
    body = busy(cv) ? <CvProgress status={cv!} /> : (
      <p className="vision__line">
        <span>Camera views need the CV pack.</span>
        <button type="button" className="chip chip--solid" onClick={() => void activate()}>{cv?.phase === 'failed' ? 'Retry' : 'Activate CV'}</button>
        {cv?.phase === 'failed' && <span className="setup__error">Activating CV did not work: {cv.reason}.</span>}
      </p>
    );
  } else if (large) {
    const cam = cameras.find((c) => c.id === large);
    const f = seen[large];
    body = (
      <figure className="views__large" aria-label={`${cam?.name ?? 'Camera'}, large`}>
        <div className="views__head">
          <button ref={back} type="button" className="chip" onClick={close}>{VIEW_WORDS.back.en} <kbd>Esc</kbd></button>
          <b>{cam?.name}</b>
          <Status f={f} live />
        </div>
        <div className="views__frame views__frame--large">
          {f?.src ? <>
            <img src={f.src} alt={`${cam?.name ?? 'The camera'} now`}
              onLoad={(e) => { const i = e.currentTarget; if (i.naturalWidth && i.naturalHeight) setAspect(i.naturalWidth / i.naturalHeight); }} />
            <DetectionOverlay zones={zones[large] ?? []} tables={tables} seen={f.state === 'frame' ? f.seen : undefined} aspect={aspect} />
          </> : <div className="skeleton" aria-hidden="true" />}
        </div>
        {f?.state === 'offline'
          ? <figcaption className="setup__error">{f.message}</figcaption>
          : <figcaption className="views__checked num">{checkedLine(f?.state === 'frame' ? f.seen : undefined, now)}</figcaption>}
      </figure>
    );
  } else {
    body = (
      <div ref={grid} className="views__grid" role="group" aria-label="Every camera; Enter opens one large" onKeyDown={onGridKey}>
        {cameras.map((c, i) => {
          const f = seen[c.id];
          return (
            <button key={c.id} type="button" data-view={c.id} tabIndex={i === Math.min(picked, cameras.length - 1) ? 0 : -1}
              className={`views__tile${f?.state === 'offline' ? ' views__tile--off' : ''}`}
              aria-label={`${c.name}, ${STATUS[f?.state ?? 'starting']}. Open large`}
              onFocus={() => setPicked(i)} onClick={() => { setPicked(i); setLarge(c.id); }}>
              <span className="views__frame">
                {f?.src ? <img src={f.src} alt="" /> : <span className="skeleton" aria-hidden="true" />}
              </span>
              <span className="views__caption"><b>{c.name}</b><Status f={f} /></span>
              {f?.state === 'offline' && <span className="views__why">{f.message}</span>}
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <section className="vision__part views" aria-labelledby="vision-views">
      <h2 id="vision-views">{VIEW_WORDS.title.en}</h2>
      {body}
      {key && paused && <p className="vision__line setup__hint" role="status">Paused to spare the shop PC. Touch the screen or press a key to watch again.</p>}
      {error && <p className="setup__error" role="alert">{error}</p>}
    </section>
  );
}

function Status({ f, live = false }: { f: Seen | undefined; live?: boolean }) {
  const state = f?.state ?? 'starting';
  const tone = state === 'frame' ? 'ok' : state === 'offline' ? 'bad' : 'wait';
  return <span className={`views__status views__status--${tone}`}>{live && state === 'frame' ? 'Live' : STATUS[state]}</span>;
}
