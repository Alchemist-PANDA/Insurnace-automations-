import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Applies Drizzle migrations then the RLS policies. Run via `pnpm db:migrate`.
 */
async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");

  const client = postgres(url, { max: 1 });
  const db = drizzle(client);

  console.log("Running migrations…");
  await migrate(db, { migrationsFolder: join(__dirname, "..", "drizzle") });

  console.log("Applying RLS policies…");
  const rls = readFileSync(join(__dirname, "rls.sql"), "utf8");
  await db.execute(sql.raw(rls));

  // Ensure the restricted application role exists and is granted. RLS is only
  // enforced for a non-superuser, non-BYPASSRLS role — the API/worker connect
  // as stl_app, never as the migration owner.
  console.log("Bootstrapping application role…");
  const roles = readFileSync(join(__dirname, "bootstrap-roles.sql"), "utf8");
  await db.execute(sql.raw(roles));

  console.log("Migration complete.");
  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
