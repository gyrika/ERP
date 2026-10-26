import { createHash, randomBytes } from 'node:crypto';
import type { TestCause } from '../src/domain/cameraSetup.ts';

/**
 * Asking an ONVIF camera for its own stream address (SCRUM-180), so setup need not guess a path.
 * Device service: GetSystemDateAndTime (the camera's clock, for the digest) and GetCapabilities
 * (where its Media service is); Media service (ver10): GetProfiles, then GetStreamUri for the
 * sub-stream of each video source. A dual-lens camera has two video sources: two streams.
 * SOAP 1.2 over HTTP with a WS-Security UsernameToken digest; the password never travels.
 * The XML helpers are pure (server/onvif.test.ts); `askCamera` is the only one on the network.
 */

const NS = {
  env: 'http://www.w3.org/2003/05/soap-envelope',
  wsse: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd',
  wsu: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd',
  digest: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest',
  b64: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary',
  tds: 'http://www.onvif.org/ver10/device/wsdl',
  trt: 'http://www.onvif.org/ver10/media/wsdl',
  tt: 'http://www.onvif.org/ver10/schema',
};

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** WS-Security's PasswordDigest: Base64(SHA-1(nonce + created + password)). */
export const passwordDigest = (nonce: Buffer, created: string, password: string): string =>
  createHash('sha1').update(Buffer.concat([nonce, Buffer.from(created, 'utf8'), Buffer.from(password, 'utf8')])).digest('base64');

export interface Login { user: string; password: string }

/** The Security header: the username, a fresh nonce, the time (the camera's clock) and the digest. */
export const usernameToken = (login: Login, nonce: Buffer, created: string): string =>
  `<wsse:Security xmlns:wsse="${NS.wsse}" xmlns:wsu="${NS.wsu}" env:mustUnderstand="true"><wsse:UsernameToken>`
  + `<wsse:Username>${esc(login.user)}</wsse:Username>`
  + `<wsse:Password Type="${NS.digest}">${passwordDigest(nonce, created, login.password)}</wsse:Password>`
  + `<wsse:Nonce EncodingType="${NS.b64}">${nonce.toString('base64')}</wsse:Nonce>`
  + `<wsu:Created>${created}</wsu:Created></wsse:UsernameToken></wsse:Security>`;

export const soapEnvelope = (body: string, security = ''): string =>
  `<?xml version="1.0" encoding="UTF-8"?><env:Envelope xmlns:env="${NS.env}" xmlns:tds="${NS.tds}" xmlns:trt="${NS.trt}" xmlns:tt="${NS.tt}">`
  + `<env:Header>${security}</env:Header><env:Body>${body}</env:Body></env:Envelope>`;

export const BODY = {
  time: '<tds:GetSystemDateAndTime/>',
  capabilities: '<tds:GetCapabilities><tds:Category>Media</tds:Category></tds:GetCapabilities>',
  profiles: '<trt:GetProfiles/>',
  streamUri: (profile: string) => '<trt:GetStreamUri><trt:StreamSetup><tt:Stream>RTP-Unicast</tt:Stream>'
    + `<tt:Transport><tt:Protocol>RTSP</tt:Protocol></tt:Transport></trt:StreamSetup><trt:ProfileToken>${esc(profile)}</trt:ProfileToken></trt:GetStreamUri>`,
};

// ----- reading the answers -----

const P = '(?:[\\w-]+:)?';
const unescape = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
/** The first <tag>text</tag>, any prefix, or ''. */
const first = (xml: string, tag: string): string => unescape(new RegExp(`<${P}${tag}\\b[^>]*>([^<]*)</${P}${tag}>`).exec(xml)?.[1].trim() ?? '');
/** Every <tag …>…</tag> block with its attributes, any prefix. */
const blocks = (xml: string, tag: string): { attrs: string; inner: string }[] =>
  [...xml.matchAll(new RegExp(`<${P}${tag}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${P}${tag}>)`, 'g'))].map((m) => ({ attrs: m[1], inner: m[2] ?? '' }));
const attr = (attrs: string, name: string): string => unescape(new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1] ?? '');

