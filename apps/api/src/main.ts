import { loadEnv } from "@stl/config";
import { buildServer } from "./server.js";

async function main() {
  const env = loadEnv();
  const app = await buildServer();
  await app.listen({ port: env.API_PORT, host: "0.0.0.0" });
  app.log.info(`api listening on :${env.API_PORT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
