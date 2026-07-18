// Public surface of the domain core. Everything here is pure logic with no I/O
// (plan: architecture §3 — the load-bearing convention). Apps and workers wire
// these functions to storage, queues, and provider adapters.

export * from "./types.js";
export * from "./normalize.js";
export * from "./dedup.js";
export * from "./state-machine.js";
export * from "./scoring.js";
export * from "./routing.js";
export * from "./optout.js";
export * from "./policy-gate.js";
export * from "./qualification.js";
export * from "./templating.js";
export * from "./verticals/roofing-hvac.js";
