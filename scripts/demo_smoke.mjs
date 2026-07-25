// One runnable check for the demo dataset: boot PGlite, replay lib/demo/seed.ts, and assert
// the things the dashboard depends on. Catches a broken regeneration (bad SQL, drifted schema,
// unescaped template literal, un-bumped identity sequence) without needing a browser.
//
//   node scripts/demo_smoke.mjs
//
// Run it after `python scripts/gen_demo_seed.py`.

import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const web = path.join(root, "web");

// seed.ts is a single `export const DEMO_SQL = \`…\`` — eval it so the JS engine does the
// template-literal unescaping, rather than re-implementing it here and getting it subtly wrong.
const src = readFileSync(path.join(web, "lib/demo/seed.ts"), "utf8");
const DEMO_SQL = (0, eval)(src.replace("export const DEMO_SQL =", ""));

const { PGlite } = await import(
  // A bare specifier would resolve against scripts/, not web/node_modules — and on Windows
  // a raw absolute path is not a legal ESM specifier, hence the file:// URL.
  pathToFileURL(path.join(web, "node_modules/@electric-sql/pglite/dist/index.js")).href
);
const pg = new PGlite({ parsers: { 20: (v) => Number(v) } });
await pg.exec(DEMO_SQL);

const one = async (sql) => (await pg.query(sql)).rows[0];

// The main read must return a populated drive.
const main = await one(
  "SELECT count(*)::int AS n FROM items WHERE is_private = 0 AND deleted_at IS NULL"
);
assert.ok(main.n >= 25, `expected a populated Main space, got ${main.n} items`);

for (const [label, sql] of [
  ["trash", "SELECT count(*)::int AS n FROM items WHERE deleted_at IS NOT NULL"],
  ["private", "SELECT count(*)::int AS n FROM items WHERE is_private = 1"],
  ["favourites", "SELECT count(*)::int AS n FROM items WHERE is_favorite = 1"],
  ["thumbnails", "SELECT count(*)::int AS n FROM thumbnails"],
  ["upload queue", "SELECT count(*)::int AS n FROM upload_jobs"],
  ["download queue", "SELECT count(*)::int AS n FROM download_jobs"],
]) {
  const { n } = await one(sql);
  assert.ok(n > 0, `${label} is empty — the demo would render a dead page`);
}

// items.total_parts / total_size must agree with the parts actually seeded, or every size
// and part count in the UI is a lie.
const mismatch = await one(`
  SELECT count(*)::int AS n FROM items i
  WHERE i.total_parts <> (SELECT count(*)::int FROM parts p WHERE p.item_id = i.id)
     OR i.total_size  <> (SELECT coalesce(sum(p.file_size), 0) FROM parts p WHERE p.item_id = i.id)`);
assert.equal(mismatch.n, 0, "items.total_parts/total_size disagree with parts");

// Every part must resolve to a demo asset that exists on disk — this is what the stream
// route redirects to, so a typo here is a broken preview in the demo.
const parts = (await pg.query("SELECT id, file_id FROM parts")).rows;
for (const p of parts) {
  assert.ok(String(p.file_id).startsWith("/demo/"), `part ${p.id}: file_id is not a demo asset`);
  const asset = path.join(web, "public", String(p.file_id));
  assert.ok(existsSync(asset), `part ${p.id}: missing asset ${p.file_id}`);
}

// Seeding with explicit ids leaves the IDENTITY sequences at 1 unless setval ran; the first
// rename or new folder in the demo would then collide with a seeded row.
for (const table of ["items", "folders", "parts", "tags"]) {
  const { next } = await one(
    `SELECT nextval(pg_get_serial_sequence('${table}', 'id'))::int AS next`
  );
  const { max } = await one(`SELECT max(id)::int AS max FROM ${table}`);
  assert.ok(next > max, `${table}: identity sequence not advanced past seeded ids`);
}

// A write must survive the same path the dashboard uses (triggers included).
await pg.query("UPDATE items SET title = 'renamed' WHERE id = 1");
assert.equal((await one("SELECT title FROM items WHERE id = 1")).title, "renamed");

console.log(`ok — ${main.n} items in Main, ${parts.length} parts, all assets present`);
