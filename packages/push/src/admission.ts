export interface PushWorkBudget {
  maxUnits?: number;
  maxPages?: number;
  deadline?: number;
  clock?: () => number;
}
export type PushWorkUnit = "recipient" | "dispatch";
export class WorkAdmission {
  readonly units = { recipient: 0, dispatch: 0 };
  pages = 0;
  stopped: "unit_limit" | "page_limit" | "deadline" | null = null;
  private readonly maxUnits: number;
  private readonly maxPages: number;
  private readonly clock: () => number;
  private readonly deadline: number;
  constructor(options: PushWorkBudget) {
    this.maxUnits = options.maxUnits ?? 100; this.maxPages = options.maxPages ?? 100;
    if (![this.maxUnits, this.maxPages].every((value) => Number.isSafeInteger(value) && value >= 0)) throw new Error("Work limits must be nonnegative safe integers");
    if (options.deadline !== undefined && !Number.isFinite(options.deadline)) throw new Error("Work deadline must be finite");
    this.deadline = options.deadline ?? Infinity; this.clock = options.clock ?? (() => performance.now());
  }
  available(): boolean {
    if (this.stopped) return false;
    const at = this.clock(); if (!Number.isFinite(at)) throw new Error("Execution clock must be finite");
    if (at >= this.deadline) this.stopped = "deadline";
    else if (this.units.recipient + this.units.dispatch >= this.maxUnits) this.stopped = "unit_limit";
    return this.stopped === null;
  }
  availablePage(): boolean {
    if (!this.available()) return false;
    if (this.pages >= this.maxPages) { this.stopped = "page_limit"; return false; }
    return true;
  }
  page(): boolean {
    if (!this.availablePage()) return false;
    this.pages++; return true;
  }
  take(unit: PushWorkUnit): boolean {
    if (!this.available()) return false;
    this.units[unit]++; return true;
  }
  result() { return { admittedUnits: this.units.recipient + this.units.dispatch, units: { ...this.units }, pages: this.pages, stopped: this.stopped }; }
}
