import type { ReactNode } from "react";
import type { Listing, Person, Tone } from "../admin";
import { demoMode } from "../admin";
import { formatDeparture } from "../domain";
import { logger } from "../logger";

export const number = new Intl.NumberFormat("en");
export const tonnes = (kg: number) => `${number.format(kg / 1000)} t`;
export const shortDate = (date: string) =>
  new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(date));

/** Loads one page's data, or the sample data in development without a database. Logs and returns undefined on failure. */
export async function load<T>(what: string, live: () => Promise<T>, sample: () => T): Promise<T | undefined> {
  try {
    return demoMode() ? sample() : await live();
  } catch (error) {
    logger.error(`Admin dashboard could not load ${what}`, error);
    return undefined;
  }
}

export function Heading({ title, intro, children }: { title: string; intro: string; children?: ReactNode }) {
  return <div className="heading">
    <div><h1>{title}</h1><p>{intro}</p></div>
    {children}
  </div>;
}

export function Tabs({ label, items }: { label: string; items: { href: string; label: string; current: boolean }[] }) {
  return <nav aria-label={label} className="periods">
    {items.map(({ href, label, current }) => <a key={href} href={href} aria-current={current ? "page" : undefined}>{label}</a>)}
  </nav>;
}

export const Badge = ({ tone, children }: { tone: Tone; children: ReactNode }) => <span className={`badge ${tone}`}>{children}</span>;

export function When({ at }: { at?: Date }) {
  return at ? <time dateTime={at.toISOString()}>{formatDeparture(at)}</time> : <span className="muted">—</span>;
}

export function PersonCell({ person }: { person: Person }) {
  return <span className="person">
    <span>{person.name || "No name given"}</span>
    <a className="phone" href={`https://wa.me/${person.phone}`} target="_blank" rel="noreferrer">+{person.phone}</a>
  </span>;
}

export function Unavailable({ what }: { what: string }) {
  return <p className="panel unavailable">{what} are temporarily unavailable. Refresh after checking the database connection.</p>;
}

export function More({ listing }: { listing: Listing<unknown> }) {
  return listing.more ? <p className="empty">Showing the latest {listing.rows.length}. Narrow the list to see older entries.</p> : null;
}
