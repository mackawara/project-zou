import type { Metadata } from "next";
import {
  getRequests, getShipments, getTrips, sampleRequests, sampleShipments, sampleTrips,
  type ShipmentScope, type TripScope,
} from "../../../admin";
import { dollars } from "../../../domain";
import { Badge, Heading, More, PersonCell, Tabs, Unavailable, When, load, number, shortDate, tonnes } from "../../ui";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Trips and bookings" };

type View = "trips" | "requests" | "shipments";
const views: { id: View; label: string }[] = [
  { id: "trips", label: "Space adverts" }, { id: "requests", label: "Transport requests" }, { id: "shipments", label: "Bookings" },
];

export default async function TripsAndBookings({ searchParams }: { searchParams: Promise<{ view?: string; scope?: string }> }) {
  const params = await searchParams;
  const view: View = params.view === "requests" || params.view === "shipments" ? params.view : "trips";
  return <>
    <Heading title="Trips and bookings" intro="Truck space on offer, what shippers asked for, and each booking's progress.">
      <Tabs label="Section" items={views.map(({ id, label }) => ({ href: `/trips?view=${id}`, label, current: id === view }))} />
    </Heading>
    {view === "trips" ? <Trips scope={params.scope === "all" ? "all" : "open"} />
      : view === "requests" ? <Requests />
      : <Shipments scope={params.scope === "completed" || params.scope === "attention" || params.scope === "all" ? params.scope : "active"} />}
  </>;
}

async function Trips({ scope }: { scope: TripScope }) {
  const data = await load("space adverts", () => getTrips(scope), () => sampleTrips(scope));
  return <section className="panel">
    <div className="panel-heading">
      <div><h2>{scope === "open" ? "Open adverts" : "All adverts"}</h2><p>{scope === "open" ? "Not closed and not yet departed, soonest first" : "Newest first"}</p></div>
      <Tabs label="Advert filter" items={[
        { href: "/trips?view=trips", label: "Open", current: scope === "open" },
        { href: "/trips?view=trips&scope=all", label: "All", current: scope === "all" },
      ]} />
    </div>
    {!data ? <Unavailable what="Space adverts" /> : data.rows.length ? <div className="table-scroll"><table className="data">
      <thead><tr>
        <th scope="col">Route</th><th scope="col">Departure</th><th scope="col">Trucker</th><th scope="col" className="num">Space</th>
        <th scope="col">Cargo accepted</th><th scope="col" className="num">Requests</th><th scope="col" className="num">Booked</th><th scope="col">Status</th>
      </tr></thead>
      <tbody>{data.rows.map((trip) => <tr key={trip.id}>
        <th scope="row">{trip.origin} <span className="arrow">→</span> {trip.destination}</th>
        <td><When at={trip.departureAt} /></td>
        <td><PersonCell person={trip.trucker} /></td>
        <td className="num">{tonnes(trip.capacity)}</td>
        <td>{trip.acceptedCargo.join(", ")}</td>
        <td className="num">{number.format(trip.requested)}</td>
        <td className="num">{number.format(trip.booked)}</td>
        <td><Badge tone={trip.tone}>{trip.status}</Badge></td>
      </tr>)}</tbody>
    </table></div> : <p className="empty">{scope === "open" ? "No open adverts." : "No adverts yet."}</p>}
    {data && <More listing={data} />}
  </section>;
}

async function Requests() {
  const data = await load("transport requests", () => getRequests(), () => sampleRequests());
  return <section className="panel">
    <div className="panel-heading"><div>
      <h2>Transport requests</h2>
      <p>Newest first. Searches that never led to a booking are deleted when they expire.</p>
    </div></div>
    {!data ? <Unavailable what="Transport requests" /> : data.rows.length ? <div className="table-scroll"><table className="data">
      <thead><tr>
        <th scope="col">Route</th><th scope="col">Ready from</th><th scope="col">Shipper</th><th scope="col">Load</th>
        <th scope="col">Booking</th><th scope="col">Requested</th><th scope="col">Status</th>
      </tr></thead>
      <tbody>{data.rows.map((request) => <tr key={request.id}>
        <th scope="row">{request.pickup} <span className="arrow">→</span> {request.dropoff}</th>
        <td>{shortDate(request.date)}</td>
        <td><PersonCell person={request.shipper} /></td>
        <td><span className="person"><span>{tonnes(request.weight)} · {request.cargo}</span>{request.notes && <span className="muted">{request.notes}</span>}</span></td>
        <td>{request.shipmentRef ? <span className="mono">{request.shipmentRef}</span> : <span className="muted">—</span>}</td>
        <td><When at={request.createdAt} /></td>
        <td><Badge tone={request.tone}>{request.status}</Badge></td>
      </tr>)}</tbody>
    </table></div> : <p className="empty">No transport requests.</p>}
    {data && <More listing={data} />}
  </section>;
}

async function Shipments({ scope }: { scope: ShipmentScope }) {
  const data = await load("bookings", () => getShipments(scope), () => sampleShipments(scope));
  const titles = { active: "Active bookings", completed: "Completed shipments", attention: "Bookings needing follow-up", all: "All bookings" };
  return <section className="panel">
    <div className="panel-heading">
      <div><h2>{titles[scope]}</h2><p>Open a booking to see its timeline</p></div>
      <Tabs label="Booking filter" items={([["active", "Active"], ["completed", "Completed"], ["attention", "Needs follow-up"], ["all", "All"]] as const).map(([id, label]) => ({
        href: `/trips?view=shipments${id === "active" ? "" : "&scope=" + id}`, label, current: id === scope,
      }))} />
    </div>
    {!data ? <Unavailable what="Bookings" /> : data.rows.length ? <ul className="bookings">{data.rows.map((shipment) => <li key={shipment.id}>
      <details>
        <summary>
          <span className="booking-main">
            <span className="mono">{shipment.ref}</span>
            <span className="event">{shipment.load ? <>{shipment.load.pickup} <span className="arrow">→</span> {shipment.load.dropoff}</> : "Search details expired"}</span>
            {shipment.load && <span className="muted">{tonnes(shipment.load.weight)} · {shipment.load.cargo}</span>}
          </span>
          <span className="booking-side">
            {shipment.priceCents !== undefined && <span className="price">{dollars(shipment.priceCents)}</span>}
            <Badge tone={shipment.tone}>{shipment.status}</Badge>
          </span>
        </summary>
        <div className="booking-detail">
          {shipment.attention && <p className="attention">{shipment.attention}</p>}
          <dl className="facts">
            <div><dt>Shipper</dt><dd><PersonCell person={shipment.shipper} /></dd></div>
            <div><dt>Trucker</dt><dd><PersonCell person={shipment.trucker} /></dd></div>
            <div><dt>Departure</dt><dd><When at={shipment.departureAt} /></dd></div>
          </dl>
          <ol className="timeline">{shipment.timeline.map((step) => <li key={step.label}>
            <span>{step.label}</span><When at={step.at} />
          </li>)}</ol>
        </div>
      </details>
    </li>)}</ul> : <p className="empty">{scope === "attention" ? "No bookings need follow-up." : "No bookings."}</p>}
    {data && <More listing={data} />}
  </section>;
}
