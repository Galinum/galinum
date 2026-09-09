import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ShippingProviderInput } from "./types.js";
import { createGithubShippingProvider } from "./github-shipping.js";
import { createGitHubProvider, GitHubProviderError, type GitHubCollection, type GitHubCommit, type GitHubDeployment, type GitHubDeploymentStatus, type GitHubProvider, type GitHubPullRequest } from "./github-provider.js";

const sha = (n: number) => n.toString(16).padStart(40, "0");
const scope = { installationId: 7, repositoryId: 12, owner: "owner", name: "repo" };
const collection = <T>(items: T[]): GitHubCollection<T> => ({ items, totalCount: items.length, completeness: { complete: true, reasons: [] } });
const deployment = (id: number, head: string): GitHubDeployment => ({ id, sha: head, environment: "production", createdAt: id });
const status = (id: number, state: GitHubDeploymentStatus["state"] = "success", environment = "production"): GitHubDeploymentStatus => ({ id, createdAt: id * 1000, state, environment });
function fixture() {
  const graph = new Map<string, GitHubCommit>();
  const branches = new Map<string, string | null>();
  const deployments = [deployment(1, sha(1))];
  const statuses = new Map<number, GitHubDeploymentStatus[]>([[1, [status(1)]]]);
  const prs = new Map<number, { pullRequest: GitHubPullRequest; commits: GitHubCollection<GitHubCommit> }>();
  const associations = new Map<string, GitHubPullRequest[]>();
  function add(n: number, parents: number[] = [], message = "feature") {
    const c = { sha: sha(n), parents: parents.map(sha), message };
    graph.set(c.sha, c);
    return c;
  }
  add(1);
  function ancestors(head: string, result = new Set<string>()): Set<string> {
    if (result.has(head)) return result;
    result.add(head);
    for (const parent of graph.get(head)?.parents ?? []) ancestors(parent, result);
    return result;
  }
  let pageSize = 100;
  const reader: GitHubProvider = {
    shippingSession: vi.fn(() => reader),
    readBranch: vi.fn(async (_scope, name) => {
      const head = branches.has(name) ? branches.get(name) : [...graph.keys()].at(-1);
      if (!head) throw new GitHubProviderError("access_denied", 404);
      return { name, sha: head, protected: false };
    }),
    listDeploymentPage: vi.fn(async (_scope, page) => {
      const items = deployments.slice((page - 1) * pageSize, page * pageSize);
      return structuredClone({ items, nextPage: page * pageSize < deployments.length ? page + 1 : null });
    }),
    listDeploymentStatusPage: vi.fn(async (_scope, id, page) => {
      const all = statuses.get(id) ?? [];
      return structuredClone({ items: all.slice((page - 1) * pageSize, page * pageSize), nextPage: page * pageSize < all.length ? page + 1 : null });
    }),
    listDeployments: vi.fn(async () => collection(deployments)),
    listDeploymentStatuses: vi.fn(async (_scope, id) => collection(statuses.get(id) ?? [])),
    readCommit: vi.fn(async (_scope, id) => {
      const c = graph.get(id);
      if (!c) throw new GitHubProviderError("access_denied");
      return c;
    }),
    compare: vi.fn<GitHubProvider["compare"]>(async (_scope, before, after) => {
      const prior = ancestors(before), current = ancestors(after);
      const relation = before === after ? "identical" : current.has(before) ? "ahead" : prior.has(after) ? "behind" : "diverged";
      const commits = [...graph.values()].filter(c => current.has(c.sha) && !prior.has(c.sha));
      return { before, after, mergeBaseSha: before, status: relation, aheadBy: commits.length, behindBy: 0,
        commits: collection(commits), files: { ...collection([]), completeness: { complete: false, reasons: ["missing_patch"] } },
        completeness: { complete: false, reasons: ["missing_patch"] } };
    }),
    listPullRequestCommits: vi.fn(async (_scope, number) => {
      const p = prs.get(number);
      if (!p) throw new GitHubProviderError("access_denied");
      return p;
    }),
    listCommitPullRequests: vi.fn(async (_scope, id) => collection(associations.get(id) ?? [])),
    listInstallationRepositories: vi.fn(), verifyInstaller: vi.fn(), readRepositoryBranch: vi.fn(), readRepositoryReadme: vi.fn(),
    readPullRequest: vi.fn(), listPullRequestFiles: vi.fn(),
  };
  const input: ShippingProviderInput = { scope, environment: "production", scopeRevision: "scope-1", sourceBranches: { source: "main", s: "main" }, generation: 0, changes: [{ id: "change", sourceId: "source", kind: "commit", sha: sha(1) }], previous: null, observed: null };
  function pr(originals: number[], merged: number) {
    const pullRequest: GitHubPullRequest = { id: 20, number: 3, title: "feature", body: null, state: "merged", draft: false,
      base: { repositoryId: 12, ref: "main", sha: sha(1) }, head: { repositoryId: 12, ref: "branch", sha: sha(originals.at(-1)!) },
      mergeCommitSha: sha(merged), updatedAt: "2026-01-01T00:00:00Z", mergedAt: "2026-01-01T00:00:00Z", changedFiles: 1 };
    prs.set(3, { pullRequest, commits: collection(originals.map(n => graph.get(sha(n))!)) });
    input.changes = [{ id: "pr-change", sourceId: "source", kind: "pull_request", number: 3, shas: originals.map(sha) }];
    return pullRequest;
  }
  function head(n: number) { deployments[0].sha = sha(n); }
  return { reader, input, add, head, graph, branches, deployments, statuses, prs, associations, pr, setPageSize: (size: number) => { pageSize = size; }, refresh: () => createGithubShippingProvider(reader).refresh(input) };
}

const reverted = (n: number) => `Revert feature\n\nThis reverts commit ${sha(n)}.`;
const revertedMerge = (target: number, mainline: number) => `This reverts commit ${sha(target)}, reversing\nchanges made to ${sha(mainline)}.`;

describe("shipping deployment evidence", () => {
  it("uses complete commit history without requiring text patches", async () => {
    const f = fixture(); f.add(2, [1]); f.head(2);
    expect(await f.refresh()).toMatchObject({ state: "current", watermark: { statusId: 1 }, coverage: [{ state: "present" }], evidence: { revision: sha(2) } });
  });

  it("selects reported success order rather than deployment creation order", async () => {
    const f = fixture(); f.add(2, [1]); f.deployments.push(deployment(2, sha(2)));
    f.statuses.set(1, [status(4)]); f.statuses.set(2, [status(3)]);
    expect((await f.refresh()).evidence?.revision).toBe(sha(1));
  });

  it.each(["failure", "pending", "in_progress"] as const)("keeps deployed code after a newer %s attempt", async state => {
    const f = fixture(); f.deployments.push(deployment(2, sha(2))); f.statuses.set(2, [status(2, state)]);
    expect((await f.refresh()).evidence?.revision).toBe(sha(1));
  });

  it.each(["inactive", "failure", "pending", "error"] as const)("invalidates selected success after %s without falling back", async state => {
    const f = fixture(); f.add(2, [1]); f.deployments.push(deployment(2, sha(2)));
    f.statuses.set(2, [status(2), status(3, state)]);
    expect(await f.refresh()).toMatchObject({ state: "unknown", watermark: { statusId: 2 }, reason: "selected_deployment_no_longer_successful" });
  });

  it("uses exact status environment even when deployment environment differs", async () => {
    const f = fixture(); f.deployments[0].environment = "preview";
    expect((await f.refresh()).state).toBe("current");
    f.statuses.set(1, [status(1, "success", "Production")]);
    expect((await f.refresh()).state).toBe("none");
  });

  it("does not reset the successful watermark across unknown refreshes", async () => {
    const f = fixture(); f.input.previous = { state: "unknown", watermark: { statusAt: 3000, statusId: 3 }, coverage: [], evidence: null, checkedAt: 0 };
    expect(await f.refresh()).toMatchObject({ state: "unknown", watermark: { statusId: 3 }, reason: "successful_watermark_not_visible" });
  });

  it("waits for the observed webhook even when REST shows a successful older deployment", async () => {
    const f = fixture(); f.input.observed = { deploymentId: 1, sha: sha(1), statusId: 2, statusAt: 2000, state: "inactive" };
    expect(await f.refresh()).toMatchObject({ state: "unknown", reason: "observed_status_not_visible" });
    f.input.observed.state = "success";
    expect((await f.refresh()).watermark?.statusId).toBe(2);
  });

  it("checks the observed identity, not only a larger unrelated status number", async () => {
    const f = fixture(); f.statuses.set(1, [{ ...status(10), createdAt: 1000 }]);
    f.input.observed = { deploymentId: 2, sha: sha(2), statusId: 2, statusAt: 2000, state: "success" };
    expect((await f.refresh()).reason).toBe("observed_status_not_visible");
  });

  it("refreshes requirements at an unchanged successful head", async () => {
    const f = fixture(); f.add(2, [1]); f.head(2); f.input.previous = await f.refresh();
    f.input.changes.push({ id: "new", sourceId: "source", kind: "commit", sha: sha(3) }); f.add(3, [2]);
    expect((await f.refresh()).coverage.map(c => c.state)).toEqual(["present", "absent"]);
  });

  it("rejects incomplete deployment and status pagination", async () => {
    const f = fixture(); vi.mocked(f.reader.listDeploymentPage).mockRejectedValue(new GitHubProviderError("response_limit"));
    expect((await f.refresh()).state).toBe("unknown");
    const g = fixture(); vi.mocked(g.reader.listDeploymentStatusPage).mockRejectedValue(new GitHubProviderError("response_limit"));
    expect((await g.refresh()).state).toBe("unknown");
  });

  it("refuses inventory that changes during history reads", async () => {
    const f = fixture(); vi.mocked(f.reader.listDeploymentStatusPage).mockResolvedValueOnce({ items: [status(1)], nextPage: null }).mockResolvedValue({ items: [status(2)], nextPage: null });
    expect((await f.refresh()).reason).toBe("deployment_inventory_changed");
  });

  it("uses status ID as the equal-timestamp tie breaker", async () => {
    const f = fixture(); f.add(2, [1]); f.deployments.push(deployment(2, sha(2)));
    f.statuses.set(2, [{ ...status(2), createdAt: 1000 }]);
    expect((await f.refresh()).evidence?.revision).toBe(sha(2));
  });

  it("detects explicit rollback to an earlier head", async () => {
    const f = fixture(); f.add(2, [1]); f.head(2); f.input.changes[0] = { ...f.input.changes[0], kind: "commit", sha: sha(2) };
    f.input.previous = await f.refresh(); f.head(1); f.statuses.set(1, [status(2)]);
    expect((await drain(f)).coverage[0].state).toBe("absent");
  });

  it("sanitizes provider errors and keeps the last successful watermark", async () => {
    const f = fixture(); f.input.previous = await f.refresh();
    vi.mocked(f.reader.listDeploymentPage).mockRejectedValue(new GitHubProviderError("rate_limited", 429, 60000));
    expect(await f.refresh()).toMatchObject({ state: "unknown", reason: "provider_rate_limited", watermark: { statusId: 1 }, retryAfterMs: 60000 });
    vi.mocked(f.reader.listDeploymentPage).mockRejectedValue(new GitHubProviderError("access_denied", 403));
    expect(await f.refresh()).not.toHaveProperty("retryAfterMs");
  });
});

