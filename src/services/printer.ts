import { escpos, opensDrawer, receipt } from '../domain/receipt.ts';
import type { PaidOrder } from '../domain/types.ts';
import { syncToken } from './syncClient.ts';

/**
 * Prints the customer receipt through the server on the counter PC, which
 * hands the bytes to the XP-80T (server/printer.ts). The bytes are built
 * here, from the same pure layout the preview shows.
 *
 * 'unavailable': this device is not paired with the server (development, the
 * demo), so there is nothing to print to and the screen offers no printing.
 */
export type PrintResult = 'printed' | 'failed' | 'unavailable';

export const canPrint = (): boolean => syncToken() !== null;

const base64 = (bytes: Uint8Array): string => {
  let s = '';
  bytes.forEach((b) => { s += String.fromCharCode(b); });
  return btoa(s);
};

/**
 * At payment the cash drawer opens with the receipt (cash only). A reprint
 * never opens the drawer and is marked COPY.
 */
export async function printReceipt(paid: PaidOrder, cashier: string, { reprint = false } = {}): Promise<PrintResult> {
  const token = syncToken();
  if (!token) return 'unavailable';
  const bytes = escpos(receipt(paid, { cashier, copy: reprint }), { openDrawer: !reprint && opensDrawer(paid) });
  try {
    const r = await fetch('/api/v1/print', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ data: base64(bytes) }),
      signal: AbortSignal.timeout(10_000),
    });
    return r.ok ? 'printed' : 'failed';
  } catch {
    return 'failed';
  }
}
