import { MAX_CAMERAS, type CameraSpec, type Point, type TableSpec, type ZoneSpec } from './tables.ts';

/**
 * Setting up the cameras on #cameras (SCRUM-171). Pure: the shop server and the screen both use it.
 * The owner picks a brand (or types a path), gives the login, presses Test, and draws each
 * table's zone on the snapshot. The login never leaves the shop server (server/cvSecrets.ts).
 */

/** The low-resolution stream of each brand: enough for people at tables, light on the shop PC. */
export const RTSP_PRESETS = [
  { brand: 'tapo', label: 'Tapo', path: '/stream2' },
  { brand: 'hikvision', label: 'Hikvision / EZVIZ', path: '/Streaming/Channels/102' },
  { brand: 'dahua', label: 'Dahua / Imou', path: '/cam/realmonitor?channel=1&subtype=1' },
  // A phone as a camera, for trying CV (owner, 2026-10-27): the Android app "IP Webcam" serves RTSP on its port, 8080 by default.
  { brand: 'phone', label: 'Phone (IP Webcam)', path: '/h264_ulaw.sdp' },
] as const;
/** The port a phone app streams on, typed after the IP: "192.168.1.5:8080". */
export const PHONE_PORT = 8080;
/**
 * Brands whose path is asked of the camera itself (ONVIF GetStreamUri, server/onvif.ts) instead of
 * guessed (SCRUM-180). The answer is kept like a custom path. Any ONVIF camera can be asked from Other.
 */
export const ASK_BRANDS = [{ brand: 'tiandy', label: 'Tiandy' }] as const;
export type Brand = (typeof RTSP_PRESETS)[number]['brand'] | (typeof ASK_BRANDS)[number]['brand'] | 'custom';
/** Setup asks the camera for this brand's path, or offers to. */
export const asksCamera = (brand: Brand): boolean => brand === 'custom' || ASK_BRANDS.some((b) => b.brand === brand);

export const presetPath = (brand: Brand): string | null => RTSP_PRESETS.find((p) => p.brand === brand)?.path ?? null;
/** The brand whose path this is ('custom' for any other). */
export const brandOf = (path: string): Brand => RTSP_PRESETS.find((p) => p.path === path)?.brand ?? 'custom';

/** "192.168.1.5:8080" → the host and the port; RTSP's own port, 554, when none is typed. */
export const hostPort = (ip: string): { host: string; port: number } => {
  const m = /^(.*):(\d{1,5})$/.exec(ip.trim());
  return m ? { host: m[1], port: Number(m[2]) } : { host: ip.trim(), port: 554 };
};

/** The stream's address with its login, for ffmpeg only: never shown, logged or stored. */
export const rtspUrl = (c: { ip: string; rtspPath: string; user?: string; password?: string }): string => {
  const login = c.user ? `${encodeURIComponent(c.user)}${c.password ? `:${encodeURIComponent(c.password)}` : ''}@` : '';
  const path = c.rtspPath.startsWith('/') ? c.rtspPath : `/${c.rtspPath}`;
  const { host, port } = hostPort(c.ip);
  return `rtsp://${login}${host}:${port}${path}`;
};

/** Any `user:pass@` in a URL in this text becomes `***@`, so ffmpeg's words can be shown. */
export const maskLogins = (text: string): string => text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]*@/gi, '$1***@');

export type TestCause = 'login' | 'rtsp' | 'path' | 'pack' | 'other';
export const CAUSE_TEXT: Record<TestCause, string> = {
  login: 'The camera refused the login: check the username and password (on Tapo, the camera account made in the Tapo app).',
  rtsp: 'The camera did not answer: check the IP address (and its port, like :8080 for a phone), and turn RTSP on in the camera’s app.',
  path: 'The camera has no stream at that path: pick its brand, or check the custom path.',
  pack: 'Activate CV first: Test needs the CV pack.',
  other: 'The camera did not send a picture.',
};

/** What went wrong, from ffmpeg's error output (or our own time limit). */
export const ffmpegCause = (stderr: string, timedOut = false): TestCause => {
  if (/\b401\b|unauthori[sz]ed/i.test(stderr)) return 'login';
  if (/\b404\b|not found|no such file/i.test(stderr)) return 'path';
  // Windows builds often give only the number: 138 ETIMEDOUT, 107 ECONNREFUSED, 10060/10061/10065 their Winsock forms.
  if (timedOut || /connection refused|timed out|timeout|no route to host|network is unreachable|host is down|connection reset|error number -(138|107|10060|10061|10065)\b/i.test(stderr)) return 'rtsp';
  return 'other';
};

