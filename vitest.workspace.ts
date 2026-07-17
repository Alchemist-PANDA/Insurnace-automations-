import { defineWorkspace } from "vitest/config";

// Runs the unit/integration suites across every package that defines tests.
export default defineWorkspace([
  "packages/*",
  "packages/adapters/*",
  "apps/*",
]);
