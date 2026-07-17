export default function CompliancePage() {
  return (
    <div>
      <h1>Consent &amp; suppression</h1>
      <p className="subtitle">
        Consent evidence, opt-outs, suppression list, and audit trail.
      </p>
      <div className="card empty">
        Full compliance dashboard ships in M10. The consent ledger, suppression
        entries, and opt-out audit trail are already being written by the Slice 1
        pipeline (verified by the STOP end-to-end test).
      </div>
    </div>
  );
}
