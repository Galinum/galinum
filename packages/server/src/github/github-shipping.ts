import type { ShippingChange, ShippingChangeCoverage, ShippingOrder, ShippingProvider, ShippingSnapshot, ShippingSourceQualification } from "./types.js";
import { GitHubProviderError, isGitHubBranchName, type GitHubCollection, type GitHubCommit, type GitHubDeploymentStatus, type GitHubProvider } from "./github-provider.js";

import { branchSnapshotSchema, changeSchema, deploymentSchema, emptyScan, ensureStateSize, hash, inputSchema, pageValue, PendingEvidence, readState, statusSchema, UnknownEvidence, type BranchSnapshot, type ImmutableComparison, type ShippingState, type ShippingStatus } from "./github-shipping-state.js";

const maxCalls = 120;
const maxChanges = 100;
const maxChain = 32;
type DeploymentCoverage = Omit<ShippingChangeCoverage, "source">;
type Revert = { target: string; mainline: string | null };

function order(a: ShippingOrder, b: ShippingOrder) {
  return a.statusAt - b.statusAt || a.statusId - b.statusId;
}
function watermark(status: GitHubDeploymentStatus): ShippingOrder {
  return { statusAt: status.createdAt, statusId: status.id };
}
function complete<T>(value: GitHubCollection<T>): T[] {
  if (!value.completeness.complete) throw new UnknownEvidence("incomplete_history");
  return value.items;
}
function revert(message: string): Revert | null {
  const declarations = [...message.matchAll(/^This reverts commit ([a-f0-9]{40})(\.|,\s*reversing\s+changes made to ([a-f0-9]{40})\.)\s*$/gim)];
  if (declarations.length > 1) throw new UnknownEvidence("ambiguous_revert");
  if (!declarations.length) {
    if (/^This reverts commit\b/im.test(message)) throw new UnknownEvidence("malformed_revert");
    return null;
  }
  return { target: declarations[0][1].toLowerCase(), mainline: declarations[0][3]?.toLowerCase() ?? null };
}

