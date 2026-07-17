import { getLeads, type LeadRow } from "@/lib/api";

export const dynamic = "force-dynamic";

/** Hot-lead queue: leads in the Hot band awaiting human action (full SLA
 *  countdown + escalation ladder arrive with routing in M5). */
export default async function HotQueue() {
  let hot: LeadRow[] = [];
  try {
    hot = (await getLeads()).leads.filter((l) => l.scoreBand === "hot");
  } catch {
    /* API not running */
  }
  return (
    <div>
      <h1>Hot-lead queue</h1>
      <p className="subtitle">Highest-intent leads first. SLA escalation ships in M5.</p>
      {hot.length === 0 ? (
        <div className="card empty">No hot leads right now.</div>
      ) : (
        <div className="card" style={{ padding: 0 }}>
          <table>
            <thead>
              <tr><th>Name</th><th>Service</th><th>City</th><th>Score</th></tr>
            </thead>
            <tbody>
              {hot.map((l) => (
                <tr key={l.id}>
                  <td>{[l.firstName, l.lastName].filter(Boolean).join(" ") || "(no name)"}</td>
                  <td>{l.serviceRequested ?? "—"}</td>
                  <td>{l.city ?? "—"}</td>
                  <td>{l.scoreCurrent ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
