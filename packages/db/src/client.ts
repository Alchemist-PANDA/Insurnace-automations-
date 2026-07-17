import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import * as schema from "./schema.js";

export type Database = PostgresJsDatabase<typeof schema>;

let sqlClient: ReturnType<typeof postgres> | undefined;
let db: Database | undefined;

export function getDb(databaseUrl = process.env.DATABASE_URL): Database {
  if (db) return db;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  sqlClient = postgres(databaseUrl, { max: 10 });
  db = drizzle(sqlClient, { schema });
  return db;
}

export async function closeDb(): Promise<void> {
  await sqlClient?.end();
  sqlClient = undefined;
  db = undefined;
}

export interface TenantContext {
  tenantId: string;
  /** When true, run without RLS tenant filter — platform-admin only, audited. */
  platformAdmin?: boolean;
}

/**
 * Run work inside a transaction with the RLS tenant variable set.
 *
 * This is the ONLY sanctioned way to touch tenant-scoped tables. `SET LOCAL`
 * scopes app.tenant_id to the transaction, so RLS policies filter every query
 * even if application code forgets a WHERE clause (plan: data-model §5).
 */
export async function withTenant<T>(
  database: Database,
  ctx: TenantContext,
  fn: (tx: Database) => Promise<T>,
): Promise<T> {
  return database.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.tenant_id', ${ctx.tenantId}, true)`,
    );
    await tx.execute(
      sql`select set_config('app.platform_admin', ${ctx.platformAdmin ? "on" : "off"}, true)`,
    );
    return fn(tx as unknown as Database);
  });
}

export { schema };