describe("shipping change identity and causal reverts", () => {
  it.each(["merge", "squash", "rebase"])("covers a complete original PR through its %s representation", async kind => {
    const f = fixture(); f.add(2, [1]); f.add(3, [2]);
    if (kind === "merge") f.add(4, [1, 3]);
    else if (kind === "squash") f.add(4, [1]);
    else { f.add(5, [1]); f.add(4, [5]); }
    f.pr([2, 3], 4); f.head(4);
    expect((await f.refresh()).coverage[0].state).toBe("present");
    f.head(2);
    expect((await f.refresh()).coverage[0].state).toBe("absent");
  });

  it("requires every original commit and complete original inventory", async () => {
    const f = fixture(); f.add(2, [1]); f.add(3, [1]); f.pr([2], 3); f.head(3);
    f.input.changes = [{ id: "pr", sourceId: "source", kind: "pull_request", number: 3, shas: [sha(2), sha(9)] }];
    expect((await f.refresh()).coverage[0]).toMatchObject({ state: "unknown", reason: "original_membership_unknown" });
    f.prs.get(3)!.commits.completeness = { complete: false, reasons: ["github_commit_limit"] };
    expect((await f.refresh()).coverage[0].state).toBe("unknown");
  });

  it("does not accept an unmerged test merge", async () => {
    const f = fixture(); f.add(2, [1]); f.pr([2], 2); f.head(2); f.prs.get(3)!.pullRequest.state = "open";
    expect((await f.refresh()).coverage[0].state).toBe("absent");
  });

  it("blocks incomplete comparison history rather than trusting ancestry alone", async () => {
    const f = fixture(); f.add(2, [1]); f.head(2);
    const compare = vi.mocked(f.reader.compare).getMockImplementation()!;
    vi.mocked(f.reader.compare).mockImplementation(async (...args) => {
      const value = await compare(...args);
      return { ...value, commits: { ...value.commits, completeness: { complete: false, reasons: ["page_budget"] } } };
    });
    expect((await f.refresh()).coverage[0].state).toBe("unknown");
  });

  it("detects a canonical revert and causal revert-of-revert", async () => {
    const f = fixture(); f.add(2, [1], reverted(1)); f.head(2);
    expect((await f.refresh()).coverage[0]).toMatchObject({ state: "reverted", revertSha: sha(2) });
    f.add(3, [2], reverted(2)); f.head(3);
    expect((await f.refresh()).coverage[0].state).toBe("present");
    f.add(4, [3], reverted(3)); f.head(4);
    expect((await f.refresh()).coverage[0].state).toBe("reverted");
  });

  it("two independent reverts never imply restoration", async () => {
    const f = fixture(); f.add(2, [1], reverted(1)); f.add(3, [2], reverted(1)); f.head(3);
    expect((await f.refresh()).coverage[0].state).toBe("reverted");
    f.add(4, [3], reverted(2)); f.head(4);
    expect((await f.refresh()).coverage[0].state).toBe("reverted");
    f.add(5, [4], reverted(3)); f.head(5);
    expect((await f.refresh()).coverage[0].state).toBe("present");
  });

  it("reports conflicting incomparable restoration and removal as unknown", async () => {
    const f = fixture(); f.add(2, [1], reverted(1)); f.add(3, [2], reverted(2)); f.add(4, [1], reverted(1)); f.add(5, [3, 4]); f.head(5);
    expect((await f.refresh()).coverage[0]).toMatchObject({ state: "unknown", reason: "conflicting_revert_effects" });
  });

  it("recognizes revert-of-merge only with a valid mainline parent", async () => {
    const f = fixture(); f.add(2, [1]); f.add(3, [1, 2]); f.pr([2], 3);
    f.add(4, [3], `This reverts commit ${sha(3)}, reversing\nchanges made to ${sha(1)}.`); f.head(4);
    expect((await f.refresh()).coverage[0].state).toBe("reverted");
    f.add(4, [3], reverted(3));
    expect((await f.refresh()).coverage[0]).toMatchObject({ state: "unknown", reason: "revert_mainline_unknown" });
  });

  it("removes branch-only side-branch commits when their enclosing merge is reverted, then restores them causally", async () => {
    const f = fixture(); f.add(2, [1]); f.add(3, [2]); f.add(4, [1, 3]); f.add(5, [4], revertedMerge(4, 1)); f.head(5);
    f.input.changes = [2, 3].map(n => ({ id: `change-${n}`, sourceId: "source", kind: "commit", sha: sha(n) }));
    const removed = await f.refresh();
    expect(removed.state).toBe("current");
    expect(removed.coverage).toMatchObject([2, 3].map(n => ({ changeId: `change-${n}`, state: "reverted", reason: "canonical_revert", revertSha: sha(5) })));
    f.add(6, [5], reverted(5)); f.head(6);
    expect((await f.refresh()).coverage.map(c => c.state)).toEqual(["present", "present"]);
    expect(f.reader.listPullRequestCommits).not.toHaveBeenCalled();
    expect(f.reader.listCommitPullRequests).not.toHaveBeenCalled();
  });

  it("removes and restores a PR representation introduced through an enclosing merge", async () => {
    const f = fixture(); f.add(2, [1]); f.add(3, [1]); f.pr([2], 3);
    f.add(4, [3]); f.add(5, [1, 4]); f.add(6, [5], revertedMerge(5, 1)); f.head(6);
    expect((await f.refresh()).coverage[0]).toMatchObject({ state: "reverted", revertSha: sha(6) });
    f.add(7, [6], reverted(6)); f.head(7);
    expect((await f.refresh()).coverage[0].state).toBe("present");
    expect(f.reader.listCommitPullRequests).not.toHaveBeenCalled();
  });

  it("does not remove a direct requirement absent from the reverted merge", async () => {
    const f = fixture(); f.add(2, [1]); f.add(3, [1]); f.add(4, [1, 3]); f.add(5, [4], revertedMerge(4, 1)); f.add(6, [5, 2]); f.head(6);
    f.input.changes = [{ id: "feature", sourceId: "source", kind: "commit", sha: sha(2) }];
    expect((await f.refresh()).coverage[0].state).toBe("present");
  });

  it.each(["commit", "pull_request"])("keeps a %s requirement already present on the declared mainline", async kind => {
    const f = fixture(); f.add(2, [1]); f.add(3, [1]);
    if (kind === "pull_request") f.pr([2], 3);
    else f.input.changes = [{ id: "feature", sourceId: "source", kind: "commit", sha: sha(3) }];
    f.add(4, [3]); f.add(5, [1]); f.add(6, [4, 5]); f.add(7, [6], revertedMerge(6, 4)); f.head(7);
    expect((await f.refresh()).coverage[0].state).toBe("present");
  });

  it("keeps enclosing-merge identity results separate for different declared mainlines", async () => {
    const f = fixture(); f.add(2, [1]); f.add(3, [2]); f.add(4, [1, 3]);
    f.add(5, [4], revertedMerge(4, 3)); f.add(6, [5], revertedMerge(4, 1)); f.head(6);
    f.input.changes = [{ id: "feature", sourceId: "source", kind: "commit", sha: sha(2) }];
    expect((await f.refresh()).coverage[0]).toMatchObject({ state: "reverted", revertSha: sha(6) });
  });

  it.each([4, 1])("leaves enclosing-merge coverage unknown when ancestry to commit %i is incomplete", async after => {
    const f = fixture(); f.add(2, [1]); f.add(3, [2]); f.add(4, [1, 3]); f.add(5, [4], revertedMerge(4, 1)); f.head(5);
    f.input.changes = [{ id: "feature", sourceId: "source", kind: "commit", sha: sha(2) }];
    const compare = vi.mocked(f.reader.compare).getMockImplementation()!;
    vi.mocked(f.reader.compare).mockImplementation(async (...args) => {
      const result = await compare(...args);
      return args[1] === sha(2) && args[2] === sha(after)
        ? { ...result, commits: { ...result.commits, completeness: { complete: false, reasons: ["page_budget"] } } }
        : result;
    });
    expect((await f.refresh()).coverage[0]).toMatchObject({ state: "unknown", reason: "incomplete_history" });
  });

  it("rejects a declared enclosing-merge mainline that is not a target parent", async () => {
    const f = fixture(); f.add(2, [1]); f.add(3, [2]); f.add(4, [1, 3]); f.add(5, [4], revertedMerge(4, 2)); f.head(5);
    f.input.changes = [{ id: "feature", sourceId: "source", kind: "commit", sha: sha(2) }];
    expect((await f.refresh()).coverage[0]).toMatchObject({ state: "unknown", reason: "revert_mainline_unknown" });
  });

  it("detects a verified rebased constituent revert", async () => {
    const f = fixture(); f.add(2, [1]); f.add(3, [2]); f.add(4, [1]); f.add(5, [4]);
    const pr = f.pr([2, 3], 5); f.associations.set(sha(4), [pr]); f.add(6, [5], reverted(4)); f.head(6);
    expect((await f.refresh()).coverage[0].state).toBe("reverted");
    pr.base.sha = sha(6);
    expect((await f.refresh()).coverage[0].state).toBe("reverted");
  });

  it.each([false, true])("keeps a PR present after an unrelated canonical revert with complete associations (other PR: %s)", async otherPr => {
    const f = fixture(); f.add(2, [1]); f.add(3, [1]); f.add(4, [3]);
    const pr = f.pr([2], 4); f.add(5, [4], reverted(3)); f.head(5);
    f.associations.set(sha(3), otherPr ? [{ ...pr, number: 7 }] : []);
    expect((await f.refresh()).coverage[0].state).toBe("present");
    expect(f.reader.listCommitPullRequests).toHaveBeenCalledWith(scope, sha(3));
  });

  it("blocks incomplete associations for a rebased constituent", async () => {
    const f = fixture(); f.add(2, [1]); f.add(3, [1]); f.add(4, [3]); f.pr([2], 4); f.add(5, [4], reverted(3)); f.head(5);
    vi.mocked(f.reader.listCommitPullRequests).mockResolvedValue({ ...collection([]), completeness: { complete: false, reasons: ["page_budget"] } });
    expect((await f.refresh()).coverage[0].state).toBe("unknown");
  });

  it.each(["duplicate", "conflict"])("keeps %s matching PR metadata unknown", async kind => {
    const f = fixture(); f.add(2, [1]); f.add(3, [1]); f.add(4, [3]);
    const pr = f.pr([2], 4); f.add(5, [4], reverted(3)); f.head(5);
    f.associations.set(sha(3), kind === "duplicate" ? [pr, pr] : [{ ...pr, mergeCommitSha: sha(9) }]);
    expect((await f.refresh()).coverage[0]).toMatchObject({ state: "unknown", reason: "ambiguous_rebased_identity" });
  });

  it("bounds causal target chains even when commits arrive in chronological order", async () => {
    const f = fixture();
    for (let n = 2; n <= 35; n++) f.add(n, [n - 1], reverted(n - 1));
    f.head(35);
    expect((await f.refresh()).coverage[0]).toMatchObject({ state: "unknown", reason: "revert_chain_limit" });
  });

  it("bounds total reader operations across all deployment histories", async () => {
    const f = fixture();
    for (let n = 2; n <= 125; n++) f.deployments.push(deployment(n, sha(1)));
    expect((await f.refresh()).reason).toBe("request_budget");
    expect(vi.mocked(f.reader.listDeploymentStatusPage).mock.calls.length + vi.mocked(f.reader.listDeploymentPage).mock.calls.length).toBeLessThanOrEqual(120);
  });

  it("detects original-target revert after squash without requiring original SHA ancestry", async () => {
    const f = fixture(); f.add(2, [1]); f.add(3, [1]); f.pr([2], 3); f.add(4, [3], reverted(2)); f.head(4);
    expect((await f.refresh()).coverage[0].state).toBe("reverted");
  });

  it("does not call unrelated feature-removal prose a revert", async () => {
    const f = fixture(); f.add(2, [1], "Remove feature support"); f.head(2);
    expect((await f.refresh()).coverage[0].state).toBe("present");
    f.add(2, [1], "This reverts commit abc123.");
    expect((await f.refresh()).coverage[0]).toMatchObject({ state: "unknown", reason: "malformed_revert" });
  });

  it("rejects a noncausal revert target and a missing commit", async () => {
    const f = fixture(); f.add(2, [], reverted(1)); f.add(3, [1, 2]); f.head(3);
    expect((await f.refresh()).coverage[0]).toMatchObject({ state: "unknown", reason: "noncausal_revert" });
    f.add(2, [1], reverted(9));
    expect((await f.refresh()).state).toBe("unknown");
  });

  it("rejects unidentifiable requirements before any provider read", async () => {
    const f = fixture(); f.input.changes = [{ id: "bad", sourceId: "", kind: "commit", sha: "branch" }];
    expect((await f.refresh()).reason).toBe("invalid_shipping_input");
    expect(f.reader.listDeploymentPage).not.toHaveBeenCalled();
  });
});

