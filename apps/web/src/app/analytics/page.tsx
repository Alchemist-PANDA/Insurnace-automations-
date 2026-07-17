export default function AnalyticsPage() {
  return (
    <div>
      <h1>Analytics</h1>
      <p className="subtitle">
        Response-time percentiles, funnel rates, and gross-profit attribution.
      </p>
      <div className="card empty">
        Delivered in milestone M10 (computed from immutable lead-event
        timestamps). The event data these metrics read from is already being
        recorded by the Slice 1 pipeline.
      </div>
    </div>
  );
}
