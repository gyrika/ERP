import { changeBlocks, changedBill, escpos, partSlip, opensDrawer, receipt, type ReceiptLine } from '../domain/receipt.ts';
import type { PaidOrder } from '../domain/types.ts';
import { receiptOfferFromEvents, type ReceiptOffer } from '../domain/campaigns.ts';
import { modulesHere, readAll } from '../ui/eventLog.ts';
import { syncToken } from './pairing.ts';

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
  // Changed after paying (SCRUM-255): the bill as it stands now, a COPY of the changed bill.
  if (paid.settled !== undefined) return printChangedBill(paid, cashier, { reprint });
  return send(escpos(receipt(paid, { cashier, copy: reprint, offers: receiptOffers() }), { openDrawer: !reprint && opensDrawer(paid) }));
}

/** While the CRM is on, the receipt carries the offers QR code under the owner's words (receipt.ts). */
export const receiptOffers = (): ReceiptOffer | null => (modulesHere().crm ? receiptOfferFromEvents(readAll()) : null);

/** The delivery bill for the customer's bag (SCRUM-193). Nothing is paid yet, so the drawer stays shut. */
export const printDeliveryBill = (lines: ReceiptLine[]): Promise<PrintResult> => send(escpos(lines));

async function send(bytes: Uint8Array): Promise<PrintResult> {
  const token = syncToken();
  if (!token) return 'unavailable';
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

/**
 * A paid order's difference settled (SCRUM-242/255): the CHANGED BILL, the whole bill again with
 * what changed and what was paid now. The drawer opens for cash (money in or out); a reprint never.
 */
export const printChangedBill = (paid: PaidOrder, cashier: string, { reprint = false } = {}): Promise<PrintResult> => {
  const blocks = changeBlocks(readAll(), paid);
  return send(escpos(changedBill(paid, blocks, { cashier, copy: reprint }), { openDrawer: !reprint && blocks.at(-1)?.tender === 'cash' }));
};

/** One part of a split bill: that person's slip, and the drawer opens for cash. */
export const printPartSlip = (o: Parameters<typeof partSlip>[0], cashier: string): Promise<PrintResult> =>
  send(escpos(partSlip(o, { at: Date.now(), cashier }), { openDrawer: o.tender === 'cash' }));
