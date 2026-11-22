import type { Metadata } from "next";
import { getHome, sampleHome } from "../../admin";
import { getAnalytics, sampleAnalytics, type Analytics } from "../../analytics";
import { Heading, Tabs, Unavailable, When, load, number, shortDate } from "../ui";
import { Icon, type IconName } from "../icons";
import AdSlot from "../ad-slot";

export const metadata: Metadata = { title: "Operations overview" };
export default async function DashboardHome({ searchParams }: { searchParams: Promise<{ period?: string }> }) {
  const period = (await searchParams).period === "30" ? "30" : "7";
  const [home, analytics] = await Promise.all([
    load("the dashboard", () => getHome(), sampleHome),
    load("freight activity", () => getAnalytics(period), () => sampleAnalytics(period)),
  ]);
  const metrics: [string, number, IconName, string, string][] = home ? [
    ["Open adverts", home.counts.openTrips, "truck", "/trips", "Truck departures ahead"],
    ["Completed shipments", home.counts.completed, "package", "/trips?view=shipments&scope=completed", "Both parties confirmed"],
    ["Registered truckers", home.counts.truckers, "route", "/users?role=trucker", "View trucker directory"],
    ["Registered shippers", home.counts.shippers, "people", "/users?role=shipper", "View shipper directory"],
  ] : [];
  return <>
    <Heading title="Operations overview" intro="Truck space, shipments and account activity across the pilot corridor." />
    {home ? <div className="metric-grid">{metrics.map(([title, value, icon, href, subtitle], i) => <a href={href} className={`metric metric-${i}`} key={title}>
      <div><span>{title}</span><span className="metric-icon"><Icon name={icon} /></span></div><strong>{number.format(value)}</strong><small>{subtitle}</small>
    </a>)}</div> : <Unavailable what="Dashboard figures" />}
    <div className="overview-mid"><section className="panel freight-chart"><div className="panel-heading"><div><h2>Freight activity</h2><p>Truck adverts and completed shipments</p></div>
      <Tabs label="Freight activity period" items={["7", "30"].map(id => ({ href: `/?period=${id}`, label: `${id} days`, current: id === period }))} /></div>
      {analytics ? <FreightChart days={analytics.days} /> : <Unavailable what="Activity figures" />}</section><AdSlot /></div>
    {home && <div className="detail">
      <section className="panel"><div className="panel-heading"><h2>Recent activity</h2><span className="subtle">Last 7 days</span></div>
        {home.activity.length ? <ul className="activity feed">{home.activity.map((item, i) => <li key={i}><span className="feed-icon"><Icon name={item.label === "Space advertised" ? "truck" : "package"} size={16} /></span>
          <div><span className="event">{item.label}</span><span className="ref">{item.ref ? item.ref + " · " : ""}{item.detail}</span></div><When at={item.at} /></li>)}</ul> : <p className="empty">No bookings or adverts in the last 7 days.</p>}</section>
      <section className="panel"><div className="panel-heading"><h2>Needs attention</h2><a className="text-link" href="/trips?view=shipments&scope=attention">View bookings</a></div>
      {home.alerts.length ? <ul className="alerts">{home.alerts.map(alert => <li key={alert.id}><span className="alert-count">{alert.count}</span><div><span className="event">{alert.href ? <a href={alert.href}>{alert.label}</a> : alert.label}</span><p>{alert.detail}</p></div></li>)}</ul> : <p className="empty">Nothing needs attention right now.</p>}
      <div className="booking-totals"><span>Active shipments <b>{home.counts.activeShipments}</b></span><span>Cancellations <b>{home.counts.cancelled}</b></span></div></section>
    </div>}
  </>;
}

function FreightChart({ days }: { days: Analytics["days"] }) {
  const max = Math.max(4, Math.ceil(Math.max(...days.flatMap(d => [d.trips, d.completed])) / 4) * 4);
  return <><div className="chart-key"><span>Adverts</span><span>Completed</span></div>
    <div className="chart-body"><div className="chart-axis" aria-hidden="true">{[4, 3, 2, 1, 0].map(n => <span key={n}>{n * max / 4}</span>)}</div>
      <div className="chart-days">{days.map((d, i) => <div className="chart-day" key={d.date} title={`${shortDate(d.date)} · ${d.trips} adverts · ${d.completed} completed`}>
        <div className="chart-pair"><i style={{ height: (100 * d.trips / max) + "%" }} /><i style={{ height: (100 * d.completed / max) + "%" }} /></div>
        <small aria-hidden="true">{days.length === 7 || i % 6 === 2 ? shortDate(d.date) : ""}</small>
        <span className="sr-only">{shortDate(d.date)}, {d.trips} adverts, {d.completed} completed shipments.</span>
      </div>)}</div></div></>;
}
