import type { CSSProperties } from "react";
import { getAnalytics, sampleAnalytics, type Analytics, type Period } from "../analytics";
import { formatDeparture } from "../domain";

export const dynamic = "force-dynamic";
const periods: { id: Period; label: string }[] = [
  { id: "7", label: "7 days" }, { id: "30", label: "30 days" }, { id: "all", label: "All time" },
];
const number = new Intl.NumberFormat("en");
const dateLabel = (date: string) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(date));

export default async function Dashboard({ searchParams }: { searchParams: Promise<{ period?: string }> }) {
  const chosen = (await searchParams).period;
  const period = chosen === "30" || chosen === "all" ? chosen : "7";
  const demo = !process.env.MONGODB_URI && process.env.NODE_ENV === "development";
  let data: Analytics | undefined;
  try { data = demo ? sampleAnalytics(period) : await getAnalytics(period); }
  catch { console.error("Dashboard could not load analytics"); }

  return <>
    <header className="top">
      <div className="top-content">
        <div className="brand"><span className="mark" aria-hidden="true">Z</span> Zunde</div>
        <span className="environment"><span />{demo ? "Demo data" : "Pilot operations"}</span>
      </div>
    </header>
    <main>
      <div className="heading">
        <div><h1>Pilot analytics</h1><p>Freight activity along the Harare–Victoria Falls corridor.</p></div>
        <nav aria-label="Reporting period" className="periods">
          {periods.map(({ id, label }) => <a key={id} href={`/?period=${id}`} aria-current={id === period ? "page" : undefined}>{label}</a>)}
        </nav>
      </div>
      {data ? <Overview data={data} period={period} /> :
        <p className="panel unavailable">Analytics are temporarily unavailable. Refresh after checking the database connection.</p>}
      <footer><span>Zunde</span><span>All times shown in Zimbabwe local time</span></footer>
    </main>
  </>;
}

function Overview({ data, period }: { data: Analytics; period: Period }) {
  const stats = [
    ["Truck searches", data.requests], ["Space adverts", data.trips], ["Searches with matches", data.matched],
    ["Offers accepted", data.confirmed], ["Completed deliveries", data.completed], ["Cancellations", data.cancelled],
  ] as const;
  const peak = Math.max(1, ...data.days.flatMap((item) => [item.requests, item.trips]));
  const rate = data.requests ? Math.round(data.matched / data.requests * 100) : null;

  return <>
    <dl className="stats">
      {stats.map(([label, count], i) => <div key={label} className={i === 2 ? "stat emphasis" : "stat"}>
        <dt>{label}</dt><dd>{number.format(count)}</dd>
        {i === 2 && rate !== null && <small>{rate}% of searches</small>}
      </div>)}
    </dl>
    <section className="panel trend">
      <div className="panel-heading">
        <div><h2>Daily activity</h2><p>{period === "all" ? "Last 30 days" : "New searches and adverts by day"}</p></div>
        <div className="legend"><span><i />Searches</span><span><i />Adverts</span></div>
      </div>
      <div className="plot">
        {data.days.map((item, index) => <div className="day" key={item.date} title={`${dateLabel(item.date)} · ${item.requests} searches · ${item.trips} adverts`}>
          <div className="bars" style={{ "--requests": item.requests / peak, "--trips": item.trips / peak } as CSSProperties}>
            <span aria-hidden="true" /><span aria-hidden="true" />
          </div>
          <span className="day-label" aria-hidden="true">{data.days.length === 7 || index % 6 === 0 ? dateLabel(item.date) : ""}</span>
          <span className="sr-only">{dateLabel(item.date)}: {item.requests} searches, {item.trips} adverts.</span>
        </div>)}
      </div>
    </section>
    <div className="detail">
      <section className="panel">
        <div className="panel-heading"><div><h2>Most requested routes</h2><p>Ranked by truck searches</p></div></div>
        {data.routes.length ? <table>
          <thead><tr><th scope="col">Route</th><th scope="col">Searches</th><th scope="col">Matched</th></tr></thead>
          <tbody>{data.routes.map((route) => <tr key={route.pickup + ":" + route.dropoff}>
            <th scope="row">{route.pickup} <span className="arrow">→</span> {route.dropoff}</th>
            <td>{number.format(route.requests)}</td><td>{number.format(route.matched)}</td>
          </tr>)}</tbody>
        </table> : <p className="empty">No truck searches in this period.</p>}
      </section>
      <section className="panel">
        <div className="panel-heading"><div><h2>Recent shipment activity</h2><p>Latest changes in this period</p></div></div>
        {data.activity.length ? <ul className="activity">{data.activity.map(({ ref, label, at }) => <li key={ref + label}>
          <div><span className="event">{label}</span><span className="ref">{ref.toUpperCase()}</span></div>
          <time dateTime={at.toISOString()}>{formatDeparture(at)}</time>
        </li>)}</ul> : <p className="empty">No shipment updates in this period.</p>}
      </section>
    </div>
  </>;
}
