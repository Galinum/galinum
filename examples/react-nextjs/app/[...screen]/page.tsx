import { Demo } from "../demo";

const apiBase = process.env.NEXT_PUBLIC_GALINUM_API_BASE ?? "http://localhost:3000";

// Every extra screen renders the same demo, so client-side navigation between
// them exercises page views and `pages` targeting.
export default function ScreenPage() {
  return <Demo apiBase={apiBase} />;
}
