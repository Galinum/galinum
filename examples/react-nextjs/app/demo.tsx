"use client";

import { GalinumProvider, InAppMessages, useGalinum } from "@galinum/react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";

// The provider lives in the root layout, above the router outlet: a provider
// inside a page would remount on every navigation and drop the identified
// user (and with it the prefetched message cache).
export function GalinumRoot({
  publishableKey,
  apiBase,
  children,
}: {
  publishableKey: string;
  apiBase: string;
  children: ReactNode;
}) {
  return (
    <GalinumProvider publishableKey={publishableKey} apiBase={apiBase}>
      {children}
      {/* Messages are prefetched and shown one per page view. */}
      <InAppMessages />
    </GalinumProvider>
  );
}

export function Demo({ apiBase }: { apiBase: string }) {
  return (
    <main>
      <h1>Galinum SDK example</h1>
      <p className="hint">
        Minimal <code>@galinum/react</code> setup: identify a user, track events, and render
        in-app messages. API: <code>{apiBase}</code>
      </p>
      <ScreenNav />
      <IdentityPanel />
      <TrackPanel />
    </main>
  );
}

const SCREENS = ["/", "/settings", "/settings/billing", "/reports"];

// Client-side navigation between screens: each one is a new page view, and a
// campaign's `pages` patterns decide where its message may appear.
function ScreenNav() {
  const pathname = usePathname();
  return (
    <section>
      <h2>Screens</h2>
      <div className="row">
        {SCREENS.map((screen) => (
          <Link key={screen} href={screen}>
            <button className="secondary" disabled={pathname === screen}>
              {screen}
            </button>
          </Link>
        ))}
      </div>
      <p className="hint">
        Current screen: <code>{pathname}</code>. One message shows per page view.
      </p>
    </section>
  );
}

function IdentityPanel() {
  const { userId, identify, reset } = useGalinum();
  const [input, setInput] = useState("demo_user_1");

  const logIn = (e: FormEvent) => {
    e.preventDefault();
    if (input.trim()) void identify(input.trim(), { plan: "free" });
  };

  return (
    <section>
      <h2>Identity</h2>
      {userId ? (
        <div className="row">
          <span>
            Logged in as <code>{userId}</code>
          </span>
          <button className="secondary" onClick={reset}>
            Log out
          </button>
        </div>
      ) : (
        <form className="row" onSubmit={logIn}>
          <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="user id" />
          <button type="submit">Log in</button>
        </form>
      )}
      <p className="hint">
        Deliveries are one per (campaign, user) — to see a campaign again, log in as a new user id.
      </p>
    </section>
  );
}

const EVENTS = ["viewed_pricing", "activated_workspace", "invited_teammate"];

function TrackPanel() {
  const { userId, track } = useGalinum();
  const [log, setLog] = useState<string[]>([]);

  const fire = (event: string) => {
    void track(event);
    setLog((prev) => [...prev, event]);
  };

  return (
    <section>
      <h2>Track events</h2>
      <div className="row">
        {EVENTS.map((event) => (
          <button className="secondary" key={event} disabled={!userId} onClick={() => fire(event)}>
            {event}
          </button>
        ))}
      </div>
      <p className="hint">
        {userId
          ? log.length
            ? `Sent: ${log.join(", ")}`
            : "The demo pricing-nudge campaign targets users who fired viewed_pricing."
          : "Log in first — track() is ignored without an identified user."}
      </p>
    </section>
  );
}
