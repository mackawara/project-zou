const paths = {
  overview: ["M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z"],
  truck: ["M3 6h11v11H3z M14 10h4l3 4v3h-7", "M6 17a2 2 0 1 0 4 0a2 2 0 1 0-4 0 M16 17a2 2 0 1 0 4 0a2 2 0 1 0-4 0"],
  route: ["M5 18v-2a4 4 0 0 1 4-4h6a4 4 0 0 0 4-4V6", "M5 17a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5 M19 2a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5"],
  people: ["M3 20v-2a5 5 0 0 1 5-5h2a5 5 0 0 1 5 5v2 M9 3a3.5 3.5 0 1 0 .01 0 M17 5a3 3 0 0 1 0 6 M17 14a4 4 0 0 1 4 4v2"],
  wallet: ["M3 7h16a2 2 0 0 1 2 2v10H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h13v3 M21 11h-6v4h6"],
  report: ["M3 3v18h18 M7 16v-4 M12 16V7 M17 16v-6"],
  package: ["M3 7l9-5 9 5v10l-9 5-9-5z M3 7l9 5 9-5 M12 12v10 M7 5l9 5"],
  check: ["M3 12l5 5L20 5"],
  calendar: ["M3 5h18v16H3z M7 3v5 M17 3v5 M3 10h18"],
  logout: ["M10 4H4v16h6 M9 12h12 M17 8l4 4-4 4"],
  activity: ["M2 12h5l3-8 4 16 3-8h5"],
  ads: ["M3 10l13-5v14L3 14z M4 14l2 6h3l-2-5 M19 9l2-1 M19 15l2 1"],
  play: ["M7 4l13 8-13 8z"], pause: ["M8 4v16 M16 4v16"],
} as const;
export type IconName = keyof typeof paths;
export function Icon({ name, size = 19 }: { name: IconName; size?: number }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65"
    strokeLinecap="round" strokeLinejoin="round">{paths[name].map(d => <path key={d} d={d} />)}</svg>;
}
