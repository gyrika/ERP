/**
 * The developer's Shops screen, on the developer's own laptop: every shop in the cloud,
 * read through this local server with the admin password (CLOUD_ADMIN_KEY in server/.env,
 * from `npm run admin-key` in cloud/). The browser never holds the password, and only this
 * computer itself may ask (app.ts checks it). A shop PC has no key, so it has no Shops screen.
 */
export interface FleetOptions {
  /** e.g. https://cheesybeez-cloud.cheesybeez-cloud.workers.dev */
  url: string;
  key: string;
  fetch?: typeof fetch;
}

export function createFleet(o: FleetOptions) {
  const http = o.fetch ?? fetch;
  const get = async (path: string): Promise<unknown> => {
    const r = await http(`${o.url}${path}`, { headers: { authorization: `Bearer ${o.key}` }, signal: AbortSignal.timeout(20_000) });
    if (r.status === 403) throw new Error('the cloud did not accept CLOUD_ADMIN_KEY: run npm run admin-key again and copy the new password');
    if (!r.ok) throw new Error(`the cloud answered ${r.status}`);
    return r.json();
  };
  return {
    /** Every shop: online, version, last update, last sale. */
    shops: () => get('/admin/api/shops'),
    /** One shop's events after a cursor, as the owner's phone gets them. */
    events: (shopId: string, after: number, limit: number) =>
      get(`/admin/api/shops/${encodeURIComponent(shopId)}/events?after=${after}&limit=${limit}`),
  };
}
export type Fleet = ReturnType<typeof createFleet>;
