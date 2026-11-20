"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const items = [
  { href: "/", label: "Dashboard home" },
  { href: "/users", label: "Users" },
  { href: "/trips", label: "Trips and bookings" },
  { href: "/reports", label: "Reports" },
];

export default function Nav() {
  const path = usePathname();
  return <nav className="sidebar" aria-label="Admin sections">
    <ul>
      {items.map(({ href, label }) => {
        const current = href === "/" ? path === "/" : path.startsWith(href);
        return <li key={href}><Link href={href} aria-current={current ? "page" : undefined}>{label}</Link></li>;
      })}
    </ul>
  </nav>;
}
