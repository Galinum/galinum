import { createPrivateKey, sign } from "node:crypto";
import { z } from "zod";

export type GitHubRepository = {
  id: number;
  owner: string;
  name: string;
  description: string | null;
  defaultBranch: string;
  private: boolean;
  archived: boolean;
  disabled: boolean;
};
export type GitHubRepositoryScope = {
  installationId: number;
  repositoryId: number;
  owner: string;
  name: string;
};
export type GitHubBranchHead = { name: string; sha: string; protected: boolean };
export type GitHubCommit = { sha: string; message: string; parents: string[] };
export type GitHubDeployment = { id: number; sha: string; environment: string; createdAt: number };
export type GitHubDeploymentStatus = { id: number; environment: string; createdAt: number; state: "queued" | "pending" | "in_progress" | "success" | "failure" | "error" | "inactive" };
export type GitHubReadme =
  | { kind: "absent"; commitSha: string }
  | { kind: "present"; commitSha: string; path: string; text: string; completeness: GitHubCompleteness };
export type GitHubPullRequest = {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed" | "merged";
  draft: boolean;
  base: { repositoryId: number; ref: string; sha: string };
  head: { repositoryId: number | null; ref: string; sha: string };
  mergeCommitSha: string | null;
  updatedAt: string;
  mergedAt: string | null;
  changedFiles: number | null;
};
export type GitHubChangedFile = {
  path: string;
  previousPath: string | null;
  status: string;
  additions: number;
  deletions: number;
  patch: string | null;
  patchComplete: boolean;
};
export type GitHubIncompleteReason =
  | "page_budget" | "item_budget" | "github_file_limit" | "missing_patch"
  | "partial_patch" | "count_mismatch" | "divergent" | "behind" | "state_changed" | "github_commit_limit";
export type GitHubCompleteness =
  | { complete: true; reasons: [] }
  | { complete: false; reasons: GitHubIncompleteReason[] };
export type GitHubCollection<T> = {
  items: T[];
  totalCount: number | null;
  completeness: GitHubCompleteness;
};
export type GitHubPage<T> = { items: T[]; nextPage: number | null };
export interface GitHubShippingReader {
  readBranch(scope: GitHubRepositoryScope, branch: string): Promise<GitHubBranchHead>;
  listDeploymentPage(scope: GitHubRepositoryScope, page: number): Promise<GitHubPage<GitHubDeployment>>;
  listDeploymentStatusPage(scope: GitHubRepositoryScope, deploymentId: number, page: number): Promise<GitHubPage<GitHubDeploymentStatus>>;
  readCommit(scope: GitHubRepositoryScope, commitSha: string): Promise<GitHubCommit>;
  listPullRequestCommits(scope: GitHubRepositoryScope, number: number): Promise<{ pullRequest: GitHubPullRequest; commits: GitHubCollection<GitHubCommit> }>;
  listCommitPullRequests(scope: GitHubRepositoryScope, commitSha: string): Promise<GitHubCollection<GitHubPullRequest>>;
  compare(scope: GitHubRepositoryScope, before: string, after: string): Promise<GitHubComparison>;
}
export type GitHubInstallationInventory = {
  installationId: number;
  repositories: GitHubCollection<GitHubRepository>;
};
export type GitHubComparison = {
  before: string;
  after: string;
  mergeBaseSha: string;
  status: "ahead" | "behind" | "identical" | "diverged";
  aheadBy: number;
  behindBy: number;
  commits: GitHubCollection<{ sha: string; message: string }>;
  files: GitHubCollection<GitHubChangedFile>;
  completeness: GitHubCompleteness;
};
export type GitHubProviderErrorCode =
  | "invalid_input" | "invalid_response" | "authentication" | "access_denied"
  | "rate_limited" | "transient" | "http_error" | "timeout" | "response_limit" | "request_budget";
export class GitHubProviderError extends Error {
  constructor(readonly code: GitHubProviderErrorCode, readonly status?: number, readonly retryAfterMs?: number) {
    super(`GitHub provider: ${code}`);
    this.name = "GitHubProviderError";
  }
}

