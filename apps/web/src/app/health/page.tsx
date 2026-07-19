import { getHealth, type IntegrationHealth } from "@/lib/api";

export const dynamic = "force-dynamic";

export default async function HealthPage() {
  let h: IntegrationHealth | null = null;
  let error: string | null = null;
  try {
    h = await getHealth();
  } catch (e) {
    error = (e as Error).message;
  }

  if (error || !h) {
    return (
      <div>
        <h1>System health</h1>
        <div className="card empty">Could not load health ({error}).</div>
      </div>
    );
  }

  return (
    <div>
      <h1>System health</h1>
      <p className="subtitle">Integration status and the dead-letter queue.</p>

      <div className="card">
        <h3>CRM sync</h3>
        <div className="kv"><span className="k">Total</span><span>{h.crm.total}</span></div>
        <div className="kv"><span className="k">Synced</span><span>{h.crm.synced}</span></div>
        <div className="kv"><span className="k">Failed</span><span style={{ color: h.crm.failed ? "var(--hot)" : "inherit" }}>{h.crm.failed}</span></div>
      </div>

      <div className="card">
        <h3>Dead-letter queue</h3>
        <div className="kv"><span className="k">Failed messages</span><span style={{ color: h.dlq.failedMessages ? "var(--hot)" : "inherit" }}>{h.dlq.failedMessages}</span></div>
        <div className="kv"><span className="k">Pending outbox</span><span>{h.dlq.pendingOutbox}</span></div>
        {h.dlq.items.length > 0 && (
          <table style={{ marginTop: 12 }}>
            <thead><tr><th>Message</th><th>Failed at</th></tr></thead>
            <tbody>
              {h.dlq.items.map((m) => (
                <tr key={m.id}>
                  <td>{m.body.slice(0, 60)}</td>
                  <td>{new Date(m.createdAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
