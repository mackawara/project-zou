import { demoMode } from "../../admin";
import { timeZone } from "../../domain";
import Nav from "../nav";
import { Icon } from "../icons";
import { requireDashboard } from "../session";
import { signOut } from "../login/actions";

export const dynamic = "force-dynamic";
export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  await requireDashboard();
  const demo = demoMode();
  const today = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone }).format(new Date());
  return <div className="console"><aside className="rail">
    <a className="wordmark" href="/" aria-label="Zunde overview"><i aria-hidden="true">Z</i> Zunde</a>
    <Nav /><div className="rail-foot"><strong>Zunde Admin</strong><small>Freight operations</small></div>
  </aside><div className="workspace">
    <header className="toolbar"><span className="workspace-name">Admin workspace</span><div>
      <span className="env-label">{demo ? "Sample data" : "Pilot operations"}</span><span className="toolbar-date"><Icon name="calendar" size={16} />{today}</span>
      {!demo && <form action={signOut}><button title="Sign out"><Icon name="logout" size={16} />Sign out</button></form>}
    </div></header>
    <main id="main">{children}<footer><span>Zunde · Freight operations</span><span>Zimbabwe local time (CAT)</span></footer></main>
  </div></div>;
}