type ProviderOptions = {
  appId: number;
  clientId: string;
  privateKey: string;
  oauth?: { clientSecret: string; redirectUri: string };
  fetch?: typeof fetch;
  limits?: Partial<typeof defaultLimits>;
};
const defaultLimits = {
  timeoutMs: 10_000, operationTimeoutMs: 30_000, maxResponseBytes: 2_000_000,
  maxTotalBytes: 8_000_000, maxPages: 5, maxItems: 500, maxRequests: 32,
  maxReadmeBytes: 65_536,
};
const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const sha = z.string().regex(/^[a-f0-9]{40}$/i);
const segment = z.string().min(1).max(255).regex(/^[A-Za-z0-9_.-]+$/).refine(v => v !== "." && v !== "..");
const ref = z.string().min(1).max(1024).refine(v => !/[\x00-\x20\x7f\\?*\[~^:]/.test(v) && !v.includes("..") && !v.includes("@{") && !v.startsWith("/") && !v.endsWith("/") && !v.includes("//") && !v.split("/").some(part => part.startsWith(".")) && Buffer.from(v).toString() === v);
const scopeSchema = z.object({ installationId: id, repositoryId: id, owner: segment, name: segment });
const pageNumber = z.number().int().positive().max(Number.MAX_SAFE_INTEGER - 1);
export function isGitHubBranchName(value: unknown): value is string { return ref.safeParse(value).success; }
export function isGitHubRepositorySegment(value: unknown): value is string { return segment.safeParse(value).success; }
const token = z.string().min(1).max(16_384).regex(/^[A-Za-z0-9_.~+\/-]+=*$/);
const repositorySchema = z.object({
  id, owner: z.object({ login: segment }), name: segment, description: z.string().nullable(),
  default_branch: z.string().min(1), private: z.boolean(), archived: z.boolean(), disabled: z.boolean(),
});
const branchSchema = z.object({ name: ref, commit: z.object({ sha }), protected: z.boolean() });
const readmeSchema = z.object({
  type: z.literal("file"), encoding: z.literal("base64"), content: z.string(), size: count,
  path: z.string().min(1).max(4096).refine(v => !/[\x00-\x1f\x7f\\:]/.test(v) && v.split("/").every(part => part !== "" && part !== "." && part !== "..")),
  truncated: z.boolean().optional(),
});
const prSchema = z.object({
  id, number: id, title: z.string(), body: z.string().nullable(), state: z.enum(["open", "closed"]),
  draft: z.boolean(), merged: z.boolean().optional(), merged_at: z.iso.datetime({ offset: true }).nullable(),
  merge_commit_sha: sha.nullable(), updated_at: z.iso.datetime({ offset: true }), changed_files: count.optional(),
  base: z.object({ ref, sha, repo: z.object({ id }) }),
  head: z.object({ ref, sha, repo: z.object({ id }).nullable() }),
});
const fileSchema = z.object({
  filename: z.string().min(1), previous_filename: z.string().optional(), status: z.string().min(1),
  additions: count, deletions: count, patch: z.string().optional(),
});
const commitSchema = z.object({ sha, commit: z.object({ message: z.string() }) });
const fullCommitSchema = commitSchema.extend({ parents: z.array(z.object({ sha })).max(100) });
const gitCommitSchema = fullCommitSchema.omit({ commit: true }).extend({ message: z.string() });
const environment = z.string().min(1).max(255).refine(v => !/[\x00-\x1f\x7f]/.test(v) && Buffer.from(v).toString() === v);
const deploymentSchema = z.object({ id, sha, environment, created_at: z.iso.datetime({ offset: true }) });
const deploymentStatusSchema = z.object({ id, environment, created_at: z.iso.datetime({ offset: true }), state: z.enum(["queued", "pending", "in_progress", "success", "failure", "error", "inactive"]) });
const comparisonSchema = z.object({
  status: z.enum(["ahead", "behind", "identical", "diverged"]), ahead_by: count, behind_by: count,
  total_commits: count, base_commit: z.object({ sha }), merge_base_commit: z.object({ sha }),
  commits: z.array(commitSchema), files: z.array(fileSchema).optional(),
});
function parse<T>(schema: z.ZodType<T>, value: unknown, code: GitHubProviderErrorCode = "invalid_response"): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new GitHubProviderError(code);
  return result.data;
}
function completeness(reasons: GitHubIncompleteReason[]): GitHubCompleteness {
  return reasons.length ? { complete: false, reasons: [...new Set(reasons)] } : { complete: true, reasons: [] };
}
function repository(value: unknown): GitHubRepository {
  const r = parse(repositorySchema, value);
  return { id: r.id, owner: r.owner.login, name: r.name, description: r.description, defaultBranch: r.default_branch, private: r.private, archived: r.archived, disabled: r.disabled };
}
function fullCommit(value: unknown): GitHubCommit {
  const c = parse(fullCommitSchema, value);
  return { sha: c.sha.toLowerCase(), message: c.commit.message, parents: c.parents.map(p => p.sha.toLowerCase()) };
}
function deployment(value: unknown): GitHubDeployment {
  const d = parse(deploymentSchema, value);
  return { id: d.id, sha: d.sha.toLowerCase(), environment: d.environment, createdAt: Date.parse(d.created_at) };
}
function deploymentStatus(value: unknown): GitHubDeploymentStatus {
  const s = parse(deploymentStatusSchema, value);
  return { id: s.id, environment: s.environment, createdAt: Date.parse(s.created_at), state: s.state };
}
function pullRequest(value: unknown): GitHubPullRequest {
  const p = parse(prSchema, value);
  return {
    id: p.id, number: p.number, title: p.title, body: p.body,
    state: p.merged === true || p.merged_at !== null ? "merged" : p.state, draft: p.draft,
    base: { repositoryId: p.base.repo.id, ref: p.base.ref, sha: p.base.sha },
    head: { repositoryId: p.head.repo?.id ?? null, ref: p.head.ref, sha: p.head.sha },
    mergeCommitSha: p.merge_commit_sha, updatedAt: p.updated_at, mergedAt: p.merged_at,
    changedFiles: p.changed_files ?? null,
  };
}
function changedFile(value: unknown): GitHubChangedFile {
  const f = parse(fileSchema, value);
  const lines = f.patch?.split("\n") ?? [];
  const additions = lines.filter(line => line.startsWith("+")).length;
  const deletions = lines.filter(line => line.startsWith("-")).length;
  return {
    path: f.filename, previousPath: f.previous_filename ?? null, status: f.status,
    additions: f.additions, deletions: f.deletions, patch: f.patch ?? null,
    patchComplete: f.patch === undefined
      ? f.additions === 0 && f.deletions === 0
      : additions === f.additions && deletions === f.deletions,
  };
}
function fileCompleteness(files: GitHubChangedFile[], reasons: GitHubIncompleteReason[]): GitHubCompleteness {
  return completeness([...reasons, ...files.flatMap<GitHubIncompleteReason>(f => f.patchComplete ? [] : f.patch === null ? ["missing_patch"] : ["partial_patch"])]);
}

