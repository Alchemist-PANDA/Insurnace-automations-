export default function LoginPage() {
  return (
    <div style={{ maxWidth: 360, margin: "80px auto" }}>
      <h1>Sign in</h1>
      <p className="subtitle">
        Session auth (better-auth) lands in milestone M1. In the pilot build the
        dashboard reads a single tenant via the <code>DEV_TENANT_ID</code> shim.
      </p>
      <div className="card">
        <div className="kv"><span className="k">Email</span><span>—</span></div>
        <div className="kv"><span className="k">Password</span><span>—</span></div>
      </div>
    </div>
  );
}
