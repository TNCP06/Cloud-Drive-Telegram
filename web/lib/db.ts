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

// DEMO_MODE=1 (the UI-only Vercel deployment) swaps Postgres for PGlite — the real
// Postgres engine compiled to WASM — running in memory and seeded from lib/demo/seed.ts.
// Every query, index, trigger and `now_text()` call below this line is unchanged, so the
// demo exercises the same SQL the production dashboard does; the ONLY other file that
// knows a demo exists is the stream route (it serves static files instead of Telegram).
// Each serverless instance gets its own copy, so edits made in the demo are real until
// that instance is recycled — and no visitor can wreck it for the next one.
const DEMO = process.env.DEMO_MODE === "1";

type Queryable = { query: (sql: string, args: unknown[]) => Promise<QueryResult> };
type QueryResult = { rows: Record<string, unknown>[]; rowCount?: number | null; affectedRows?: number };

const globalForDb = globalThis as unknown as {
  _cdtPool?: Pool;
  _cdtDemo?: Promise<Queryable>;
};

function connect(): Promise<Queryable> {
  if (DEMO) {
    globalForDb._cdtDemo ??= (async () => {
      const [{ PGlite }, { DEMO_SQL }] = await Promise.all([
        import("@electric-sql/pglite"),
        import("./demo/seed"),
      ]);
      // Match the BIGINT→Number parser above; PGlite would otherwise hand back strings.
      const pg = new PGlite({ parsers: { 20: (v: string) => Number(v) } });
      await pg.exec(DEMO_SQL);
      return pg as unknown as Queryable;
    })();
    return globalForDb._cdtDemo;
  }

  globalForDb._cdtPool ??= new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 10,
  });
  return Promise.resolve(globalForDb._cdtPool as unknown as Queryable);
}

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
    const res = await (await connect()).query(toPg(sql), args);
    return { rows: res.rows, rowsAffected: res.rowCount ?? res.affectedRows ?? 0 };
  },
};
