import { getAnalytics, type Analytics } from "@/lib/api";

export const dynamic = "force-dynamic";

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card" style={{ margin: 0 }}>
      <div style={{ color: "var(--muted)", fontSize: 12, textTransform: "uppercase", letterSpacing: "0.04em" }}>
        {label}
      </div>
      <div style={{ fontSize: 28, fontWeight: 700, marginTop: 6 }}>{value}</div>
      {sub && <div style={{ color: "var(--muted)", fontSize: 12, marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);
const money = (n: number) => `$${n.toLocaleString()}`;

export default async function AnalyticsPage() {
  let a: Analytics | null = null;
  let error: string | null = null;
  try {
    a = await getAnalytics();
  } catch (e) {
    error = (e as Error).message;
  }

  if (error || !a) {
    return (
      <div>
        <h1>Analytics</h1>
        <div className="card empty">Could not load analytics ({error}). Start the API service.</div>
      </div>
    );
  }

  const { responseTime: rt, funnel, attribution } = a;
  const grid = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 16 } as const;

  return (
    <div>
      <h1>Analytics</h1>
      <p className="subtitle">
        Response SLA and conversion funnel, computed from immutable lead-event timestamps.
      </p>

      <h3>Speed to lead</h3>
      <div style={grid}>
        <Stat label="Leads" value={String(rt.count)} sub={`${rt.contacted} contacted`} />
        <Stat label="Median response" value={fmtMs(rt.medianMs)} />
        <Stat label="p90 response" value={fmtMs(rt.p90Ms)} />
        <Stat label="≤ 60s" value={`${rt.withinPct.s60}%`} sub={`≤90s: ${rt.withinPct.s90}%`} />
      </div>

      <h3 style={{ marginTop: 24 }}>Conversion funnel</h3>
      <div style={grid}>
        <Stat label="Contact rate" value={`${funnel.rates.contactRate}%`} sub={`${funnel.counts.contacted}/${funnel.counts.total}`} />
        <Stat label="Reply rate" value={`${funnel.rates.replyRate}%`} />
        <Stat label="Qualification" value={`${funnel.rates.qualificationRate}%`} sub={`${funnel.counts.qualified} qualified`} />
        <Stat label="Booking rate" value={`${funnel.rates.bookingRate}%`} sub={`${funnel.counts.booked} booked`} />
        <Stat label="Close rate" value={`${funnel.rates.closeRate}%`} sub={`${funnel.counts.won} won`} />
      </div>

      <h3 style={{ marginTop: 24 }}>Attribution</h3>
      <div style={grid}>
        <Stat label="Attributed gross profit" value={money(attribution.attributedGrossProfit)} sub={`${attribution.wonDeals} won deals`} />
      </div>
    </div>
  );
}
