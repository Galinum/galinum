import { Demo } from "./demo";

const apiBase = process.env.NEXT_PUBLIC_GALINUM_API_BASE ?? "http://localhost:3000";

export default function Page() {
  return <Demo apiBase={apiBase} />;
}