async function drain(f: ReturnType<typeof fixture>, limit = 20) {
  for (let run = 0; run < limit; run++) {
    const value = await f.refresh();
    f.input.previous = structuredClone(value);
    if (!value.pendingWork) return value;
  }
  throw new Error("Shipping continuation failed to converge");
}

describe("bounded resumable shipping", () => {
  it("visits 130 deployments through resumed ten-item pages within the original call bound", async () => {
    const f = fixture(); f.setPageSize(10);
    for (let id = 2; id <= 130; id++) { f.deployments.push(deployment(id, sha(1))); f.statuses.set(id, [status(id)]); }
    let maximumCalls = 0;
    let priorCalls = 0;
    for (let run = 0; run < 10; run++) {
      const value = await f.refresh();
      const calls = vi.mocked(f.reader.listDeploymentPage).mock.calls.length + vi.mocked(f.reader.listDeploymentStatusPage).mock.calls.length;
      maximumCalls = Math.max(maximumCalls, calls - priorCalls); priorCalls = calls;
      f.input.previous = structuredClone(value);
      if (run === 0) expect(value).toMatchObject({ state: "pending", pendingWork: true, evidence: null });
      if (!value.pendingWork) break;
    }
    expect(maximumCalls).toBeLessThanOrEqual(120);
    expect(f.input.previous).toMatchObject({ state: "current", evidence: { id: "github:12:130:130" }, coverage: [{ state: "present" }] });
    expect(new Set(vi.mocked(f.reader.listDeploymentStatusPage).mock.calls.map(args => args[1])).size).toBe(130);
    expect(vi.mocked(f.reader.listDeploymentPage).mock.calls.filter(args => args[1] === 13)).toHaveLength(1);
  });

  it("completes a 125-change union without repeating immutable proofs", async () => {
    const f = fixture();
    for (let n = 2; n <= 126; n++) f.add(n, [n - 1]);
    f.head(126);
    f.input.changes = Array.from({ length: 125 }, (_, i) => ({ id: `change-${i}`, sourceId: "source", kind: "commit", sha: sha(i + 1) }));
    const first = await f.refresh();
    expect(first.pendingWork).toBe(true);
    expect(first.coverage.filter(item => item.state === "present")).toHaveLength(100);
    f.input.previous = structuredClone(first);
    const final = await drain(f);
    expect(final.state).toBe("current"); expect(final.pendingWork).toBeUndefined();
    expect(final.coverage).toHaveLength(125); expect(final.coverage.every(item => item.state === "present")).toBe(true);
    expect(f.reader.compare).toHaveBeenCalledTimes(125);
  });

  it("retains other page proofs and reuses them when that page returns", async () => {
    const f = fixture(); f.add(2, [1]); f.add(3, [2]); f.head(3);
    const original = structuredClone(f.input.changes);
    f.input.previous = await f.refresh();
    f.input.changes = [{ id: "second", sourceId: "source", kind: "commit", sha: sha(2) }];
    f.input.previous = await f.refresh();
    f.input.changes = original;
    const calls = vi.mocked(f.reader.compare).mock.calls.length;
    expect((await f.refresh()).coverage).toMatchObject([{ changeId: "change", state: "present" }]);
    expect(f.reader.compare).toHaveBeenCalledTimes(calls);
  });

  it("invalidates PR proof reuse when the actual merged identity changes", async () => {
    const f = fixture(); f.add(2, [1]); f.add(3, [1]); f.add(4, [1]); f.pr([2], 3); f.head(3);
    f.input.previous = await f.refresh();
    expect(f.input.previous.coverage[0].state).toBe("present");
    f.prs.get(3)!.pullRequest.mergeCommitSha = sha(4);
    const changed = await f.refresh();
    expect(changed.coverage[0].state).toBe("absent");
    expect(f.reader.listPullRequestCommits).toHaveBeenCalledTimes(2);
  });

  it("revalidates original PR membership even when its merge SHA is unchanged", async () => {
    const f = fixture(); f.add(2, [1]); f.add(3, [1]); f.add(4, [1]); f.pr([2], 3); f.head(3);
    f.input.previous = await f.refresh();
    f.prs.get(3)!.commits = collection([f.graph.get(sha(4))!]);
    expect((await f.refresh()).coverage[0]).toMatchObject({ state: "unknown", reason: "original_membership_unknown" });
  });

  it("never carries old positives into a new deployed SHA", async () => {
    const f = fixture(); f.add(2, [1]); f.head(2);
    f.input.changes = [{ id: "feature", sourceId: "source", kind: "commit", sha: sha(2) }];
    f.input.previous = await f.refresh();
    f.head(1); f.statuses.set(1, [status(2)]); f.input.generation++;
    expect((await f.refresh()).coverage[0].state).toBe("absent");
  });

  it("keys cache by full requirement, not a reused public id", async () => {
    const f = fixture(); f.input.previous = await f.refresh(); f.add(2, [1]);
    f.input.changes[0] = { id: "change", sourceId: "source", kind: "commit", sha: sha(2) };
    expect((await f.refresh()).coverage[0].state).toBe("absent");
  });

  it("restarts an interrupted scan on mapping generation and observed status changes", async () => {
    const f = fixture(); f.setPageSize(10);
    for (let id = 2; id <= 130; id++) { f.deployments.push(deployment(id, sha(1))); f.statuses.set(id, [status(id)]); }
    f.input.previous = await f.refresh(); expect(f.input.previous.pendingWork).toBe(true);
    f.input.generation++;
    f.statuses.set(130, [status(130), status(131, "inactive")]);
    f.input.observed = { deploymentId: 130, sha: sha(1), statusId: 131, statusAt: 131000, state: "inactive" };
    const value = await drain(f);
    expect(value).toMatchObject({ state: "unknown", evidence: null, reason: "selected_deployment_no_longer_successful" });
    expect(vi.mocked(f.reader.listDeploymentPage).mock.calls.filter(args => args[1] === 13)).toHaveLength(2);
  });

  it("retains successful watermark discovered before a scan interruption", async () => {
    const f = fixture();
    for (let id = 2; id <= 130; id++) { f.deployments.push(deployment(id, sha(1))); f.statuses.set(id, [status(id)]); }
    const value = await f.refresh();
    expect(value.state).toBe("pending"); expect(value.watermark!.statusId).toBeGreaterThan(1);
  });

  it("keeps private proofs through provider failure but grants no launch authority", async () => {
    const f = fixture(); f.add(2, [1]); f.head(2);
    f.input.previous = await f.refresh();
    const savedState = structuredClone(f.input.previous.providerState);
    vi.mocked(f.reader.listDeploymentPage).mockRejectedValueOnce(new GitHubProviderError("transient", 503));
    const failure = await f.refresh();
    expect(failure).toMatchObject({ state: "unknown", evidence: null, coverage: [{ state: "unknown" }] });
    expect(failure.providerState).toMatchObject({ proofs: (savedState as { proofs: unknown }).proofs });
    f.input.previous = failure;
    expect((await f.refresh()).coverage[0].state).toBe("present");
    expect(f.reader.compare).toHaveBeenCalledTimes(1);
  });

  it.each(["repository", "installation", "environment"])("rebuilds proof scope and resets the watermark for an actual %s target change", async target => {
    const f = fixture(); f.statuses.set(1, [status(10)]); f.input.previous = await f.refresh();
    f.input.scopeRevision = "scope-2";
    if (target === "repository") f.input.scope = { ...scope, repositoryId: 13 };
    else if (target === "installation") f.input.scope = { ...scope, installationId: 8 };
    else f.input.environment = "other-production";
    f.statuses.set(1, [status(1, "success", f.input.environment)]);
    expect(await f.refresh()).toMatchObject({ state: "current", watermark: { statusId: 1 }, coverage: [{ state: "present" }] });
  });

  it.each(["scope", "state", "overflow"])("fails closed for malformed or bounded %s", async fault => {
    const f = fixture(); f.input.previous = await f.refresh();
    if (fault === "scope") f.input.scope = { ...scope, owner: "../escape" };
    else f.input.previous.providerState = fault === "state" ? { version: 999 } : "x".repeat(8 * 1024 * 1024);
    const value = await f.refresh();
    expect(value.state).toBe("unknown"); expect(value.evidence).toBeNull(); expect(value.pendingWork).toBeUndefined();
    if (fault === "overflow") expect(value.reason).toContain("use manual launch");
  });

  it("advances past unresolved requirements without busy-looping them", async () => {
    const f = fixture(); f.add(2, [1]); f.head(2);
    f.input.changes = Array.from({ length: 125 }, (_, i) => ({ id: `change-${i}`, sourceId: "source", kind: "commit", sha: sha(i + 1) }));
    const compare = vi.mocked(f.reader.compare).getMockImplementation()!;
    vi.mocked(f.reader.compare).mockImplementation(async (...args) => {
      const value = await compare(...args);
      return args[1] === sha(1) ? { ...value, commits: { ...value.commits, completeness: { complete: false, reasons: ["page_budget"] } } } : value;
    });
    const value = await drain(f);
    expect(value.pendingWork).toBeUndefined(); expect(value.coverage[0]).toMatchObject({ state: "unknown", reason: "incomplete_history" });
    expect(value.coverage[1].state).toBe("present");
    expect(vi.mocked(f.reader.compare).mock.calls.filter(args => args[1] === sha(1))).toHaveLength(1);
  });
});

