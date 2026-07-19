"use client";

import { useState } from "react";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";

export default function LoginPage() {
  const [email, setEmail] = useState("owner@summit.test");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/v1/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) {
        setError("That email and password don't match. Try again.");
        return;
      }
      window.location.href = "/leads";
    } catch {
      setError("Couldn't reach the server. Is the API running?");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ minHeight: "80vh", display: "grid", placeItems: "center" }}>
      <form className="card" onSubmit={submit} style={{ width: 360, padding: 28 }}>
        <div className="brand" style={{ marginBottom: 6 }}>
          <div className="brand-text">
            <b>Summit Roofing</b>
            <span>Speed-to-Lead</span>
          </div>
        </div>
        <h1 style={{ fontSize: 19, margin: "10px 0 2px" }}>Sign in</h1>
        <p className="subtitle" style={{ margin: "0 0 18px" }}>Operations console</p>

        <label className="label" style={{ display: "block", marginBottom: 4 }}>Email</label>
        <input
          className="fld"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="username"
          required
        />
        <label className="label" style={{ display: "block", margin: "14px 0 4px" }}>Password</label>
        <input
          className="fld"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          placeholder="demo1234"
          required
        />

        {error && <div style={{ color: "var(--crit)", fontSize: 12.5, marginTop: 12 }}>{error}</div>}

        <button className="btn" type="submit" disabled={busy} style={{ width: "100%", justifyContent: "center", marginTop: 18 }}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
        <p style={{ color: "var(--faint)", fontSize: 11.5, marginTop: 14, textAlign: "center" }}>
          Demo tenant seeded with password <code>demo1234</code>.
        </p>
      </form>
    </div>
  );
}
