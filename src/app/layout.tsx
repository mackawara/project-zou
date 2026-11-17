import type { Metadata } from "next";
import "./styles.css";

export const metadata: Metadata = {
  title: "Zunde · Pilot analytics",
  description: "Truck adverts, freight requests and deliveries on the Zunde pilot corridor.",
  robots: { index: false, follow: false },
};

export default function Layout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
