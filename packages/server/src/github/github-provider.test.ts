import { generateKeyPairSync, verify } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGitHubProvider, GitHubProviderError, isGitHubBranchName, isGitHubRepositorySegment } from "./github-provider.js";

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const before = "a".repeat(40);
const after = "b".repeat(40);
const scope = { installationId: 7, repositoryId: 12, owner: "owner", name: "repo" };
const repo = { id: 12, owner: { login: "owner" }, name: "repo", description: "Product communications", default_branch: "main", private: true, archived: false, disabled: false };
const pr = {
  id: 21, number: 3, title: "Feature", body: null, state: "open", draft: false, merged_at: null,
  merge_commit_sha: null, updated_at: "2026-01-01T00:00:00Z", changed_files: 1,
  base: { ref: "main", sha: before, repo: { id: 12 } }, head: { ref: "feature/topic", sha: after, repo: { id: 14 } },
};
const file = { filename: "src/a.ts", status: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-old\n+new" };
const compare = {
  status: "ahead", ahead_by: 1, behind_by: 0, total_commits: 1,
  base_commit: { sha: before }, merge_base_commit: { sha: before },
  commits: [{ sha: after, commit: { message: "feature" } }], files: [file],
};
const installation = { id: 7, app_id: 9, suspended_at: null };
function json(data: unknown, headers?: HeadersInit) { return new Response(JSON.stringify(data), { headers }); }
function auth() { return json({ token: "ghs_installation_secret", expires_at: "2099-01-01T00:00:00Z" }); }
type Reply = Response | ((url: URL, init: RequestInit) => Response | Promise<Response>);
function fixture(replies: Reply[], limits?: Parameters<typeof createGitHubProvider>[0]["limits"]) {
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    expect(["https://api.github.com", "https://github.com"]).toContain(url.origin);
    expect(init?.redirect).toBe("error");
    expect(init?.cache).toBe("no-store");
    expect(new Headers(init?.headers).get("X-GitHub-Api-Version")).toBe("2026-03-10");
    const reply = replies.shift();
    if (!reply) throw new Error("unexpected request");
    return typeof reply === "function" ? reply(url, init ?? {}) : reply;
  });
  const provider = createGitHubProvider({ appId: 9, clientId: "Iv.client", privateKey, fetch: fetcher, limits,
    oauth: { clientSecret: "oauth_client_secret", redirectUri: "https://galinum.test/github/callback" } });
  return { provider, fetcher, replies };
}
function scoped(...replies: Reply[]) { return fixture([auth(), json(repo), ...replies]); }
const installerInput = { code: "authorization_code", codeVerifier: "v".repeat(43), installationId: 7 };
const oauthToken = () => json({ access_token: "ghu_user_secret", token_type: "bearer", refresh_token: "ghr_refresh_secret" });
const user = () => json({ id: 4, login: "person", token: "do_not_export" });
afterEach(() => vi.useRealTimers());