it("resumes the real shipping transport after its unchanged 32-request session budget", async () => {
  const key = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const fetcher = vi.fn<typeof fetch>(async input => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/access_tokens")) return Response.json({ token: "fixture_token", expires_at: "2099-01-01T00:00:00Z" });
    if (url.pathname === "/repos/owner/repo") return Response.json({ id: 12, owner: { login: "owner" }, name: "repo", description: null,
      default_branch: "main", private: true, archived: false, disabled: false });
    if (url.pathname === "/repos/owner/repo/branches/main") return Response.json({ name: "main", commit: { sha: sha(1) }, protected: false });
    const page = Number(url.searchParams.get("page"));
    if (url.pathname.endsWith("/deployments")) {
      const start = (page - 1) * 10;
      return Response.json(Array.from({ length: 10 }, (_, i) => ({ id: start + i + 1, sha: sha(1), environment: "production", created_at: "2026-01-01T00:00:00Z" })),
        { headers: page < 13 ? { Link: `<https://api.github.com/repos/owner/repo/deployments?page=${page + 1}>; rel="next"` } : {} });
    }
    const match = /\/deployments\/([0-9]+)\/statuses$/.exec(url.pathname);
    if (match) return Response.json([{ id: Number(match[1]), environment: "production", state: "success", created_at: "2026-01-01T00:00:00Z" }]);
    throw new Error(`Unexpected fixture request ${url.pathname}`);
  });
  const provider = createGithubShippingProvider(createGitHubProvider({ appId: 9, clientId: "Iv.fixture", privateKey: key, fetch: fetcher }));
  const input = fixture().input;
  for (let run = 0; run < 20; run++) {
    const before = fetcher.mock.calls.length;
    input.previous = structuredClone(await provider.refresh(input));
    expect(fetcher.mock.calls.length - before).toBeLessThanOrEqual(32);
    if (!input.previous.pendingWork) break;
  }
  expect(input.previous).toMatchObject({ state: "current", coverage: [{ state: "present" }], evidence: { id: "github:12:130:130" } });
  expect(input.previous?.pendingWork).toBeUndefined();
  expect(fetcher.mock.calls.length).toBeGreaterThan(260);
  for (let id = 1; id < 130; id++) {
    expect(fetcher.mock.calls.filter(args => new URL(String(args[0])).pathname === `/repos/owner/repo/deployments/${id}/statuses`)).toHaveLength(2);
  }
});

it("continues coverage under session exhaustion without redoing completed work", async () => {
  const f = fixture();
  for (let n = 2; n <= 126; n++) f.add(n, [n - 1]);
  f.head(126);
  f.input.changes = Array.from({ length: 125 }, (_, i) => ({ id: String(i), sourceId: "source", kind: "commit", sha: sha(i + 1) }));
  boundedSessions(f);
  const value = await drain(f);
  expect(value.coverage.every(item => item.state === "present")).toBe(true);
  expect(f.reader.compare).toHaveBeenCalledTimes(125);
});

it("resumes one coverage proof across sessions without replaying immutable reads", async () => {
  const f = fixture();
  for (let n = 2; n <= 25; n++) f.add(n, [n - 1], reverted(n - 1));
  f.head(25);
  f.input.changes.push({ id: "independent", sourceId: "source", kind: "commit", sha: sha(25) });
  boundedSessions(f);
  const value = await drain(f);
  expect(value.pendingWork).toBeUndefined();
  expect(value.coverage).toMatchObject([{ changeId: "change", state: "present" }, { changeId: "independent", state: "present" }]);
  const commitReads = vi.mocked(f.reader.readCommit).mock.calls.map(args => args[1]);
  expect(commitReads.length).toBe(new Set(commitReads).size);
  const comparisons = vi.mocked(f.reader.compare).mock.calls.map(args => args.slice(1).join(":"));
  expect(comparisons.length).toBe(new Set(comparisons).size);
  expect(f.reader.shippingSession).toHaveBeenCalledTimes(3);
});

it("rechecks a multi-page status boundary and refuses a changed status history", async () => {
  const f = fixture(); f.setPageSize(1); f.statuses.set(1, [status(3), status(2), status(1)]);
  const original = vi.mocked(f.reader.listDeploymentStatusPage).getMockImplementation()!;
  vi.mocked(f.reader.listDeploymentStatusPage).mockImplementation(async (...args) => {
    const value = await original(...args);
    if (args[2] === 3) f.statuses.set(1, [status(4, "inactive"), status(3), status(2), status(1)]);
    return value;
  });
  f.input.previous = await f.refresh();
  expect(f.input.previous).toMatchObject({ state: "pending", pendingWork: true, evidence: null, reason: "deployment_inventory_changed" });
  expect(await drain(f)).toMatchObject({ state: "unknown", evidence: null, reason: "selected_deployment_no_longer_successful" });
});

it("rejects duplicate deployment identity across valid pages", async () => {
  const f = fixture(); f.setPageSize(1); f.deployments.push(deployment(1, sha(1)));
  expect(await f.refresh()).toMatchObject({ state: "unknown", evidence: null, reason: "conflicting_deployment_identity" });
});

it("continues a large PR bundle inventory with complete provenance checks", async () => {
  const f = fixture(); f.add(2, [1]); f.add(3, [1]); const template = f.pr([2], 3); f.head(3);
  f.input.changes = Array.from({ length: 125 }, (_, i) => {
    const number = i + 1;
    f.prs.set(number, { pullRequest: { ...template, id: number, number }, commits: collection([f.graph.get(sha(2))!]) });
    return { id: `pr-${number}`, sourceId: "source", kind: "pull_request", number, shas: [sha(2)] };
  });
  const value = await drain(f);
  expect(value.coverage.every(item => item.state === "present")).toBe(true);
  expect(f.reader.listPullRequestCommits).toHaveBeenCalledTimes(125);
});

it("classifies a reader operation with no resumable progress without starving other requirements", async () => {
  const f = fixture(); f.add(2, [1]); f.head(2);
  f.input.changes.push({ id: "independent", sourceId: "source", kind: "commit", sha: sha(2) });
  vi.mocked(f.reader.compare).mockRejectedValue(new GitHubProviderError("request_budget"));
  const value = await drain(f);
  expect(value.pendingWork).toBeUndefined();
  expect(value.coverage).toMatchObject([{ changeId: "change", state: "unknown", reason: "unsupported_requirement_budget: use manual launch" }, { changeId: "independent", state: "present" }]);
  expect(f.reader.compare).toHaveBeenCalledTimes(2);
});

it("finishes bounded unmerged PR checks instead of repeatedly draining mutable negatives", async () => {
  const f = fixture(); f.add(2, [1]); const template = f.pr([2], 2);
  f.input.changes = Array.from({ length: 125 }, (_, i) => {
    const number = i + 1;
    f.prs.set(number, { pullRequest: { ...template, id: number, number, state: "open" }, commits: collection([f.graph.get(sha(2))!]) });
    return { id: `pr-${number}`, sourceId: "source", kind: "pull_request", number, shas: [sha(2)] };
  });
  const value = await drain(f);
  expect(value.coverage.every(item => item.reason === "pull_request_not_merged")).toBe(true);
  expect(f.reader.listPullRequestCommits).toHaveBeenCalledTimes(125);
  f.head(2); f.prs.get(1)!.pullRequest.state = "merged"; f.statuses.set(1, [status(2)]);
  expect((await drain(f)).coverage[0].state).toBe("present");
});

