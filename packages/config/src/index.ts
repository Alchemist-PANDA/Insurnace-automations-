import { z } from "zod";

/**
 * Environment validation. Fails fast on boot — a misconfigured service must
 * never start and silently misbehave (plan: architecture §8, principle #5).
 *
 * Each service calls `loadEnv()` once at startup. Missing/invalid values throw
 * with a readable aggregate error before any work begins.
 */
const EnvSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  API_PORT: z.coerce.number().int().positive().default(4000),
  API_PUBLIC_URL: z.string().url().default("http://localhost:4000"),

  WEB_PORT: z.coerce.number().int().positive().default(3000),
  AUTH_SECRET: z.string().min(16),

  CREDENTIAL_ENCRYPTION_KEY: z
    .string()
    .min(1, "CREDENTIAL_ENCRYPTION_KEY is required (base64 32-byte key)"),

  TWILIO_ACCOUNT_SID: z.string().optional().default(""),
  TWILIO_AUTH_TOKEN: z.string().optional().default(""),
  TWILIO_MESSAGING_SERVICE_SID: z.string().optional().default(""),

  ANTHROPIC_API_KEY: z.string().optional().default(""),
  LLM_MODEL: z.string().default("claude-sonnet-4-5"),

  USE_FAKE_ADAPTERS: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),

  // When true, API routes accept x-tenant-id/x-user-id headers as an auth
  // fallback (dev + tests). FORCED OFF in production regardless of this value —
  // see `devAuthAllowed()`.
  AUTH_ALLOW_DEV_HEADERS: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** Test helper: reset the cached env so a fresh source can be loaded. */
export function resetEnvCache(): void {
  cached = undefined;
}

/**
 * Whether the x-tenant-id/x-user-id dev-header auth fallback is permitted.
 * Production ALWAYS rejects it, no matter the env flag — this is the guard that
 * makes the header shim safe to keep for local/tests.
 */
export function devAuthAllowed(env: Env = loadEnv()): boolean {
  if (env.NODE_ENV === "production") return false;
  return env.AUTH_ALLOW_DEV_HEADERS;
}
