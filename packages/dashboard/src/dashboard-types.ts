import type { ComponentType, ReactNode } from "react";
import type { ManagementReader } from "@galinum/core/contract";

export type DashboardLink = ComponentType<{
  href: string;
  className?: string;
  children: ReactNode;
}>;

export type DashboardManagement<Operation extends keyof ManagementReader> = Pick<
  ManagementReader,
  Operation
>;
