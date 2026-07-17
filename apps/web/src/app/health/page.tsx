export default function HealthPage() {
  return (
    <div>
      <h1>System health</h1>
      <p className="subtitle">Queue depths, dead-letter queue, integration status.</p>
      <div className="card empty">
        Full health screen ships in M10. API and worker already expose
        <code> /healthz</code> and <code> /readyz</code>, and failed messages are
        retained for the DLQ view.
      </div>
    </div>
  );
}
