import type { Metadata } from "next";
import { getUsers, sampleUsers, type UserRole } from "../../admin";
import { Badge, Heading, More, PersonCell, Tabs, Unavailable, When, load, number } from "../ui";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Users" };

const roles: { id?: UserRole; label: string }[] = [{ label: "All users" }, { id: "shipper", label: "Shippers" }, { id: "trucker", label: "Truckers" }];
const roleLabel = { shipper: "Shipper", trucker: "Trucker" } as const;

export default async function Users({ searchParams }: { searchParams: Promise<{ role?: string; q?: string }> }) {
  const params = await searchParams;
  const role = params.role === "shipper" || params.role === "trucker" ? params.role : undefined;
  const q = params.q?.slice(0, 80) ?? "";
  const data = await load("users", () => getUsers({ role, q }), () => sampleUsers({ role, q }));
  const href = (next: UserRole | undefined) => "/users?" + new URLSearchParams({ ...(next && { role: next }), ...(q && { q }) });

  return <>
    <Heading title="Users" intro="Shippers who gave their name to book, and registered truckers.">
      <Tabs label="Role" items={roles.map(({ id, label }) => ({ href: href(id), label, current: id === role }))} />
    </Heading>
    <form className="search" action="/users" role="search">
      {role && <input type="hidden" name="role" value={role} />}
      <label htmlFor="q" className="sr-only">Search users</label>
      <input id="q" name="q" type="search" defaultValue={q} placeholder="Name, number, company or vehicle" maxLength={80} />
      <button type="submit">Search</button>
      {q && <a href={href(role)}>Clear</a>}
    </form>
    {data ? <section className="panel">
      {data.rows.length ? <div className="table-scroll"><table className="data">
        <thead><tr>
          <th scope="col">User</th><th scope="col">Role</th><th scope="col">Company and vehicle</th>
          <th scope="col" className="num">Adverts</th><th scope="col" className="num">Shipments</th><th scope="col">Last message</th>
        </tr></thead>
        <tbody>{data.rows.map((user) => <tr key={user.phone}>
          <th scope="row"><PersonCell person={{ phone: user.phone, name: user.name }} /></th>
          <td><span className="badges">{user.roles.map((r) => <Badge key={r} tone={r === "trucker" ? "ok" : "wait"}>{roleLabel[r]}</Badge>)}</span></td>
          <td>{user.company ? <span className="person"><span>{user.company}</span><span className="muted">{user.registration}</span></span> : <span className="muted">—</span>}</td>
          <td className="num">{number.format(user.trips)}</td>
          <td className="num">{number.format(user.shipments)}</td>
          <td><When at={user.lastMessageAt} /></td>
        </tr>)}</tbody>
      </table></div> : <p className="empty">{q ? "No users match this search." : "No users yet."}</p>}
      <More listing={data} />
    </section> : <Unavailable what="Users" />}
  </>;
}