describe("completed inventory repair and recovery", () => {
  it("revalidates all warm status boundaries without reloading deployment or status history pages", async () => {
    const f = fixture(); f.setPageSize(10);
    for (let id = 2; id <= 130; id++) { f.deployments.push(deployment(id, sha(1))); f.statuses.set(id, [status(id)]); }
    const first = await drain(f);
    expect(first.state).toBe("current");
    const completedFullScanAt = (first.providerState as { completedFullScanAt: number }).completedFullScanAt;
    expect(completedFullScanAt).toBeGreaterThan(0);
    vi.mocked(f.reader.listDeploymentPage).mockClear(); vi.mocked(f.reader.listDeploymentStatusPage).mockClear();
    f.add(2, [1]); f.input.changes.push({ id: "new", sourceId: "source", kind: "commit", sha: sha(2) });
    const warm = await drain(f);
    expect(warm.state).toBe("current"); expect(warm.pendingWork).toBeUndefined();
    expect(warm.coverage.map(item => item.state)).toEqual(["present", "absent"]);
    expect(warm.providerState).toMatchObject({ completedFullScanAt });
    expect(vi.mocked(f.reader.listDeploymentPage).mock.calls.map(args => args[1])).toEqual([1, 1]);
    const statusCalls = vi.mocked(f.reader.listDeploymentStatusPage).mock.calls;
    expect(statusCalls.every(args => args[2] === 1)).toBe(true);
    for (let id = 1; id < 130; id++) expect(statusCalls.filter(args => args[1] === id)).toHaveLength(1);
    expect(statusCalls.filter(args => args[1] === 130)).toHaveLength(3);
  });

  it("repairs missed older status changes at ten minutes without sliding the full-scan timestamp", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    try {
      const f = fixture(); f.add(2, [1]); f.deployments.push(deployment(2, sha(2))); f.statuses.set(2, [status(2)]);
      f.input.changes = [{ id: "feature", sourceId: "source", kind: "commit", sha: sha(2) }];
      f.input.previous = await f.refresh();
      expect(f.input.previous).toMatchObject({ state: "current", evidence: { revision: sha(2) }, providerState: { completedFullScanAt: 1_000_000 } });
      clock.mockReturnValue(1_599_999);
      f.input.previous = await f.refresh();
      expect(f.input.previous).toMatchObject({ evidence: { revision: sha(2) }, providerState: { completedFullScanAt: 1_000_000 } });
      f.statuses.set(1, [status(1), status(3)]);
      vi.mocked(f.reader.listDeploymentStatusPage).mockClear();
      clock.mockReturnValue(1_600_000);
      const repaired = await f.refresh();
      expect(repaired).toMatchObject({ state: "current", evidence: { id: "github:12:1:3", revision: sha(1) }, providerState: { completedFullScanAt: 1_600_000 } });
      expect(repaired.coverage[0].state).toBe("absent");
      expect(new Set(vi.mocked(f.reader.listDeploymentStatusPage).mock.calls.map(args => args[1]))).toEqual(new Set([1, 2]));
    } finally { clock.mockRestore(); }
  });

  it("returns pending on a changed warm boundary and scans status-environment overrides without filtering", async () => {
    const f = fixture(); f.input.previous = await f.refresh();
    f.add(2, [1]); f.deployments.push({ ...deployment(2, sha(2)), environment: "preview" }); f.statuses.set(2, [status(2)]);
    const changed = await f.refresh();
    expect(changed).toMatchObject({ state: "pending", pendingWork: true, evidence: null, reason: "deployment_inventory_changed",
      providerState: { completedFullScanAt: null, scan: { phase: "deployments", deployments: [] } } });
    f.input.previous = changed;
    expect(await drain(f)).toMatchObject({ state: "current", evidence: { id: "github:12:2:2" }, coverage: [{ state: "present" }] });
  });

  it("invalidates warm inventory on a shipping generation change before the repair TTL", async () => {
    const f = fixture(); f.deployments.push(deployment(2, sha(1))); f.statuses.set(2, [status(2)]);
    f.input.previous = await f.refresh();
    f.input.generation++; f.statuses.set(1, [status(3)]);
    vi.mocked(f.reader.listDeploymentStatusPage).mockClear();
    expect(await f.refresh()).toMatchObject({ state: "current", evidence: { id: "github:12:1:3" } });
    expect(new Set(vi.mocked(f.reader.listDeploymentStatusPage).mock.calls.map(args => args[1]))).toEqual(new Set([1, 2]));
  });

  it("treats a confirmed canonical-target 404 as per-requirement unknown", async () => {
    const f = fixture(); f.add(2, [1], reverted(9)); f.add(3, [2]); f.add(4, [3]); f.head(4);
    f.input.changes.push({ id: "later", sourceId: "source", kind: "commit", sha: sha(3) });
    const original = vi.mocked(f.reader.readCommit).getMockImplementation()!;
    vi.mocked(f.reader.readCommit).mockImplementation(async (...args) => {
      if (args[1] === sha(9)) throw new GitHubProviderError("access_denied", 404);
      return original(...args);
    });
    expect(await f.refresh()).toMatchObject({ state: "current", evidence: { revision: sha(4) }, coverage: [
      { changeId: "change", state: "unknown", reason: "revert_target_unavailable" }, { changeId: "later", state: "present" },
    ] });
    expect(f.reader.listDeploymentStatusPage).toHaveBeenCalledTimes(4);
  });

  it.each([
    new GitHubProviderError("access_denied", 403), new GitHubProviderError("access_denied"),
    new GitHubProviderError("rate_limited", 429, 60000), new GitHubProviderError("transient", 503),
  ])("keeps provider-wide authority failures fatal even at canonical targets: %s", async failure => {
    const f = fixture(); f.add(2, [1], reverted(9)); f.add(3, [2]); f.add(4, [3]); f.head(4);
    f.input.changes.unshift({ id: "later", sourceId: "source", kind: "commit", sha: sha(3) });
    const original = vi.mocked(f.reader.readCommit).getMockImplementation()!;
    vi.mocked(f.reader.readCommit).mockImplementation(async (...args) => {
      if (args[1] === sha(9)) throw failure;
      return original(...args);
    });
    const value = await f.refresh();
    expect(value.state).toBe("unknown"); expect(value.evidence).toBeNull();
    expect(value.coverage.every(item => item.state === "unknown")).toBe(true);
    if (failure.retryAfterMs) expect(value.retryAfterMs).toBe(failure.retryAfterMs);
  });

  it("keeps final scope validation after recovering from a missing canonical target", async () => {
    const f = fixture(); f.add(2, [1], reverted(9)); f.head(2);
    const original = vi.mocked(f.reader.readCommit).getMockImplementation()!;
    vi.mocked(f.reader.readCommit).mockImplementation(async (...args) => {
      if (args[1] === sha(9)) throw new GitHubProviderError("access_denied", 404);
      return original(...args);
    });
    vi.mocked(f.reader.listDeploymentStatusPage).mockResolvedValueOnce({ items: [status(1)], nextPage: null })
      .mockResolvedValueOnce({ items: [status(1)], nextPage: null }).mockRejectedValue(new GitHubProviderError("access_denied", 403));
    expect(await f.refresh()).toMatchObject({ state: "unknown", evidence: null, reason: "provider_access_denied" });
  });

  it.each(["success", "inactive"] as const)("supersedes a missing obsolete %s observation only with verified newer success", async observedState => {
    const f = fixture(); f.statuses.set(1, [status(5)]);
    f.input.observed = { deploymentId: 2, sha: sha(2), statusId: 2, statusAt: 2000, state: observedState };
    f.input.previous = { state: "unknown", evidence: null, watermark: { statusAt: 4000, statusId: 4 }, coverage: [], checkedAt: 0 };
    const observed = structuredClone(f.input.observed);
    const value = await f.refresh();
    expect(value).toMatchObject({ state: "current", watermark: { statusAt: 5000, statusId: 5 }, evidence: { id: "github:12:1:5" } });
    expect(f.input.observed).toEqual(observed);
    expect(f.reader.listDeploymentStatusPage).toHaveBeenCalledTimes(4);
  });

  it("never falls back when the latest known successful record is missing", async () => {
    const f = fixture(); f.statuses.set(1, [status(5)]);
    f.input.observed = { deploymentId: 2, sha: sha(2), statusId: 6, statusAt: 6000, state: "success" };
    f.input.previous = { state: "unknown", evidence: null, watermark: { statusAt: 6000, statusId: 6 }, coverage: [], checkedAt: 0 };
    const value = await f.refresh();
    expect(value).toMatchObject({ state: "unknown", evidence: null, watermark: { statusId: 6 }, reason: "observed_status_not_visible" });
    expect(value.coverage.every(item => item.state === "unknown")).toBe(true);
  });

  it("rejects a successor below the retained successful watermark despite an obsolete observation", async () => {
    const f = fixture(); f.statuses.set(1, [status(5)]);
    f.input.observed = { deploymentId: 2, sha: sha(2), statusId: 2, statusAt: 2000, state: "success" };
    f.input.previous = { state: "unknown", evidence: null, watermark: { statusAt: 6000, statusId: 6 }, coverage: [], checkedAt: 0 };
    expect(await f.refresh()).toMatchObject({ state: "unknown", evidence: null, watermark: { statusId: 6 } });
  });

  it("does not supersede conflicting observed identity or a noncurrent successor", async () => {
    const f = fixture(); f.statuses.set(1, [status(2), status(5)]);
    f.input.observed = { deploymentId: 2, sha: sha(2), statusId: 2, statusAt: 2000, state: "success" };
    expect(await f.refresh()).toMatchObject({ state: "unknown", evidence: null, reason: "observed_status_not_visible" });
    f.statuses.set(1, [status(5), status(6, "inactive")]);
    expect(await f.refresh()).toMatchObject({ state: "unknown", evidence: null, reason: "selected_deployment_no_longer_successful" });
  });

  it("requires fresh final validation before superseding an obsolete observation", async () => {
    const f = fixture(); f.statuses.set(1, [status(5)]);
    f.input.observed = { deploymentId: 2, sha: sha(2), statusId: 2, statusAt: 2000, state: "success" };
    vi.mocked(f.reader.listDeploymentStatusPage).mockResolvedValueOnce({ items: [status(5)], nextPage: null })
      .mockResolvedValueOnce({ items: [status(5)], nextPage: null }).mockResolvedValue({ items: [status(5), status(6, "inactive")], nextPage: null });
    expect(await f.refresh()).toMatchObject({ state: "pending", pendingWork: true, evidence: null, reason: "deployment_inventory_changed" });
  });
});

