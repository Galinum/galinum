import { createHash } from "node:crypto";
import { z } from "zod";
import type { ShippingProviderInput } from "./types.js";

export const maxStateBytes = 8 * 1024 * 1024;
const fullScanInterval = 10 * 60_000;
const sha = z.string().regex(/^[a-f0-9]{40}$/i);
const id = z.number().int().positive().safe();
const time = z.number().int().nonnegative().safe();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const activationToken = z.string().min(1).max(1024);
const environment = z.string().min(1).max(255).refine(value => !/[\x00-\x1f\x7f]/.test(value));
export const deploymentSchema = z.object({ id, sha, environment, createdAt: time });
export const statusSchema = z.object({ id, environment, createdAt: time,
  state: z.enum(["queued", "pending", "in_progress", "success", "failure", "error", "inactive"]) });
export const changeIdentitySchema = z.object({ id: z.string().min(1).max(512), sourceId: z.string().min(1).max(128) });
export const changeSchema = z.intersection(changeIdentitySchema,
  z.discriminatedUnion("kind", [z.object({ kind: z.literal("commit"), sha }),
    z.object({ kind: z.literal("pull_request"), number: id, shas: z.array(sha).min(1).max(250) })]));
export const inputSchema = z.object({
  scope: z.object({ installationId: id, repositoryId: id,
    owner: z.string().regex(/^[A-Za-z0-9_.-]+$/).max(255).refine(value => value !== "." && value !== ".."),
    name: z.string().regex(/^[A-Za-z0-9_.-]+$/).max(255).refine(value => value !== "." && value !== "..") }),
  environment, scopeRevision: z.string().min(1).max(1024), generation: time,
  activationToken: activationToken.optional(),
  sourceBranches: z.record(z.string().min(1).max(128), z.string()),
  changes: z.array(changeIdentitySchema),
  observed: statusSchema.pick({ state: true }).extend({ deploymentId: id, sha, statusId: id, statusAt: time }).nullable(),
});
const scanSchema = z.object({
  phase: z.enum(["deployments", "statuses", "status_boundary", "validate", "ready"]),
  page: id, deploymentIndex: z.number().int().nonnegative().safe(),
  deployments: z.array(deploymentSchema),
  statuses: z.array(statusSchema.extend({ deployment: deploymentSchema })),
  deploymentBoundary: digest.nullable(), statusBoundaries: z.record(z.string(), digest),
});
const proofSchema = z.object({ raw: digest, head: sha, provenance: digest, change: changeSchema,
  result: z.object({ changeId: z.string(), state: z.enum(["present", "absent", "reverted"]), reason: z.string().optional(), revertSha: sha.optional() }) });
const commitSchema = z.object({ sha, message: z.string(), parents: z.array(sha).max(100) });
const comparisonSchema = z.object({ before: sha, after: sha, mergeBaseSha: sha,
  status: z.enum(["ahead", "behind", "identical", "diverged"]), commits: z.array(commitSchema.omit({ parents: true })).max(500) });
