import { createCloud, type D1Like } from './cloud.ts';
import { answersApi, questionsPage } from './questions.ts';

interface Env {
  DB: D1Like;
  /** The shop code for new shops (npx wrangler secret put ENROL_CODE). */
  ENROL_CODE?: string;
  /** The key in the owner's questions link (npx wrangler secret put ANSWER_KEY). */
  ANSWER_KEY?: string;
  /** The owner's page: the cloud build of the app (npm run build:cloud), served as static files. */
  ASSETS: { fetch(request: Request): Promise<Response> };
}

/**
 * The owner's app description, per phone. A home-screen app on an iPhone has its own storage, so it
 * would not know the owner's key: the key rides in the address the app opens (`?k=` → start_url),
 * exactly as in the QR code it came from.
 */
export const ownerManifest = (key: string | null) => ({
  name: 'CheesyBeez Owner',
  short_name: 'CheesyBeez',
  description: "Today's takings and anything that needs you, from anywhere.",
  start_url: key && /^[A-Za-z0-9_-]{20,64}$/.test(key) ? `/?owner=${key}#owner` : '/#owner',
  scope: '/',
  display: 'standalone',
  orientation: 'portrait',
  background_color: '#F2F1EF',
  theme_color: '#F2F1EF',
  icons: [
    { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
});

/** Cloudflare Workers entry point: the API under /api/, the owner's app for everything else. */
export default {
  fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/api/v1/answers') return answersApi(request, env.DB, env.ANSWER_KEY);
    if (url.pathname.startsWith('/api/')) return createCloud(env.DB, { enrolCode: env.ENROL_CODE })(request);
    if (url.pathname === '/questions') {
      return Promise.resolve(new Response(questionsPage(), {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' },
      }));
    }
    if (url.pathname === '/owner.webmanifest') {
      return Promise.resolve(new Response(JSON.stringify(ownerManifest(url.searchParams.get('k'))), {
        headers: { 'content-type': 'application/manifest+json', 'cache-control': 'no-store' },
      }));
    }
    return env.ASSETS.fetch(request);
  },
};
