import type { Metadata } from "next";
import { demoMode } from "../admin";
import Nav from "./nav";
import "./styles.css";

export const metadata: Metadata = {
  title: { default: "Zunde Admin", template: "%s · Zunde Admin" },
  description: "Users, truck adverts, freight requests and bookings on the Zunde pilot corridor.",
  robots: { index: false, follow: false },
};

export default function Layout({ children }: Readonly<{ children: React.ReactNode }>) {
  const demo = demoMode();
  return <html lang="en"><body>
    <header className="top">
      <div className="top-content">
        <div className="brand"><span className="mark" aria-hidden="true">Z</span> Zunde <span className="brand-role">Admin</span></div>
        <span className="environment"><span />{demo ? "Demo data" : "Pilot operations"}</span>
      </div>
    </header>
    <div className="shell">
      <Nav />
      <main>
        {children}
        <footer><span>Zunde</span><span>All times shown in Zimbabwe local time</span></footer>
      </main>
    </div>
  </body></html>;
}