export function createGitHubProvider(options: ProviderOptions) {
  parse(id, options.appId, "invalid_input");
  parse(z.string().regex(/^[A-Za-z0-9_.-]+$/).max(255), options.clientId, "invalid_input");
  const appId = options.appId;
  const clientId = options.clientId;
  let key: ReturnType<typeof createPrivateKey>;
  try {
    key = createPrivateKey(options.privateKey);
    if (key.asymmetricKeyType !== "rsa") throw new Error();
  } catch { throw new GitHubProviderError("invalid_input"); }
  const oauth = options.oauth ? { ...options.oauth } : undefined;
  if (oauth) {
    parse(z.string().min(1).max(4096), oauth.clientSecret, "invalid_input");
    parse(z.string().url().max(2048), oauth.redirectUri, "invalid_input");
  }
  const limits = { ...defaultLimits, ...options.limits };
  for (const name of Object.keys(defaultLimits) as (keyof typeof defaultLimits)[]) {
    parse(z.number().int().min(1).max(defaultLimits[name]), limits[name], "invalid_input");
  }
  const fetcher = options.fetch ?? fetch;

  function operation() {
    const deadline = Date.now() + limits.operationTimeoutMs;
    let requests = 0;
    let totalBytes = 0;
    async function request(path: string, bearer: string | null, body?: object, oauthRequest = false): Promise<{ data: unknown; next: boolean }> {
      for (let attempt = 0; ; attempt++) {
        if (++requests > limits.maxRequests) throw new GitHubProviderError("request_budget");
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new GitHubProviderError("timeout");
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), Math.min(limits.timeoutMs, remaining));
        try {
          const response = await fetcher(oauthRequest ? "https://github.com/login/oauth/access_token" : `https://api.github.com${path}`, {
            method: body ? "POST" : "GET", redirect: "error", cache: "no-store", signal: controller.signal,
            headers: {
              Accept: oauthRequest ? "application/json" : "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10", "User-Agent": "Galinum-GitHub-Provider",
              ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
              ...(body ? { "Content-Type": "application/json" } : {}),
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
          });
          if (!response.ok) {
            await response.body?.cancel();
            if (!body && attempt === 0 && [502, 503, 504].includes(response.status)) {
              if (deadline - Date.now() <= 250) throw new GitHubProviderError("timeout");
              await new Promise(resolve => setTimeout(resolve, 250));
              continue;
            }
            const code = response.status === 429 || (response.status === 403 && (response.headers.has("retry-after") || response.headers.get("x-ratelimit-remaining") === "0"))
              ? "rate_limited" : response.status === 401 ? "authentication"
                : [403, 404].includes(response.status) ? "access_denied"
                  : response.status >= 500 ? "transient" : "http_error";
            const retrySeconds = Number(response.headers.get("retry-after"));
            const resetSeconds = Number(response.headers.get("x-ratelimit-reset"));
            const retryAfterMs = code === "rate_limited" ? Math.max(60_000,
              Number.isSafeInteger(retrySeconds) && retrySeconds > 0 && retrySeconds <= Number.MAX_SAFE_INTEGER / 1000 ? retrySeconds * 1000 : 0,
              Number.isSafeInteger(resetSeconds) && resetSeconds > 0 && resetSeconds <= Number.MAX_SAFE_INTEGER / 1000 ? resetSeconds * 1000 - Date.now() : 0,
            ) : undefined;
            throw new GitHubProviderError(code, response.status, retryAfterMs);
          }
          const declaredLength = Number(response.headers.get("content-length") ?? 0);
          if (declaredLength > limits.maxResponseBytes || declaredLength + totalBytes > limits.maxTotalBytes) {
            await response.body?.cancel();
            throw new GitHubProviderError("response_limit");
          }
          if (!response.body) throw new GitHubProviderError("invalid_response");
          const reader = response.body.getReader();
          const chunks: Uint8Array[] = [];
          let bytes = 0;
          try {
            for (;;) {
              const result = await reader.read();
              if (result.done) break;
              bytes += result.value.byteLength;
              totalBytes += result.value.byteLength;
              if (bytes > limits.maxResponseBytes || totalBytes > limits.maxTotalBytes) {
                await reader.cancel();
                throw new GitHubProviderError("response_limit");
              }
              chunks.push(result.value);
            }
          } finally { reader.releaseLock(); }
          let data: unknown;
          try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
          catch { throw new GitHubProviderError("invalid_response"); }
          return { data, next: /;\s*rel="?next"?(?:[,;\s]|$)/.test(response.headers.get("link") ?? "") };
        } catch (error) {
          if (error instanceof GitHubProviderError) throw error;
          throw new GitHubProviderError(controller.signal.aborted ? "timeout" : "transient");
        } finally { clearTimeout(timer); }
      }
    }
    async function installationToken(installationId: number, repositoryId?: number, deployments = false) {
      parse(id, installationId, "invalid_input");
      if (repositoryId !== undefined) parse(id, repositoryId, "invalid_input");
      const now = Math.floor(Date.now() / 1000);
      const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
      const claims = Buffer.from(JSON.stringify({ iss: clientId, iat: now - 60, exp: now + 540 })).toString("base64url");
      const unsigned = `${header}.${claims}`;
      let jwt: string;
      try { jwt = `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), key).toString("base64url")}`; }
      catch { throw new GitHubProviderError("authentication"); }
      const response = await request(`/app/installations/${installationId}/access_tokens`, jwt, {
        ...(repositoryId === undefined ? {} : { repository_ids: [repositoryId] }),
        permissions: repositoryId === undefined ? { metadata: "read" } : { metadata: "read", contents: "read", pull_requests: "read", ...(deployments ? { deployments: "read" } : {}) },
      }).catch(error => {
        if (deployments && repositoryId !== undefined && error instanceof GitHubProviderError && error.status === 422) throw new GitHubProviderError("access_denied", 422);
        throw error;
      });
      const result = parse(z.object({ token, expires_at: z.string().datetime() }), response.data);
      if (Date.parse(result.expires_at) <= Date.now()) throw new GitHubProviderError("authentication");
      return result.token;
    }
    async function collection<T extends { id: number } | { sha: string } | GitHubChangedFile>(path: string, bearer: string, normalize: (v: unknown) => T, field?: "repositories" | "installations"): Promise<GitHubCollection<T>> {
      const items: T[] = [];
      let totalCount: number | null = null;
      const reasons: GitHubIncompleteReason[] = [];
      for (let page = 1; page <= limits.maxPages; page++) {
        const response = await request(`${path}?per_page=100&page=${page}`, bearer);
        const envelope = field ? parse(z.object({ total_count: count, [field]: z.array(z.unknown()) }), response.data) : null;
        const values = parse(z.array(z.unknown()).max(100), envelope ? envelope[field!] : response.data);
        if (envelope) {
          const nextTotal = parse(count, envelope.total_count);
          if (totalCount !== null && totalCount !== nextTotal) reasons.push("count_mismatch");
          totalCount = nextTotal;
        }
        const available = limits.maxItems - items.length;
        items.push(...values.slice(0, available).map(normalize));
        const more = response.next || (totalCount !== null ? items.length < totalCount : values.length === 100);
        if (values.length > available || (items.length >= limits.maxItems && more)) { reasons.push("item_budget"); break; }
        if (!more) break;
        if (values.length === 0) { reasons.push("count_mismatch"); break; }
        if (page === limits.maxPages) reasons.push("page_budget");
      }
      if (totalCount !== null && totalCount !== items.length) reasons.push("count_mismatch");
      if (new Set(items.map(item => "id" in item ? item.id : "sha" in item ? item.sha : item.path)).size !== items.length) reasons.push("count_mismatch");
      return { items, totalCount, completeness: completeness(reasons) };
    }
    async function page<T extends { id: number }>(path: string, bearer: string, number: number, normalize: (value: unknown) => T): Promise<GitHubPage<T>> {
      const response = await request(`${path}?per_page=100&page=${number}`, bearer);
      const items = parse(z.array(z.unknown()).max(100), response.data).map(normalize);
      if (items.length > limits.maxItems) throw new GitHubProviderError("request_budget");
      if (new Set(items.map(item => item.id)).size !== items.length || (!items.length && response.next)) throw new GitHubProviderError("invalid_response");
      return { items, nextPage: response.next || items.length === 100 ? number + 1 : null };
    }
    async function scoped(scope: GitHubRepositoryScope, deployments = false) {
      const s = parse(scopeSchema, scope, "invalid_input");
      const bearer = await installationToken(s.installationId, s.repositoryId, deployments);
      const path = `/repos/${encodeURIComponent(s.owner)}/${encodeURIComponent(s.name)}`;
      const repo = repository((await request(path, bearer)).data);
      if (repo.id !== s.repositoryId) throw new GitHubProviderError("access_denied");
      return { bearer, path, repository: repo };
    }
    return { request, installationToken, collection, scoped, page };
  }

  function repositoryReader(makeOperation: () => ReturnType<typeof operation>) {
    return {
      async readBranch(scope: GitHubRepositoryScope, branch: string): Promise<GitHubBranchHead> {
        parse(ref, branch, "invalid_input");
        const op = makeOperation();
        const s = await op.scoped(scope);
        const value = parse(branchSchema, (await op.request(`${s.path}/branches/${encodeURIComponent(branch)}`, s.bearer)).data);
        if (value.name !== branch) throw new GitHubProviderError("invalid_response");
        return { name: value.name, sha: value.commit.sha.toLowerCase(), protected: value.protected };
      },
      async listDeploymentPage(scope: GitHubRepositoryScope, page: number): Promise<GitHubPage<GitHubDeployment>> {
        parse(pageNumber, page, "invalid_input");
        const op = makeOperation();
        const s = await op.scoped(scope, true);
        return op.page(`${s.path}/deployments`, s.bearer, page, deployment);
      },
      async listDeploymentStatusPage(scope: GitHubRepositoryScope, deploymentId: number, page: number): Promise<GitHubPage<GitHubDeploymentStatus>> {
        parse(id, deploymentId, "invalid_input");
        parse(pageNumber, page, "invalid_input");
        const op = makeOperation();
        const s = await op.scoped(scope, true);
        return op.page(`${s.path}/deployments/${deploymentId}/statuses`, s.bearer, page, deploymentStatus);
      },
      async listDeployments(scope: GitHubRepositoryScope): Promise<GitHubCollection<GitHubDeployment>> {
        const op = makeOperation();
        const s = await op.scoped(scope, true);
        return op.collection(`${s.path}/deployments`, s.bearer, deployment);
      },
      async listDeploymentStatuses(scope: GitHubRepositoryScope, deploymentId: number): Promise<GitHubCollection<GitHubDeploymentStatus>> {
        parse(id, deploymentId, "invalid_input");
        const op = makeOperation();
        const s = await op.scoped(scope, true);
        return op.collection(`${s.path}/deployments/${deploymentId}/statuses`, s.bearer, deploymentStatus);
      },
      async readCommit(scope: GitHubRepositoryScope, commitSha: string): Promise<GitHubCommit> {
        parse(sha, commitSha, "invalid_input");
        const op = makeOperation();
        const s = await op.scoped(scope);
        const commit = parse(gitCommitSchema, (await op.request(`${s.path}/git/commits/${encodeURIComponent(commitSha)}`, s.bearer)).data);
        if (commit.sha.toLowerCase() !== commitSha.toLowerCase()) throw new GitHubProviderError("invalid_response");
        return { sha: commit.sha.toLowerCase(), message: commit.message, parents: commit.parents.map(parent => parent.sha.toLowerCase()) };
      },
      async listPullRequestCommits(scope: GitHubRepositoryScope, number: number): Promise<{ pullRequest: GitHubPullRequest; commits: GitHubCollection<GitHubCommit> }> {
        parse(id, number, "invalid_input");
        const op = makeOperation();
        const s = await op.scoped(scope);
        const path = `${s.path}/pulls/${number}`;
        const before = parse(prSchema.extend({ commits: count }), (await op.request(path, s.bearer)).data);
        if (before.number !== number || before.base.repo.id !== scope.repositoryId) throw new GitHubProviderError("invalid_response");
        const commits = await op.collection(`${path}/commits`, s.bearer, fullCommit);
        const after = parse(prSchema.extend({ commits: count }), (await op.request(path, s.bearer)).data);
        const reasons = [...commits.completeness.reasons];
        if (JSON.stringify(before) !== JSON.stringify(after)) reasons.push("state_changed");
        if (before.commits !== commits.items.length) reasons.push("count_mismatch");
        if (before.commits >= 250) reasons.push("github_commit_limit");
        return { pullRequest: pullRequest(before), commits: { ...commits, totalCount: before.commits, completeness: completeness(reasons) } };
      },
      async readPullRequest(scope: GitHubRepositoryScope, number: number): Promise<GitHubPullRequest> {
        parse(id, number, "invalid_input");
        const op = makeOperation();
        const s = await op.scoped(scope);
        const pr = pullRequest((await op.request(`${s.path}/pulls/${number}`, s.bearer)).data);
        if (pr.number !== number || pr.base.repositoryId !== scope.repositoryId) throw new GitHubProviderError("invalid_response");
        return pr;
      },
      async compare(scope: GitHubRepositoryScope, before: string, after: string): Promise<GitHubComparison> {
        parse(sha, before, "invalid_input");
        parse(sha, after, "invalid_input");
        const op = makeOperation();
        const s = await op.scoped(scope);
        const commits: GitHubComparison["commits"]["items"] = [];
        let first: z.infer<typeof comparisonSchema> | undefined;
        const reasons: GitHubIncompleteReason[] = [];
        for (let page = 1; page <= limits.maxPages; page++) {
          const response = await op.request(`${s.path}/compare/${encodeURIComponent(before)}...${encodeURIComponent(after)}?per_page=100&page=${page}`, s.bearer);
          const result = parse(comparisonSchema, response.data);
          if (result.commits.length > 100 || result.base_commit.sha.toLowerCase() !== before.toLowerCase()) throw new GitHubProviderError("invalid_response");
          first ??= result;
          if (result.total_commits !== first.total_commits || result.status !== first.status || result.merge_base_commit.sha !== first.merge_base_commit.sha) reasons.push("state_changed");
          const available = limits.maxItems - commits.length;
          commits.push(...result.commits.slice(0, available).map(c => ({ sha: c.sha, message: c.commit.message })));
          const more = response.next || commits.length < first.total_commits;
          if (result.commits.length > available || (commits.length >= limits.maxItems && more)) { reasons.push("item_budget"); break; }
          if (!more) break;
          if (!result.commits.length) { reasons.push("count_mismatch"); break; }
          if (page === limits.maxPages) reasons.push("page_budget");
        }
        if (!first) throw new GitHubProviderError("invalid_response");
        if (commits.length !== first.total_commits || new Set(commits.map(c => c.sha)).size !== commits.length) reasons.push("count_mismatch");
        const fileReasons: GitHubIncompleteReason[] = [];
        if (!first.files) fileReasons.push("count_mismatch");
        if ((first.files?.length ?? 0) >= 300) fileReasons.push("github_file_limit");
        if ((first.files?.length ?? 0) > limits.maxItems) fileReasons.push("item_budget");
        const files = (first.files ?? []).slice(0, limits.maxItems).map(changedFile);
        if (new Set(files.map(f => f.path)).size !== files.length) fileReasons.push("count_mismatch");
        const fileStatus = fileCompleteness(files, fileReasons);
        const relation: GitHubIncompleteReason[] = first.status === "diverged" ? ["divergent"] : first.status === "behind" ? ["behind"] : [];
        return {
          before, after, mergeBaseSha: first.merge_base_commit.sha, status: first.status, aheadBy: first.ahead_by, behindBy: first.behind_by,
          commits: { items: commits, totalCount: first.total_commits, completeness: completeness(reasons) },
          files: { items: files, totalCount: null, completeness: fileStatus },
          completeness: completeness([...reasons, ...fileStatus.reasons, ...relation]),
        };
      },
      async listCommitPullRequests(scope: GitHubRepositoryScope, commitSha: string): Promise<GitHubCollection<GitHubPullRequest>> {
        parse(sha, commitSha, "invalid_input");
        const op = makeOperation();
        const s = await op.scoped(scope);
        return op.collection(`${s.path}/commits/${encodeURIComponent(commitSha)}/pulls`, s.bearer, value => {
          const pr = pullRequest(value);
          if (pr.base.repositoryId !== scope.repositoryId) throw new GitHubProviderError("invalid_response");
          return pr;
        });
      },
    };
  }

  return {
    ...repositoryReader(operation),
    shippingSession(): GitHubShippingReader {
      const op = operation();
      let identity: string | null = null;
      let prepared: ReturnType<typeof op.scoped> | null = null;
      const shared = { ...op, async scoped(scope: GitHubRepositoryScope) {
        const value = parse(scopeSchema, scope, "invalid_input");
        const key = JSON.stringify(value);
        if (identity !== null && identity !== key) throw new GitHubProviderError("access_denied");
        identity = key;
        prepared ??= op.scoped(value, true);
        return prepared;
      } };
      const reader = repositoryReader(() => shared);
      return Object.freeze({
        listDeploymentPage: reader.listDeploymentPage, listDeploymentStatusPage: reader.listDeploymentStatusPage,
        readBranch: reader.readBranch, readCommit: reader.readCommit, compare: reader.compare,
        listPullRequestCommits: reader.listPullRequestCommits, listCommitPullRequests: reader.listCommitPullRequests,
      });
    },
    async listInstallationRepositories(installationId: number): Promise<GitHubInstallationInventory> {
      const op = operation();
      const bearer = await op.installationToken(installationId);
      return { installationId, repositories: await op.collection("/installation/repositories", bearer, repository, "repositories") };
    },
    async verifyInstaller(input: { code: string; codeVerifier: string; installationId: number }): Promise<GitHubInstallationInventory & { user: { id: number; login: string } }> {
      if (!oauth) throw new GitHubProviderError("invalid_input");
      const value = parse(z.object({ code: z.string().min(1).max(1024), codeVerifier: z.string().regex(/^[A-Za-z0-9_.~-]{43,128}$/), installationId: id }), input, "invalid_input");
      const op = operation();
      const exchanged = await op.request("", null, { client_id: clientId, client_secret: oauth.clientSecret, code: value.code, redirect_uri: oauth.redirectUri, code_verifier: value.codeVerifier }, true);
      const auth = parse(z.object({ access_token: token, token_type: z.literal("bearer") }), exchanged.data, "authentication");
      const user = parse(z.object({ id, login: segment }), (await op.request("/user", auth.access_token)).data);
      const installations = await op.collection("/user/installations", auth.access_token, v => parse(z.object({ id, app_id: id, suspended_at: z.string().nullable() }), v), "installations");
      const installation = installations.items.find(i => i.id === value.installationId && i.app_id === appId && i.suspended_at === null);
      if (!installation) throw new GitHubProviderError(installations.completeness.complete ? "access_denied" : "request_budget");
      const repositories = await op.collection(`/user/installations/${installation.id}/repositories`, auth.access_token, repository, "repositories");
      return { user, installationId: installation.id, repositories };
    },
    async readRepositoryBranch(scope: GitHubRepositoryScope, branch: string): Promise<{ repository: GitHubRepository; branch: GitHubBranchHead }> {
      parse(ref, branch, "invalid_input");
      const op = operation();
      const s = await op.scoped(scope);
      const b = parse(branchSchema, (await op.request(`${s.path}/branches/${encodeURIComponent(branch)}`, s.bearer)).data);
      if (b.name !== branch) throw new GitHubProviderError("invalid_response");
      return { repository: s.repository, branch: { name: b.name, sha: b.commit.sha, protected: b.protected } };
    },
    async readRepositoryReadme(scope: GitHubRepositoryScope, immutableCommitSha: string): Promise<GitHubReadme> {
      parse(sha, immutableCommitSha, "invalid_input");
      const op = operation();
      const s = await op.scoped(scope);
      let data: unknown;
      try {
        data = (await op.request(`${s.path}/readme?ref=${encodeURIComponent(immutableCommitSha)}`, s.bearer)).data;
      } catch (error) {
        if (error instanceof GitHubProviderError && error.status === 404) return { kind: "absent", commitSha: immutableCommitSha };
        throw error;
      }
      const readme = parse(readmeSchema, data);
      if (readme.size > limits.maxReadmeBytes) throw new GitHubProviderError("response_limit");
      if (readme.truncated === true) throw new GitHubProviderError("invalid_response");
      const encoded = readme.content.replace(/[\r\n]/g, "");
      if (encoded.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(encoded)) throw new GitHubProviderError("invalid_response");
      if (Buffer.byteLength(encoded, "base64") > limits.maxReadmeBytes) throw new GitHubProviderError("response_limit");
      const decoded = Buffer.from(encoded, "base64");
      if (decoded.length !== readme.size || decoded.toString("base64") !== encoded) throw new GitHubProviderError("invalid_response");
      let text: string;
      try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(decoded); }
      catch { throw new GitHubProviderError("invalid_response"); }
      if (text.includes("\0")) throw new GitHubProviderError("invalid_response");
      return { kind: "present", commitSha: immutableCommitSha, path: readme.path, text, completeness: completeness([]) };
    },
    async listPullRequestFiles(scope: GitHubRepositoryScope, number: number): Promise<{ pullRequest: GitHubPullRequest; files: GitHubCollection<GitHubChangedFile> }> {
      parse(id, number, "invalid_input");
      const op = operation();
      const s = await op.scoped(scope);
      const path = `${s.path}/pulls/${number}`;
      const before = pullRequest((await op.request(path, s.bearer)).data);
      if (before.number !== number || before.base.repositoryId !== scope.repositoryId) throw new GitHubProviderError("invalid_response");
      const files = await op.collection(`${path}/files`, s.bearer, changedFile);
      const after = pullRequest((await op.request(path, s.bearer)).data);
      const reasons = [...files.completeness.reasons];
      if (JSON.stringify(before) !== JSON.stringify(after)) reasons.push("state_changed");
      if (before.changedFiles === null || before.changedFiles !== files.items.length || new Set(files.items.map(f => f.path)).size !== files.items.length) reasons.push("count_mismatch");
      if (before.changedFiles !== null && before.changedFiles >= 3000) reasons.push("github_file_limit");
      return { pullRequest: before, files: { ...files, totalCount: before.changedFiles, completeness: fileCompleteness(files.items, reasons) } };
    },

  };
}

export type GitHubProvider = ReturnType<typeof createGitHubProvider>;
