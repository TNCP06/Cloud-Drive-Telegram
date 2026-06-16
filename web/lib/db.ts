import "server-only";
import { createClient } from "@libsql/client";

// libSQL client for Turso. server-only ensures this module is excluded from the
// client bundle (auth token never leaks to the browser).
export const db = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});