describe("fresh inventory for initial activation", () => {
  it.each([undefined, "activation-1"])("finds a delayed rollback before activation after completed work with token %s", async priorToken => {
    const f = fixture(); f.add(2, [1]); f.deployments.push(deployment(2, sha(2))); f.statuses.set(2, [status(2)]);
    f.input.changes = [{ id: "feature", sourceId: "source", kind: "commit", sha: sha(2) }];
    f.input.activationToken = priorToken;
    f.input.previous = await f.refresh();
    expect(f.input.previous).toMatchObject({ state: "current", evidence: { id: "github:12:2:2" }, coverage: [{ state: "present" }] });
    expect(f.input.previous.pendingWork).toBeUndefined();
    f.statuses.set(1, [status(1), status(3)]);
    f.input.activationToken = "activation-1";
    vi.mocked(f.reader.listDeploymentStatusPage).mockClear();
    const activated = await f.refresh();
    expect(activated).toMatchObject({ state: "current", evidence: { id: "github:12:1:3", revision: sha(1) }, coverage: [{ state: "absent" }],
      providerState: { lastActivationToken: "activation-1" } });
    expect(f.input.generation).toBe(0); expect(f.input.observed).toBeNull();
    expect(new Set(vi.mocked(f.reader.listDeploymentStatusPage).mock.calls.map(args => args[1]))).toEqual(new Set([1, 2]));
  });

  it("resets completed inventory when the activation token changes during pending proof work", async () => {
    const f = fixture();
    for (let n = 2; n <= 126; n++) f.add(n, [n - 1]);
    f.deployments.push(deployment(2, sha(126))); f.statuses.set(2, [status(2)]);
    f.input.changes = Array.from({ length: 125 }, (_, i) => ({ id: `feature-${i + 1}`, sourceId: "source", kind: "commit", sha: sha(i + 1) }));
    f.input.activationToken = "before-approval-change";
    f.input.previous = await f.refresh();
    expect(f.input.previous).toMatchObject({ state: "current", pendingWork: true, providerState: { scan: { phase: "ready" } } });
    f.statuses.set(1, [status(1), status(3)]);
    f.input.activationToken = "after-approval-change";
    const refreshed = await drain(f);
    expect(refreshed).toMatchObject({ state: "current", evidence: { id: "github:12:1:3" }, providerState: { lastActivationToken: "after-approval-change" } });
    expect(refreshed.coverage.find(item => item.changeId === "feature-2")?.state).toBe("absent");
    expect(refreshed.coverage.filter(item => item.state === "present")).toMatchObject([{ changeId: "feature-1", state: "present" }]);
  });

  it.each([false, true])("continues an unfinished 130-record full scan without restarting pages (token changes: %s)", async changeToken => {
    const f = fixture(); f.setPageSize(10);
    for (let id = 2; id <= 130; id++) { f.deployments.push(deployment(id, sha(1))); f.statuses.set(id, [status(id)]); }
    f.input.activationToken = "activation-1";
    f.input.previous = await f.refresh();
    expect(f.input.previous).toMatchObject({ state: "pending", pendingWork: true, providerState: { scan: { phase: "statuses" } } });
    if (changeToken) f.input.activationToken = "activation-2";
    const completed = await drain(f);
    expect(completed).toMatchObject({ state: "current", coverage: [{ state: "present" }], providerState: { lastActivationToken: f.input.activationToken } });
    expect(completed.pendingWork).toBeUndefined();
    expect(vi.mocked(f.reader.listDeploymentPage).mock.calls.filter(args => args[1] === 13)).toHaveLength(1);
  });
});

it.each(["scope revision", "repository rename"])("retains the rollback watermark across a same-target %s", async change => {
  const f = fixture(); f.add(2, [1]); f.head(2);
  f.deployments.push(deployment(2, sha(1)), deployment(3, sha(2)));
  f.statuses.set(2, [status(2)]); f.statuses.set(3, [status(3, "pending")]);
  f.input.changes = [{ id: "feature", sourceId: "source", kind: "commit", sha: sha(2) }];
  f.input.observed = { deploymentId: 3, sha: sha(2), statusId: 3, statusAt: 3000, state: "pending" };
  f.input.previous = await f.refresh();
  expect(f.input.previous.watermark).toEqual({ statusAt: 2000, statusId: 2 });
  expect(f.input.previous.coverage[0].state).toBe("absent");
  f.deployments.splice(1, 1); f.statuses.delete(2);
  if (change === "scope revision") f.input.scopeRevision = "description-only-revision";
  else f.input.scope = { ...scope, name: "renamed-repository" };
  const value = await f.refresh();
  expect(value.state).toBe("unknown"); expect(value.evidence).toBeNull();
  expect(value.watermark).toEqual({ statusAt: 2000, statusId: 2 });
  expect(value.reason).toBe("successful_watermark_not_visible");
  expect(value.coverage[0].state).toBe("unknown");
});

it.each([false, true])("compares retained deployment identity only within the same physical target (target changes: %s)", async changedTarget => {
  const f = fixture(); f.input.previous = await f.refresh();
  f.add(2, [1]); f.head(2); f.input.scopeRevision = "scope-2";
  if (changedTarget) f.input.scope = { ...scope, repositoryId: 13 };
  const value = await f.refresh();
  expect(value.state).toBe(changedTarget ? "current" : "unknown");
  if (changedTarget) expect(value.evidence?.revision).toBe(sha(2));
  else { expect(value.evidence).toBeNull(); expect(value.reason).toBe("conflicting_deployment_identity"); }
});

describe("non-selected deployment boundary races", () => {
  it.each(["inventory", "coverage"])("rejects a newer rollback status on a non-selected deployment during %s IO", async phase => {
    const f = fixture(); f.add(2, [1]); f.add(3, [2]);
    f.deployments.push(deployment(2, sha(3))); f.statuses.set(2, [status(2)]);
    f.input.changes = [{ id: "feature", sourceId: "source", kind: "commit", sha: sha(2) }];
    f.input.activationToken = "initial-launch";
    let changed = false;
    if (phase === "inventory") {
      const original = vi.mocked(f.reader.listDeploymentStatusPage).getMockImplementation()!;
      vi.mocked(f.reader.listDeploymentStatusPage).mockImplementation(async (...args) => {
        const result = await original(...args);
        if (!changed && args[1] === 2) { changed = true; f.statuses.set(1, [status(3)]); }
        return result;
      });
    } else {
      const original = vi.mocked(f.reader.compare).getMockImplementation()!;
      vi.mocked(f.reader.compare).mockImplementation(async (...args) => {
        const result = await original(...args);
        if (!changed) { changed = true; f.statuses.set(1, [status(3)]); }
        return result;
      });
    }
    const first = await f.refresh();
    expect(changed).toBe(true);
    expect(first.state).toBe("pending");
    expect(first.evidence).toBeNull();
    expect(first.coverage.some(item => item.state === "present")).toBe(false);
    f.input.previous = first;
    const settled = await drain(f);
    expect(settled.state).toBe("current");
    expect(settled.evidence?.id).toBe("github:12:1:3");
    expect(settled.coverage[0].state).toBe("absent");
    expect(f.input.observed).toBeNull(); expect(f.input.generation).toBe(0);
  });
});

it.each(["empty", "environment override"])("revalidates a non-selected %s status boundary", async mode => {
  const f = fixture(); f.add(2, [1]); f.deployments.push(deployment(2, sha(2))); f.statuses.set(2, [status(2)]);
  if (mode === "empty") f.statuses.set(1, []);
  else f.deployments[0].environment = "preview";
  f.input.changes = [{ id: "feature", sourceId: "source", kind: "commit", sha: sha(2) }];
  const original = vi.mocked(f.reader.listDeploymentStatusPage).getMockImplementation()!;
  let changed = false;
  vi.mocked(f.reader.listDeploymentStatusPage).mockImplementation(async (...args) => {
    const value = await original(...args);
    if (!changed && args[1] === 2) { changed = true; f.statuses.set(1, [status(3)]); }
    return value;
  });
  f.input.previous = await f.refresh();
  expect(f.input.previous.state).toBe("pending"); expect(f.input.previous.evidence).toBeNull();
  const value = await drain(f);
  expect(value.evidence?.id).toBe("github:12:1:3"); expect(value.coverage[0].state).toBe("absent");
});

it("does not accept an empty inventory result after its scanned status boundary gained success", async () => {
  const f = fixture(); f.statuses.set(1, []);
  const original = vi.mocked(f.reader.listDeploymentStatusPage).getMockImplementation()!;
  let changed = false;
  vi.mocked(f.reader.listDeploymentStatusPage).mockImplementation(async (...args) => {
    const value = await original(...args);
    if (!changed) { changed = true; f.statuses.set(1, [status(2)]); }
    return value;
  });
  f.input.previous = await f.refresh();
  expect(f.input.previous.state).toBe("pending"); expect(f.input.previous.evidence).toBeNull();
  expect(await drain(f)).toMatchObject({ state: "current", evidence: { id: "github:12:1:2" }, coverage: [{ state: "present" }] });
});

