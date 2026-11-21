import type { CampaignResult } from '../domain/campaignResults.ts';
import type { Audience } from '../domain/campaigns.ts';
import type { ImportPlan } from '../domain/customerImport.ts';
import type { Customer, NameMatch } from '../domain/customers.ts';
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

/**
 * The first names this screen was told (lookup, ensure), by id, for this session only: so an order
 * paid by a customer given at Charge shows who it was on the list and the bill. Never stored.
 */
const told = new Map<string, string | null>();
export const rememberName = (c: Greeting | null | undefined): void => { if (c) told.set(c.id, c.name); };
export const toldName = (id: string): string | null => told.get(id) ?? null;
const remembering = <T extends { customer: Greeting | null }>(r: T): T => { rememberName(r.customer); return r; };

export const crmClient = {
  count: () => call<{ customers: number }>('/count'),
  /** The list, and which customers have the app (for campaigns). */
  list: () => call<{ customers: Customer[]; withApp: string[] }>('/customers'),
  optOut: (id: string, optedOut: boolean) => post<{ optedOut: boolean }>('/customers/opt-out', { id, optedOut }),
  add: (phone: string, name: string) => post<{ customer: Customer }>('/customers/add', { phone, name }),
  /** A manager's or the owner's correction of the mobile and name (`before` is for Undo). */
  edit: (id: string, phone: string, name: string) => post<{ customer: Customer; before: Customer }>('/customers/edit', { id, phone, name }),
  /** The owner's: erased from the list (returned for Undo). */
  remove: (id: string) => post<{ removed: Customer }>('/customers/remove', { id }),
  restore: (customer: Customer) => post<{ customer: Customer }>('/customers/restore', { customer }),
  /** At Charge, while typing: quick, and it never waits long (the sale never waits on it). */
  lookup: (phone: string) => post<{ customer: Greeting | null }>('/lookup', { phone }, 2_000).then(remembering),
  /** A name typed instead of a mobile: who it may be (up to 5, first names and the last 3 digits). */
  search: (q: string) => post<{ matches: NameMatch[] }>('/search', { q }, 2_000),
  /** The customer, made if new; `name` is kept only for someone the list has no name for. */
  ensure: (phone: string, name?: string, source?: 'app') =>
    post<{ customer: Greeting; created: boolean }>('/ensure', { phone, ...(name ? { name } : {}), ...(source ? { source } : {}) }, 2_000).then(remembering),
  preview: (file: File, rename: boolean) => {
    const u = upload('preview', file, rename);
    return call<{ plan: ImportPlan }>(u.path, u.init);
  },
  save: (file: File, rename: boolean) => {
    const u = upload('save', file, rename);
    return call<{ plan: ImportPlan; saved: { added: number; updated: number }; customers: number }>(u.path, u.init);
  },
  reach: (audience: Audience) => post<{ customers: number; reachable: number }>('/campaigns/reach', { audience }),
  /** Every audience's reach at once (the Campaigns chips). */
  reachAll: () => post<{ reach: Record<Exclude<Audience, 'test'>, { customers: number; reachable: number }> }>('/campaigns/reach-all', {}),
  /** The last campaign that reached this customer, and when they came in after (their page). */
  messages: (id: string) => post<{ last: { title: string; at: number; cameAt: number | null } | null }>('/customers/messages', { id }),
  send: (audience: Audience, title: string, body: string, testPhone?: string) =>
    post<{ events: SyncEvent[] }>('/campaigns/send', { audience, title, body, testPhone }, 5 * 60_000),
  setAuto: (on: boolean, title: string, body: string) => post<{ events: SyncEvent[] }>('/campaigns/auto', { on, title, body }),
  /** The receipt's words above the offers QR code (the owner's). */
  setReceipt: (headline: string, line: string) => post<{ events: SyncEvent[] }>('/campaigns/receipt', { headline, line }),
  /** What each campaign brought in, by its event id (counts only; campaignResults.ts). */
  results: () => post<{ results: Record<string, CampaignResult> }>('/campaigns/results', {}),
};
