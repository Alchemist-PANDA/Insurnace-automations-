import Link from "next/link";
import { getLeads, type LeadRow } from "@/lib/api";

export const dynamic = "force-dynamic";

function Band({ band }: { band: string | null }) {
  if (!band) return <span className="state-pill">unscored</span>;
  return <span className={`badge ${band}`}>{band}</span>;
}

function name(l: LeadRow): string {
  return [l.firstName, l.lastName].filter(Boolean).join(" ") || "(no name)";
}

export default async function LeadInbox() {
  let leads: LeadRow[] = [];
  let error: string | null = null;
  try {
    leads = (await getLeads()).leads;
  } catch (e) {
    error = (e as Error).message;
  }

  return (
    <div>
      <h1>Lead inbox</h1>
      <p className="subtitle">
        Every inbound lead, newest first — with its live score and state.
      </p>

      {error ? (
        <div className="card empty">
          Could not reach the API ({error}). Start the API service and set
          <code> DEV_TENANT_ID</code>.
        </div>
      ) : leads.length === 0 ? (
        <div className="card empty">No leads yet. Send a test webhook to see one appear.</div>
      ) : (
        <div className="card" style={{ padding: 0 }}>
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Service</th>
                <th>City</th>
                <th>Score</th>
                <th>Band</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {leads.map((l) => (
                <tr key={l.id}>
                  <td>
                    <Link href={`/leads/${l.id}`}>{name(l)}</Link>
                  </td>
                  <td>{l.serviceRequested ?? "—"}</td>
                  <td>{l.city ?? "—"}</td>
                  <td>{l.scoreCurrent ?? "—"}</td>
                  <td>
                    <Band band={l.scoreBand} />
                  </td>
                  <td>
                    <span className="state-pill">{l.state}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
