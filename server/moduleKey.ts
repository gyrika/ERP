/**
 * The developers' PUBLIC key for module codes (server/modules.ts). It can check a code, never make
 * one. Written by `npm run module:key`, which keeps the private half outside the repo.
 * null: no key made yet, so no module can be turned on.
 */
export const MODULE_PUBLIC_KEY: string | null = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEArfT4V8HzLfdCdlN1UtEcJdt0DjtwLX74pTMYjcEhprI=\n-----END PUBLIC KEY-----\n";