/** The camera's clock in UTC (ms), from GetSystemDateAndTime, or null. */
export const parseDeviceTime = (xml: string): number | null => {
  const utc = blocks(xml, 'UTCDateTime')[0]?.inner;
  if (!utc) return null;
  const n = (tag: string) => Number(first(utc, tag));
  const t = Date.UTC(n('Year'), n('Month') - 1, n('Day'), n('Hour'), n('Minute'), n('Second'));
  return Number.isFinite(t) && n('Year') > 2000 ? t : null;
};

/** Where the Media service is, from GetCapabilities, or ''. */
export const parseMediaXAddr = (xml: string): string => {
  const media = blocks(xml, 'Media')[0]?.inner;
  return media ? first(media, 'XAddr') : '';
};

export interface Profile { token: string; name: string; source: string; encoding: string; width: number; height: number }

/** The profiles with a video encoder, from GetProfiles. */
export const parseProfiles = (xml: string): Profile[] => blocks(xml, 'Profiles').flatMap(({ attrs, inner }) => {
  const enc = blocks(inner, 'VideoEncoderConfiguration')[0]?.inner;
  const res = enc ? blocks(enc, 'Resolution')[0]?.inner : undefined;
  const token = attr(attrs, 'token');
  if (!token || !res) return [];
  const source = first(blocks(inner, 'VideoSourceConfiguration')[0]?.inner ?? '', 'SourceToken');
  return [{ token, name: first(inner, 'Name'), source, encoding: first(enc!, 'Encoding'), width: Number(first(res, 'Width')) || 0, height: Number(first(res, 'Height')) || 0 }];
});

/** Wide enough to see people at a table; the smallest such stream is the lightest on the shop PC. */
export const MIN_WIDTH = 640;

/**
 * One stream per video source (a lens), in the camera's order: its smallest profile at least
 * MIN_WIDTH wide (the sub-stream), else its largest.
 */
export const pickStreams = (profiles: readonly Profile[]): Profile[] => {
  const bySource = new Map<string, Profile[]>();
  for (const p of profiles) bySource.set(p.source, [...(bySource.get(p.source) ?? []), p]);
  return [...bySource.values()].map((ps) => {
    const area = (p: Profile) => p.width * p.height;
    const wide = ps.filter((p) => p.width >= MIN_WIDTH).sort((a, b) => area(a) - area(b));
    return wide[0] ?? [...ps].sort((a, b) => area(b) - area(a))[0];
  });
};

export const parseStreamUri = (xml: string): string => first(blocks(xml, 'MediaUri')[0]?.inner ?? '', 'Uri');

/** The SOAP fault's reason, or '' when it is not a fault. */
export const parseFault = (xml: string): string => {
  const fault = blocks(xml, 'Fault')[0]?.inner;
  if (fault === undefined) return '';
  return first(fault, 'Text') || first(fault, 'faultstring') || [...fault.matchAll(/<(?:[\w-]+:)?Value>([^<]*)</g)].map((m) => m[1]).at(-1) || 'fault';
};

/** The camera refused the login (wrong password, or the clock too far out for the digest). */
export const isAuthFault = (reason: string): boolean => /notauthori[sz]ed|not authori[sz]ed|sender not authorized|authority|failedauthentication|unauthori[sz]ed/i.test(reason);

/**
 * The stream's path for setup (as a custom path), from the URI the camera gave: the path and
 * query only, never the host or a login in it. Setup always connects on RTSP's port 554.
 */
export const rtspPathOf = (uri: string): { path: string } | { error: string } => {
  let u: URL;
  try { u = new URL(uri); } catch { return { error: 'the camera gave no stream address' }; }
  if (u.protocol !== 'rtsp:') return { error: 'the camera gave no RTSP address' };
  if (u.port && u.port !== '554') return { error: `the camera streams on port ${u.port}; only 554 works for now` };
  const path = `${u.pathname || '/'}${u.search}`;
  if (path.length > 200 || !/^\/[A-Za-z0-9/_.?=&%-]*$/.test(path)) return { error: 'the camera’s stream path has characters setup cannot keep' };
  return { path };
};

// ----- on the network -----

export interface FoundStream { path: string; label: string; width: number; height: number }
export type Asked = { ok: true; streams: FoundStream[] } | { ok: false; cause: TestCause; message: string };