describe("GitHub provider authentication and domain boundary", () => {
  it("signs an RS256 App JWT, narrows token permissions and repository, then uses the installation token", async () => {
    const { provider, fetcher } = fixture([
      (url, init) => {
        expect(url.href).toBe("https://api.github.com/app/installations/7/access_tokens");
        expect(init.method).toBe("POST");
        expect(JSON.parse(String(init.body))).toEqual({ repository_ids: [12], permissions: { metadata: "read", contents: "read", pull_requests: "read" } });
        const jwt = new Headers(init.headers).get("Authorization")!.slice(7);
        const [header, payload, signature] = jwt.split(".");
        expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
        const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
        expect(claims.iss).toBe("Iv.client");
        expect(claims.iat).toBeGreaterThanOrEqual(Math.floor(Date.now() / 1000) - 61);
        expect(claims.exp - claims.iat).toBe(600);
        expect(verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), keys.publicKey, Buffer.from(signature, "base64url"))).toBe(true);
        return auth();
      }, json({ ...repo, token: "must_not_export", url: "https://evil.test" }),
      (url, init) => {
        expect(url.pathname).toBe("/repos/owner/repo/branches/feature%2Ftopic");
        expect(new Headers(init.headers).get("Authorization")).toBe("Bearer ghs_installation_secret");
        return json({ name: "feature/topic", commit: { sha: after, url: "https://evil.test" }, protected: true });
      },
    ]);
    expect(await provider.readRepositoryBranch(scope, "feature/topic")).toEqual({
      repository: { id: 12, owner: "owner", name: "repo", description: "Product communications", defaultBranch: "main", private: true, archived: false, disabled: false },
      branch: { name: "feature/topic", sha: after, protected: true },
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(provider)).toBe("{}");
  });

  it("uses metadata-only installation inventory and strips transport fields", async () => {
    const { provider } = fixture([(url, init) => {
      expect(JSON.parse(String(init.body))).toEqual({ permissions: { metadata: "read" } });
      return auth();
    }, json({ total_count: 1, repositories: [repo] })]);
    const result = await provider.listInstallationRepositories(7);
    expect(result.installationId).toBe(7);
    expect(result.repositories.completeness.complete).toBe(true);
    expect(result.repositories.items[0].id).toBe(12);
  });

  it.each(["..", ".", "https://evil.test", "a/b", "a?b", "%2e%2e", "a\\b"])("rejects unsafe repository segment %s before transport", async name => {
    const { provider, fetcher } = fixture([]);
    await expect(provider.readRepositoryBranch({ ...scope, name }, "main")).rejects.toMatchObject({ code: "invalid_input" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([".", "../main", "a/../../b", "https://evil.test", "a?b", "/main", "\ud800"])("rejects unsafe branch %s before transport", async branch => {
    const { provider, fetcher } = fixture([]);
    await expect(provider.readRepositoryBranch(scope, branch)).rejects.toMatchObject({ code: "invalid_input" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not accept a different repository identity", async () => {
    const { provider, fetcher } = fixture([auth(), json({ ...repo, id: 99 })]);
    await expect(provider.readPullRequest(scope, 3)).rejects.toMatchObject({ code: "access_denied" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid configuration without exposing key material", () => {
    expect(() => createGitHubProvider({ appId: 9, clientId: "client", privateKey: "private_key_secret" })).toThrow("GitHub provider: invalid_input");
    expect(() => fixture([], { maxPages: 999 })).toThrow("GitHub provider: invalid_input");
  });
});

describe("OAuth installer verification", () => {
  it("exchanges code and PKCE at the fixed origin, verifies user installation and returns no credentials", async () => {
    const { provider, fetcher } = fixture([
      (url, init) => {
        expect(url.href).toBe("https://github.com/login/oauth/access_token");
        expect(init.method).toBe("POST");
        expect(new Headers(init.headers).has("Authorization")).toBe(false);
        expect(JSON.parse(String(init.body))).toEqual({ client_id: "Iv.client", client_secret: "oauth_client_secret", code: "authorization_code", redirect_uri: "https://galinum.test/github/callback", code_verifier: "v".repeat(43) });
        return oauthToken();
      }, user(), json({ total_count: 1, installations: [installation] }),
      (url, init) => {
        expect(url.href).toBe("https://api.github.com/user/installations/7/repositories?per_page=100&page=1");
        expect(new Headers(init.headers).get("Authorization")).toBe("Bearer ghu_user_secret");
        return json({ total_count: 1, repositories: [repo] });
      },
    ]);
    const result = await provider.verifyInstaller(installerInput);
    expect(result.user).toEqual({ id: 4, login: "person" });
    expect(result.repositories.completeness.complete).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/secret|token|authorization_code/);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it.each([{ ...installation, app_id: 99 }, { ...installation, suspended_at: "2026-01-01T00:00:00Z" }, { ...installation, id: 99 }])("denies an unverified or suspended installation", async value => {
    const { provider, fetcher } = fixture([oauthToken(), user(), json({ total_count: 1, installations: [value] })]);
    await expect(provider.verifyInstaller(installerInput)).rejects.toMatchObject({ code: "access_denied" });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("reports a bounded lookup as unverified when the selected installation was not reached", async () => {
    const { provider } = fixture([oauthToken(), user(), json({ total_count: 2, installations: [{ ...installation, id: 99 }] })], { maxPages: 1 });
    await expect(provider.verifyInstaller(installerInput)).rejects.toMatchObject({ code: "request_budget" });
  });

  it("sanitizes OAuth error payload and does not retry code exchange", async () => {
    const { provider, fetcher } = fixture([json({ error: "bad_verification_code", error_description: "ghu_user_secret" })]);
    await expect(provider.verifyInstaller(installerInput)).rejects.toMatchObject({ code: "authentication", message: "GitHub provider: authentication" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("bounded evidence", () => {
  it("preserves the baseline and returns normalized commits and changed files", async () => {
    const { provider, fetcher } = scoped(json(compare));
    const result = await provider.compare(scope, before, after);
    expect(result).toMatchObject({ before, after, status: "ahead", mergeBaseSha: before, completeness: { complete: true } });
    expect(result.commits.items).toEqual([{ sha: after, message: "feature" }]);
    expect(result.files.items[0]).toMatchObject({ path: "src/a.ts", previousPath: null, patchComplete: true });
    expect(String(fetcher.mock.calls[2][0])).toBe(`https://api.github.com/repos/owner/repo/compare/${before}...${after}?per_page=100&page=1`);
  });

  it.each([["diverged", "divergent"], ["behind", "behind"]])("makes %s comparisons explicit without changing before", async (status, reason) => {
    const { provider } = scoped(json({ ...compare, status, merge_base_commit: { sha: "c".repeat(40) } }));
    const result = await provider.compare(scope, before, after);
    expect(result.before).toBe(before);
    expect(result.completeness).toEqual({ complete: false, reasons: [reason] });
  });

  it("allows an identical empty comparison", async () => {
    const { provider } = scoped(json({ ...compare, status: "identical", ahead_by: 0, total_commits: 0, commits: [], files: [] }));
    expect((await provider.compare(scope, before, before)).completeness.complete).toBe(true);
  });

  it.each([
    [{ ...file, patch: undefined }, "missing_patch"],
    [{ ...file, patch: "@@ -1 +1 @@\n+new" }, "partial_patch"],
  ])("does not claim missing or truncated patch evidence is complete", async (value, reason) => {
    const { provider } = scoped(json({ ...compare, files: [value] }));
    const result = await provider.compare(scope, before, after);
    expect(result.files.items[0].patchComplete).toBe(false);
    expect(result.completeness.reasons).toContain(reason);
  });

  it("flags the 300-file compare cap even without a pagination link", async () => {
    const { provider } = scoped(json({ ...compare, files: Array.from({ length: 300 }, (_, i) => ({ ...file, filename: `${i}.ts` })) }));
    const result = await provider.compare(scope, before, after);
    expect(result.files.items).toHaveLength(300);
    expect(result.completeness.reasons).toContain("github_file_limit");
  });

  it.each([
    { filename: "logo/favicon.png", status: "added", additions: 0, deletions: 0 },
    { filename: "src/new.ts", previous_filename: "src/old.ts", status: "renamed", additions: 0, deletions: 0 },
  ])("accepts complete file metadata when GitHub reports no text changes %j", async (metadata) => {
    const { provider } = scoped(json({ ...compare, files: [file, metadata] }));
    const result = await provider.compare(scope, before, after);
    expect(result.files.items[1]).toMatchObject({ patch: null, patchComplete: true });
    expect(result.completeness.complete).toBe(true);
  });

  it("does not mistake missing file inventory for an empty diff", async () => {
    const { provider } = scoped(json({ ...compare, files: undefined }));
    expect((await provider.compare(scope, before, after)).completeness.reasons).toContain("count_mismatch");
  });

  it("paginates commits from a fixed path and keeps first-page files", async () => {
    const { provider, fetcher } = scoped(
      json({ ...compare, total_commits: 2 }, { Link: '<https://evil.test/steal>; rel="next"' }),
      json({ ...compare, total_commits: 2, commits: [{ sha: "c".repeat(40), commit: { message: "second" } }], files: undefined }),
    );
    const result = await provider.compare(scope, before, after);
    expect(result.commits.items).toHaveLength(2);
    expect(result.files.items).toHaveLength(1);
    expect(result.completeness.complete).toBe(true);
    expect(String(fetcher.mock.calls[3][0])).toBe(`https://api.github.com/repos/owner/repo/compare/${before}...${after}?per_page=100&page=2`);
  });

  it("exposes comparison page and item budgets", async () => {
    for (const limits of [{ maxPages: 1 }, { maxItems: 1 }]) {
      const { provider } = fixture([auth(), json(repo), json({ ...compare, total_commits: 2 })], limits);
      const result = await provider.compare(scope, before, after);
      expect(result.completeness.complete).toBe(false);
      expect(result.commits.items).toHaveLength(1);
      expect(result.completeness.reasons).toContain("count_mismatch");
      expect(result.completeness.reasons).toContain("maxPages" in limits ? "page_budget" : "item_budget");
    }
  });

  it("normalizes merged PR state and a deleted fork", async () => {
    const { provider } = scoped(json({ ...pr, state: "closed", merged: true, merged_at: "2026-01-01T01:00:00Z", head: { ...pr.head, repo: null } }));
    expect(await provider.readPullRequest(scope, 3)).toMatchObject({ state: "merged", head: { repositoryId: null } });
  });

  it.each([
    { updated_at: "yesterday" },
    { updated_at: "2026-02-30T00:00:00Z" },
    { merged_at: "unknown" },
  ])("rejects unusable PR lifecycle timestamps %j", async (timestamps) => {
    const { provider } = scoped(json({ ...pr, ...timestamps }));
    await expect(provider.readPullRequest(scope, 3)).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("reads PR files with before and after state checks", async () => {
    const { provider } = scoped(json(pr), json([{ ...file, status: "renamed", previous_filename: "src/old.ts" }]), json(pr));
    const result = await provider.listPullRequestFiles(scope, 3);
    expect(result.files.completeness.complete).toBe(true);
    expect(result.files.items[0].previousPath).toBe("src/old.ts");
  });

  it("marks a PR head change during file enumeration as incomplete", async () => {
    const { provider } = scoped(json(pr), json([file]), json({ ...pr, head: { ...pr.head, sha: "c".repeat(40) } }));
    const result = await provider.listPullRequestFiles(scope, 3);
    expect(result.files.completeness.reasons).toContain("state_changed");
    expect(result.pullRequest.head.sha).toBe(after);
  });

  it("marks provider PR file truncation as incomplete", async () => {
    const p = { ...pr, changed_files: 3001 };
    const { provider } = scoped(json(p), json([file]), json(p));
    const result = await provider.listPullRequestFiles(scope, 3);
    expect(result.files.completeness.reasons).toEqual(["count_mismatch", "github_file_limit"]);
  });

  it("lists commit-associated PRs through the bounded normalized collection", async () => {
    const { provider, fetcher } = scoped(json([pr]));
    const result = await provider.listCommitPullRequests(scope, after);
    expect(result.items[0]).toMatchObject({ number: 3, state: "open" });
    expect(result.completeness.complete).toBe(true);
    expect(String(fetcher.mock.calls[2][0])).toBe(`https://api.github.com/repos/owner/repo/commits/${after}/pulls?per_page=100&page=1`);
  });

  it("reports installation inventory truncation and rejects oversize pages", async () => {
    const f = fixture([auth(), json({ total_count: 2, repositories: [repo] })], { maxPages: 1 });
    expect((await f.provider.listInstallationRepositories(7)).repositories.completeness.reasons).toEqual(["page_budget", "count_mismatch"]);
    const g = fixture([auth(), json({ total_count: 101, repositories: Array(101).fill(repo) })]);
    await expect(g.provider.listInstallationRepositories(7)).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("rejects an inconsistent baseline and invalid immutable comparison input", async () => {
    const f = scoped(json({ ...compare, base_commit: { sha: after } }));
    await expect(f.provider.compare(scope, before, after)).rejects.toMatchObject({ code: "invalid_response" });
    const g = fixture([]);
    await expect(g.provider.compare(scope, "main", after)).rejects.toMatchObject({ code: "invalid_input" });
    expect(g.fetcher).not.toHaveBeenCalled();
  });

  it("detects duplicate inventory entries and changing totals across pages", async () => {
    const { provider } = fixture([auth(), json({ total_count: 2, repositories: [repo] }), json({ total_count: 1, repositories: [repo] })]);
    const result = await provider.listInstallationRepositories(7);
    expect(result.repositories.completeness.reasons).toContain("count_mismatch");
  });

  it("reports changed comparison metadata and duplicated commit evidence", async () => {
    const { provider } = scoped(json({ ...compare, total_commits: 2 }), json({ ...compare, total_commits: 2, status: "diverged" }));
    const result = await provider.compare(scope, before, after);
    expect(result.completeness.reasons).toEqual(["state_changed", "count_mismatch"]);
  });
});

describe("transport budgets and safe failures", () => {
  it.each([401, 403, 404, 429])("does not retry denied or rate-limited reads (%i) or leak their body", async status => {
    const { provider, fetcher } = scoped(new Response("ghs_installation_secret", { status }));
    await expect(provider.readPullRequest(scope, 3)).rejects.toMatchObject({ status, message: `GitHub provider: ${status === 429 ? "rate_limited" : status === 401 ? "authentication" : "access_denied"}` });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("recognizes secondary rate limiting without immediate retries", async () => {
    const { provider, fetcher } = scoped(new Response("secret", { status: 403, headers: { "retry-after": "120" } }));
    await expect(provider.readPullRequest(scope, 3)).rejects.toMatchObject({ code: "rate_limited", retryAfterMs: 120_000 });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("retries transient GET once then succeeds", async () => {
    const { provider, fetcher } = scoped(new Response("secret", { status: 503 }), json(pr));
    expect((await provider.readPullRequest(scope, 3)).number).toBe(3);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("bounds repeated transient failures and never retries token minting", async () => {
    const f = scoped(new Response("secret", { status: 502 }), new Response("secret", { status: 502 }));
    await expect(f.provider.readPullRequest(scope, 3)).rejects.toMatchObject({ code: "transient" });
    expect(f.fetcher).toHaveBeenCalledTimes(4);
    const g = fixture([new Response("secret", { status: 503 })]);
    await expect(g.provider.listInstallationRepositories(7)).rejects.toMatchObject({ code: "transient" });
    expect(g.fetcher).toHaveBeenCalledTimes(1);
  });

  it("returns denied token scope without retrying or reading a repository", async () => {
    const { provider, fetcher } = fixture([new Response("token_secret", { status: 403 })]);
    await expect(provider.readPullRequest(scope, 3)).rejects.toMatchObject({ code: "access_denied" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("never retries OAuth token exchange after a transient failure", async () => {
    const { provider, fetcher } = fixture([new Response("oauth_client_secret", { status: 503 })]);
    await expect(provider.verifyInstaller(installerInput)).rejects.toMatchObject({ code: "transient" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects an expired installation token before reading repository data", async () => {
    const { provider, fetcher } = fixture([json({ token: "expired_secret", expires_at: "2000-01-01T00:00:00Z" })]);
    await expect(provider.listInstallationRepositories(7)).rejects.toMatchObject({ code: "authentication" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects redirects without following response locations", async () => {
    const { provider, fetcher } = fixture([new Response(null, { status: 302, headers: { location: "https://evil.test/token" } })]);
    await expect(provider.listInstallationRepositories(7)).rejects.toMatchObject({ code: "http_error" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("sanitizes fetch exceptions and malformed JSON", async () => {
    for (const response of [() => { throw new Error("Bearer ghs_installation_secret"); }, new Response("{ghs_installation_secret")]) {
      const { provider } = fixture([response]);
      try { await provider.listInstallationRepositories(7); expect.fail("expected failure"); }
      catch (error) {
        expect(error).toBeInstanceOf(GitHubProviderError);
        expect(String(error)).not.toContain("ghs_installation_secret");
        expect(JSON.stringify(error)).not.toContain("ghs_installation_secret");
        expect((error as Error).cause).toBeUndefined();
      }
    }
  });

  it.each([true, false])("enforces streamed response bytes, with declared size %s", async declared => {
    const response = new Response("x".repeat(100), { headers: declared ? { "content-length": "100" } : {} });
    const { provider } = fixture([response], { maxResponseBytes: 50 });
    await expect(provider.listInstallationRepositories(7)).rejects.toMatchObject({ code: "response_limit" });
  });

  it("enforces cumulative response and request budgets", async () => {
    const f = fixture([auth(), json({ total_count: 1, repositories: [repo] })], { maxTotalBytes: 100 });
    await expect(f.provider.listInstallationRepositories(7)).rejects.toMatchObject({ code: "response_limit" });
    const g = fixture([auth()], { maxRequests: 1 });
    await expect(g.provider.listInstallationRepositories(7)).rejects.toMatchObject({ code: "request_budget" });
    expect(g.fetcher).toHaveBeenCalledTimes(1);
  });

  it("aborts a slow request and sanitizes the abort reason", async () => {
    vi.useFakeTimers();
    const { provider } = fixture([(_url, init) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(new Error("ghs_installation_secret")));
    })], { timeoutMs: 10 });
    const assertion = expect(provider.listInstallationRepositories(7)).rejects.toMatchObject({ code: "timeout", message: "GitHub provider: timeout" });
    await vi.advanceTimersByTimeAsync(11);
    await assertion;
  });

  it("aborts response body reads and respects the operation deadline", async () => {
    vi.useFakeTimers();
    const { provider } = fixture([(_url, init) => new Response(new ReadableStream({ start(controller) {
      init.signal!.addEventListener("abort", () => controller.error(new Error("secret")));
    } }))], { operationTimeoutMs: 5, timeoutMs: 10 });
    const assertion = expect(provider.listInstallationRepositories(7)).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(6);
    await assertion;
  });

  it("does not wait beyond the operation deadline for a transient retry", async () => {
    const { provider, fetcher } = fixture([auth(), json(repo), new Response("secret", { status: 503 })], { operationTimeoutMs: 100 });
    await expect(provider.readPullRequest(scope, 3)).rejects.toMatchObject({ code: "timeout" });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});

describe("repository context", () => {
  const payload = (text = "# Product\nComunicación 🐙\n") => ({
    type: "file", encoding: "base64", path: ".github/README.md",
    content: Buffer.from(text).toString("base64"), size: Buffer.byteLength(text),
  });

  it.each(["Product communications", null])("retains nullable repository description %s", async description => {
    const { provider } = fixture([auth(), json({ total_count: 1, repositories: [{ ...repo, description }] })]);
    expect((await provider.listInstallationRepositories(7)).repositories.items[0].description).toBe(description);
  });

  it("reads UTF-8 README text at the exact commit through the fixed endpoint", async () => {
    const text = "# Product\nComunicación 🐙\n<script>doNotExecute()</script>\nhttps://evil.test\n";
    const value = payload(text);
    const { provider, fetcher } = scoped((url, init) => {
      expect(url.href).toBe(`https://api.github.com/repos/owner/repo/readme?ref=${after}`);
      expect(init.method).toBe("GET");
      expect(new Headers(init.headers).get("Authorization")).toBe("Bearer ghs_installation_secret");
      expect(new Headers(init.headers).get("Accept")).toBe("application/vnd.github+json");
      return json({ ...value, content: value.content.match(/.{1,16}/g)!.join("\r\n") + "\n",
        download_url: "https://evil.test/steal", token: "ghs_installation_secret" });
    });
    const result = await provider.readRepositoryReadme(scope, after);
    expect(result).toEqual({ kind: "present", commitSha: after, path: ".github/README.md", text, completeness: { complete: true, reasons: [] } });
    expect(JSON.stringify(result)).not.toContain("ghs_installation_secret");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("rejects mutable refs before any authentication request", async () => {
    const { provider, fetcher } = fixture([]);
    await expect(provider.readRepositoryReadme(scope, "main")).rejects.toMatchObject({ code: "invalid_input" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("returns absent only for README 404 after repository verification", async () => {
    const { provider, fetcher } = scoped(new Response("secret", { status: 404 }));
    expect(await provider.readRepositoryReadme(scope, after)).toEqual({ kind: "absent", commitSha: after });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it.each([401, 403, 429])("keeps README failure %i distinct from absence", async status => {
    const { provider } = scoped(new Response("secret", { status }));
    await expect(provider.readRepositoryReadme(scope, after)).rejects.toMatchObject({ status });
  });

  it("does not treat repository or installation 404 as README absence", async () => {
    for (const replies of [[new Response("secret", { status: 404 })], [auth(), new Response("secret", { status: 404 })]]) {
      const { provider, fetcher } = fixture(replies);
      await expect(provider.readRepositoryReadme(scope, after)).rejects.toMatchObject({ code: "access_denied", status: 404 });
      expect(fetcher.mock.calls.some(call => String(call[0]).includes("/readme"))).toBe(false);
    }
  });

  it("rejects a mismatched repository before README lookup", async () => {
    const { provider, fetcher } = fixture([auth(), json({ ...repo, id: 99 })]);
    await expect(provider.readRepositoryReadme(scope, after)).rejects.toMatchObject({ code: "access_denied" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("accepts an empty README as present", async () => {
    const { provider } = scoped(json(payload("")));
    expect(await provider.readRepositoryReadme(scope, after)).toMatchObject({ kind: "present", text: "", completeness: { complete: true } });
  });

  it("counts UTF-8 bytes rather than characters at the decoded size limit", async () => {
    const text = "é🐙";
    const f = fixture([auth(), json(repo), json(payload(text))], { maxReadmeBytes: 6 });
    expect(await f.provider.readRepositoryReadme(scope, after)).toMatchObject({ kind: "present", text });
    const g = fixture([auth(), json(repo), json(payload(text))], { maxReadmeBytes: 5 });
    await expect(g.provider.readRepositoryReadme(scope, after)).rejects.toMatchObject({ code: "response_limit" });
  });

  it("enforces decoded limits even when the declared size is false", async () => {
    const { provider } = fixture([auth(), json(repo), json({ ...payload("x".repeat(20)), size: 1 })], { maxReadmeBytes: 10 });
    await expect(provider.readRepositoryReadme(scope, after)).rejects.toMatchObject({ code: "response_limit" });
  });

  it("enforces the default decoded limit and the existing response budget", async () => {
    const f = scoped(json(payload("x".repeat(65_537))));
    await expect(f.provider.readRepositoryReadme(scope, after)).rejects.toMatchObject({ code: "response_limit" });
    const g = fixture([auth(), json(repo), json(payload("x".repeat(1024)))], { maxResponseBytes: 512 });
    await expect(g.provider.readRepositoryReadme(scope, after)).rejects.toMatchObject({ code: "response_limit" });
  });

  it.each([
    { encoding: "none", content: "" }, { content: undefined }, { content: "a$==" },
    { content: "YQ" }, { content: "YR==", size: 1 }, { content: "====", size: 0 },
    { content: "wyg=", size: 2 }, { content: "AA==", size: 1 },
    { size: 1000 }, { size: -1 }, { truncated: true }, { type: "symlink" },
    { path: "https://evil.test/README" }, { path: "../README.md" },
  ])("rejects malformed, truncated, or non-text README payload %#", async change => {
    const { provider } = scoped(json({ ...payload(), ...change }));
    await expect(provider.readRepositoryReadme(scope, after)).rejects.toMatchObject({ code: "invalid_response", message: "GitHub provider: invalid_response" });
  });
});

describe("shipping transport", () => {
  const deployment = { id: 41, sha: after, environment: "production", created_at: "2026-01-01T00:00:00Z" };
  const status = { id: 51, state: "success", environment: "production", created_at: "2026-01-01T01:00:00Z" };
  const commit = { sha: after, commit: { message: "feature" }, parents: [{ sha: before }] };
  const gitCommit = { sha: after, message: "feature", parents: [{ sha: before }] };
  const merged = { ...pr, state: "closed", merged: true, merged_at: "2026-01-01T00:00:00Z", merge_commit_sha: after, commits: 1 };

  it("adds deployments read only to deployment inventory and status operations", async () => {
    for (const statuses of [false, true]) {
      const { provider } = fixture([(_url, init) => {
        expect(JSON.parse(String(init.body))).toEqual({ repository_ids: [12], permissions: { metadata: "read", contents: "read", pull_requests: "read", deployments: "read" } });
        return auth();
      }, json(repo), (url) => {
        expect(url.pathname).toBe(statuses ? "/repos/owner/repo/deployments/41/statuses" : "/repos/owner/repo/deployments");
        return json([statuses ? status : deployment]);
      }]);
      const result = statuses ? await provider.listDeploymentStatuses(scope, 41) : await provider.listDeployments(scope);
      expect(result.completeness.complete).toBe(true);
      expect(result.items[0]).toMatchObject({ environment: "production", createdAt: Date.parse(statuses ? status.created_at : deployment.created_at) });
    }
  });

  it("follows bounded status pages without following provider URLs", async () => {
    const { provider, fetcher } = scoped(json([status], { Link: '<https://evil.test>; rel="next"' }), json([{ ...status, id: 52, state: "inactive" }]));
    expect((await provider.listDeploymentStatuses(scope, 41)).items.map(s => s.state)).toEqual(["success", "inactive"]);
    expect(String(fetcher.mock.calls[3][0])).toBe("https://api.github.com/repos/owner/repo/deployments/41/statuses?per_page=100&page=2");
    const limited = fixture([auth(), json(repo), json([status], { Link: '<https://evil.test>; rel="next"' })], { maxPages: 1 });
    expect((await limited.provider.listDeploymentStatuses(scope, 41)).completeness).toEqual({ complete: false, reasons: ["page_budget"] });
  });

  it("bounds deployment inventory and detects duplicate identities", async () => {
    const limited = fixture([auth(), json(repo), json([deployment], { Link: '<https://evil.test>; rel="next"' })], { maxItems: 1 });
    expect((await limited.provider.listDeployments(scope)).completeness.reasons).toContain("item_budget");
    const duplicate = scoped(json([deployment, deployment]));
    expect((await duplicate.provider.listDeployments(scope)).completeness.reasons).toContain("count_mismatch");
  });

  it.each([
    { sha: "main" }, { environment: "production\n" }, { created_at: "yesterday" }, { id: 0 },
  ])("rejects malformed deployment evidence %j", async malformed => {
    const { provider } = scoped(json([{ ...deployment, ...malformed }]));
    await expect(provider.listDeployments(scope)).rejects.toMatchObject({ code: "invalid_response" });
  });

  it.each([{ state: "completed" }, { created_at: "2026-02-30T00:00:00Z" }, { environment: "" }])("rejects malformed status evidence %j", async malformed => {
    const { provider } = scoped(json([{ ...status, ...malformed }]));
    await expect(provider.listDeploymentStatuses(scope, 41)).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("validates deployment ID before token minting and checks repository identity", async () => {
    const f = fixture([]);
    await expect(f.provider.listDeploymentStatuses(scope, -1)).rejects.toMatchObject({ code: "invalid_input" });
    expect(f.fetcher).not.toHaveBeenCalled();
    const g = fixture([auth(), json({ ...repo, id: 999 })]);
    await expect(g.provider.listDeployments(scope)).rejects.toMatchObject({ code: "access_denied" });
  });

  it("reads exact immutable commit parents with unchanged contents permissions", async () => {
    const { provider } = fixture([(_url, init) => {
      expect(JSON.parse(String(init.body)).permissions).toEqual({ metadata: "read", contents: "read", pull_requests: "read" });
      return auth();
    }, json(repo), (url) => {
      expect(url.pathname).toBe(`/repos/owner/repo/git/commits/${after}`);
      return json({ ...gitCommit, html_url: "https://evil.test", token: "secret" });
    }]);
    expect(await provider.readCommit(scope, after)).toEqual({ sha: after, message: "feature", parents: [before] });
    const mismatch = scoped(json({ ...gitCommit, sha: before }));
    await expect(mismatch.provider.readCommit(scope, after)).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("rejects missing parent evidence instead of inventing a root commit", async () => {
    const { provider } = scoped(json({ ...gitCommit, parents: undefined }));
    await expect(provider.readCommit(scope, after)).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("reads original PR commits with exact count and before/after metadata fences", async () => {
    const { provider } = scoped(json(merged), json([commit]), json(merged));
    expect(await provider.listPullRequestCommits(scope, 3)).toMatchObject({ pullRequest: { state: "merged" }, commits: { items: [{ sha: after, parents: [before] }], totalCount: 1, completeness: { complete: true } } });
    const changed = scoped(json(merged), json([commit]), json({ ...merged, merge_commit_sha: before }));
    expect((await changed.provider.listPullRequestCommits(scope, 3)).commits.completeness.reasons).toContain("state_changed");
  });

  it("does not mistake PR commit cap, count mismatch or missing total for completeness", async () => {
    const capped = { ...merged, commits: 251 };
    const f = scoped(json(capped), json([commit]), json(capped));
    expect((await f.provider.listPullRequestCommits(scope, 3)).commits.completeness.reasons).toEqual(["count_mismatch", "github_commit_limit"]);
    const g = scoped(json({ ...merged, commits: undefined }));
    await expect(g.provider.listPullRequestCommits(scope, 3)).rejects.toMatchObject({ code: "invalid_response" });
  });
});

describe("shipping pages and explicit sessions", () => {
  const deployment = { id: 41, sha: after, environment: "production", created_at: "2026-01-01T00:00:00Z" };
  const status = { id: 51, state: "success", environment: "production", created_at: "2026-01-01T01:00:00Z" };
  const gitCommit = { sha: after, message: "feature", parents: [{ sha: before }] };
  const originalCommit = { sha: after, commit: { message: "feature" }, parents: [{ sha: before }] };
  const merged = { ...pr, state: "closed", merged: true, merged_at: "2026-01-01T00:00:00Z", merge_commit_sha: after, commits: 1 };

  it("returns one requested page and constructs its cursor without following a link URL", async () => {
    const { provider, fetcher } = scoped(json([deployment], { Link: '<https://evil.test/steal?page=999>; rel="next"' }));
    expect(await provider.listDeploymentPage(scope, 7)).toMatchObject({ items: [{ id: 41 }], nextPage: 8 });
    expect(String(fetcher.mock.calls[2][0])).toBe("https://api.github.com/repos/owner/repo/deployments?per_page=100&page=7");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("returns one status page with the reported environment and terminal cursor", async () => {
    const { provider, fetcher } = scoped(json([{ ...status, environment: "Production" }]));
    expect(await provider.listDeploymentStatusPage(scope, 41, 3)).toMatchObject({ items: [{ environment: "Production", state: "success" }], nextPage: null });
    expect(String(fetcher.mock.calls[2][0])).toBe("https://api.github.com/repos/owner/repo/deployments/41/statuses?per_page=100&page=3");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it.each(["deployments", "statuses"])("requires another page after 100 %s even without a Link header", async kind => {
    const { provider } = scoped(json(Array.from({ length: 100 }, (_, i) => ({ ...(kind === "deployments" ? deployment : status), id: i + 1 }))));
    const result = kind === "deployments" ? await provider.listDeploymentPage(scope, 1) : await provider.listDeploymentStatusPage(scope, 41, 1);
    expect(result.items).toHaveLength(100);
    expect(result.nextPage).toBe(2);
  });

  it("treats an empty page as terminal but refuses an empty page advertising more data", async () => {
    const f = scoped(json([]));
    expect(await f.provider.listDeploymentPage(scope, 2)).toEqual({ items: [], nextPage: null });
    const g = scoped(json([], { Link: '<https://api.github.com/next>; rel="next"' }));
    await expect(g.provider.listDeploymentPage(scope, 2)).rejects.toMatchObject({ code: "invalid_response" });
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER, NaN])("rejects invalid page %s before authentication", async page => {
    const { provider, fetcher } = fixture([]);
    await expect(provider.listDeploymentPage(scope, page)).rejects.toMatchObject({ code: "invalid_input" });
    await expect(provider.listDeploymentStatusPage(scope, 41, page)).rejects.toMatchObject({ code: "invalid_input" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("refuses malformed, duplicated, oversize and item-truncated page evidence", async () => {
    for (const body of [[{ ...deployment, sha: "main" }], [deployment, deployment], Array(101).fill(deployment)]) {
      const { provider } = scoped(json(body));
      await expect(provider.listDeploymentPage(scope, 1)).rejects.toMatchObject({ code: "invalid_response" });
    }
    const limited = fixture([auth(), json(repo), json([deployment, { ...deployment, id: 42 }])], { maxItems: 1 });
    await expect(limited.provider.listDeploymentPage(scope, 1)).rejects.toMatchObject({ code: "request_budget" });
  });

  it("reuses one restricted token and repository check across every shipping read", async () => {
    const { provider, fetcher } = fixture([
      (_url, init) => {
        expect(JSON.parse(String(init.body))).toEqual({ repository_ids: [12], permissions: { metadata: "read", contents: "read", pull_requests: "read", deployments: "read" } });
        return auth();
      }, json(repo), json([deployment]), json([status]), json(compare), json(gitCommit),
      json(merged), json([originalCommit]), json(merged), json([merged]),
    ]);
    const reader = provider.shippingSession();
    await reader.listDeploymentPage(scope, 1);
    await reader.listDeploymentStatusPage(scope, 41, 1);
    expect((await reader.compare(scope, before, after)).commits.completeness.complete).toBe(true);
    expect(await reader.readCommit(scope, after)).toEqual({ sha: after, message: "feature", parents: [before] });
    expect((await reader.listPullRequestCommits(scope, 3)).commits.completeness.complete).toBe(true);
    expect((await reader.listCommitPullRequests(scope, after)).items[0].number).toBe(3);
    const paths = fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname);
    expect(paths.filter(path => path.endsWith("/access_tokens"))).toHaveLength(1);
    expect(paths.filter(path => path === "/repos/owner/repo")).toHaveLength(1);
    expect(paths).toContain(`/repos/owner/repo/git/commits/${after}`);
    expect(paths).not.toContain(`/repos/owner/repo/commits/${after}`);
    expect(fetcher).toHaveBeenCalledTimes(10);
    for (const [, init] of fetcher.mock.calls.slice(2)) expect(new Headers(init?.headers).get("authorization")).toBe("Bearer ghs_installation_secret");
    expect(Object.keys(reader).sort()).toEqual(["compare", "listCommitPullRequests", "listDeploymentPage", "listDeploymentStatusPage", "listPullRequestCommits", "readBranch", "readCommit"].sort());
    expect(Object.isFrozen(reader)).toBe(true);
  });

  it("shares in-flight scope establishment for concurrent first reads", async () => {
    const { provider, fetcher } = fixture([async () => { await Promise.resolve(); return auth(); }, json(repo), json([]), json([])]);
    const session = provider.shippingSession();
    const results = await Promise.all([session.listDeploymentPage(scope, 1), session.listDeploymentStatusPage(scope, 41, 1)]);
    expect(results).toEqual([{ items: [], nextPage: null }, { items: [], nextPage: null }]);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it.each([{ repositoryId: 99 }, { installationId: 8 }, { owner: "other" }, { name: "other" }])("rejects changed scope %j without sending its cached token", async change => {
    const { provider, fetcher } = scoped(json([]));
    const session = provider.shippingSession();
    await session.listDeploymentPage(scope, 1);
    await expect(session.readCommit({ ...scope, ...change }, after)).rejects.toMatchObject({ code: "access_denied" });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("does not cross scopes while the first token is still being established", async () => {
    const { provider, fetcher } = scoped(json([]));
    const session = provider.shippingSession();
    const pending = session.listDeploymentPage(scope, 1);
    await expect(session.listDeploymentStatusPage({ ...scope, repositoryId: 99 }, 41, 1)).rejects.toMatchObject({ code: "access_denied" });
    await pending;
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("does not cache a caller-owned mutable scope object", async () => {
    const { provider, fetcher } = scoped(json([]), json([]));
    const session = provider.shippingSession();
    const mutable = { ...scope };
    await session.listDeploymentPage(mutable, 1);
    mutable.repositoryId = 99;
    await expect(session.listDeploymentPage(mutable, 2)).rejects.toMatchObject({ code: "access_denied" });
    await session.listDeploymentPage({ ...scope }, 2);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("checks repository identity once and retains a failed setup rather than minting again", async () => {
    const { provider, fetcher } = fixture([auth(), json({ ...repo, id: 99 })]);
    const session = provider.shippingSession();
    await expect(session.listDeploymentPage(scope, 1)).rejects.toMatchObject({ code: "access_denied" });
    await expect(session.readCommit(scope, after)).rejects.toMatchObject({ code: "access_denied" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("keeps sessions independent and ordinary drafting permissions unchanged", async () => {
    const permissions: unknown[] = [];
    const mint = (_url: URL, init: RequestInit) => { permissions.push(JSON.parse(String(init.body)).permissions); return auth(); };
    const { provider, fetcher } = fixture([
      mint, json(repo), json([]), mint, json({ ...repo, id: 99, name: "second" }), json([]),
      mint, json(repo), json({ name: "main", commit: { sha: after }, protected: false }),
    ]);
    await provider.shippingSession().listDeploymentPage(scope, 1);
    await provider.shippingSession().listDeploymentPage({ ...scope, repositoryId: 99, name: "second" }, 1);
    await provider.readRepositoryBranch(scope, "main");
    expect(permissions).toEqual([
      { metadata: "read", contents: "read", pull_requests: "read", deployments: "read" },
      { metadata: "read", contents: "read", pull_requests: "read", deployments: "read" },
      { metadata: "read", contents: "read", pull_requests: "read" },
    ]);
    expect(fetcher).toHaveBeenCalledTimes(9);
  });

  it("classifies deployment-token 422 as access denied without changing other 422 errors", async () => {
    const f = fixture([new Response("permissions not granted: secret", { status: 422 })]);
    await expect(f.provider.shippingSession().listDeploymentPage(scope, 1)).rejects.toMatchObject({ code: "access_denied", status: 422, message: "GitHub provider: access_denied" });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    const g = fixture([new Response("secret", { status: 422 })]);
    await expect(g.provider.readRepositoryBranch(scope, "main")).rejects.toMatchObject({ code: "http_error", status: 422 });
    const h = scoped(new Response("secret", { status: 422 }));
    await expect(h.provider.listDeploymentPage(scope, 1)).rejects.toMatchObject({ code: "http_error", status: 422 });
  });

  it.each([{ message: undefined }, { parents: undefined }, { parents: [{ sha: "main" }] }, { sha: before }])("rejects incomplete or mismatched Git Data commit identity %j", async change => {
    const { provider } = scoped(json({ ...gitCommit, ...change }));
    await expect(provider.shippingSession().readCommit(scope, after)).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("shares request and cumulative byte bounds across the session", async () => {
    const limited = fixture([auth(), json(repo), json([]), json([])], { maxRequests: 4 });
    const session = limited.provider.shippingSession();
    await session.listDeploymentPage(scope, 1);
    await session.listDeploymentStatusPage(scope, 41, 1);
    await expect(session.readCommit(scope, after)).rejects.toMatchObject({ code: "request_budget" });
    expect(limited.fetcher).toHaveBeenCalledTimes(4);
    const bytes = fixture([auth(), json(repo), json([]), json([{ ...status, ignored: "x".repeat(1000) }])], { maxTotalBytes: 1000 });
    const byteSession = bytes.provider.shippingSession();
    await byteSession.listDeploymentPage(scope, 1);
    await expect(byteSession.listDeploymentStatusPage(scope, 41, 1)).rejects.toMatchObject({ code: "response_limit" });
  });

  it("counts token and repository requests in the default 32-request session budget and resumes only with a fresh session", async () => {
    const { provider, fetcher } = fixture([auth(), json(repo), ...Array.from({ length: 30 }, () => json([])), auth(), json(repo), json([])]);
    const session = provider.shippingSession();
    await session.listDeploymentPage(scope, 1);
    for (let index = 0; index < 29; index++) await session.listDeploymentStatusPage(scope, 41, 1);
    expect(fetcher).toHaveBeenCalledTimes(32);
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("/access_tokens"))).toHaveLength(1);
    expect(fetcher.mock.calls.filter(([url]) => String(url) === "https://api.github.com/repos/owner/repo")).toHaveLength(1);
    await expect(session.listDeploymentStatusPage(scope, 42, 1)).rejects.toMatchObject({ code: "request_budget" });
    await expect(session.listDeploymentPage(scope, 2)).rejects.toMatchObject({ code: "request_budget" });
    expect(fetcher).toHaveBeenCalledTimes(32);
    expect(await provider.shippingSession().listDeploymentStatusPage(scope, 42, 1)).toEqual({ items: [], nextPage: null });
    expect(fetcher).toHaveBeenCalledTimes(35);
  });

  it("keeps independent per-operation budgets for ordinary non-session readers", async () => {
    const { provider, fetcher } = fixture([auth(), json(repo), json([]), auth(), json(repo), json([])], { maxRequests: 3 });
    await provider.listDeploymentPage(scope, 1);
    await provider.listDeploymentStatusPage(scope, 41, 1);
    expect(fetcher).toHaveBeenCalledTimes(6);
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("/access_tokens"))).toHaveLength(2);
  });

  it("does not reset its operation deadline between reader methods", async () => {
    vi.useFakeTimers();
    const { provider, fetcher } = fixture([auth(), json(repo), json([])], { operationTimeoutMs: 10 });
    const session = provider.shippingSession();
    await session.listDeploymentPage(scope, 1);
    await vi.advanceTimersByTimeAsync(11);
    await expect(session.readCommit(scope, after)).rejects.toMatchObject({ code: "timeout" });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});

describe("shipping branch provenance transport", () => {
  it("reads an exact branch through the same scoped shipping session budget", async () => {
    const { provider, fetcher } = fixture([auth(), json(repo), (url) => {
      expect(url.pathname).toBe("/repos/owner/repo/branches/release%2Fstable");
      return json({ name: "release/stable", commit: { sha: after.toUpperCase() }, protected: true });
    }, json([])], { maxRequests: 4 });
    const session = provider.shippingSession();
    expect(await session.readBranch(scope, "release/stable")).toEqual({ name: "release/stable", sha: after, protected: true });
    await session.listDeploymentPage(scope, 1);
    await expect(session.readBranch(scope, "release/stable")).rejects.toMatchObject({ code: "request_budget" });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("rejects malformed branches before transport and mismatched response identity", async () => {
    const empty = fixture([]);
    await expect(empty.provider.shippingSession().readBranch(scope, "../main")).rejects.toMatchObject({ code: "invalid_input" });
    expect(empty.fetcher).not.toHaveBeenCalled();
    const mismatched = fixture([auth(), json(repo), json({ name: "other", commit: { sha: after }, protected: false })]);
    await expect(mismatched.provider.shippingSession().readBranch(scope, "main")).rejects.toMatchObject({ code: "invalid_response" });
  });
});

describe("pure GitHub configuration validation", () => {
  it.each(["main", "release/stable", "feature.topic"])("accepts branch %s without transport", value => {
    expect(isGitHubBranchName(value)).toBe(true);
  });
  it.each(["", "../main", "a..b", "main\n", "x".repeat(1025), 123, null])("rejects invalid branch %#", value => {
    expect(isGitHubBranchName(value)).toBe(false);
  });
  it.each(["owner", "repo-name", "repo.name"])("accepts repository segment %s", value => {
    expect(isGitHubRepositorySegment(value)).toBe(true);
  });
  it.each(["", ".", "..", "owner/repo", "x".repeat(256), null])("rejects invalid repository segment %#", value => {
    expect(isGitHubRepositorySegment(value)).toBe(false);
  });
});
