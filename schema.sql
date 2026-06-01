CREATE TABLE IF NOT EXISTS prospects (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  place_id         TEXT    UNIQUE NOT NULL,
  name             TEXT    NOT NULL,
  address          TEXT    NOT NULL DEFAULT '',
  phone            TEXT    NOT NULL DEFAULT '',
  category         TEXT    NOT NULL DEFAULT '',
  email            TEXT,
  status           TEXT    NOT NULL DEFAULT 'nuevo'
                   CHECK(status IN ('nuevo', 'contactado', 'sin_email', 'cerrado', 'error')),
  email_subject    TEXT,
  email_body       TEXT,
  error_msg        TEXT,
  email_sent_at    TEXT,
  created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_status     ON prospects(status);
CREATE INDEX IF NOT EXISTS idx_created_at ON prospects(created_at DESC);
