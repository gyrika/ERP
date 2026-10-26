import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  askCamera, BODY, deviceAddresses, isAuthFault, parseDeviceTime, parseFault, parseMediaXAddr, parseProfiles, parseStreamUri,
  passwordDigest, pickStreams, rtspPathOf, soapEnvelope, usernameToken,
} from './onvif.ts';

/** The ONVIF Core spec's own example: nonce, created and password give this digest. */
test('the password digest is Base64(SHA-1(nonce + created + password)), as WS-Security says', () => {
  const nonce = Buffer.from('LKqI6G/AikKCQrN0zqZFlg==', 'base64');
  assert.equal(passwordDigest(nonce, '2010-09-16T07:50:45Z', 'userpassword'), 'tuOSpGlFlIXsozq4HFNeeGeFLEI=');
});

test('the Security header carries the user, the digest, the nonce and the time, never the password', () => {
  const nonce = Buffer.from('LKqI6G/AikKCQrN0zqZFlg==', 'base64');
  const xml = usernameToken({ user: 'admin<&>', password: 'userpassword' }, nonce, '2010-09-16T07:50:45Z');
  assert.match(xml, /<wsse:Username>admin&lt;&amp;&gt;<\/wsse:Username>/);
  assert.match(xml, /#PasswordDigest">tuOSpGlFlIXsozq4HFNeeGeFLEI=<\/wsse:Password>/);
  assert.match(xml, /<wsse:Nonce [^>]*>LKqI6G\/AikKCQrN0zqZFlg==<\/wsse:Nonce>/);
  assert.match(xml, /<wsu:Created>2010-09-16T07:50:45Z<\/wsu:Created>/);
  assert.doesNotMatch(xml, /userpassword/);
  const env = soapEnvelope(BODY.profiles, xml);
  assert.match(env, /^<\?xml[^>]*\?><env:Envelope xmlns:env="http:\/\/www\.w3\.org\/2003\/05\/soap-envelope"/);
  assert.match(env, /<env:Header><wsse:Security[\s\S]*<\/env:Header><env:Body><trt:GetProfiles\/><\/env:Body>/);
  assert.match(soapEnvelope(BODY.streamUri('Profile_102')), /<tt:Protocol>RTSP<\/tt:Protocol>[\s\S]*<trt:ProfileToken>Profile_102<\/trt:ProfileToken>/);
});

const TIME = `<?xml version="1.0"?><SOAP-ENV:Envelope xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope" xmlns:tds="http://www.onvif.org/ver10/device/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema"><SOAP-ENV:Body>
<tds:GetSystemDateAndTimeResponse><tds:SystemDateAndTime><tt:DateTimeType>NTP</tt:DateTimeType><tt:DaylightSavings>false</tt:DaylightSavings>
<tt:TimeZone><tt:TZ>CST-5:30</tt:TZ></tt:TimeZone>
<tt:UTCDateTime><tt:Time><tt:Hour>8</tt:Hour><tt:Minute>5</tt:Minute><tt:Second>9</tt:Second></tt:Time><tt:Date><tt:Year>2026</tt:Year><tt:Month>10</tt:Month><tt:Day>26</tt:Day></tt:Date></tt:UTCDateTime>
<tt:LocalDateTime><tt:Time><tt:Hour>13</tt:Hour><tt:Minute>35</tt:Minute><tt:Second>9</tt:Second></tt:Time><tt:Date><tt:Year>2026</tt:Year><tt:Month>10</tt:Month><tt:Day>26</tt:Day></tt:Date></tt:LocalDateTime>
</tds:SystemDateAndTime></tds:GetSystemDateAndTimeResponse></SOAP-ENV:Body></SOAP-ENV:Envelope>`;

const CAPS = `<?xml version="1.0"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body><tds:GetCapabilitiesResponse xmlns:tds="http://www.onvif.org/ver10/device/wsdl"><tds:Capabilities>
<tt:Media xmlns:tt="http://www.onvif.org/ver10/schema"><tt:XAddr>http://192.168.1.31:80/onvif/Media</tt:XAddr><tt:StreamingCapabilities><tt:RTPMulticast>false</tt:RTPMulticast></tt:StreamingCapabilities></tt:Media>
</tds:Capabilities></tds:GetCapabilitiesResponse></s:Body></s:Envelope>`;

const profile = (token: string, name: string, source: string, w: number, h: number, enc = 'H264') =>
  `<trt:Profiles token="${token}" fixed="true"><tt:Name>${name}</tt:Name>
<tt:VideoSourceConfiguration token="VSC_${source}"><tt:Name>VSC</tt:Name><tt:UseCount>3</tt:UseCount><tt:SourceToken>${source}</tt:SourceToken><tt:Bounds x="0" y="0" width="2560" height="1440"/></tt:VideoSourceConfiguration>
<tt:AudioSourceConfiguration token="ASC"><tt:Name>ASC</tt:Name><tt:SourceToken>Audio_1</tt:SourceToken></tt:AudioSourceConfiguration>
<tt:VideoEncoderConfiguration token="VEC_${token}"><tt:Name>VEC</tt:Name><tt:UseCount>1</tt:UseCount><tt:Encoding>${enc}</tt:Encoding>
<tt:Resolution><tt:Width>${w}</tt:Width><tt:Height>${h}</tt:Height></tt:Resolution><tt:Quality>4</tt:Quality>
<tt:RateControl><tt:FrameRateLimit>25</tt:FrameRateLimit><tt:EncodingInterval>1</tt:EncodingInterval><tt:BitrateLimit>4096</tt:BitrateLimit></tt:RateControl></tt:VideoEncoderConfiguration>
</trt:Profiles>`;

/** A dual-lens Tiandy (TC-C32 style): two video sources, each a main, sub and third stream. */
const TIANDY_DUAL = `<?xml version="1.0" encoding="UTF-8"?><SOAP-ENV:Envelope xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope" xmlns:trt="http://www.onvif.org/ver10/media/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema"><SOAP-ENV:Body><trt:GetProfilesResponse>
${profile('profile_1_main', 'mainStream', 'VideoSource_1', 2560, 1440, 'H265')}
${profile('profile_1_sub', 'subStream', 'VideoSource_1', 640, 360)}
${profile('profile_1_third', 'thirdStream', 'VideoSource_1', 352, 288)}
${profile('profile_2_main', 'mainStream', 'VideoSource_2', 2560, 1440, 'H265')}
${profile('profile_2_sub', 'subStream', 'VideoSource_2', 704, 576)}
<trt:Profiles token="profile_audio_only" fixed="false"><tt:Name>audio</tt:Name></trt:Profiles>
</trt:GetProfilesResponse></SOAP-ENV:Body></SOAP-ENV:Envelope>`;

const uri = (u: string) => `<?xml version="1.0"?><env:Envelope xmlns:env="http://www.w3.org/2003/05/soap-envelope"><env:Body><trt:GetStreamUriResponse xmlns:trt="http://www.onvif.org/ver10/media/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema">
<trt:MediaUri><tt:Uri>${u}</tt:Uri><tt:InvalidAfterConnect>false</tt:InvalidAfterConnect><tt:InvalidAfterReboot>false</tt:InvalidAfterReboot><tt:Timeout>PT60S</tt:Timeout></trt:MediaUri>
</trt:GetStreamUriResponse></env:Body></env:Envelope>`;

const FAULT = `<?xml version="1.0"?><env:Envelope xmlns:env="http://www.w3.org/2003/05/soap-envelope" xmlns:ter="http://www.onvif.org/ver10/error"><env:Body><env:Fault>
<env:Code><env:Value>env:Sender</env:Value><env:Subcode><env:Value>ter:NotAuthorized</env:Value></env:Subcode></env:Code>
<env:Reason><env:Text xml:lang="en">Sender not Authorized</env:Text></env:Reason></env:Fault></env:Body></env:Envelope>`;

test("the camera's clock, its Media address, and a fault are read from its answers", () => {
  assert.equal(parseDeviceTime(TIME), Date.UTC(2026, 9, 26, 8, 5, 9), 'UTC, not the local time');
  assert.equal(parseDeviceTime('<x/>'), null);
  assert.equal(parseMediaXAddr(CAPS), 'http://192.168.1.31:80/onvif/Media');
  assert.equal(parseMediaXAddr('<x/>'), '');
  assert.equal(parseFault(FAULT), 'Sender not Authorized');
  assert.ok(isAuthFault(parseFault(FAULT)));
  assert.equal(parseFault(TIME), '');
  assert.ok(!isAuthFault('Action not supported'));
});

test('profiles: one stream per lens, the sub-stream (smallest at least 640 wide), audio-only ones left out', () => {
  const ps = parseProfiles(TIANDY_DUAL);
  assert.equal(ps.length, 5);
  assert.deepEqual(ps[1], { token: 'profile_1_sub', name: 'subStream', source: 'VideoSource_1', encoding: 'H264', width: 640, height: 360 });
  assert.deepEqual(pickStreams(ps).map((p) => p.token), ['profile_1_sub', 'profile_2_sub'], 'two lenses, two streams; the 352 third stream is too small');
  const single = parseProfiles(`<r>${profile('main', 'main', 'V', 1920, 1080)}${profile('tiny', 'third', 'V', 320, 240)}</r>`);
  assert.deepEqual(pickStreams(single).map((p) => p.token), ['main'], 'nothing 640 wide but the main: the largest');
  assert.deepEqual(pickStreams([]), []);
});

test("the stream URI becomes a path setup keeps: no host, no login, only on 554", () => {
  assert.equal(parseStreamUri(uri('rtsp://192.168.1.31:554/1/2?transmode=unicast&amp;profile=vam')), 'rtsp://192.168.1.31:554/1/2?transmode=unicast&profile=vam');
  assert.deepEqual(rtspPathOf('rtsp://192.168.1.31:554/1/2?transmode=unicast&profile=vam'), { path: '/1/2?transmode=unicast&profile=vam' });
  assert.deepEqual(rtspPathOf('rtsp://admin:secret@192.168.1.31/Streaming/Channels/102'), { path: '/Streaming/Channels/102' }, 'the login is dropped');
  assert.match((rtspPathOf('rtsp://192.168.1.31:8554/live') as { error: string }).error, /port 8554/);
  assert.ok('error' in rtspPathOf('http://192.168.1.31/snap.jpg'));
  assert.ok('error' in rtspPathOf(''));
  assert.ok('error' in rtspPathOf('rtsp://192.168.1.31/a b|c'));
});

test('the device service is looked for where Scan found it first, then at the usual ports', () => {
  assert.deepEqual(deviceAddresses('10.0.0.5'), ['http://10.0.0.5/onvif/device_service', 'http://10.0.0.5:8080/onvif/device_service', 'http://10.0.0.5:2020/onvif/device_service']);
  assert.equal(deviceAddresses('10.0.0.5', 'http://10.0.0.5:8000/onvif/device_service')[0], 'http://10.0.0.5:8000/onvif/device_service');
});

/** A fake camera on port 80: answers each request by its body; records what was sent. */
const fakeCamera = (answer: (body: string, url: string) => { status?: number; xml: string } | 'down') => {
  const sent: { url: string; body: string }[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = String(init?.body ?? '');
    sent.push({ url: String(url), body });
    const a = answer(body, String(url));
    if (a === 'down') throw new TypeError('fetch failed');
    return new Response(a.xml, { status: a.status ?? 200 });
  }) as typeof fetch;
  return { f, sent };
};

