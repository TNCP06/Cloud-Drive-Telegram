-- excerpt of the drive schema
CREATE TABLE items (
    id          BIGINT PRIMARY KEY,
    slug        TEXT UNIQUE NOT NULL,
    title       TEXT NOT NULL,
    kind        TEXT NOT NULL,
    total_parts INTEGER NOT NULL DEFAULT 0,
    total_size  BIGINT NOT NULL DEFAULT 0
);

CREATE INDEX idx_items_kind ON items(kind);
