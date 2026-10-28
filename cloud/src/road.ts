import type { DeliveryPin } from '../../src/domain/online.ts';

/**
 * Road distance for delivery fees (SCRUM-193), from openrouteservice.org: free, no card, 2,000 routes
 * a day on its standard plan, OpenStreetMap's roads. The key is a Worker secret (ORS_API_KEY).
 * Any trouble (no key, slow, refused, over the day's limit) answers null, and the caller falls back to
 * the straight line × ROAD_FACTOR, so an order never fails because this service did.
 */
export type RoadKm = (from: DeliveryPin, to: DeliveryPin) => Promise<number | null>;

const URL_DRIVING = 'https://api.openrouteservice.org/v2/directions/driving-car';

export const orsRoadKm = (key: string | undefined, http: typeof fetch = fetch): RoadKm => async (from, to) => {
  if (!key) return null;
  try {
    const r = await http(URL_DRIVING, {
      method: 'POST',
      headers: { authorization: key, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ coordinates: [[from.lng, from.lat], [to.lng, to.lat]] }),
      signal: AbortSignal.timeout(4_000),
    });
    if (!r.ok) return null;
    const meters = ((await r.json()) as { routes?: { summary?: { distance?: unknown } }[] }).routes?.[0]?.summary?.distance;
    return typeof meters === 'number' && Number.isFinite(meters) && meters >= 0 ? meters / 1000 : null;
  } catch {
    return null;
  }
};
