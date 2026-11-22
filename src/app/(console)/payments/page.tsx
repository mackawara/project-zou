import { randomUUID } from "node:crypto";
import { demoMode, getUsers, sampleUsers } from "../../../admin";
import { getPayments, paymentMethods } from "../../../admin-operations";
import { dollars, localDate } from "../../../domain";
import { Heading, PersonCell, Unavailable, load } from "../../ui";
import { PaymentForm } from "./form";

export const metadata = { title: "Shipper payments" };
export default async function Payments({ searchParams }: { searchParams: Promise<{ shipper?: string }> }) {
  const today = localDate(new Date());
  const preset = (await searchParams).shipper ?? "";
  const [rows, people] = await Promise.all([
    load("payments", getPayments, () => [{ _id: "demo", shipper: "263770000102", name: "Rudo Ncube", amountCents: 8025,
      paidOn: today, method: "EcoCash", reference: "DEMO-1240", recordedBy: "Demo admin", createdAt: new Date() }]),
    load("shipper directory", () => getUsers({ role: "shipper" }), () => sampleUsers({ role: "shipper" })),
  ]);
  return <><Heading title="Shipper payments" intro="Record payments received and look up ledger entries in US dollars." />
    <div className="payment-layout"><section className="panel"><h2>Record a payment</h2>
      <PaymentForm id={randomUUID()} today={today} phone={/^\+?\d{8,15}$/.test(preset) ? preset : ""} methods={paymentMethods} demo={demoMode()}
        shippers={(people?.rows ?? []).map(({ phone, name }) => ({ phone, name }))} /></section>
    <section className="panel"><div className="panel-heading"><h2>Payment ledger</h2><span className="subtle">Latest 100</span></div>
      {!rows ? <Unavailable what="Payments" /> : !rows.length ? <p className="empty">No payments recorded yet.</p> : <div className="table-scroll"><table className="data ledger"><thead><tr>
        <th>Payment date</th><th>Shipper</th><th>Method / reference</th><th className="num">Amount</th><th>Recorded by</th></tr></thead>
        <tbody>{rows.map(row => <tr key={row._id}><td>{row.paidOn}</td><th scope="row"><PersonCell person={{ phone: row.shipper, name: row.name }} /></th>
        <td>{row.method}<span className="ref">{row.reference || "—"}</span></td><td className="num price">{dollars(row.amountCents)}</td><td>{row.recordedBy}</td></tr>)}</tbody></table></div>}
    </section></div></>;
}
