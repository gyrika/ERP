# Cook times

Each kitchen ticket has one button that is its next step: **Start** (the cook picks it up), then
**Done**. Space does the same for the oldest ticket; Undo / Ctrl+Z takes back either tap.

Both taps are events (`kitchen.started`, `kitchen.bumped`; Undo writes `kitchen.unstarted` /
`kitchen.unbumped`), so the times are stored in the `events` table (MySQL or SQLite) and the
cloud copy like everything else. Nothing extra is written.

## In the app

`cookLog(events)` in `src/domain/kitchen.ts` gives one record per finished ticket, with Undo and
recalled sends already applied:

| field | meaning |
|---|---|
| `sentAt`, `startedAt`, `doneAt` | ms timestamps (`startedAt` null if Done was tapped without Start) |
| `waitMs` | sent → Start: time in the queue |
| `cookMs` | Start → Done: cooking time |
| `totalMs` | sent → Done: what the customer waited |
| `items` | item id, category, size, qty of what was cooked (cancelled lines left out) |

## Straight from MySQL

A quick look without Undo handling (fine while Undo is rare; use `cookLog` for exact numbers):

```sql
SELECT s.order_number,
       FROM_UNIXTIME(s.at / 1000)            AS sent,
       (MAX(st.at) - s.at) / 60000           AS wait_min,
       (MAX(d.at) - MAX(st.at)) / 60000      AS cook_min,
       (MAX(d.at) - s.at) / 60000            AS total_min
FROM events s
LEFT JOIN events st ON st.tenant_id = s.tenant_id AND st.type = 'kitchen.started'
                   AND st.body->>'$.ticketId' = s.body->>'$.ticketId'
JOIN events d       ON d.tenant_id = s.tenant_id AND d.type = 'kitchen.bumped'
                   AND d.body->>'$.ticketId' = s.body->>'$.ticketId'
WHERE s.type = 'order.sent'
GROUP BY s.tenant_id, s.id, s.order_number, s.at
ORDER BY s.at;
```