test('Ask the camera: clock, capabilities, profiles, then one URI per lens; the password never on the wire', async () => {
  const cam = fakeCamera((body, url) => {
    if (new URL(url).hostname !== '192.168.1.31' || new URL(url).port === '8080') return 'down';
    if (body.includes('GetSystemDateAndTime')) return { xml: TIME };
    if (body.includes('GetCapabilities')) return { xml: CAPS };
    if (body.includes('GetProfiles')) return { xml: TIANDY_DUAL };
    const lens = /<trt:ProfileToken>profile_(\d)_sub</.exec(body)?.[1];
    return { xml: uri(`rtsp://192.168.1.31:554/${lens}/2?transmode=unicast&amp;profile=vam`) };
  });
  const now = Date.UTC(2026, 9, 26, 8, 0, 0); // the PC is 5 min 9 s behind the camera
  const r = await askCamera({ ip: '192.168.1.31', login: { user: 'admin', password: 'Sup3r-secret' }, fetch: cam.f, now: () => now, nonce: () => Buffer.alloc(16, 7) });
  assert.deepEqual(r, { ok: true, streams: [
    { path: '/1/2?transmode=unicast&profile=vam', label: 'Lens 1', width: 640, height: 360 },
    { path: '/2/2?transmode=unicast&profile=vam', label: 'Lens 2', width: 704, height: 576 },
  ] });
  assert.ok(cam.sent.every((s) => !s.body.includes('Sup3r-secret')));
  assert.doesNotMatch(cam.sent[0].body, /Security/, 'the clock is asked without a login');
  assert.match(cam.sent[1].body, /<wsu:Created>2026-10-26T08:05:09Z<\/wsu:Created>/, 'the digest uses the cameraâ€™s clock');
  assert.deepEqual(cam.sent.slice(2).map((s) => s.url), Array(3).fill('http://192.168.1.31:80/onvif/Media'));
});

