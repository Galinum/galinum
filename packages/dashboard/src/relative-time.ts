const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

export function relativeTime(timestamp: number, now: number) {
  const delta = timestamp - now;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (Math.abs(delta) < hour) return formatter.format(Math.round(delta / minute), "minute");
  if (Math.abs(delta) < day) return formatter.format(Math.round(delta / hour), "hour");
  return formatter.format(Math.round(delta / day), "day");
}
