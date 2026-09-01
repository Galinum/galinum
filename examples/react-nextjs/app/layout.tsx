import type { Metadata } from "next";
import type { ReactNode } from "react";
import { GalinumRoot } from "./demo";
import "./globals.css";

const publishableKey = process.env.NEXT_PUBLIC_GALINUM_PUBLISHABLE_KEY ?? "";
const apiBase = process.env.NEXT_PUBLIC_GALINUM_API_BASE ?? "http://localhost:3000";

export const metadata: Metadata = {
  title: "Galinum SDK example",
  description: "Minimal Next.js setup for @galinum/react",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <GalinumRoot publishableKey={publishableKey} apiBase={apiBase}>
          {children}
        </GalinumRoot>
      </body>
    </html>
  );
}