export function createGithubShippingProvider(provider: Pick<GitHubProvider, "shippingSession">): ShippingProvider {
  return { async refresh(input) {
    const checkedAt = Date.now();
    const deadline = checkedAt + 30_000;
    let calls = 0;
    let state: ShippingState | undefined;
    let reader: ReturnType<GitHubProvider["shippingSession"]>;
    let successful = input.previous?.watermark ?? null;
    if (input.observed?.state === "success" && (!successful || order(input.observed, successful) > 0)) successful = { statusAt: input.observed.statusAt, statusId: input.observed.statusId };
    function project(kind: "unknown" | "pending", reason: string, pending = false): ShippingSnapshot {
      if (state) {
        try { ensureStateSize(state); }
        catch (error) { state = undefined; kind = "unknown"; pending = false; reason = error instanceof Error ? error.message : "shipping_state_limit"; }
      }
      return { state: kind, evidence: null, watermark: successful, coverage: input.changes.map(c => ({ changeId: c.id, state: "unknown", reason, source: { state: "unknown", reason } })),
        checkedAt, reason, ...(pending ? { pendingWork: true as const } : {}), ...(state ? { providerState: state } : {}) };
    }
    async function call<T>(operation: () => Promise<T>): Promise<T> {
      if (calls >= maxCalls || Date.now() >= deadline) throw new PendingEvidence("request_budget");
      calls++;
      const result = await operation();
      if (Date.now() >= deadline) throw new PendingEvidence("request_budget");
      return result;
    }
    function branchNameFor(change: ShippingChange): string | undefined {
      return Object.hasOwn(input.sourceBranches, change.sourceId) ? input.sourceBranches[change.sourceId] : undefined;
    }
    function branchFor(change: ShippingChange): BranchSnapshot | undefined {
      const name = branchNameFor(change);
      return name ? state!.branches[hash(name)] : undefined;
    }
    async function readBranch(name: string): Promise<BranchSnapshot> {
      try {
        const value = await call(() => reader.readBranch(input.scope, name));
        const parsed = branchSnapshotSchema.safeParse({ ...value, state: "ready" });
        if (!parsed.success || parsed.data.name !== name) throw new UnknownEvidence("source_branch_identity_unknown");
        return parsed.data;
      } catch (error) {
        if (error instanceof GitHubProviderError && error.code === "access_denied" && error.status === 404) return { state: "unavailable", name, reason: "source_branch_unavailable" };
        throw error;
      }
    }
    function branchNames(): string[] { return [...new Set(Object.values(input.sourceBranches))].filter(isGitHubBranchName).sort(); }
    async function gatherBranches(): Promise<void> {
      for (const name of branchNames()) {
        const key = hash(name);
        if (!state!.branches[key]) state!.branches[key] = await readBranch(name);
      }
      ensureStateSize(state!);
    }
    function sourceFor(change: ShippingChange, raw: string): ShippingSourceQualification {
      const name = branchNameFor(change);
      if (name !== undefined && !isGitHubBranchName(name)) return { state: "unknown", reason: "source_branch_invalid" };
      const branch = branchFor(change);
      if (!branch) return { state: "unknown", reason: "source_branch_unconfigured" };
      const failure = state!.branchFailures[hash(branch.name)];
      if (failure) return { state: "unknown", reason: failure };
      if (branch.state === "unavailable") return { state: "unknown", reason: branch.reason };
      return state!.sourceChecks[raw] ?? { state: "unknown", reason: "source_qualification_pending" };
    }
    function inventoryChanged(): never {
      state!.scan = emptyScan(); state!.validation = null; state!.branches = {}; state!.sourceChecks = {}; state!.branchFailures = {}; state!.completedFullScanAt = null; state!.validated = {}; state!.unmerged = {};
      throw new PendingEvidence("deployment_inventory_changed");
    }
    async function inventory(): Promise<ShippingStatus[]> {
      const scan = state!.scan;
      while (scan.phase !== "validate" && scan.phase !== "ready") {
        if (scan.phase === "deployments") {
          const page = pageValue(deploymentSchema, await call(() => reader.listDeploymentPage(input.scope, scan.page)), scan.page);
          if (scan.page === 1) scan.deploymentBoundary = hash(page);
          for (const deployment of page.items) {
            if (scan.deployments.some(item => item.id === deployment.id)) throw new UnknownEvidence("conflicting_deployment_identity");
            scan.deployments.push(deployment);
          }
          if (page.nextPage === null) { scan.phase = "statuses"; scan.page = 1; }
          else scan.page = page.nextPage;
        } else {
          const deployment = scan.deployments[scan.deploymentIndex];
          if (!deployment) { scan.phase = "validate"; state!.completedFullScanAt = Date.now(); continue; }
          const pageNumber = scan.phase === "status_boundary" ? 1 : scan.page;
          const page = pageValue(statusSchema, await call(() => reader.listDeploymentStatusPage(input.scope, deployment.id, pageNumber)), pageNumber);
          if (scan.phase === "status_boundary") {
            if (hash(page) !== scan.statusBoundaries[String(deployment.id)]) inventoryChanged();
            scan.deploymentIndex++; scan.page = 1; scan.phase = "statuses";
          } else {
            if (scan.page === 1) scan.statusBoundaries[String(deployment.id)] = hash(page);
            for (const status of page.items) {
              if (scan.statuses.some(item => item.id === status.id)) throw new UnknownEvidence("conflicting_status_identity");
              scan.statuses.push({ ...status, deployment });
              if (status.state === "success" && status.environment === input.environment && (!successful || order(watermark(status), successful) > 0)) successful = watermark(status);
            }
            if (page.nextPage !== null) scan.page = page.nextPage;
            else if (scan.page > 1) scan.phase = "status_boundary";
            else { scan.deploymentIndex++; scan.page = 1; }
          }
        }
        ensureStateSize(state!);
      }
      return [...scan.statuses].sort((a, b) => order(watermark(a), watermark(b)));
    }
    async function validateStatusBoundary(deploymentId: number): Promise<void> {
      const page = pageValue(statusSchema, await call(() => reader.listDeploymentStatusPage(input.scope, deploymentId, 1)), 1);
      for (const status of page.items) {
        if (status.state === "success" && status.environment === input.environment && (!successful || order(watermark(status), successful) > 0)) successful = watermark(status);
      }
      if (hash(page) !== state!.scan.statusBoundaries[String(deploymentId)]) inventoryChanged();
    }
    async function validateSelected(selected: ShippingStatus | undefined): Promise<void> {
      const first = pageValue(deploymentSchema, await call(() => reader.listDeploymentPage(input.scope, 1)), 1);
      if (hash(first) !== state!.scan.deploymentBoundary) inventoryChanged();
      if (selected) await validateStatusBoundary(selected.deployment.id);
    }
    async function validateInventory(selected: ShippingStatus | undefined): Promise<void> {
      const scan = state!.scan;
      const validation = state!.validation ??= { nextDeployment: 0, nextBranch: 0 };
      scan.phase = "validate";
      while (validation.nextDeployment < scan.deployments.length) {
        const deployment = scan.deployments[validation.nextDeployment];
        await validateStatusBoundary(deployment.id);
        validation.nextDeployment++;
      }
      const names = branchNames();
      while (validation.nextBranch < names.length) {
        const name = names[validation.nextBranch];
        const current = await readBranch(name);
        if (hash(current) !== hash(state!.branches[hash(name)])) state!.branchFailures[hash(name)] = current.state === "unavailable" ? current.reason : "source_branch_changed";
        validation.nextBranch++;
      }
      await validateSelected(selected);
      state!.validation = null;
    }
    const comparisons = new Map<string, Promise<ImmutableComparison>>();
    async function compare(before: string, after: string) {
      const key = hash([before, after]);
      const cached = state!.reads.comparisons[key];
      if (cached) return cached;
      if (!comparisons.has(key)) comparisons.set(key, (async () => {
        const result = await call(() => reader.compare(input.scope, before, after));
        const commits = complete(result.commits);
        if (result.before.toLowerCase() !== before || result.after.toLowerCase() !== after ||
          (result.status === "identical" && before !== after) || (result.status === "ahead" &&
            (result.mergeBaseSha.toLowerCase() !== before || !commits.some(c => c.sha.toLowerCase() === after)))) throw new UnknownEvidence("comparison_identity_unknown");
        const value: ImmutableComparison = { before, after, mergeBaseSha: result.mergeBaseSha.toLowerCase(), status: result.status,
          commits: commits.map(commit => ({ sha: commit.sha.toLowerCase(), message: commit.message })) };
        state!.reads.comparisons[key] = value;
        ensureStateSize(state!);
        return value;
      })());
      return comparisons.get(key)!;
    }
    async function ancestor(before: string, after: string) {
      if (before === after) return true;
      const result = await compare(before, after);
      return result.status === "ahead" || result.status === "identical";
    }
    const commits = new Map<string, Promise<GitHubCommit>>();
    async function commit(sha: string) {
      const cached = state!.reads.commits[sha];
      if (cached) return cached;
      if (!commits.has(sha)) commits.set(sha, (async () => {
        const value = await call(() => reader.readCommit(input.scope, sha));
        if (value.sha !== sha) throw new UnknownEvidence("commit_identity_unknown");
        state!.reads.commits[sha] = value;
        ensureStateSize(state!);
        return value;
      })());
      return commits.get(sha)!;
    }
    async function identity(change: ShippingChange) {
      let representation: string;
      let original = new Set<string>();
      let bundle: Awaited<ReturnType<GitHubProvider["listPullRequestCommits"]>> | null = null;
      if (change.kind === "commit") representation = change.sha.toLowerCase();
      else {
        bundle = await call(() => reader.listPullRequestCommits(input.scope, change.number));
        original = new Set(complete(bundle.commits).map(c => c.sha.toLowerCase()));
        const pr = bundle.pullRequest;
        if (pr.number !== change.number || pr.base.repositoryId !== input.scope.repositoryId || !change.shas.length ||
          change.shas.some(s => !original.has(s.toLowerCase()))) throw new UnknownEvidence("original_membership_unknown");
        if (pr.state !== "merged" || !pr.mergedAt || !pr.mergeCommitSha) return null;
        if (!original.has(pr.head.sha.toLowerCase())) throw new UnknownEvidence("original_head_unknown");
        representation = pr.mergeCommitSha.toLowerCase();
      }
      const provenance = hash(bundle ? { number: bundle.pullRequest.number, base: bundle.pullRequest.base.repositoryId,
        head: bundle.pullRequest.head.sha, merge: representation, originals: [...original].sort(), mergedAt: bundle.pullRequest.mergedAt } : representation);
      return { representation, original, bundle, provenance, baseRef: bundle?.pullRequest.base.ref ?? null };
    }
    async function qualify(change: ShippingChange, raw: string, resolved: NonNullable<Awaited<ReturnType<typeof identity>>>): Promise<ShippingSourceQualification> {
      const name = branchNameFor(change);
      if (name !== undefined && !isGitHubBranchName(name)) return { state: "unknown", reason: "source_branch_invalid" };
      const branch = branchFor(change);
      if (!branch || branch.state !== "ready") return { state: "unknown", reason: branch?.reason ?? "source_branch_unconfigured" };
      if (resolved.baseRef !== null && resolved.baseRef !== branch.name) return { state: "unknown", reason: "source_branch_mismatch" };
      const key = hash([raw, resolved.provenance, resolved.baseRef, branch.sha]);
      if (state!.qualified[key]) return { state: "verified" };
      try {
        if (!await ancestor(resolved.representation, branch.sha)) return { state: "unknown", reason: "source_branch_mismatch" };
        state!.qualified[key] = true;
        return { state: "verified" };
      } catch (error) {
        if (error instanceof UnknownEvidence) {
          if (error.message.startsWith("shipping_state_limit")) throw error;
          return { state: "unknown", reason: error.message };
        }
        if (error instanceof GitHubProviderError && error.code === "access_denied" && error.status === 404) return { state: "unknown", reason: "source_requirement_unavailable" };
        throw error;
      }
    }
    async function coverage(change: ShippingChange, head: string, resolved: NonNullable<Awaited<ReturnType<typeof identity>>>): Promise<DeploymentCoverage & { state: "present" | "absent" | "reverted" }> {
      const { representation, original, bundle } = resolved;
      if (!await ancestor(representation, head)) return { changeId: change.id, state: "absent", reason: "change_not_deployed" };
      const history = representation === head ? [] : (await compare(representation, head)).commits;
      const effects = new Map<string, { target: string; depth: number }>();
      const unrelated = new Set<string>();
      const visiting = new Set<string>();
      const roots = new Map<string, Promise<boolean>>();
      async function isRoot(sha: string, mainline: string | null): Promise<boolean> {
        const key = `${sha}:${mainline ?? ""}`;
        if (!roots.has(key)) roots.set(key, (async () => {
          if (sha === representation || original.has(sha)) return true;
          if (mainline && await ancestor(representation, sha)) return !await ancestor(representation, mainline);
          if (!bundle || change.kind !== "pull_request") return false;
          if (!await ancestor(sha, representation)) return false;
          const associations = complete(await call(() => reader.listCommitPullRequests(input.scope, sha)));
          const matches = associations.filter(p => p.number === change.number);
          if (!matches.length) return false;
          if (matches.length !== 1 || matches[0].state !== "merged" || matches[0].mergeCommitSha?.toLowerCase() !== representation ||
            matches[0].base.repositoryId !== input.scope.repositoryId || matches[0].head.sha !== bundle!.pullRequest.head.sha) throw new UnknownEvidence("ambiguous_rebased_identity");
          return true;
        })());
        return roots.get(key)!;
      }
      async function resolve(sha: string, depth = 0): Promise<void> {
        if (effects.has(sha) || unrelated.has(sha)) return;
        if (depth >= maxChain || visiting.has(sha)) throw new UnknownEvidence("revert_chain_limit");
        visiting.add(sha);
        const current = await commit(sha);
        const declaration = revert(current.message);
        if (!declaration) { unrelated.add(sha); visiting.delete(sha); return; }
        const target = await commit(declaration.target).catch((error: unknown) => {
          if (error instanceof GitHubProviderError && error.code === "access_denied" && error.status === 404) throw new UnknownEvidence("revert_target_unavailable");
          throw error;
        });
        if (target.parents.length > 1 ? !declaration.mainline || !target.parents.includes(declaration.mainline) : declaration.mainline !== null) throw new UnknownEvidence("revert_mainline_unknown");
        const root = await isRoot(target.sha, declaration.mainline);
        if (!await ancestor(target.sha, sha) && !(root && await ancestor(representation, sha))) throw new UnknownEvidence("noncausal_revert");
        if (root) effects.set(sha, { target: target.sha, depth: 1 });
        else {
          await resolve(target.sha, depth + 1);
          const parent = effects.get(target.sha);
          if (parent && parent.depth >= maxChain) throw new UnknownEvidence("revert_chain_limit");
          if (parent) effects.set(sha, { target: target.sha, depth: parent.depth + 1 });
          else unrelated.add(sha);
        }
        visiting.delete(sha);
      }
      for (const item of history) if (revert(item.message)) await resolve(item.sha.toLowerCase());
      if (!effects.size) return { changeId: change.id, state: "present" };
      for (const sha of effects.keys()) if (!await ancestor(sha, head)) throw new UnknownEvidence("revert_membership_unknown");
      const children = new Map<string, string[]>();
      for (const [sha, effect] of effects) children.set(effect.target, [...(children.get(effect.target) ?? []), sha]);
      const enabled = (sha: string): boolean => !(children.get(sha) ?? []).some(enabled);
      const leaves = [...effects.keys()].filter(sha => !children.has(sha));
      for (let i = 0; i < leaves.length; i++) for (let j = i + 1; j < leaves.length; j++) {
        if (effects.get(leaves[i])!.depth % 2 !== effects.get(leaves[j])!.depth % 2 &&
          !await ancestor(leaves[i], leaves[j]) && !await ancestor(leaves[j], leaves[i])) throw new UnknownEvidence("conflicting_revert_effects");
      }
      const active = [...effects].find(([sha, effect]) => effect.depth === 1 && enabled(sha));
      return active ? { changeId: change.id, state: "reverted", reason: "canonical_revert", revertSha: active[0] } : { changeId: change.id, state: "present" };
    }
    try {
      if (!inputSchema.safeParse(input).success || new Set(input.changes.map(c => c.id)).size !== input.changes.length) throw new UnknownEvidence("invalid_shipping_input");
      const restored = readState(input);
      state = restored.value;
      if (restored.changedTarget) successful = input.observed?.state === "success" ? { statusAt: input.observed.statusAt, statusId: input.observed.statusId } : null;
      reader = provider.shippingSession();
      const entries = input.changes.map(change => {
        const parsed = changeSchema.safeParse(change);
        return { change, supported: parsed.success, raw: hash(parsed.success ? parsed.data : [change.id, change.sourceId]) };
      });
      const statuses = await inventory();
      const selected = statuses.filter(s => s.state === "success" && s.environment === input.environment).at(-1);
      if (selected && (!successful || order(watermark(selected), successful) > 0)) successful = watermark(selected);
      if (input.observed) {
        const observed = input.observed;
        const matches = statuses.filter(s => s.id === observed.statusId);
        const visible = matches.some(s => s.createdAt === observed.statusAt && s.deployment.id === observed.deploymentId
          && s.deployment.sha === observed.sha.toLowerCase() && s.state === observed.state && s.environment === input.environment);
        const superseded = matches.length === 0 && selected && order(watermark(selected), observed) > 0
          && (!successful || order(watermark(selected), successful) >= 0);
        if (!visible && !superseded) throw new UnknownEvidence("observed_status_not_visible");
      }
      if (!selected) {
        if (successful) throw new UnknownEvidence("successful_watermark_not_visible");
        await gatherBranches();
        await validateInventory(undefined); state.scan.phase = "ready";
        return { state: "none", evidence: null, watermark: null, coverage: entries.map(({ change, supported }) => ({ changeId: change.id,
          state: supported ? "absent" : "unknown", reason: supported ? "no_successful_deployment" : "unsupported_requirement",
          source: { state: "unknown", reason: supported ? "deployment_unavailable" : "unsupported_requirement" } })), checkedAt, providerState: state };
      }
      const selectedOrder = watermark(selected);
      if (successful && order(selectedOrder, successful) < 0) throw new UnknownEvidence("successful_watermark_not_visible");
      successful = selectedOrder;
      const latest = statuses.filter(s => s.deployment.id === selected.deployment.id).at(-1)!;
      if (latest.id !== selected.id) throw new UnknownEvidence("selected_deployment_no_longer_successful");
      if (!restored.changedTarget && input.previous?.watermark && order(selectedOrder, input.previous.watermark) === 0 && input.previous.evidence &&
        input.previous.evidence.revision !== selected.deployment.sha) throw new UnknownEvidence("conflicting_deployment_identity");
      if (!state.validation) await validateSelected(selected);
      await gatherBranches();
      const head = selected.deployment.sha;
      if (state.reads.head !== head) state.reads = { head, commits: {}, comparisons: {} };
      state.proofs = Object.fromEntries(Object.entries(state.proofs).filter(([, proof]) => proof.head === head));
      state.attempts = Object.fromEntries(Object.entries(state.attempts).filter(([, attempt]) => attempt.head === head));
      const results = new Map<string, DeploymentCoverage>();
      for (const { change, raw, supported } of entries) {
        if (!supported) { results.set(change.id, { changeId: change.id, state: "unknown", reason: "unsupported_requirement" }); continue; }
        if (change.kind === "pull_request" && state.unmerged[raw] === head) {
          results.set(change.id, { changeId: change.id, state: "absent", reason: "pull_request_not_merged" }); continue;
        }
        const provenance = change.kind === "commit" ? hash(change.sha.toLowerCase()) : state.validated[hash([raw, head])];
        if (!provenance) continue;
        const proof = state.proofs[hash([state.scope, raw, head, provenance])];
        if (proof) results.set(change.id, proof.result);
      }
      const cursor = entries.findIndex(entry => entry.raw === state!.cursor);
      const ordered = [...entries.slice(cursor + 1), ...entries.slice(0, cursor + 1)];
      let evaluated = 0;
      let workBudgetExhausted = false;
      for (const { change, raw, supported } of ordered) {
        if (!supported || (results.has(change.id) && state.sourceChecks[raw])) continue;
        const attempt = state.attempts[raw];
        if (attempt?.head === head && (state.validation || attempt.retryAt > checkedAt)) {
          results.set(change.id, { changeId: change.id, state: "unknown", reason: attempt.reason }); continue;
        }
        if (state.validation) continue;
        if (evaluated >= maxChanges) break;
        evaluated++;
        state.cursor = raw;
        try {
          const resolved = await identity(change);
          if (!resolved) {
            state.unmerged[raw] = head;
            state.sourceChecks[raw] = { state: "unknown", reason: "pull_request_not_merged" };
            delete state.budgetRetries[raw]; delete state.progressCounts[raw];
            results.set(change.id, { changeId: change.id, state: "absent", reason: "pull_request_not_merged" }); continue;
          }
          state.sourceChecks[raw] = await qualify(change, raw, resolved);
          state.validated[hash([raw, head])] = resolved.provenance;
          const key = hash([state.scope, raw, head, resolved.provenance]);
          const result = state.proofs[key]?.result ?? await coverage(change, head, resolved);
          results.set(change.id, result);
          state.proofs[key] = { raw, head, provenance: resolved.provenance, change, result };
          delete state.attempts[raw]; delete state.budgetRetries[raw]; delete state.progressCounts[raw];
          ensureStateSize(state);
        } catch (error) {
          if (error instanceof PendingEvidence || (error instanceof GitHubProviderError && error.code === "request_budget")) {
            const progress = Object.keys(state.reads.commits).length + Object.keys(state.reads.comparisons).length;
            if (!state.budgetRetries[raw] || state.progressCounts[raw] !== progress) {
              state.budgetRetries[raw] = true; state.progressCounts[raw] = progress; workBudgetExhausted = true; break;
            }
            const reason = "unsupported_requirement_budget: use manual launch";
            state.attempts[raw] = { head, reason, retryAt: checkedAt + 60_000 };
            state.sourceChecks[raw] = { state: "unknown", reason };
            results.set(change.id, { changeId: change.id, state: "unknown", reason });
            workBudgetExhausted = true;
            break;
          }
          if (error instanceof GitHubProviderError && error.code === "access_denied" && error.status === 404) error = new UnknownEvidence("source_requirement_unavailable");
          if (!(error instanceof UnknownEvidence)) throw error;
          if (error.message.startsWith("shipping_state_limit")) throw error;
          state.attempts[raw] = { head, reason: error.message, retryAt: checkedAt + 60_000 };
          state.sourceChecks[raw] ??= { state: "unknown", reason: error.message };
          results.set(change.id, { changeId: change.id, state: "unknown", reason: error.message });
        }
      }
      if (workBudgetExhausted) throw new PendingEvidence("request_budget");
      let pending = entries.some(entry => entry.supported && (!results.has(entry.change.id) || !state!.sourceChecks[entry.raw]));
      await validateInventory(selected);
      pending ||= Object.values(state.branchFailures).includes("source_branch_changed");
      state.scan.phase = "ready";
      if (!pending && [...results.values()].every(result => result.state !== "unknown")) state.reads = { head, commits: {}, comparisons: {} };
      ensureStateSize(state);
      return { state: "current", watermark: selectedOrder, checkedAt,
        coverage: entries.map(({ change, raw, supported }) => ({ ...(results.get(change.id) ?? { changeId: change.id, state: "unknown" as const, reason: "coverage_pending" }),
          source: supported ? sourceFor(change, raw) : { state: "unknown" as const, reason: "unsupported_requirement" } })),
        ...(pending ? { pendingWork: true as const } : {}), providerState: state, evidence: {
          id: `github:${input.scope.repositoryId}:${selected.deployment.id}:${selected.id}`, provider: "github", label: `${input.environment} deployment ${selected.deployment.id}`,
          url: `https://github.com/${encodeURIComponent(input.scope.owner)}/${encodeURIComponent(input.scope.name)}/deployments`,
          revision: head, reportedAt: selected.createdAt,
        } };
    } catch (error) {
      if (error instanceof PendingEvidence || (error instanceof GitHubProviderError && error.code === "request_budget")) return project("pending", error instanceof PendingEvidence ? error.message : "request_budget", true);
      if (error instanceof UnknownEvidence) {
        if (state) { state.scan = emptyScan(); state.validation = null; state.branches = {}; state.sourceChecks = {}; state.branchFailures = {}; state.completedFullScanAt = null; state.validated = {}; state.unmerged = {}; }
        if (error.message.startsWith("shipping_state_limit")) state = undefined;
        return project("unknown", error.message);
      }
      if (error instanceof GitHubProviderError) return { ...project("unknown", `provider_${error.code}`), ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }) };
      return project("unknown", "provider_error");
    }
  } };
}
