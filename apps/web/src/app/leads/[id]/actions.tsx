"use client";

import { useState } from "react";

/**
 * Lead action buttons (plan: blueprint §5I). Client component that calls the
 * API's human-in-the-loop endpoints. Tenant is the dev shim until sessions land.
 */
const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";
const DEV_TENANT = process.env.NEXT_PUBLIC_DEV_TENANT_ID ?? "";

export function LeadActions({ leadId, state }: { leadId: string; state: string }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function call(path: string, label: string) {
    setBusy(label);
    setMsg(null);
    try {
      const res = await fetch(`${API_BASE}${path}`, {
        method: "POST",
        headers: { "x-tenant-id": DEV_TENANT, "x-user-id": "dashboard-user" },
      });
      setMsg(res.ok ? `${label} ✓` : `${label} failed (${res.status})`);
    } catch (e) {
      setMsg(`${label} error: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  const isHuman = state === "human_owned";

  return (
    <div className="card">
      <h3>Actions</h3>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {!isHuman ? (
          <button className="btn" disabled={!!busy} onClick={() => call(`/v1/leads/${leadId}/takeover`, "Take over")}>
            Take over
          </button>
        ) : (
          <button className="btn" disabled={!!busy} onClick={() => call(`/v1/leads/${leadId}/resume`, "Resume AI")}>
            Resume automation
          </button>
        )}
        <button className="btn ghost" disabled={!!busy} onClick={() => call(`/v1/leads/${leadId}/acknowledge`, "Acknowledge")}>
          Acknowledge
        </button>
      </div>
      {msg && <div style={{ marginTop: 10, color: "var(--muted)", fontSize: 13 }}>{msg}</div>}
    </div>
  );
}
