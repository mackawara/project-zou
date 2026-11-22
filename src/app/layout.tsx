import type { Metadata } from "next";
import "./styles.css";

export const metadata: Metadata = {
  title: { default: "Zunde Admin", template: "%s · Zunde Admin" },
  description: "Zunde freight operations and shipper accounts.",
  robots: { index: false, follow: false },
};
export default function Layout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
