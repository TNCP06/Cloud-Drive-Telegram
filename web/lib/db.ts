import "server-only";
import { createClient } from "@libsql/client";

// Client libSQL untuk Turso. server-only memastikan modul ini tidak ikut ke bundle client
// (auth token tidak bocor ke browser).
export const db = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});
