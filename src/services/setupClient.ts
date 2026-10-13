import type { Role } from '../domain/auth.ts';

/**
 * The setup wizard's calls to the shop server (server/setup.ts). They work only
 * on the shop PC itself. After setup, changes carry the owner's PIN.
 */
export interface StaffRow { id: string; name: string; role: Role; active: boolean }
export interface SetupState {
  done: boolean;
  shop: { id: string; name: string; place: string } | null;
  printer: string | null;
  printers: string[];
  cloud: boolean;
  staff?: StaffRow[];
}

export class SetupFailed extends Error {}

const call = async <T>(step: string, body?: unknown): Promise<T> => {
  const r = await fetch(`/api/v1/setup${step}`, body === undefined ? { signal: AbortSignal.timeout(15_000) } : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000),
  });
  const data = (await r.json().catch(() => ({}))) as T & { message?: string };
  if (!r.ok) throw new SetupFailed(data.message ?? `The shop server said ${r.status}.`);
  return data;
};

export const setupClient = {
  state: () => call<SetupState>(''),
  nameShop: (name: string, place: string) => call<{ shopId: string; counterToken?: string }>('/shop', { name, place }),
  setPrinter: (name: string | null, ownerPin?: string) => call<{ printer: string | null }>('/printer', { name, ownerPin }),
  staff: (ownerPin?: string) => call<{ staff: StaffRow[] }>('/staff/list', { ownerPin }),
  addStaff: (name: string, role: Role, pin: string, ownerPin?: string) => call<{ staff: StaffRow[] }>('/staff', { name, role, pin, ownerPin }),
  removeStaff: (id: string, ownerPin?: string) => call<{ staff: StaffRow[] }>('/staff/remove', { id, ownerPin }),
  pair: (kind: 'kitchen' | 'owner', ownerPin?: string) => call<{ link: string }>('/pair', { kind, ownerPin }),
  pairCounter: (ownerPin: string) => call<{ counterToken: string; shopId: string }>('/pair', { kind: 'counter', ownerPin }),
  connectCloud: (code: string, ownerPin?: string) => call<{ cloud: boolean }>('/cloud', { code, ownerPin }),
  finish: () => call<{ done: boolean }>('/finish', {}),
  checkUpdate: (ownerPin?: string) => call<{ current: string; latest: string | null; newer: boolean }>('/update/check', { ownerPin }),
  installUpdate: (ownerPin?: string) => call<{ started: boolean; from: string }>('/update/install', { ownerPin }),
  updateStatus: (ownerPin?: string) =>
    call<{ status: { phase: string; percent: number; version: string; at: number } | null }>('/update/status', { ownerPin }),
};
