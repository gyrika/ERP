-- Test data cleared (src/domain/freshStart.ts): the shop's latest `shop.started_fresh` the sales
-- ledger was rebuilt for. The ledger is only a copy of the events, so it is emptied and filed again
-- from the start without the test payments; this row stops that happening twice for one record.
CREATE TABLE sales_fresh (
  tenant_id   TEXT    PRIMARY KEY REFERENCES shops(id),
  marker_seq  INTEGER NOT NULL
);
