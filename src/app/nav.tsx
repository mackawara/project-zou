"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon, type IconName } from "./icons";

const groups: { label: string; items: [string, string, IconName][] }[] = [
  { label: "Workspace", items: [["/", "Overview", "overview"], ["/trips", "Trips & bookings", "truck"], ["/routes", "Routes", "route"], ["/reports", "Analytics", "report"]] },
  { label: "Accounts", items: [["/users", "Shippers & truckers", "people"], ["/payments", "Shipper payments", "wallet"]] },
];
export default function Nav() {
  const path = usePathname();
  return <nav className="side-nav" aria-label="Admin sections">{groups.map(group => <div key={group.label}>
    <h2>{group.label}</h2><ul>{group.items.map(([href, label, icon]) => <li key={href}>
      <Link href={href} aria-current={path === href ? "page" : undefined}><Icon name={icon} />{label}</Link>
    </li>)}</ul></div>)}</nav>;
}
