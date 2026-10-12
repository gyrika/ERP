-- The owner's answers to the questions page (/questions): missing recipe amounts, menu, receipt.
-- Every save is a new row; the newest is the answer, the older ones are its history.
CREATE TABLE owner_answers (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  saved_at  INTEGER NOT NULL,
  body      TEXT    NOT NULL
);
