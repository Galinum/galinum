import type { ReactNode } from "react";
import { ChartColumn } from "lucide-react";
import type { MetricsRange } from "@galinum/core/contract";
import type { DashboardManagement } from "./dashboard-types.js";
import { BarChart, ChartLegend, LineChart } from "./components/charts.js";
import { PageHeader } from "./components/page-header.js";
import { StatTile } from "./components/stat-tile.js";
import { Card, CardContent, CardHeader } from "./ui/card.js";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "./ui/empty.js";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./ui/table.js";

const messagingSeries = [
  { key: "impressions", name: "Impressions", color: "var(--chart-1)" },
  { key: "clicks", name: "Clicks", color: "var(--chart-2)" },
  { key: "conversions", name: "Conversions", color: "var(--chart-3)" },
] as const;

const dayLabel = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

export type MetricsManagement = DashboardManagement<"getMetrics">;
export type MetricsPageProps = {
  management: MetricsManagement;
  range: MetricsRange;
  filter?: ReactNode;
};

export async function MetricsPage({
  management,
  range,
  filter,
}: MetricsPageProps) {
  const data = await management.getMetrics(range);
  const labels = data.days.map((day) => dayLabel.format(day.startAt));
  const clickRate = data.totals.impressions > 0
    ? `${((data.totals.clicks / data.totals.impressions) * 100).toFixed(1)}% of impressions`
    : "No impressions yet";
  const series = messagingSeries.map((item) => ({
    name: item.name,
    color: item.color,
    values: data.days.map((day) => day[item.key]),
  }));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Metrics" description="How your messages and product activity are trending." />
      {filter && <div className="flex flex-wrap items-center gap-2">{filter}</div>}

      {!data.hasAnyActivity ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon"><ChartColumn /></EmptyMedia>
            <EmptyTitle>No activity to chart yet</EmptyTitle>
            <EmptyDescription>
              Metrics fill in once your app sends events and campaigns start delivering messages.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StatTile label="Impressions" value={data.totals.impressions} />
            <StatTile label="Clicks" value={data.totals.clicks} hint={clickRate} />
            <StatTile label="Conversions" value={data.totals.conversions} />
            <StatTile label="Events" value={data.totals.events} />
          </div>

          <Card className="py-5">
            <CardHeader className="flex flex-wrap items-center justify-between gap-2 px-5">
              <h2 className="text-sm font-semibold">Messaging activity</h2>
              <ChartLegend series={series} />
            </CardHeader>
            <CardContent className="px-5">
              <LineChart title="Messaging activity per day" labels={labels} series={series} />
            </CardContent>
          </Card>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
            <Card className="py-5 lg:col-span-2">
              <CardHeader className="px-5"><h2 className="text-sm font-semibold">Events</h2></CardHeader>
              <CardContent className="px-5">
                <BarChart
                  title="Tracked events per day"
                  labels={labels}
                  series={{
                    name: "Events",
                    color: "var(--chart-1)",
                    values: data.days.map((day) => day.events),
                  }}
                />
              </CardContent>
            </Card>

            <Card className="overflow-hidden py-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-5">Top events</TableHead>
                    <TableHead className="pr-5 text-right">Count</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.topEvents.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={2} className="py-8 pl-5 text-muted-foreground">
                        No events in this period.
                      </TableCell>
                    </TableRow>
                  ) : data.topEvents.map((event) => (
                    <TableRow key={event.name}>
                      <TableCell className="max-w-44 truncate pl-5 font-mono text-xs font-medium">
                        {event.name}
                      </TableCell>
                      <TableCell className="pr-5 text-right tabular-nums text-muted-foreground">
                        {event.count.toLocaleString("en-US")}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
