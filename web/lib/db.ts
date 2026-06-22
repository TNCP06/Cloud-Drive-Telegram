import "server-only";
import { Pool, types } from "pg";

// Postgres client. `server-only` keeps this module (and the connection string) out of
// the client bundle. The project migrated from Turso/libSQL to self-hosted Postgres;
// this thin wrapper preserves the exact libSQL surface the app uses — `db.execute(sql)`
// / `db.execute({ sql, args })` returning `{ rows }` whose rows are objects keyed by
// column name — so the hundreds of `?`-placeholder call sites stay unchanged.

// BIGINT (oid 20) → Number, matching libSQL's default number mode. Sizes are bytes and
// never approach 2^53, so precision is safe; call sites already wrap values in Number().
types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

const globalForDb = globalThis as unknown as { _cdtPool?: Pool };

const pool =
  globalForDb._cdtPool ??
  new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 10,
  });
if (process.env.NODE_ENV !== "production") globalForDb._cdtPool = pool;

// `?` → `$1, $2, …`. The app's SQL never contains a literal `?` outside placeholders.
function toPg(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

type Args = unknown[];
type ExecArg = string | { sql: string; args?: Args };

export const db = {
  async execute(arg: ExecArg, maybeArgs?: Args) {
    const sql = typeof arg === "string" ? arg : arg.sql;
    const rawArgs = typeof arg === "string" ? maybeArgs ?? [] : arg.args ?? [];
    // pg rejects `undefined` params; libSQL tolerated them — coerce to null.
    const args = rawArgs.map((v) => (v === undefined ? null : v));
    const res = await pool.query(toPg(sql), args);
    return { rows: res.rows, rowsAffected: res.rowCount ?? 0 };
  },
};
