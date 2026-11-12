import type { Audience } from '../domain/campaigns.ts';
import type { ImportPlan } from '../domain/customerImport.ts';
import type { Customer } from '../domain/customers.ts';
import type { SyncEvent } from '../domain/sync.ts';
import { syncToken } from './pairing.ts';
import { signedIn } from './serverAuth.ts';

/**
 * The customer list on the shop server (server/crm/routes.ts). Only the counter PC asks, as the
 * person signed in on it; customer numbers never go to the cloud or another device.
 */
export class CrmFailed extends Error {}

/** This screen can reach the customer list at all (the counter PC, someone signed in). */
export const crmReachable = (): boolean => syncToken() !== null && signedIn() !== null;

const headers = (): Record<string, string> => {
  const token = syncToken();
  if (!token) throw new CrmFailed('Customers are kept on the shop PC: open this there.');
  const me = signedIn();
  return { authorization: `Bearer ${token}`, ...(me ? { 'x-staff-id': me.id } : {}) };
};

const call = async <T>(path: string, init: RequestInit = {}, timeoutMs = 60_000): Promise<T> => {
  const r = await fetch(`/api/v1/crm${path}`, { ...init, headers: { ...headers(), ...(init.headers ?? {}) }, signal: AbortSignal.timeout(timeoutMs) });
  const data = (await r.json().catch(() => ({}))) as T & { message?: string };
  if (!r.ok) throw new CrmFailed(data.message ?? `The shop PC said ${r.status}.`);
  return data;
};
const post = <T>(path: string, body: unknown, timeoutMs?: number) =>
  call<T>(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }, timeoutMs);

const upload = (step: 'preview' | 'save', file: File, rename: boolean) => {
  const q = new URLSearchParams({ name: file.name, ...(rename ? { rename: '1' } : {}) });
  return { path: `/import/${step}?${q}`, init: { method: 'POST', body: file, headers: { 'content-type': 'application/octet-stream' } } };
};

/** What the counter is told about a customer: the first name to greet them by. */
export interface Greeting { id: string; name: string | null }

export const crmClient = {
  count: () => call<{ customers: number }>('/count'),
  /** The list, and which customers have the app (for campaigns). */
  list: () => call<{ customers: Customer[]; withApp: string[] }>('/customers'),
  optOut: (id: string, optedOut: boolean) => post<{ optedOut: boolean }>('/customers/opt-out', { id, optedOut }),
  add: (phone: string, name: string) => post<{ customer: Customer }>('/customers/add', { phone, name }),
  /** The owner's: erased from the list (returned for Undo). */
  remove: (id: string) => post<{ removed: Customer }>('/customers/remove', { id }),
  restore: (customer: Customer) => post<{ customer: Customer }>('/customers/restore', { customer }),
  /** At Charge, while typing: quick, and it never waits long (the sale never waits on it). */
  lookup: (phone: string) => post<{ customer: Greeting | null }>('/lookup', { phone }, 2_000),
  ensure: (phone: string) => post<{ customer: Greeting; created: boolean }>('/ensure', { phone }, 2_000),
  preview: (file: File, rename: boolean) => {
    const u = upload('preview', file, rename);
    return call<{ plan: ImportPlan }>(u.path, u.init);
  },
  save: (file: File, rename: boolean) => {
    const u = upload('save', file, rename);
    return call<{ plan: ImportPlan; saved: { added: number; updated: number }; customers: number }>(u.path, u.init);
  },
  reach: (audience: Audience) => post<{ customers: number; reachable: number }>('/campaigns/reach', { audience }),
  send: (audience: Audience, title: string, body: string, testPhone?: string) =>
    post<{ events: SyncEvent[] }>('/campaigns/send', { audience, title, body, testPhone }, 5 * 60_000),
  setAuto: (on: boolean, title: string, body: string) => post<{ events: SyncEvent[] }>('/campaigns/auto', { on, title, body }),
};