export type ImmutableComparison = z.infer<typeof comparisonSchema>;
const readsSchema = z.object({ head: sha.nullable(), commits: z.record(sha, commitSchema), comparisons: z.record(digest, comparisonSchema) });
export const branchSnapshotSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("ready"), name: z.string().min(1).max(1024), sha }),
  z.object({ state: z.literal("unavailable"), name: z.string().min(1).max(1024), reason: z.string().max(256) }),
]);
export type BranchSnapshot = z.infer<typeof branchSnapshotSchema>;
const stateSchema = z.object({
  version: z.literal(3), target: digest, scope: digest, generation: time, observation: digest,
  completedFullScanAt: time.nullable().default(null), lastActivationToken: activationToken.nullable().default(null),
  sourceChecks: z.record(digest, z.discriminatedUnion("state", [z.object({ state: z.literal("verified") }), z.object({ state: z.literal("unknown"), reason: z.string().max(256) })])),
  branchFailures: z.record(digest, z.string().max(256)),
  branches: z.record(digest, branchSnapshotSchema), qualified: z.record(digest, z.literal(true)),
  validation: z.object({ nextDeployment: time, nextBranch: time }).nullable().default(null),
  scan: scanSchema, proofs: z.record(digest, proofSchema), cursor: digest.nullable(),
  attempts: z.record(digest, z.object({ head: sha, reason: z.string().max(256), retryAt: time })),
  budgetRetries: z.record(digest, z.literal(true)), validated: z.record(digest, digest),
  progressCounts: z.record(digest, time).default({}), unmerged: z.record(digest, sha).default({}),
  reads: readsSchema.default({ head: null, commits: {}, comparisons: {} }),
});
export type ShippingState = z.infer<typeof stateSchema>;
export type ShippingStatus = ShippingState["scan"]["statuses"][number];
export class UnknownEvidence extends Error {}
export class PendingEvidence extends Error {}
export function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function emptyScan(): ShippingState["scan"] {
  return { phase: "deployments", page: 1, deploymentIndex: 0, deployments: [], statuses: [], deploymentBoundary: null, statusBoundaries: {} };
}
export function readState(input: ShippingProviderInput): { value: ShippingState; changedTarget: boolean } {
  const target = hash([input.scope.installationId, input.scope.repositoryId, input.environment]);
  const scope = hash([input.scope, input.environment, input.scopeRevision, Object.entries(input.sourceBranches).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)]);
  const observation = hash(input.observed);
  let previous: ShippingState | null = null;
  if (input.previous?.providerState !== undefined) {
    if (Buffer.byteLength(JSON.stringify(input.previous.providerState)) > maxStateBytes) throw new UnknownEvidence("shipping_state_limit: reduce tracked requirements or use manual launch");
    const parsed = stateSchema.safeParse(input.previous.providerState);
    if (!parsed.success) throw new UnknownEvidence("invalid_shipping_state");
    previous = parsed.data;
    if (previous.scan.deploymentIndex > previous.scan.deployments.length || (previous.validation?.nextDeployment ?? 0) > previous.scan.deployments.length || (previous.validation?.nextBranch ?? 0) > Object.keys(previous.branches).length || Object.entries(previous.proofs).some(([key, proof]) =>
      proof.raw !== hash(changeSchema.parse(proof.change)) || proof.result.changeId !== proof.change.id || key !== hash([previous!.scope, proof.raw, proof.head, proof.provenance]))) {
      throw new UnknownEvidence("invalid_shipping_state");
    }
    if (Object.entries(previous.branches).some(([key, branch]) => key !== hash(branch.name))) throw new UnknownEvidence("invalid_shipping_state");
    if (Object.entries(previous.reads.commits).some(([sha, commit]) => sha !== commit.sha)
      || Object.entries(previous.reads.comparisons).some(([key, value]) => key !== hash([value.before, value.after]))) throw new UnknownEvidence("invalid_shipping_state");
  }
  if (!previous || previous.scope !== scope) return { changedTarget: previous !== null && previous.target !== target, value: { version: 3, target, scope, generation: input.generation, observation,
    completedFullScanAt: null, lastActivationToken: input.activationToken ?? null, sourceChecks: {}, branchFailures: {}, branches: {}, qualified: {}, validation: null, scan: emptyScan(), proofs: {}, cursor: null, attempts: {}, budgetRetries: {}, validated: {}, progressCounts: {}, unmerged: {}, reads: { head: null, commits: {}, comparisons: {} } } };
  if (previous.generation !== input.generation || previous.observation !== observation) {
    previous.scan = emptyScan(); previous.validation = null; previous.branches = {}; previous.sourceChecks = {}; previous.branchFailures = {}; previous.completedFullScanAt = null; previous.attempts = {}; previous.budgetRetries = {}; previous.progressCounts = {}; previous.validated = {}; previous.unmerged = {};
  }
  const newActivation = input.activationToken !== undefined && (previous.lastActivationToken !== input.activationToken || !input.previous?.pendingWork);
  if (previous.scan.phase === "ready" && (newActivation || previous.completedFullScanAt === null || Date.now() - previous.completedFullScanAt >= fullScanInterval)) {
    previous.scan = emptyScan(); previous.validation = null; previous.branches = {}; previous.sourceChecks = {}; previous.branchFailures = {}; previous.validated = {}; previous.unmerged = {};
  }
  if (!input.previous?.pendingWork) {
    previous.validated = {}; previous.unmerged = {};
    if (!previous.validation) { previous.branches = {}; previous.sourceChecks = {}; previous.branchFailures = {}; previous.attempts = {}; }
  }
  if (!previous.validation && Object.keys(previous.branchFailures).length) {
    previous.branches = {}; previous.sourceChecks = {}; previous.branchFailures = {};
  }
  previous.lastActivationToken = input.activationToken ?? null;
  previous.generation = input.generation;
  previous.observation = observation;
  return { value: previous, changedTarget: false };
}
export function ensureStateSize(state: ShippingState): void {
  if (Buffer.byteLength(JSON.stringify(state)) > maxStateBytes) throw new UnknownEvidence("shipping_state_limit: reduce tracked requirements or use manual launch");
}
export function pageValue<T>(schema: z.ZodType<T>, value: unknown, page: number): { items: T[]; nextPage: number | null } {
  const parsed = z.object({ items: z.array(schema).max(100), nextPage: id.nullable() }).safeParse(value);
  if (!parsed.success || (parsed.data.nextPage !== null && parsed.data.nextPage !== page + 1)
    || (parsed.data.nextPage !== null && parsed.data.items.length === 0)) throw new UnknownEvidence("invalid_inventory_page");
  return parsed.data;
}
