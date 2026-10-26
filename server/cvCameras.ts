import { spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createSocket } from 'node:dgram';
import type { EventEmitter } from 'node:events';
import type { Readable } from 'node:stream';
import { rtspUrl, testFailure, type TestCause } from '../src/domain/cameraSetup.ts';

/**
 * Finding and testing cameras for #cameras (SCRUM-171), on the shop server.
 * Scan: one ONVIF WS-Discovery Probe to 239.255.255.250:3702; every camera that answers names
 * its address in XAddrs. Test: the CV pack's ffmpeg.exe takes one frame as a JPEG in memory
 * (nothing is saved); a failure becomes its likely cause, with the login masked.
 */

const WS_DISCOVERY = { address: '239.255.255.250', port: 3702 };

/** The Probe for ONVIF cameras (Types NetworkVideoTransmitter), SOAP 1.2 as ONVIF wants it. */
export const probeXml = (messageId: string): string =>
  '<?xml version="1.0" encoding="UTF-8"?>'
  + '<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope" xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing"'
  + ' xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:dn="http://www.onvif.org/ver10/network/wsdl">'
  + `<e:Header><w:MessageID>${messageId}</w:MessageID>`
  + '<w:To e:mustUnderstand="true">urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To>'
  + '<w:Action e:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action></e:Header>'
  + '<e:Body><d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe></e:Body></e:Envelope>';

export interface FoundCamera { ip: string; name: string }

const tagText = (xml: string, tag: string): string[] =>
  [...xml.matchAll(new RegExp(`<(?:[\\w-]+:)?${tag}\\b[^>]*>([^<]*)</(?:[\\w-]+:)?${tag}>`, 'g'))].map((m) => m[1].trim());

const scope = (scopes: string, key: string): string => {
  const m = new RegExp(`onvif://www\\.onvif\\.org/${key}/(\\S+)`).exec(scopes);
  if (!m) return '';
  try { return decodeURIComponent(m[1]); } catch { return m[1]; }
};

/** The cameras in one ProbeMatches reply: each IPv4 address in XAddrs, and a name from the scopes. */
export const parseProbeMatch = (xml: string): FoundCamera[] => {
  const scopes = tagText(xml, 'Scopes').join(' ');
  const model = scope(scopes, 'name');
  const hardware = scope(scopes, 'hardware');
  const name = hardware && !model.includes(hardware) ? `${model} ${hardware}`.trim() : model;
  const ips = new Set<string>();
  for (const list of tagText(xml, 'XAddrs')) {
    for (const addr of list.split(/\s+/)) {
      try {
        const host = new URL(addr).hostname;
        if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) ips.add(host);
      } catch { /* not a URL */ }
    }
  }
  return [...ips].map((ip) => ({ ip, name }));
};

/** Scan: the cameras that answer the Probe within `waitMs`, by IP. */
export const discover = (waitMs = 3000): Promise<FoundCamera[]> => new Promise((resolve) => {
  const found = new Map<string, FoundCamera>();
  const socket = createSocket({ type: 'udp4', reuseAddr: true });
  const done = () => { try { socket.close(); } catch { /* closed */ } resolve([...found.values()]); };
  socket.on('message', (msg) => { for (const c of parseProbeMatch(msg.toString('utf8'))) if (!found.has(c.ip)) found.set(c.ip, c); });
  socket.on('error', done);
  socket.bind(0, () => {
    const probe = Buffer.from(probeXml(`uuid:${randomUUID()}`));
    // UDP may drop one: send it twice, as ONVIF Device Manager does.
    socket.send(probe, WS_DISCOVERY.port, WS_DISCOVERY.address);
    setTimeout(() => socket.send(probe, WS_DISCOVERY.port, WS_DISCOVERY.address), 200);
    setTimeout(done, waitMs);
  });
});

type Child = EventEmitter & { stdout: Readable; stderr: Readable; kill: () => boolean };
export type Spawn = (command: string, args: string[]) => Child;

export type Snapshot = { ok: true; jpeg: Buffer } | { ok: false; cause: TestCause; message: string };

const MAX_JPEG = 5_000_000;
const MAX_STDERR = 16_000;

/** One frame from the camera as a JPEG in memory. The password is in ffmpeg's arguments only, never in what comes back. */
export const snapshot = (o: {
  ffmpeg: string; camera: { ip: string; rtspPath: string; user?: string; password?: string }; spawn?: Spawn; timeoutMs?: number;
}): Promise<Snapshot> => new Promise((resolve) => {
  const run = o.spawn ?? ((cmd, args) => nodeSpawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }) as unknown as Child);
  const args = [
    '-hide_banner', '-loglevel', 'error', '-rtsp_transport', 'tcp', '-timeout', '5000000',
    '-i', rtspUrl(o.camera), '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'mjpeg', '-q:v', '4', 'pipe:1',
  ];
  const out: Buffer[] = [];
  let outBytes = 0;
  let err = '';
  let timedOut = false;
  let child: Child;
  try { child = run(o.ffmpeg, args); } catch { resolve({ ok: false, ...testFailure('could not start ffmpeg') }); return; }
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, o.timeoutMs ?? 12_000);
  child.stdout.on('data', (c: Buffer) => { outBytes += c.length; if (outBytes <= MAX_JPEG) out.push(c); });
  child.stderr.on('data', (c: Buffer) => { if (err.length < MAX_STDERR) err += c.toString('utf8'); });
  child.on('error', () => { err += '\ncould not start ffmpeg'; });
  child.on('close', (code: number | null) => {
    clearTimeout(timer);
    const jpeg = Buffer.concat(out);
    if (!timedOut && code === 0 && outBytes <= MAX_JPEG && jpeg[0] === 0xff && jpeg[1] === 0xd8) resolve({ ok: true, jpeg });
    else resolve({ ok: false, ...testFailure(err, timedOut) });
  });
});
