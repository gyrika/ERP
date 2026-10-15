import { adminRoutes } from './admin.ts';
import { createCloud, type D1Like } from './cloud.ts';
import { downloadPage, latestRelease } from './download.ts';
import { answersApi, questionsPage } from './questions.ts';

interface Env {
  DB: D1Like;
  /** The shop code for new shops (npx wrangler secret put ENROL_CODE). */
  ENROL_CODE?: string;
  /** The key in the owner's questions link (npx wrangler secret put ANSWER_KEY). */
  ANSWER_KEY?: string;
  /** The shop that cheesybeez.com takes online orders for (wrangler.toml [vars]). */
  ORDER_SHOP?: string;
  /** Its daily hours for the page's status pill, "11:00-21:00" in Sri Lanka time (wrangler.toml [vars]). */
  ORDER_HOURS?: string;
  /** Its phone / WhatsApp number and street address for the page's pickup card (wrangler.toml [vars]). */
  ORDER_PHONE?: string;
  ORDER_ADDRESS?: string;
  /** The developer's /admin password (npm run admin-key in cloud/). */
  ADMIN_KEY?: string;
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

export const orderManifest = (customerDomain: boolean) => ({
  name: 'CheesyBeez Ordering',
  short_name: 'CheesyBeez',
  description: 'Order pizza, burgers and pasta for pickup at CheesyBeez.',
  start_url: customerDomain ? '/' : '/order',
  scope: customerDomain ? '/' : '/order',
  display: 'standalone',
  background_color: '#FAF6EF',
  theme_color: '#FAF6EF',
  icons: [
    { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
});

/** Customers' address: its home page is the ordering page (order.html); /order shows it on any address. */
const CUSTOMER_HOST = 'cheesybeez.com';

/** Cloudflare Workers entry point: customer ordering, its API, and the separate owner app. */
export default {
  fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.hostname === `www.${CUSTOMER_HOST}`) {
      return Promise.resolve(Response.redirect(`https://${CUSTOMER_HOST}${url.pathname}${url.search}`, 301));
    }
    if (url.hostname === CUSTOMER_HOST && url.pathname === '/') return env.ASSETS.fetch(new Request(new URL('/order', url), request));
    if (url.pathname === '/order.webmanifest') {
      return Promise.resolve(new Response(JSON.stringify(orderManifest(url.hostname === CUSTOMER_HOST)), {
        headers: { 'content-type': 'application/manifest+json', 'cache-control': 'public, max-age=3600' },
      }));
    }
    if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) {
      return adminRoutes(request, url, {
        db: env.DB,
        key: env.ADMIN_KEY ?? null,
        latest: () => latestRelease().then((r) => r?.version ?? null),
        app: (req) => env.ASSETS.fetch(req),
      }).then((r) => r ?? new Response('Not found', { status: 404 }));
    }
    if (url.pathname === '/api/v1/answers') return answersApi(request, env.DB, env.ANSWER_KEY);
    if (url.pathname.startsWith('/api/')) return createCloud(env.DB, { enrolCode: env.ENROL_CODE, orderShop: env.ORDER_SHOP, orderHours: env.ORDER_HOURS, orderPhone: env.ORDER_PHONE, orderAddress: env.ORDER_ADDRESS })(request);
    if (url.pathname === '/get' || url.pathname === '/download') {
      return latestRelease().then((rel) => new Response(downloadPage(rel), {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' },
      }));
    }
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
