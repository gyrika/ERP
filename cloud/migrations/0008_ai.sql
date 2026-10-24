-- Language-model answers (SCRUM-144, Cloudflare Workers AI). The same question asked again is
-- answered from here, not by the model: faster, and it does not count towards the daily cap.
CREATE TABLE ai_cache (
  tenant_id   TEXT    NOT NULL REFERENCES shops(id),
  key         TEXT    NOT NULL,                       -- sha256 of the task and its input
  answer      TEXT    NOT NULL,                       -- JSON
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, key)
);

-- Model calls per shop per day (Sri Lanka date), for the daily cap.
CREATE TABLE ai_usage (
  tenant_id   TEXT    NOT NULL REFERENCES shops(id),
  day         TEXT    NOT NULL,                       -- YYYY-MM-DD
  calls       INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, day)
);
