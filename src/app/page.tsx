import type { Metadata } from "next";
import { getHome, sampleHome } from "../admin";
import { Heading, Unavailable, When, load, number } from "./ui";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Dashboard home" };

export default async function DashboardHome() {
  const data = await load("the dashboard", () => getHome(), () => sampleHome());
  return <>
    <Heading title="Dashboard home" intro="Users, bookings and anything that needs a follow-up today." />
    {data ? <>
      <dl className="stats">
        {([
          ["Shippers", data.counts.shippers], ["Truckers", data.counts.truckers], ["Open adverts", data.counts.openTrips],
          ["Active shipments", data.counts.activeShipments], ["Completed deliveries", data.counts.completed], ["Cancellations", data.counts.cancelled],
        ] as const).map(([label, count], i) => <div key={label} className={i === 3 ? "stat emphasis" : "stat"}>
          <dt>{label}</dt><dd>{number.format(count)}</dd>
        </div>)}
      </dl>
      <div className="detail">
        <section className="panel">
          <div className="panel-heading"><div><h2>Needs attention</h2><p>Bookings and messages that need someone to act</p></div></div>
          {data.alerts.length ? <ul className="alerts">{data.alerts.map((alert) => <li key={alert.id}>
            <span className="alert-count">{number.format(alert.count)}</span>
            <div>
              <span className="event">{alert.href ? <a href={alert.href}>{alert.label}</a> : alert.label}</span>
              <p>{alert.detail}</p>
            </div>
          </li>)}</ul> : <p className="empty">Nothing needs attention right now.</p>}
        </section>
        <section className="panel">
          <div className="panel-heading"><div><h2>Recent activity</h2><p>Bookings and adverts in the last 7 days</p></div></div>
          {data.activity.length ? <ul className="activity">{data.activity.map((item, i) => <li key={i}>
            <div><span className="event">{item.label}</span><span className="ref">{item.ref ? `${item.ref} · ` : ""}{item.detail}</span></div>
            <When at={item.at} />
          </li>)}</ul> : <p className="empty">No bookings or adverts in the last 7 days.</p>}
        </section>
      </div>
    </> : <Unavailable what="Dashboard figures" />}
  </>;
}