it("retains a higher successful watermark discovered by the validation sweep", async () => {
  const f = fixture(); f.add(2, [1]); f.add(3, [2]); f.deployments.push(deployment(2, sha(3))); f.statuses.set(2, [status(2)]);
  f.input.changes = [{ id: "feature", sourceId: "source", kind: "commit", sha: sha(2) }];
  const original = vi.mocked(f.reader.compare).getMockImplementation()!;
  vi.mocked(f.reader.compare).mockImplementation(async (...args) => {
    const value = await original(...args); f.statuses.set(1, [status(3)]); return value;
  });
  f.input.previous = await f.refresh();
  expect(f.input.previous.state).toBe("pending"); expect(f.input.previous.watermark?.statusId).toBe(3);
  f.statuses.set(1, [status(1)]);
  const value = await drain(f);
  expect(value.state).toBe("unknown"); expect(value.evidence).toBeNull();
  expect(value.watermark?.statusId).toBe(3); expect(value.reason).toBe("successful_watermark_not_visible");
});

function boundedSessions(f: ReturnType<typeof fixture>) {
  vi.mocked(f.reader.shippingSession).mockImplementation(() => {
    let calls = 0;
    return new Proxy(f.reader, { get(target, property) {
      const value = Reflect.get(target, property);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (++calls > 32) throw new GitHubProviderError("request_budget");
        return value(...args);
      };
    } });
  });
}

it("freezes coverage IO while a 130-record validation sweep resumes and accepts later input only as pending", async () => {
  const f = fixture(); f.add(2, [1]); f.add(3, [2]); f.head(2);
  for (let id = 2; id <= 130; id++) { f.deployments.push(deployment(id, sha(2))); f.statuses.set(id, [status(id)]); }
  f.input.activationToken = "first-page";
  boundedSessions(f);
  let position = 0;
  for (let n = 0; n < 20; n++) {
    f.input.previous = structuredClone(await f.refresh());
    position = (f.input.previous.providerState as { validation?: { nextDeployment: number } }).validation?.nextDeployment ?? 0;
    if (position > 0) break;
  }
  expect(position).toBeGreaterThan(0); expect(position).toBeLessThan(130);
  expect(f.input.previous?.state).toBe("pending");
  const oldCalls = vi.mocked(f.reader.compare).mock.calls.length;
  const firstBoundaryCalls = vi.mocked(f.reader.listDeploymentStatusPage).mock.calls.filter(args => args[1] === 1).length;
  f.input.changes.push({ id: "new-input", sourceId: "source", kind: "commit", sha: sha(3) });
  f.input.activationToken = "next-page";
  let firstPublication;
  for (let n = 0; n < 20; n++) {
    f.input.previous = structuredClone(await f.refresh());
    expect(f.reader.compare).toHaveBeenCalledTimes(oldCalls);
    if (f.input.previous.state === "current") { firstPublication = f.input.previous; break; }
    expect(f.input.previous.evidence).toBeNull();
  }
  expect(firstPublication?.coverage.find(item => item.changeId === "new-input")).toMatchObject({ state: "unknown", reason: "coverage_pending" });
  expect(firstPublication?.pendingWork).toBe(true);
  expect(vi.mocked(f.reader.listDeploymentStatusPage).mock.calls.filter(args => args[1] === 1)).toHaveLength(firstBoundaryCalls);
  const value = await drain(f);
  expect(value.coverage.find(item => item.changeId === "new-input")?.state).toBe("absent");
  expect(value.pendingWork).toBeUndefined();
});

it.each([false, true])("never publishes a partial failed validation and respects observation invalidation on recovery (%s)", async newObservation => {
  const f = fixture(); f.add(2, [1]);
  for (let id = 2; id <= 130; id++) { f.deployments.push(deployment(id, sha(2))); f.statuses.set(id, [status(id)]); }
  f.input.changes = [{ id: "feature", sourceId: "source", kind: "commit", sha: sha(2) }];
  boundedSessions(f); await drain(f);
  vi.mocked(f.reader.listDeploymentStatusPage).mockClear();
  const original = vi.mocked(f.reader.listDeploymentStatusPage).getMockImplementation()!;
  let failed = false;
  vi.mocked(f.reader.listDeploymentStatusPage).mockImplementation(async (...args) => {
    if (!failed && args[1] === 40) { failed = true; throw new GitHubProviderError("transient", 503); }
    return original(...args);
  });
  const failure = await drain(f);
  expect(failure.state).toBe("unknown"); expect(failure.evidence).toBeNull();
  expect(failure.coverage.every(item => item.state === "unknown")).toBe(true);
  expect(failure.providerState).toMatchObject({ validation: { nextDeployment: 39 } });
  if (newObservation) {
    f.statuses.set(1, [status(200)]); f.input.generation++;
    f.input.observed = { deploymentId: 1, sha: sha(1), statusId: 200, statusAt: 200000, state: "success" };
  }
  const recovered = await drain(f);
  expect(recovered.state).toBe("current");
  expect(recovered.coverage[0].state).toBe(newObservation ? "absent" : "present");
  expect(vi.mocked(f.reader.listDeploymentStatusPage).mock.calls.filter(args => args[1] === 1).length).toBe(newObservation ? 5 : 1);
});

it("rechecks the deployment listing after the status sweep", async () => {
  const f = fixture();
  const original = vi.mocked(f.reader.listDeploymentStatusPage).getMockImplementation()!;
  let calls = 0;
  vi.mocked(f.reader.listDeploymentStatusPage).mockImplementation(async (...args) => {
    const value = await original(...args);
    if (++calls === 3) { f.deployments.push(deployment(2, sha(1))); f.statuses.set(2, [status(2)]); }
    return value;
  });
  expect(await f.refresh()).toMatchObject({ state: "pending", evidence: null, reason: "deployment_inventory_changed" });
});

it("rechecks the selected status after the complete boundary sweep", async () => {
  const f = fixture();
  const original = vi.mocked(f.reader.listDeploymentStatusPage).getMockImplementation()!;
  let calls = 0;
  vi.mocked(f.reader.listDeploymentStatusPage).mockImplementation(async (...args) => {
    if (++calls === 4) f.statuses.set(1, [status(1), status(2, "inactive")]);
    return original(...args);
  });
  expect(await f.refresh()).toMatchObject({ state: "pending", evidence: null, reason: "deployment_inventory_changed" });
});

describe("configured source provenance", () => {
  it("does not authorize a deployed commit outside the selected source branch", async () => {
    const f = fixture(); f.add(2, [1]); f.head(2); f.branches.set("main", sha(1));
    f.input.changes = [{ id: "outside", sourceId: "source", kind: "commit", sha: sha(2) }];
    const result = await f.refresh();
    expect(result.coverage[0]).toMatchObject({ state: "present", source: { state: "unknown", reason: "source_branch_mismatch" } });
    expect(f.reader.readBranch).toHaveBeenCalledWith(scope, "main");
  });

  it("does not authorize a deployed PR merged into a different source branch", async () => {
    const f = fixture(); f.add(2, [1]); f.add(3, [1]); const pr = f.pr([2], 3); f.head(3);
    pr.base.ref = "release";
    const result = await f.refresh();
    expect(result.coverage[0]).toMatchObject({ state: "present", source: { state: "unknown", reason: "source_branch_mismatch" } });
  });

  it("keeps an unsupported 251-original PR local to that requirement", async () => {
    const f = fixture();
    f.input.changes.push({ id: "large", sourceId: "source", kind: "pull_request", number: 42, shas: Array.from({ length: 251 }, (_, i) => sha(i + 1)) });
    const result = await f.refresh();
    expect(result.state).toBe("current");
    expect(result.coverage).toEqual([{ changeId: "change", state: "present", source: { state: "verified" } },
      { changeId: "large", state: "unknown", reason: "unsupported_requirement", source: { state: "unknown", reason: "unsupported_requirement" } }]);
    expect(f.reader.listPullRequestCommits).not.toHaveBeenCalled();
    expect(f.input.changes[1].kind === "pull_request" && f.input.changes[1].shas).toHaveLength(251);
  });
});

it.each(["off-branch", "deleted"])("preserves actual deployed rollback evidence when the source is %s", async sourceState => {
  const f = fixture(); f.add(2, [1]); f.head(2); f.branches.set("main", sha(2));
  f.input.changes = [{ id: "feature", sourceId: "source", kind: "commit", sha: sha(2) }];
  f.input.previous = await f.refresh();
  expect(f.input.previous.coverage[0]).toMatchObject({ state: "present", source: { state: "verified" } });
  f.deployments.push(deployment(2, sha(1))); f.statuses.set(2, [status(2)]);
  f.branches.set("main", sourceState === "deleted" ? null : sha(1));
  const result = await drain(f);
  expect(result.state).toBe("current"); expect(result.evidence?.id).toBe("github:12:2:2");
  expect(result.coverage[0]).toMatchObject({ state: "absent", source: { state: "unknown", reason: sourceState === "deleted" ? "source_branch_unavailable" : "source_branch_mismatch" } });
});

it("does not reuse a positive source proof after the configured branch loses membership", async () => {
  const f = fixture(); f.add(2, [1]); f.head(2); f.branches.set("main", sha(2));
  f.input.changes = [{ id: "feature", sourceId: "source", kind: "commit", sha: sha(2) }];
  f.input.previous = await f.refresh();
  f.branches.set("main", sha(1));
  const result = await f.refresh();
  expect(result.coverage[0]).toMatchObject({ state: "present", source: { state: "unknown", reason: "source_branch_mismatch" } });
  expect(f.reader.readBranch).toHaveBeenCalledTimes(4);
});

it.each([false, true])("invalidates source qualification when its branch changes during evidence IO (removed: %s)", async removed => {
  const f = fixture(); f.add(2, [1]); f.add(3, []); f.head(2); f.branches.set("main", sha(2));
  const original = vi.mocked(f.reader.compare).getMockImplementation()!;
  let changed = false;
  vi.mocked(f.reader.compare).mockImplementation(async (...args) => {
    const result = await original(...args);
    if (!changed) { changed = true; f.branches.set("main", removed ? null : sha(3)); }
    return result;
  });
  const result = await f.refresh();
  expect(changed).toBe(true); expect(result.state).toBe("current");
  expect(result.coverage[0]).toMatchObject({ state: "present", source: { state: "unknown", reason: removed ? "source_branch_unavailable" : "source_branch_changed" } });
  f.input.previous = result;
  expect((await f.refresh()).coverage[0].source).toEqual({ state: "unknown", reason: removed ? "source_branch_unavailable" : "source_branch_mismatch" });
});

