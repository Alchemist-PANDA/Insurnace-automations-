/**
 * Live provider smoke test (plan: Tier 1 #3, PLAN M11). Exercises the REAL
 * Twilio / HubSpot adapters against live credentials to prove the wiring end to
 * end before a pilot. It sends an actual SMS and creates an actual CRM contact,
 * so it refuses to run unless USE_FAKE_ADAPTERS=false and credentials exist.
 *
 * Usage:
 *   USE_FAKE_ADAPTERS=false \
 *   TWILIO_ACCOUNT_SID=... TWILIO_AUTH_TOKEN=... TWILIO_MESSAGING_SERVICE_SID=... \
 *   HUBSPOT_TOKEN=... SMOKE_TO=+1XXXXXXXXXX \
 *   pnpm --filter @stl/worker smoke
 */
import { loadEnv } from "@stl/config";
import { TwilioSmsChannel } from "@stl/messaging";
import { HubSpotCrm } from "@stl/crm";

async function main() {
  const env = loadEnv();
  const to = process.env.SMOKE_TO;
  const hubspotToken = process.env.HUBSPOT_TOKEN;

  if (env.USE_FAKE_ADAPTERS) {
    fail("USE_FAKE_ADAPTERS is true — set it to false and provide real credentials to run a live smoke test.");
  }

  console.log("── Speed-to-Lead live smoke test ──\n");

  // 1. Twilio SMS
  if (env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_MESSAGING_SERVICE_SID && to) {
    const sms = new TwilioSmsChannel({ accountSid: env.TWILIO_ACCOUNT_SID, authToken: env.TWILIO_AUTH_TOKEN });
    const res = await sms.send({
      tenantSender: { sender: env.TWILIO_MESSAGING_SERVICE_SID },
      to,
      body: "Speed-to-Lead smoke test — you can ignore this. Reply STOP to opt out.",
      dedupeKey: `smoke:${Date.now()}`,
      correlationId: "smoke",
    });
    report("Twilio SMS", res.ok, res.ok ? `sid ${res.providerSid}` : `${res.code}: ${res.message}`);
  } else {
    skip("Twilio SMS", "set TWILIO_* and SMOKE_TO");
  }

  // 2. HubSpot contact upsert
  if (hubspotToken) {
    try {
      const crm = new HubSpotCrm();
      const ref = await crm.upsertContact(
        { accessToken: hubspotToken },
        { firstName: "Smoke", lastName: "Test", email: `smoke+${Date.now()}@example.com`, phone: null, source: "smoke_test" },
      );
      report("HubSpot contact", true, `id ${ref.externalId}`);
    } catch (err) {
      report("HubSpot contact", false, (err as Error).message);
    }
  } else {
    skip("HubSpot contact", "set HUBSPOT_TOKEN");
  }

  // 3. Google Calendar requires a per-rep OAuth token; verified via the app's
  // connect flow rather than a static credential, so it is exercised in staging.
  skip("Google Calendar", "verified via per-rep OAuth in staging, not a static token");

  console.log("\nDone. A green Twilio + HubSpot line means the live wiring works.");
}

function report(name: string, ok: boolean, detail: string) {
  console.log(`${ok ? "✓" : "✗"} ${name.padEnd(18)} ${detail}`);
}
function skip(name: string, why: string) {
  console.log(`− ${name.padEnd(18)} skipped (${why})`);
}
function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
