import type { Actor } from '../../src/domain/auth.ts';
import type { Device } from '../store.ts';
import type { InboxRow } from './push.ts';
import type { CrmApi } from './routes.ts';

/**
 * The CRM's background work on the shop PC, only while the module is on:
 * - every minute, with the cloud linked: hands the cloud this shop's push key (the app needs it to
 *   sign up) and takes the app's sign-ups and stops that the cloud kept for it (cloud/src/push.ts),
 *   which the cloud then deletes;
 * - every hour: the automatic "we miss you" (push.ts winback: 10:00-19:59, once per quiet spell).
 * Both are quiet when they fail (no internet): the next run tries again.
 */
export interface CrmJobsOptions {
  crm: CrmApi;
  tenantId: () => string | null;
  /** The local device the server's own campaign records are filed under (made once). */
  device: (tenantId: string) => Promise<Device>;
  cloud: () => { url: string; token: string } | null;
  publicKey: () => Promise<string>;
  fetch?: typeof fetch;
  inboxEveryMs?: number;
  winbackEveryMs?: number;
}

/** The automatic message is the shop's own, not a person's. */
export const AUTOMATIC: Actor = { id: 'crm-automatic', name: 'Automatic message', role: 'owner' };

export function startCrmJobs(o: CrmJobsOptions) {
  const f = o.fetch ?? fetch;
  let keySentTo: string | null = null;
  let stopped = false;

  const inbox = async () => {
    const tenant = o.tenantId();
    const link = o.cloud();
    if (!tenant || !link || !(await o.crm.isOn(tenant)) || !o.crm.push) return;
    const headers = { authorization: `Bearer ${link.token}`, 'content-type': 'application/json' };
    const key = await o.publicKey();
    if (keySentTo !== `${link.url}|${key}`) {
      const r = await f(`${link.url}/api/v1/push/key`, { method: 'POST', headers, body: JSON.stringify({ key }), signal: AbortSignal.timeout(15_000) });
      if (r.ok) keySentTo = `${link.url}|${key}`;
    }
    const r = await f(`${link.url}/api/v1/push/inbox`, { headers, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) return;
    const { rows } = await r.json() as { rows: InboxRow[] };
    if (!rows.length) return;
    const done = await o.crm.push.applyInbox(tenant, rows);
    await f(`${link.url}/api/v1/push/inbox/ack`, { method: 'POST', headers, body: JSON.stringify({ ids: done }), signal: AbortSignal.timeout(15_000) });
  };

  const winback = async () => {
    const tenant = o.tenantId();
    if (!tenant || !(await o.crm.isOn(tenant)) || !o.crm.push) return;
    await o.crm.push.winback(await o.device(tenant), AUTOMATIC);
  };

  const quietly = (job: () => Promise<void>, name: string) => () => {
    if (stopped) return;
    job().catch((e: unknown) => console.error(`crm ${name}:`, e instanceof Error ? e.message : e));
  };
  const timers = [
    setInterval(quietly(inbox, 'sign-ups'), o.inboxEveryMs ?? 60_000),
    setInterval(quietly(winback, 'we miss you'), o.winbackEveryMs ?? 60 * 60_000),
  ];
  for (const t of timers) t.unref?.();
  setTimeout(quietly(inbox, 'sign-ups'), 5_000).unref?.();

  return {
    /** For tests and Settings: run now. */
    inbox, winback,
    stop() { stopped = true; for (const t of timers) clearInterval(t); },
  };
}