it("fences source branch rebinding even without a separate scope revision bump", async () => {
  const f = fixture(); f.add(2, [1]); f.head(2); f.branches.set("main", sha(2)); f.branches.set("release", sha(1));
  f.input.changes = [{ id: "feature", sourceId: "source", kind: "commit", sha: sha(2) }];
  f.input.previous = await f.refresh(); f.input.sourceBranches = { source: "release" };
  const result = await f.refresh();
  expect(result.coverage[0]).toMatchObject({ state: "present", source: { state: "unknown", reason: "source_branch_mismatch" } });
  expect(result.watermark).toEqual(f.input.previous.watermark);
});

it("requires a PR's merged representative on the configured branch, not just the deployment", async () => {
  const f = fixture(); f.add(2, [1]); f.add(3, [1]); f.pr([2], 3); f.head(3); f.branches.set("main", sha(1));
  const result = await f.refresh();
  expect(result.coverage[0]).toMatchObject({ state: "present", source: { state: "unknown", reason: "source_branch_mismatch" } });
});

it("keeps deployment reverts detectable beside an unsupported PR", async () => {
  const f = fixture(); f.add(2, [1], reverted(1)); f.head(2);
  f.input.changes.push({ id: "large", sourceId: "source", kind: "pull_request", number: 42, shas: Array.from({ length: 251 }, (_, i) => sha(i + 1)) });
  const result = await f.refresh();
  expect(result.state).toBe("current");
  expect(result.coverage[0]).toMatchObject({ state: "reverted", source: { state: "verified" }, revertSha: sha(2) });
  expect(result.coverage[1]).toMatchObject({ state: "unknown", source: { state: "unknown", reason: "unsupported_requirement" } });
});

it("keeps per-requirement syntax limits separate from unidentifiable envelope errors", async () => {
  const f = fixture();
  f.input.changes.push({ id: "invalid-sha", sourceId: "source", kind: "commit", sha: "not-a-sha" });
  expect((await f.refresh()).coverage).toEqual([
    { changeId: "change", state: "present", source: { state: "verified" } },
    { changeId: "invalid-sha", state: "unknown", reason: "unsupported_requirement", source: { state: "unknown", reason: "unsupported_requirement" } },
  ]);
  f.input.changes[1].id = "change";
  expect((await f.refresh()).state).toBe("unknown");
});

it("does not qualify a source that has no configured branch binding", async () => {
  const f = fixture(); f.input.sourceBranches = {};
  expect((await f.refresh()).coverage[0]).toMatchObject({ state: "present", source: { state: "unknown", reason: "source_branch_unconfigured" } });
});

it("keeps branch permission failures as provider-wide authority failures", async () => {
  const f = fixture(); f.input.previous = await f.refresh();
  vi.mocked(f.reader.readBranch).mockRejectedValue(new GitHubProviderError("access_denied", 403));
  expect(await f.refresh()).toMatchObject({ state: "unknown", evidence: null, coverage: [{ state: "unknown", source: { state: "unknown" } }] });
});

it("resumes 20 source branches, 125 changes and 130 deployments under actual 32-request sessions", async () => {
  const key = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const fetcher = vi.fn<typeof fetch>(async input => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/access_tokens")) return Response.json({ token: "fixture_token", expires_at: "2099-01-01T00:00:00Z" });
    if (url.pathname === "/repos/owner/repo") return Response.json({ id: 12, owner: { login: "owner" }, name: "repo", description: null, default_branch: "main", private: true, archived: false, disabled: false });
    const branch = /\/branches\/(source-[0-9]+)$/.exec(url.pathname);
    if (branch) return Response.json({ name: branch[1], commit: { sha: sha(126) }, protected: false });
    const page = Number(url.searchParams.get("page"));
    if (url.pathname.endsWith("/deployments")) {
      const start = (page - 1) * 100;
      return Response.json(Array.from({ length: Math.min(100, 130 - start) }, (_, i) => ({ id: start + i + 1, sha: sha(126), environment: "production", created_at: "2026-01-01T00:00:00Z" })),
        { headers: page === 1 ? { Link: '<https://api.github.com/repos/owner/repo/deployments?page=2>; rel="next"' } : {} });
    }
    const statusMatch = /\/deployments\/([0-9]+)\/statuses$/.exec(url.pathname);
    if (statusMatch) return Response.json([{ id: Number(statusMatch[1]), environment: "production", state: "success", created_at: "2026-01-01T00:00:00Z" }]);
    const comparison = /\/compare\/([a-f0-9]{40})\.\.\.([a-f0-9]{40})$/.exec(url.pathname);
    if (comparison) {
      const before = Number.parseInt(comparison[1], 16); const after = Number.parseInt(comparison[2], 16);
      const all = Array.from({ length: after - before }, (_, i) => ({ sha: sha(before + i + 1), commit: { message: "Feature" } }));
      return Response.json({ status: "ahead", ahead_by: all.length, behind_by: 0, total_commits: all.length, base_commit: { sha: comparison[1] }, merge_base_commit: { sha: comparison[1] },
        commits: all.slice((page - 1) * 100, page * 100), files: [] }, { headers: all.length > page * 100 ? { Link: '<https://api.github.com/compare?page=2>; rel="next"' } : {} });
    }
    throw new Error(`Unexpected fixture request ${url.pathname}`);
  });
  const provider = createGithubShippingProvider(createGitHubProvider({ appId: 9, clientId: "Iv.fixture", privateKey: key, fetch: fetcher }));
  const input = fixture().input;
  input.sourceBranches = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`source-${i}`, `source-${i}`]));
  input.changes = Array.from({ length: 125 }, (_, i) => ({ id: `change-${i}`, sourceId: `source-${i % 20}`, kind: "commit", sha: sha(i + 1) }));
  let runs = 0;
  for (; runs < 30; runs++) {
    const before = fetcher.mock.calls.length;
    input.previous = structuredClone(await provider.refresh(input));
    expect(fetcher.mock.calls.length - before).toBeLessThanOrEqual(32);
    if (!input.previous.pendingWork) break;
  }
  expect(runs).toBeLessThan(30);
  expect(input.previous?.state).toBe("current"); expect(input.previous?.coverage).toHaveLength(125);
  expect(input.previous?.coverage.every(item => item.state === "present" && item.source.state === "verified")).toBe(true);
  for (let i = 0; i < 20; i++) expect(fetcher.mock.calls.filter(args => new URL(String(args[0])).pathname === `/repos/owner/repo/branches/source-${i}`)).toHaveLength(2);
});

it.each(["../main", "", "x".repeat(1025)])("isolates an invalid configured branch without requesting it: %s", async invalidBranch => {
  const f = fixture(); f.input.sourceBranches = { source: "main", invalid: invalidBranch };
  f.input.changes.push({ id: "disabled-source", sourceId: "invalid", kind: "commit", sha: sha(1) });
  const value = await f.refresh();
  expect(value.state).toBe("current");
  expect(value.coverage).toEqual([
    { changeId: "change", state: "present", source: { state: "verified" } },
    { changeId: "disabled-source", state: "present", source: { state: "unknown", reason: "source_branch_invalid" } },
  ]);
  expect(vi.mocked(f.reader.readBranch).mock.calls.every(args => args[1] === "main")).toBe(true);
});

it("does not let one missing configured branch block another source's qualification", async () => {
  const f = fixture(); f.input.sourceBranches = { source: "main", removed: "release" }; f.branches.set("release", null);
  f.input.changes.push({ id: "removed-source", sourceId: "removed", kind: "commit", sha: sha(1) });
  const value = await f.refresh();
  expect(value.state).toBe("current");
  expect(value.coverage).toEqual([
    { changeId: "change", state: "present", source: { state: "verified" } },
    { changeId: "removed-source", state: "present", source: { state: "unknown", reason: "source_branch_unavailable" } },
  ]);
});

it("revalidates every source branch across a resumed validation pass", async () => {
  const f = fixture(); f.add(2, [1]); f.head(2);
  for (let id = 2; id <= 130; id++) { f.deployments.push(deployment(id, sha(2))); f.statuses.set(id, [status(id)]); }
  f.input.sourceBranches = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`source-${i}`, `branch-${i}`]));
  f.input.changes = Array.from({ length: 20 }, (_, i) => ({ id: `change-${i}`, sourceId: `source-${i}`, kind: "commit", sha: sha(2) }));
  const original = vi.mocked(f.reader.readBranch).getMockImplementation()!;
  const counts = new Map<string, number>();
  vi.mocked(f.reader.readBranch).mockImplementation(async (...args) => {
    const count = (counts.get(args[1]) ?? 0) + 1; counts.set(args[1], count);
    if (args[1] === "branch-9" && count === 2) f.branches.set("branch-9", null);
    return original(...args);
  });
  boundedSessions(f);
  const value = await drain(f, 30);
  expect(value.state).toBe("current");
  for (let i = 0; i < 20; i++) {
    expect(value.coverage[i].state).toBe("present");
    expect(value.coverage[i].source).toEqual(i === 9 ? { state: "unknown", reason: "source_branch_unavailable" } : { state: "verified" });
    expect(counts.get(`branch-${i}`)).toBe(2);
  }
});

it("requests bounded follow-up qualification after a branch moves to a new stable head", async () => {
  const f = fixture(); f.add(2, [1]); f.add(3, [2]); f.head(2); f.branches.set("main", sha(2));
  const original = vi.mocked(f.reader.compare).getMockImplementation()!;
  let changed = false;
  vi.mocked(f.reader.compare).mockImplementation(async (...args) => {
    const value = await original(...args);
    if (!changed) { changed = true; f.branches.set("main", sha(3)); }
    return value;
  });
  const first = await f.refresh();
  expect(first).toMatchObject({ state: "current", pendingWork: true, coverage: [{ state: "present", source: { state: "unknown", reason: "source_branch_changed" } }] });
  f.input.previous = first;
  const settled = await drain(f);
  expect(settled.pendingWork).toBeUndefined(); expect(settled.coverage[0]).toMatchObject({ state: "present", source: { state: "verified" } });
});
