import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { parseProbeMatch, probeXml, snapshot, type Spawn } from './cvCameras.ts';

/** A Tapo C200's ProbeMatch, as captured on a shop LAN (trimmed). */
const TAPO = `<?xml version="1.0" encoding="UTF-8"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope" xmlns:wsa="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:wsdd="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:tdn="http://www.onvif.org/ver10/network/wsdl">
<SOAP-ENV:Header><wsa:MessageID>uuid:1419d68a-1dd2-11b2-a105-F0A73100A0B1</wsa:MessageID><wsa:RelatesTo>uuid:5bd4a1b2-0000-4000-8000-000000000001</wsa:RelatesTo></SOAP-ENV:Header>
<SOAP-ENV:Body><wsdd:ProbeMatches><wsdd:ProbeMatch>
<wsa:EndpointReference><wsa:Address>urn:uuid:3fa1fe68-b915-4053-a3e1-f0a73100a0b1</wsa:Address></wsa:EndpointReference>
<wsdd:Types>tdn:NetworkVideoTransmitter</wsdd:Types>
<wsdd:Scopes>onvif://www.onvif.org/name/TP-IPC onvif://www.onvif.org/hardware/C200 onvif://www.onvif.org/Profile/Streaming onvif://www.onvif.org/location/ShenZhen</wsdd:Scopes>
<wsdd:XAddrs>http://192.168.1.20:2020/onvif/device_service</wsdd:XAddrs>
<wsdd:MetadataVersion>1</wsdd:MetadataVersion>
</wsdd:ProbeMatch></wsdd:ProbeMatches></SOAP-ENV:Body></SOAP-ENV:Envelope>`;

/** A Hikvision one: two addresses (IPv4 and IPv6), no prefix on XAddrs. */
const HIK = `<?xml version="1.0" encoding="UTF-8"?><env:Envelope xmlns:env="http://www.w3.org/2003/05/soap-envelope" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery"><env:Body><d:ProbeMatches><d:ProbeMatch>
<d:Scopes>onvif://www.onvif.org/type/video_encoder onvif://www.onvif.org/name/HIKVISION%20DS-2CD1023G0E-I onvif://www.onvif.org/hardware/DS-2CD1023G0E-I</d:Scopes>
<XAddrs>http://192.168.1.64/onvif/device_service http://[fe80::4619:b6ff:fe2c:1a2b]/onvif/device_service</XAddrs>
</d:ProbeMatch></d:ProbeMatches></env:Body></env:Envelope>`;

test('the Probe asks for ONVIF cameras (NetworkVideoTransmitter) with its own message id', () => {
  const xml = probeXml('uuid:5bd4a1b2-0000-4000-8000-000000000001');
  assert.match(xml, /<w:MessageID>uuid:5bd4a1b2-0000-4000-8000-000000000001<\/w:MessageID>/);
  assert.match(xml, /http:\/\/schemas\.xmlsoap\.org\/ws\/2005\/04\/discovery\/Probe/);
  assert.match(xml, /<d:Types>dn:NetworkVideoTransmitter<\/d:Types>/);
  assert.match(xml, /urn:schemas-xmlsoap-org:ws:2005:04:discovery/);
});

test("a ProbeMatch gives the camera's IPv4 address from XAddrs, and its name from the scopes", () => {
  assert.deepEqual(parseProbeMatch(TAPO), [{ ip: '192.168.1.20', name: 'TP-IPC C200' }]);
  assert.deepEqual(parseProbeMatch(HIK), [{ ip: '192.168.1.64', name: 'HIKVISION DS-2CD1023G0E-I' }], 'IPv6 left out; the hardware repeats the name, so once');
  assert.deepEqual(parseProbeMatch('<not xml'), []);
  assert.deepEqual(parseProbeMatch('<XAddrs>http://10.0.0.9:80/onvif</XAddrs>'), [{ ip: '10.0.0.9', name: '' }]);
});

/** A fake ffmpeg: writes `out` and `err`, then exits with `code` (or never, when `hang`). */
function fakeFfmpeg(o: { out?: Buffer; err?: string; code?: number; hang?: boolean }) {
  const calls: string[][] = [];
  let killed = false;
  const spawn: Spawn = (_cmd, args) => {
    calls.push(args);
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => { killed = true; child.emit('close', null); return true; } });
    setImmediate(() => {
      if (o.out) child.stdout.write(o.out);
      if (o.err) child.stderr.write(o.err);
      child.stdout.end(); child.stderr.end();
      if (!o.hang) child.emit('close', o.code ?? 0);
    });
    return child;
  };
  return { spawn, calls, killed: () => killed };
}

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
const cam = { ip: '192.168.1.20', rtspPath: '/stream2', user: 'admin', password: 'hunter2' };

test('Test takes one frame as a JPEG in memory, over TCP, and saves nothing', async () => {
  const ff = fakeFfmpeg({ out: JPEG });
  const r = await snapshot({ ffmpeg: 'C:\\pack\\ffmpeg.exe', camera: cam, spawn: ff.spawn });
  assert.deepEqual(r, { ok: true, jpeg: JPEG });
  const args = ff.calls[0];
  assert.deepEqual(args.slice(args.indexOf('-frames:v'), args.indexOf('-frames:v') + 2), ['-frames:v', '1']);
  assert.equal(args.at(-1), 'pipe:1', 'to memory, never a file');
  assert.ok(args.includes('rtsp://admin:hunter2@192.168.1.20:554/stream2'));
  assert.deepEqual(args.slice(args.indexOf('-rtsp_transport'), args.indexOf('-rtsp_transport') + 2), ['-rtsp_transport', 'tcp']);
});

test('a failed Test says the likely cause, with the password masked out of what ffmpeg said', async () => {
  const login = await snapshot({ ffmpeg: 'ffmpeg', camera: cam, spawn: fakeFfmpeg({ err: 'method DESCRIBE failed: 401 Unauthorized', code: 1 }).spawn });
  assert.equal(login.ok || login.cause, 'login');
  const odd = await snapshot({ ffmpeg: 'ffmpeg', camera: cam, spawn: fakeFfmpeg({ err: 'rtsp://admin:hunter2@192.168.1.20:554/stream2: Invalid data found when processing input', code: 1 }).spawn });
  assert.ok(!odd.ok);
  assert.equal(odd.cause, 'other');
  assert.doesNotMatch(odd.message, /hunter2/);
  assert.match(odd.message, /rtsp:\/\/\*\*\*@192\.168\.1\.20/);
  const notJpeg = await snapshot({ ffmpeg: 'ffmpeg', camera: cam, spawn: fakeFfmpeg({ out: Buffer.from('hello') }).spawn });
  assert.equal(notJpeg.ok, false);
});

test('a camera that never answers is given up after the time limit: RTSP is off or the IP is wrong', async () => {
  const ff = fakeFfmpeg({ hang: true });
  const r = await snapshot({ ffmpeg: 'ffmpeg', camera: cam, spawn: ff.spawn, timeoutMs: 30 });
  assert.equal(r.ok || r.cause, 'rtsp');
  assert.ok(ff.killed());
});
