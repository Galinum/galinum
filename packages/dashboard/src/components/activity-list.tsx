import { Activity, Users } from "lucide-react";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty.js";

export type ActivityItem = {
  id: string;
  kind: "delivery" | "user";
  title: string;
  detail: string;
  when: string;
};

export function ActivityList({ items }: { items: ActivityItem[] }) {
  if (items.length === 0) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Activity />
          </EmptyMedia>
          <EmptyTitle>No activity yet</EmptyTitle>
          <EmptyDescription>
            It shows up here as soon as your project sees users and deliveries.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <ul className="flex flex-col">
      {items.map((item) => (
        <li
          key={item.id}
          className="flex items-center gap-3 border-b py-2.5 last:border-b-0"
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
            {item.kind === "delivery" ? (
              <Activity className="size-4" />
            ) : (
              <Users className="size-4" />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{item.title}</p>
            <p className="truncate text-xs text-muted-foreground">
              {item.detail}
            </p>
          </div>
          <span className="shrink-0 text-xs text-muted-foreground">
            {item.when}
          </span>
        </li>
      ))}
    </ul>
  );
}
