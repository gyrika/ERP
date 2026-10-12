-- Each shop server makes a private secret the first time it connects; the cloud keeps only its hash.
-- The shop code then only ever creates NEW shops: getting back into an existing one (a lost answer,
-- connecting again) needs that shop's own secret. Shops from before this have none: nobody gets in.
ALTER TABLE shops ADD COLUMN secret_hash TEXT;
