import { createCloud, type D1Like } from './cloud.ts';

interface Env {
  DB: D1Like;
  /** The owner's page: the cloud build of the app (npm run build:cloud), served as static files. */
  ASSETS: { fetch(request: Request): Promise<Response> };
}

/** Cloudflare Workers entry point: the API under /api/, the owner's page for everything else. */
export default {
  fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname.startsWith('/api/')) return createCloud(env.DB)(request);
    return env.ASSETS.fetch(request);
  },
};
