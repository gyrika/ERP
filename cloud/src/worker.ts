import { createCloud, type D1Like } from './cloud.ts';

/** Cloudflare Workers entry point. `DB` is the D1 database bound in wrangler.toml. */
export default {
  fetch(request: Request, env: { DB: D1Like }): Promise<Response> {
    return createCloud(env.DB)(request);
  },
};
