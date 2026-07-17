import Link from "next/link";
import { getLead } from "@/lib/api";

export const dynamic = "force-dynamic";

function fmt(ts: string | null): string {
  return ts ? new Date(ts).toLocaleString() : "—";
}

export default async function LeadDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  let data;
  try {
    data = await getLead(id);
  } catch (e) {
    return (
      <div className="card empty">Could not load lead ({(e as Error).message}).</div>
    );
  }

  const { lead, messages, scores, events } = data;
  const latestScore = scores[0];
  const displayName =
    [lead.firstName, lead.lastName].filter(Boolean).join(" ") || "(no name)";

  return (
    <div>
      <p className="subtitle">
        <Link href="/leads">← Lead inbox</Link>
      </p>
      <h1>
        {displayName}{" "}
        {lead.scoreBand && <span className={`badge ${lead.scoreBand}`}>{lead.scoreBand}</span>}
      </h1>
      <p className="subtitle">
        {lead.serviceRequested ?? "—"} · {lead.city ?? "—"} ·{" "}
        <span className="state-pill">{lead.state}</span>
      </p>

      <div className="grid-2">
        <div>
          <div className="card">
            <h3>Conversation</h3>
            {messages.length === 0 ? (
              <div className="empty">No messages yet.</div>
            ) : (
              <div className="timeline">
                {messages.map((m) => (
                  <div key={m.id} className={`msg ${m.direction}`}>
                    <div>{m.body}</div>
                    <div className="meta">
                      {m.direction === "out" ? "Sent" : "Received"} · {m.status} ·{" "}
                      {fmt(m.createdAt)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div>
          <div className="card">
            <h3>Score {latestScore ? `· ${latestScore.total}` : ""}</h3>
            {latestScore ? (
              <div>
                {latestScore.breakdown.map((line) => (
                  <div key={line.rule} className="score-line">
                    <span>{line.label}</span>
                    <span className={`pts ${line.points >= 0 ? "pos" : "neg"}`}>
                      {line.points >= 0 ? "+" : ""}
                      {line.points}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty">Not scored yet.</div>
            )}
          </div>

          <div className="card">
            <h3>Details</h3>
            <div className="kv"><span className="k">Phone</span><span>{lead.phoneE164 ?? "—"}</span></div>
            <div className="kv"><span className="k">First touch</span><span>{fmt(lead.firstTouchAt)}</span></div>
            <div className="kv"><span className="k">Created</span><span>{fmt(lead.createdAt)}</span></div>
          </div>

          <div className="card">
            <h3>Event trail</h3>
            <div className="timeline">
              {events.map((e, i) => (
                <div key={i} className="kv">
                  <span className="k">{e.type}</span>
                  <span>{fmt(e.occurredAt)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
