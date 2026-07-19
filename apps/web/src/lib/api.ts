/**
 * Dashboard data access. Reads from the API service. Tenant is supplied via the
 * `x-tenant-id` dev shim header (better-auth sessions land in M1); the API still
 * enforces RLS on every query.
 */
const API_BASE = process.env.API_BASE_URL ?? "http://localhost:4000";
const DEV_TENANT = process.env.DEV_TENANT_ID ?? "";

export interface LeadRow {
  id: string;
  firstName: string | null;
  lastName: string | null;
  phoneE164: string | null;
  city: string | null;
  serviceRequested: string | null;
  state: string;
  scoreCurrent: number | null;
  scoreBand: string | null;
  createdAt: string;
  firstTouchAt: string | null;
}

export interface ScoreLine {
  rule: string;
  label: string;
  category: string;
  points: number;
}

export interface LeadDetail {
  lead: LeadRow & { region: string | null; postalCode: string | null };
  messages: {
    id: string;
    direction: "in" | "out";
    body: string;
    status: string;
    createdAt: string;
  }[];
  scores: { total: number; band: string; breakdown: ScoreLine[]; createdAt: string }[];
  events: { type: string; occurredAt: string }[];
}

async function api<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "x-tenant-id": DEV_TENANT },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`API ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

export interface Analytics {
  responseTime: {
    count: number;
    contacted: number;
    medianMs: number;
    p90Ms: number;
    withinPct: { s30: number; s60: number; s90: number };
  };
  funnel: {
    counts: { total: number; contacted: number; replied: number; qualified: number; booked: number; won: number };
    rates: { contactRate: number; replyRate: number; qualificationRate: number; bookingRate: number; closeRate: number };
  };
  attribution: { attributedGrossProfit: number; wonDeals: number };
}

export interface IntegrationHealth {
  crm: { total: number; synced: number; failed: number };
  dlq: { failedMessages: number; items: { id: string; body: string; createdAt: string }[]; pendingOutbox: number };
}

export const getLeads = () => api<{ leads: LeadRow[] }>("/v1/leads");
export const getLead = (id: string) => api<LeadDetail>(`/v1/leads/${id}`);
export const getAnalytics = () => api<Analytics>("/v1/analytics");
export const getHealth = () => api<IntegrationHealth>("/v1/health/integrations");
