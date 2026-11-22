import { getRoutes, type RouteRow } from "../../../admin-operations";
import { towns } from "../../../domain";
import { Heading, Unavailable, load, number } from "../../ui";
export const metadata = { title: "Routes" };
const sample: RouteRow[] = [
  { origin: "Harare", destination: "Bulawayo", adverts: 12, searches: 19, completed: 8 },
  { origin: "Gweru", destination: "Bulawayo", adverts: 7, searches: 13, completed: 4 },
  { origin: "Bulawayo", destination: "Hwange", adverts: 6, searches: 11, completed: 3 },
  { origin: "Hwange", destination: "Victoria Falls", adverts: 4, searches: 6, completed: 2 },
];
export default async function Routes() {
  const rows = await load("routes", getRoutes, () => sample);
  return <><Heading title="Routes" intro="Supply, demand and completed shipments by direction of travel." />
    <section className="corridor"><div><h2>Pilot corridor</h2><span>Both directions</span></div>
      <ol>{towns.map(t => <li key={t}><i />{t}</li>)}</ol></section>
    <section className="panel"><div className="panel-heading"><h2>Route activity</h2><span className="subtle">All time</span></div>
    {!rows ? <Unavailable what="Route figures" /> : !rows.length ? <p className="empty">Routes appear when a trucker advertises or a shipper searches.</p> : <div className="table-scroll"><table className="data"><thead><tr>
      <th>Origin</th><th>Destination</th><th className="num">Space adverts</th><th className="num">Shipper searches</th><th className="num">Completed shipments</th>
    </tr></thead><tbody>{rows.map(r => <tr key={r.origin + r.destination}><th scope="row">{r.origin}</th><td>{r.destination}</td>
      <td className="num">{number.format(r.adverts)}</td><td className="num">{number.format(r.searches)}</td><td className="num">{number.format(r.completed)}</td></tr>)}</tbody></table></div>}</section>
  </>;
}
