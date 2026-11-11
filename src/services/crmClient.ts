import type { ImportPlan } from '../domain/customerImport.ts';
import { syncToken } from './pairing.ts';
import { signedIn } from './serverAuth.ts';

/**
 * The customer list on the shop server (server/crm/routes.ts). Only the counter PC asks, as the
 * manager or owner signed in on it; customer numbers never go to the cloud or another device.
 */
export class CrmFailed extends Error {}

const headers = (): Record<string, string> => {
  const token = syncToken();
  if (!token) throw new CrmFailed('Customers are kept on the shop PC: open this there.');
  const me = signedIn();
  return { authorization: `Bearer ${token}`, ...(me ? { 'x-staff-id': me.id } : {}) };
};

const call = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
  const r = await fetch(`/api/v1/crm${path}`, { ...init, headers: { ...headers(), ...(init.headers ?? {}) }, signal: AbortSignal.timeout(60_000) });
  const data = (await r.json().catch(() => ({}))) as T & { message?: string };
  if (!r.ok) throw new CrmFailed(data.message ?? `The shop PC said ${r.status}.`);
  return data;
};

const upload = (step: 'preview' | 'save', file: File, rename: boolean) => {
  const q = new URLSearchParams({ name: file.name, ...(rename ? { rename: '1' } : {}) });
  return { path: `/import/${step}?${q}`, init: { method: 'POST', body: file, headers: { 'content-type': 'application/octet-stream' } } };
};

export const crmClient = {
  count: () => call<{ customers: number }>('/count'),
  /** What importing the file would do: nothing is saved. */
  preview: (file: File, rename: boolean) => {
    const u = upload('preview', file, rename);
    return call<{ plan: ImportPlan }>(u.path, u.init);
  },
  /** Saves it (planned again on the shop PC against the list as it is then). */
  save: (file: File, rename: boolean) => {
    const u = upload('save', file, rename);
    return call<{ plan: ImportPlan; saved: { added: number; updated: number }; customers: number }>(u.path, u.init);
  },
};
