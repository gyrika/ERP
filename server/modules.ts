import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto';
import { checkGrant, type ModuleGrant, type ModuleId } from '../src/domain/modules.ts';

/**
 * The developers' one-time module codes (src/domain/modules.ts). A code is
 *   CB1.<the grant as base64url JSON>.<its Ed25519 signature, base64url>
 * Only the developers hold the private key (outside the repo, never printed); the shop server
 * holds the public key (server/moduleKey.ts) and so can check a code but never make one.
 */
export const CODE_PREFIX = 'CB1.';
/** A code works for a week after it is made, unless it says otherwise. */
export const CODE_DAYS = 7;

const b64 = (b: Buffer) => b.toString('base64url');

export const newCodeId = () => randomBytes(8).toString('hex');

/** The developers' side (scripts/module-code.ts and tests): a signed code for one shop. */
export const signModuleCode = (grant: ModuleGrant, privateKeyPem: string): string => {
  const payload = Buffer.from(JSON.stringify(grant), 'utf8');
  return `${CODE_PREFIX}${b64(payload)}.${b64(sign(null, payload, createPrivateKey(privateKeyPem)))}`;
};

/** A new pair: the private half for the developers alone, the public half for the repo. */
export const newModuleKeys = (): { privateKeyPem: string; publicKeyPem: string } => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
};

/**
 * The shop's side: what this code grants, or why it does not work here. `used`: the code ids this
 * shop has already used. Spaces and line breaks from pasting are ignored.
 */
export const readModuleCode = (
  code: unknown, publicKeyPem: string | null, shopId: string, used: ReadonlySet<string>, now: number,
): { grant: ModuleGrant } | { reason: string } => {
  if (!publicKeyPem) return { reason: 'this version has no developer key: modules cannot be changed' };
  if (typeof code !== 'string') return { reason: 'paste the code' };
  const clean = code.replace(/\s+/g, '');
  if (!clean) return { reason: 'paste the code' };
  if (!clean.startsWith(CODE_PREFIX) || clean.length > 1000) return { reason: 'that is not a module code' };
  const parts = clean.slice(CODE_PREFIX.length).split('.');
  if (parts.length !== 2) return { reason: 'that is not a module code' };
  const payload = Buffer.from(parts[0], 'base64url');
  const signature = Buffer.from(parts[1], 'base64url');
  let ok = false;
  try { ok = verify(null, payload, createPublicKey(publicKeyPem), signature); } catch { ok = false; }
  if (!ok) return { reason: 'the code is not signed by the developers (or was copied wrong)' };
  let grant: unknown;
  try { grant = JSON.parse(payload.toString('utf8')); } catch { return { reason: 'that is not a module code' }; }
  const why = checkGrant(grant);
  if (why) return { reason: why };
  const g = grant as ModuleGrant;
  if (g.shop !== shopId) return { reason: `the code is for another shop (${g.shop})` };
  if (used.has(g.id)) return { reason: 'the code was already used: ask for a new one' };
  if (now > g.until) return { reason: 'the code has run out: ask for a new one' };
  return { grant: g };
};

/** A grant as the developers make it: for one shop, one module, on or off, for a week. */
export const grantFor = (shop: string, module: ModuleId, on: boolean, now: number, days = CODE_DAYS): ModuleGrant =>
  ({ v: 1, shop, module, on, id: newCodeId(), until: now + days * 86_400_000 });