const ASK_TEXT: Record<'login' | 'rtsp' | 'onvif', string> = {
  login: 'The camera refused the login: check the username and password.',
  rtsp: 'The camera did not answer ONVIF: check the IP address, and that ONVIF is on in the camera’s settings.',
  onvif: 'The camera answered but gave no stream: pick Other and type its path.',
};

/** The usual device-service addresses: port 80, then 8080, then Tapo's 2020. */
export const deviceAddresses = (ip: string, found?: string): string[] => {
  const usual = [`http://${ip}/onvif/device_service`, `http://${ip}:8080/onvif/device_service`, `http://${ip}:2020/onvif/device_service`];
  return found ? [found, ...usual.filter((u) => u !== found)] : usual;
};

/** The same camera: an address the camera hands back must not send our login digest elsewhere. */
const sameHost = (url: string, ip: string): boolean => { try { return new URL(url).hostname === ip; } catch { return false; } };

/**
 * Asks the camera at `ip` for one stream per lens. `xaddr`: its device service from Scan, if known
 * (only used when it is on that same IP). Each call times out after 5 s.
 */
export async function askCamera(o: {
  ip: string; login: Login; xaddr?: string; fetch?: typeof fetch; now?: () => number; nonce?: () => Buffer;
}): Promise<Asked> {
  const http = o.fetch ?? fetch;
  const now = o.now ?? Date.now;
  const nonce = o.nonce ?? (() => randomBytes(16));
  let skew = 0;
  const post = async (url: string, body: string, signed: boolean): Promise<{ status: number; xml: string }> => {
    const created = new Date(now() + skew).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const r = await http(url, {
      method: 'POST', headers: { 'content-type': 'application/soap+xml; charset=utf-8' },
      body: soapEnvelope(body, signed ? usernameToken(o.login, nonce(), created) : ''), signal: AbortSignal.timeout(5000),
    });
    return { status: r.status, xml: await r.text() };
  };
  const failed = (r: { status: number; xml: string }): Asked | null => {
    if (r.status < 400 && !parseFault(r.xml)) return null;
    const reason = parseFault(r.xml);
    return r.status === 401 || isAuthFault(reason) ? { ok: false, cause: 'login', message: ASK_TEXT.login } : { ok: false, cause: 'path', message: ASK_TEXT.onvif };
  };

  // The device service: the first usual address that answers GetSystemDateAndTime (no login needed).
  let device = '';
  for (const url of deviceAddresses(o.ip, o.xaddr && sameHost(o.xaddr, o.ip) ? o.xaddr : undefined)) {
    try {
      const r = await post(url, BODY.time, false);
      const t = parseDeviceTime(r.xml);
      if (r.status < 500 && (t !== null || r.status === 200 || r.status === 401)) { device = url; if (t !== null) skew = t - now(); break; }
    } catch { /* not here */ }
  }
  if (!device) return { ok: false, cause: 'rtsp', message: ASK_TEXT.rtsp };

  try {
    const caps = await post(device, BODY.capabilities, true);
    const no = failed(caps);
    if (no) return no;
    const found = parseMediaXAddr(caps.xml);
    const media = found && sameHost(found, o.ip) ? found : device;
    const profiles = await post(media, BODY.profiles, true);
    const no2 = failed(profiles);
    if (no2) return no2;
    const streams: FoundStream[] = [];
    const picked = pickStreams(parseProfiles(profiles.xml));
    for (const [i, p] of picked.entries()) {
      const r = await post(media, BODY.streamUri(p.token), true);
      const no3 = failed(r);
      if (no3) return no3;
      const path = rtspPathOf(parseStreamUri(r.xml));
      if ('error' in path) return { ok: false, cause: 'path', message: `${path.error[0].toUpperCase()}${path.error.slice(1)}.` };
      streams.push({ path: path.path, label: picked.length > 1 ? `Lens ${i + 1}` : p.name, width: p.width, height: p.height });
    }
    return streams.length ? { ok: true, streams } : { ok: false, cause: 'path', message: ASK_TEXT.onvif };
  } catch {
    return { ok: false, cause: 'rtsp', message: ASK_TEXT.rtsp };
  }
}
