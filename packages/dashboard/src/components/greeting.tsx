"use client";

import { useSyncExternalStore } from "react";

function subscribe() {
  return () => {};
}

function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 5) return "Good evening";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

// SSR can't know the visitor's timezone, so the server renders a neutral
// fallback and the client swaps in the local time-of-day greeting.
export function Greeting({ firstName }: { firstName: string }) {
  const greeting = useSyncExternalStore(
    subscribe,
    getGreeting,
    () => "Welcome back",
  );
  return (
    <span>
      {firstName ? `${greeting}, ${firstName}` : greeting}
    </span>
  );
}
