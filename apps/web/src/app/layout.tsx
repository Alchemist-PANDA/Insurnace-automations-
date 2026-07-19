import type { ReactNode } from "react";
import Link from "next/link";
import "./globals.css";

export const metadata = {
  title: "Speed-to-Lead",
  description: "Inbound lead response and appointment-conversion platform",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="app">
          <aside className="sidebar">
            <div className="brand">
              <div className="brand-text">
                <b>Summit Roofing</b>
                <span>Speed-to-Lead</span>
              </div>
            </div>
            <nav>
              <Link href="/leads">Lead inbox</Link>
              <Link href="/hot">Hot-lead queue</Link>
              <Link href="/analytics">Analytics</Link>
              <Link href="/compliance">Compliance</Link>
              <Link href="/health">System health</Link>
            </nav>
            <div className="footnote">Pilot build · roofing / HVAC</div>
          </aside>
          <main className="content">{children}</main>
        </div>
      </body>
    </html>
  );
}