test('Ask the camera: a refused login, nobody there, and a Media address on another host', async () => {
  const refused = fakeCamera((body) => (body.includes('GetSystemDateAndTime') ? { xml: TIME } : { status: 400, xml: FAULT }));
  assert.equal((await askCamera({ ip: '10.0.0.9', login: { user: 'a', password: 'b' }, fetch: refused.f })).ok, false);
  const r1 = await askCamera({ ip: '10.0.0.9', login: { user: 'a', password: 'b' }, fetch: refused.f });
  assert.deepEqual(r1.ok ? null : r1.cause, 'login');

  const down = fakeCamera(() => 'down');
  const r2 = await askCamera({ ip: '10.0.0.9', login: { user: 'a', password: 'b' }, fetch: down.f });
  assert.deepEqual(r2.ok ? null : r2.cause, 'rtsp');
  assert.equal(down.sent.length, 3, 'ports 80, 8080 and 2020 tried');

  const elsewhere = fakeCamera((body, url) => {
    if (body.includes('GetSystemDateAndTime')) return { xml: TIME };
    if (body.includes('GetCapabilities')) return { xml: CAPS.replace('192.168.1.31', '203.0.113.9') };
    if (body.includes('GetProfiles')) return { xml: `<r>${profile('p', 'sub', 'V', 640, 360)}</r>` };
    return { xml: uri(`rtsp://${new URL(url).hostname}/live`) };
  });
  const r3 = await askCamera({ ip: '192.168.1.31', login: { user: 'a', password: 'b' }, fetch: elsewhere.f });
  assert.deepEqual(r3, { ok: true, streams: [{ path: '/live', label: 'sub', width: 640, height: 360 }] });
  assert.ok(elsewhere.sent.every((s) => s.url.startsWith('http://192.168.1.31/')), 'our digest never goes to another host');
});