/** The words for a failed Test: the cause, and for 'other' ffmpeg's last line with every login masked. */
export const testFailure = (stderr: string, timedOut = false): { cause: TestCause; message: string } => {
  const cause = ffmpegCause(stderr, timedOut);
  if (cause !== 'other') return { cause, message: CAUSE_TEXT[cause] };
  const last = maskLogins(stderr).trim().split(/\r?\n/).filter(Boolean).at(-1)?.slice(0, 200);
  return { cause, message: last ? `${CAUSE_TEXT.other} ffmpeg said: ${last}` : CAUSE_TEXT.other };
};

// ----- The 4-camera limit -----

export const LIMIT_TEXT = `Limit ${MAX_CAMERAS} cameras - turn one off first`;
/** May this camera's "Use for CV" go on? Only while fewer than MAX_CAMERAS others are on. */
export const mayUse = (cameras: readonly Pick<CameraSpec, 'id' | 'enabled'>[], id: string): boolean =>
  cameras.filter((c) => c.enabled && c.id !== id).length < MAX_CAMERAS;

// ----- Live needs a camera and a zone; tables without one are staff's -----

/** Tables no enabled camera has a zone on. */
export const tablesWithoutZone = (tables: readonly TableSpec[], cameras: readonly CameraSpec[], zones: Record<string, readonly ZoneSpec[]>): TableSpec[] => {
  const seen = new Set(cameras.filter((c) => c.enabled).flatMap((c) => (zones[c.id] ?? []).map((z) => z.tableId)));
  return tables.filter((t) => !seen.has(t.id));
};

const tableNames = (ts: readonly TableSpec[]) => {
  const names = ts.map((t) => t.label);
  return `${ts.length === 1 ? 'Table' : 'Tables'} ${names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]}`;
};

/**
 * Why CV cannot be turned on yet, or null. With Shadow gone (owner, 2026-10-27) On is Live, so it
 * needs one table the cameras can see, not every table: the others stay staff's (`unzonedNote`).
 */
export const liveBlocked = (tables: readonly TableSpec[], cameras: readonly CameraSpec[], zones: Record<string, readonly ZoneSpec[]>): string | null => {
  if (!tables.length) return 'Add the tables first.';
  if (!cameras.some((c) => c.enabled)) return 'Turn on "Use for CV" for a camera first.';
  if (tablesWithoutZone(tables, cameras, zones).length === tables.length) return 'Draw a zone on a table first.';
  return null;
};

/** The tables the cameras cannot see, said plainly: staff set them on the floor. Null when every table has a zone. */
export const unzonedNote = (tables: readonly TableSpec[], cameras: readonly CameraSpec[], zones: Record<string, readonly ZoneSpec[]>): string | null => {
  const missing = tablesWithoutZone(tables, cameras, zones);
  if (!missing.length || missing.length === tables.length) return null;
  return `${tableNames(missing)} ${missing.length === 1 ? 'has' : 'have'} no zone: staff set ${missing.length === 1 ? 'it' : 'them'}.`;
};

// ----- Drawing a zone -----

export const MIN_ZONE_POINTS = 3;
export const MAX_ZONE_POINTS = 32;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const round4 = (v: number) => Math.round(v * 10_000) / 10_000;

/** A click on the shown frame → a point normalised 0-1 to the frame, whatever size it is shown at. */
export const normalisePoint = (clientX: number, clientY: number, frame: { left: number; top: number; width: number; height: number }): Point => ({
  x: round4(clamp01((clientX - frame.left) / frame.width)),
  y: round4(clamp01((clientY - frame.top) / frame.height)),
});

/** Adds a point, unless it repeats the last one or the zone is full. */
export const addPoint = (points: readonly Point[], p: Point): Point[] => {
  const last = points.at(-1);
  if (points.length >= MAX_ZONE_POINTS || (last && last.x === p.x && last.y === p.y)) return [...points];
  return [...points, { x: round4(clamp01(p.x)), y: round4(clamp01(p.y)) }];
};

/** Enter: the drawn points as a closed zone, or null while there are too few (or they lie on one line). */
export const closePolygon = (points: readonly Point[]): Point[] | null => {
  const ps = points.filter((p, i) => i === 0 || p.x !== points[i - 1].x || p.y !== points[i - 1].y);
  const first = ps[0], last = ps.at(-1);
  if (ps.length > 1 && first && last && first.x === last.x && first.y === last.y) ps.pop(); // clicked the first point again
  if (ps.length < MIN_ZONE_POINTS || ps.length > MAX_ZONE_POINTS) return null;
  let area = 0;
  for (let i = 0, j = ps.length - 1; i < ps.length; j = i++) area += (ps[j].x + ps[i].x) * (ps[j].y - ps[i].y);
  return Math.abs(area) / 2 > 1e-6 ? ps : null;
};
