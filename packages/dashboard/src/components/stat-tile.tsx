import { Card, CardContent } from "../ui/card.js";

const compact = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

export function formatStat(value: number): string {
  return value < 10_000 ? value.toLocaleString("en-US") : compact.format(value);
}

export function StatTile({
  label,
  value,
  hint,
}: {
  label: string;
  value: number;
  hint?: string;
}) {
  return (
    <Card className="py-5">
      <CardContent className="flex flex-col gap-1 px-5">
        <p className="text-sm font-medium text-muted-foreground">{label}</p>
        <p className="text-3xl font-semibold tracking-tight">
          {formatStat(value)}
        </p>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );
}
