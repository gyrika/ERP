import type { OrderEvent } from '../../src/domain/events.ts';
import { saleFrom } from '../../src/domain/salesLedger.ts';
import type { D1Like, D1Statement } from './cloud.ts';

/**
 * Keeps the sales ledger (`sales`, `sale_items`, migration 0006) in step with a shop's events.
 * Runs after every copy from the shop server: it reads the payments and Undos past the shop's
 * cursor, in the order they were copied, and files each one with the cursor in one transaction,
 * so a crash halfway never files a payment twice or skips one. A new cloud fills the ledger
 * from all the shop's past events on its first pass.
 */
const PAGE = 200;
const MAX_PAGES = 10; // the rest waits for the next copy (about every 30 s)

interface Row { seq: number; type: string; order_number: number; body: string }

export async function projectSales(db: D1Like, tenantId: string): Promise<number> {
  const cursorTo = (seq: number) => db.prepare(`INSERT INTO sales_cursor (tenant_id, last_seq) VALUES (?, ?)
    ON CONFLICT (tenant_id) DO UPDATE SET last_seq = MAX(last_seq, excluded.last_seq)`).bind(tenantId, seq);
  let filed = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const cursor = (await db.prepare('SELECT last_seq FROM sales_cursor WHERE tenant_id = ?').bind(tenantId).first<{ last_seq: number }>())?.last_seq ?? 0;
    // Only up to what is there now: events copied in meanwhile wait for the next pass.
    const top = (await db.prepare('SELECT MAX(seq) AS top FROM events WHERE tenant_id = ?').bind(tenantId).first<{ top: number | null }>())?.top ?? 0;
    if (top <= cursor) return filed;
    const { results } = await db.prepare(`SELECT seq, type, order_number, body FROM events
      WHERE tenant_id = ? AND seq > ? AND seq <= ? AND type IN ('order.paid', 'order.payment_undone')
      ORDER BY seq LIMIT ?`).bind(tenantId, cursor, top, PAGE).all<Row>();

    for (const row of results) {
      const writes: D1Statement[] = [];
      // The payment still standing before this one, for the same number, ends the order before it.
      const standing = (seqBefore: number) => db.prepare(`SELECT id, event_seq FROM sales
        WHERE tenant_id = ? AND order_number = ? AND status = 'paid' AND event_seq < ?
        ORDER BY event_seq DESC LIMIT 1`).bind(tenantId, row.order_number, seqBefore).first<{ id: string; event_seq: number }>();

      if (row.type === 'order.paid') {
        const paid = JSON.parse(row.body) as Extract<OrderEvent, { type: 'order.paid' }>;
        const from = (await standing(row.seq))?.event_seq ?? 0;
        const { results: order } = await db.prepare(`SELECT body FROM events
          WHERE tenant_id = ? AND order_number = ? AND seq > ? AND seq < ? AND type LIKE 'order.%'
          ORDER BY seq`).bind(tenantId, row.order_number, from, row.seq).all<{ body: string }>();
        let sale: ReturnType<typeof saleFrom>;
        try {
          if (!Number.isSafeInteger(paid.total) || !Number.isSafeInteger(paid.tendered) || typeof paid.tender !== 'string') throw new Error('bad payment');
          sale = saleFrom(paid, order.map((o) => JSON.parse(o.body) as OrderEvent));
        } catch (e) {
          // A payment the ledger cannot read is skipped (it stays in the events), never retried forever.
          console.error('sales ledger: skipped', paid.id, e);
          await cursorTo(row.seq).run();
          continue;
        }
        writes.push(db.prepare(`INSERT OR IGNORE INTO sales
          (id, tenant_id, order_number, sale_date, sale_time, paid_at, items_count, subtotal, discount, total,
           tender, tendered, change_given, cashier, online, event_seq)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
          sale.id, tenantId, sale.orderNumber, sale.saleDate, sale.saleTime, sale.paidAt, sale.itemsCount, sale.subtotal,
          sale.discount, sale.total, sale.tender, sale.tendered, sale.changeGiven, sale.cashier, sale.online ? 1 : 0, row.seq));
        for (const it of sale.items) {
          writes.push(db.prepare(`INSERT OR IGNORE INTO sale_items
            (sale_id, tenant_id, line_no, item_id, item_name, size, qty, unit_price, line_total, extras, left_out)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
            sale.id, tenantId, it.lineNo, it.itemId, it.itemName, it.size, it.qty, it.unitPrice, it.lineTotal, it.extras, it.leftOut));
        }
        filed++;
      } else {
        // An Undo takes back the latest payment of that number still standing.
        const undone = await standing(row.seq);
        const at = (JSON.parse(row.body) as { at: number }).at;
        if (undone) writes.push(db.prepare(`UPDATE sales SET status = 'undone', undone_at = ? WHERE id = ?`).bind(at, undone.id));
      }
      writes.push(cursorTo(row.seq));
      await db.batch(writes);
    }
    if (results.length < PAGE) {
      await cursorTo(top).run(); // nothing else up to `top` concerns the ledger
      return filed;
    }
  }
  return filed;
}
