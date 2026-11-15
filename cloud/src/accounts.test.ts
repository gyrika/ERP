import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCloud, sha256Hex } from './cloud.ts';
import { fakeD1 } from './fakeD1.ts';
import { verifyGoogleIdToken } from './google.ts';
import { sealKeys, seal, unseal, lookupHash } from './seal.ts';

const SHOP = 'cheesybeez-thalwila-ab12';
const CLIENT = 'test-client.apps.googleusercontent.com';
const PROFILE_KEY = Buffer.alloc(32, 7).toString('base64');

const b64url = (bytes: Uint8Array | string) =>
  Buffer.from(typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes).toString('base64url');

/** A Google-like signer: its own RSA key, offered as Google's public keys. */
async function google() {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'k1' };
  const sign = async (claims: Record<string, unknown>, kid = 'k1') => {
    const head = b64url(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' }));
    const body = b64url(JSON.stringify(claims));
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(`${head}.${body}`));
    return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
  };
  return { keys: async () => [jwk as JsonWebKey], sign };
}

async function setup(opts: { profileKey?: string; clientId?: string } = { profileKey: PROFILE_KEY, clientId: CLIENT }) {
  const { d1, db } = fakeD1();
  db.prepare("INSERT INTO shops (id, name, created_at) VALUES (?, 'CheesyBeez Thalwila', 0)").run(SHOP);
  db.prepare("INSERT INTO devices (id, tenant_id, kind, token_hash, created_at) VALUES ('dev-a', ?, 'shop_server', ?, 0)").run(SHOP, await sha256Hex('server-a'));
  const g = await google();
  const clock = { t: 1_800_000_000_000 };
  const handle = createCloud(d1, {
    now: () => clock.t, orderShop: SHOP, googleClientId: opts.clientId, profileKey: opts.profileKey, googleKeys: g.keys,
    shopLocation: '7.0,79.9', deliveryPerKm: '50', deliveryMaxKm: '5', roadKm: async () => 1.2,
  });
  let cookie = '';
  const call = async (path: string, body?: unknown, extra: Record<string, string> = {}) => {
    const r = await handle(new Request(`https://cheesybeez.test${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'cf-connecting-ip': '1.2.3.4', ...(cookie ? { cookie } : {}), ...extra },
      body: body === undefined ? undefined : JSON.stringify(body),
    }));
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
    return { status: r.status, headers: r.headers, body: await r.json() as Record<string, any> };
  };
  const idToken = (over: Record<string, unknown> = {}) => g.sign({
    iss: 'https://accounts.google.com', aud: CLIENT, sub: '1234567890', email: 'kasun@example.com', email_verified: true,
    given_name: 'Kasun', iat: clock.t / 1000, exp: clock.t / 1000 + 3600, ...over,
  });
  const signIn = async (over: Record<string, unknown> = {}) => call('/api/v1/account/google', { credential: await idToken(over) });
  return { call, signIn, idToken, clock, db, g, cookie: () => cookie, setCookie: (c: string) => { cookie = c; } };
}

const pizza = { itemId: 'devilled-chicken', qty: 1, size: 'L', adds: [], outs: [] };

test('sealing: only the same key and the same row open it; lookups are keyed', async () => {
  const keys = (await sealKeys(PROFILE_KEY))!;
  const sealed = await seal(keys, { name: 'Kasun' }, 'profile:acc-1');
  assert.ok(!sealed.includes('Kasun'));
  assert.deepEqual(await unseal(keys, sealed, 'profile:acc-1'), { name: 'Kasun' });
  await assert.rejects(unseal(keys, sealed, 'profile:acc-2'), 'copied into another row, it does not open');
  const other = (await sealKeys(Buffer.alloc(32, 8).toString('base64')))!;
  await assert.rejects(unseal(other, sealed, 'profile:acc-1'), 'another key does not open it');
  assert.notEqual(await lookupHash(keys, 'phone', '0771234567'), await lookupHash(other, 'phone', '0771234567'));
  assert.equal(await sealKeys(undefined), null);
  assert.equal(await sealKeys('too-short'), null);
});

test('Google sign-in tokens: signature, site, expiry and issuer are all checked', async () => {
  const g = await google();
  const now = 1_800_000_000_000;
  const claims = { iss: 'accounts.google.com', aud: CLIENT, sub: 's1', email: 'a@b.lk', email_verified: true, name: 'Nimali Perera', exp: now / 1000 + 60 };
  assert.deepEqual(await verifyGoogleIdToken(await g.sign(claims), CLIENT, g.keys, now), { sub: 's1', email: 'a@b.lk', name: 'Nimali Perera' });
  const refused = async (token: unknown) => 'reason' in (await verifyGoogleIdToken(token, CLIENT, g.keys, now));
  assert.ok(await refused(await g.sign({ ...claims, aud: 'another-site' })), 'another site');
  assert.ok(await refused(await g.sign({ ...claims, exp: now / 1000 - 120 })), 'expired');
  assert.ok(await refused(await g.sign({ ...claims, iss: 'evil.example' })), 'not Google');
  assert.ok(await refused(await g.sign(claims, 'unknown-kid')), 'unknown key');
  const [h] = (await g.sign(claims)).split('.');
  const forged = b64url(JSON.stringify({ ...claims, sub: 'someone-else' }));
  assert.ok(await refused(`${h}.${forged}.${(await g.sign(claims)).split('.')[2]}`), 'changed after signing');
  assert.ok(await refused('not.a.jwt') && await refused(42));
  const unverified = await verifyGoogleIdToken(await g.sign({ ...claims, email_verified: false }), CLIENT, g.keys, now);
  assert.equal('email' in unverified && unverified.email, null, 'an email Google has not checked is not kept');
});

test('off until both the client id and the sealing key are set', async () => {
  for (const opts of [{}, { clientId: CLIENT }, { profileKey: PROFILE_KEY }]) {
    const { call, idToken } = await setup(opts);
    assert.deepEqual((await call('/api/v1/account')).body, { google: null, account: null });
    assert.equal((await call('/api/v1/account/google', { credential: await idToken() })).status, 404);
  }
});

test('sign in, the account fills itself from an order, sign out', async () => {
  const { call, signIn, cookie, db } = await setup();
  assert.deepEqual((await call('/api/v1/account')).body, { google: CLIENT, account: null }, 'signed out: the page shows Sign in');

  const first = await signIn();
  assert.equal(first.status, 200);
  assert.match(first.headers.get('set-cookie')!, /^cb_session=[\w-]+; Path=\/api\/; Max-Age=7776000; HttpOnly; Secure; SameSite=Lax$/);
  assert.deepEqual(first.body.account.profile, { name: 'Kasun', phone: '', email: 'kasun@example.com' });
  assert.ok(cookie());

  // Nothing personal is readable in the database, and the cookie's token is kept only as a hash.
  const raw = JSON.stringify(db.prepare('SELECT * FROM customer_accounts').all()) + JSON.stringify(db.prepare('SELECT * FROM customer_sessions').all());
  for (const plain of ['Kasun', 'kasun@example.com', '1234567890', cookie().split('=')[1]]) assert.ok(!raw.includes(plain), `${plain} is not stored as is`);

  await call('/api/v1/online/poll', { open: true }, { authorization: 'Bearer server-a' });
  const placed = await call('/api/v1/orders', {
    kind: 'delivery', name: 'Kasun', phone: '077 123 4567', address: '12 Temple Rd, Thalwila', pin: { lat: 7.01, lng: 79.91 }, note: '', lines: [pizza],
  });
  assert.equal(placed.status, 200);
  const me = (await call('/api/v1/account')).body.account;
  assert.equal(me.profile.phone, '0771234567', 'the phone from the order');
  assert.deepEqual(me.addresses.map((a: any) => [a.address, a.pin]), [['12 Temple Rd, Thalwila', { lat: 7.01, lng: 79.91 }]]);
  assert.deepEqual(me.orders.map((o: any) => [o.id, o.kind, o.status, o.lines.length]), [[placed.body.id, 'delivery', 'new', 1]]);

  const counter = (await call('/api/v1/online/poll', { open: true }, { authorization: 'Bearer server-a' })).body.orders;
  assert.equal(counter[0].account, true, 'the counter sees it came from an account');
  assert.equal((await call(`/api/v1/orders/${placed.body.id}?t=${placed.body.token}`)).body.account, undefined);

  // The same place again (other spacing) updates it rather than saving it twice.
  await call('/api/v1/orders', { kind: 'delivery', name: 'Kasun', phone: '0771234567', address: '12 temple rd,  Thalwila', pin: { lat: 7.02, lng: 79.91 }, note: '', lines: [pizza] }, { 'cf-connecting-ip': '5.6.7.8' });
  const again = (await call('/api/v1/account')).body.account;
  assert.equal(again.addresses.length, 1);
  assert.deepEqual(again.addresses[0].pin, { lat: 7.02, lng: 79.91 });

  assert.equal((await call('/api/v1/account/sign-out', {})).status, 200);
  assert.equal(cookie(), '', 'the cookie is cleared');
  assert.equal((await call('/api/v1/account')).body.account, null);
  assert.equal((await call('/api/v1/account/profile', { name: 'X' })).status, 401);
});

test('a signed-out order belongs to nobody, and the counter sees no account mark', async () => {
  const { call } = await setup();
  await call('/api/v1/online/poll', { open: true }, { authorization: 'Bearer server-a' });
  await call('/api/v1/orders', { kind: 'pickup', name: 'Ama', phone: '0712345678', note: '', lines: [pizza] });
  const counter = (await call('/api/v1/online/poll', { open: true }, { authorization: 'Bearer server-a' })).body.orders;
  assert.equal(counter[0].account, undefined);
});

test('profile and addresses: checked, at most five, the one used longest ago goes', async () => {
  const { call, signIn, clock } = await setup();
  await signIn();
  assert.equal((await call('/api/v1/account/profile', { name: 'Kasun P', phone: '123' })).status, 400);
  assert.deepEqual((await call('/api/v1/account/profile', { name: ' Kasun  P ', phone: '+94 77 123 4567' })).body.account.profile,
    { name: 'Kasun P', phone: '0771234567', email: 'kasun@example.com' });

  assert.equal((await call('/api/v1/account/addresses', { address: '' })).status, 400);
  for (let i = 1; i <= 6; i++) {
    clock.t += 1000;
    await call('/api/v1/account/addresses', { label: `Place ${i}`, address: `${i} Main St`, pin: null });
  }
  let list = (await call('/api/v1/account')).body.account.addresses;
  assert.deepEqual(list.map((a: any) => a.label), ['Place 6', 'Place 5', 'Place 4', 'Place 3', 'Place 2'], 'newest first, the oldest gone');

  const home = list[0].id;
  assert.equal((await call('/api/v1/account/addresses', { id: home, label: 'Home', address: '6 Main St', pin: { lat: 7, lng: 80 } })).status, 200);
  assert.equal((await call('/api/v1/account/addresses', { id: 'adr-nothere', label: 'X', address: 'Y' })).status, 404);
  list = (await call('/api/v1/account/addresses/remove', { id: list[1].id })).body.account.addresses;
  assert.deepEqual(list.map((a: any) => a.label), ['Home', 'Place 4', 'Place 3', 'Place 2']);
});

test("one customer cannot reach another's account, and other sites cannot post", async () => {
  const a = await setup();
  await a.signIn();
  const kasunCookie = a.cookie();
  await a.signIn({ sub: '999', given_name: 'Ama', email: 'ama@example.com' });
  const ama = (await a.call('/api/v1/account')).body.account;
  assert.equal(ama.profile.name, 'Ama', 'another Google account, another customer');
  await a.call('/api/v1/account/addresses', { label: 'Home', address: 'Ama house' });
  const amaAddress = (await a.call('/api/v1/account')).body.account.addresses[0].id;

  a.setCookie(kasunCookie);
  assert.equal((await a.call('/api/v1/account')).body.account.profile.name, 'Kasun');
  await a.call('/api/v1/account/addresses/remove', { id: amaAddress });
  assert.equal((await a.call('/api/v1/account/addresses', { id: amaAddress, address: 'taken' })).status, 404);
  assert.equal((await a.call('/api/v1/account/profile', { name: 'X' }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await a.call('/api/v1/account/profile', { name: 'Kasun' }, { origin: 'https://cheesybeez.test' })).status, 200);
  assert.equal((await a.call('/api/v1/account/google', { credential: 'forged' })).status, 401);
});

test('signing in again is the same account; sessions end after 90 days and on "everywhere"', async () => {
  const { call, signIn, clock, cookie, setCookie } = await setup();
  await signIn();
  await call('/api/v1/account/profile', { name: 'Kasun', phone: '0771234567' });
  const phoneOne = cookie();
  const again = (await signIn({ email: 'new@example.com' })).body.account;
  assert.equal(again.profile.phone, '0771234567', 'the same account');
  assert.equal(again.profile.email, 'new@example.com', "Google's email follows");

  await call('/api/v1/account/sign-out', { everywhere: true });
  setCookie(phoneOne);
  assert.equal((await call('/api/v1/account')).body.account, null, 'the other phone is signed out too');

  await signIn();
  clock.t += 90 * 86_400_000 + 1;
  assert.equal((await call('/api/v1/account')).body.account, null, 'expired');
});

test('download my data, then delete the account: gone, and its orders no longer point to it', async () => {
  const { call, signIn, db, cookie, setCookie } = await setup();
  await signIn();
  await call('/api/v1/online/poll', { open: true }, { authorization: 'Bearer server-a' });
  await call('/api/v1/orders', { kind: 'pickup', name: 'Kasun', phone: '0771234567', note: '', lines: [pizza] });

  const r = await call('/api/v1/account/export');
  assert.equal(r.headers.get('content-disposition'), 'attachment; filename="cheesybeez-my-data.json"');
  assert.equal(r.body.profile.name, 'Kasun');
  assert.equal(r.body.orders.length, 1);
  assert.equal(r.body.signedIn.length, 1);

  const kept = cookie();
  assert.equal((await call('/api/v1/account/delete', {})).body.deleted, true);
  for (const table of ['customer_accounts', 'customer_addresses', 'customer_sessions']) {
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n, 0, table);
  }
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM online_orders WHERE account_id IS NOT NULL').get() as { n: number }).n, 0);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM online_orders').get() as { n: number }).n, 1, "the order stays in the shop's books");
  assert.equal(cookie(), '');
  setCookie(kept);
  assert.equal((await call('/api/v1/account')).body.account, null, 'the old cookie no longer works');
  assert.equal((await signIn()).body.account.orders.length, 0, 'signing in again starts a new, empty account');
});
