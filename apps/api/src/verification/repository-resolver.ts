// Fixes the commit of a delivered repository at the moment of delivery (ADR-0020 decision 1A).
//
// Why here and not in the Engine: "copy on delivery" is the rule. If the Engine looked up the
// branch head when it ran, a seller could push after delivering and the buyer would be shown a
// verdict about code that was never delivered. Core stores the SHA in the submission, the
// Engine reads only that commit, and the report says which one it was.
//
// Why before the database transaction: a call to GitHub can take seconds, and holding the
// milestone's row lock for that long would block every other action on it.
import { ProblemException } from "../errors/problem.js";

export const REPOSITORY_RESOLVER = Symbol("REPOSITORY_RESOLVER");

const GITHUB = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/.*)?$/;
const SHA = /^[0-9a-f]{40}$/;

export interface ResolvedRepository {
  readonly url: string; // canonical https://github.com/owner/name
  readonly commitSha: string;
}

export interface RepositoryResolver {
  resolve(url: string, commitSha: string | null | undefined): Promise<ResolvedRepository>;
}

function unreadable(reason: string): ProblemException {
  return new ProblemException("REPOSITORY_UNREADABLE", 422, "The repository cannot be read", `${reason} Only public GitHub repositories can be delivered for now.`, { reason });
}

export class GitHubRepositoryResolver implements RepositoryResolver {
  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    // Settld's own read-only token, only to raise GitHub's anonymous rate limit. Never a
    // seller's credentials (ADR-0019 decision 1A).
    private readonly token: string | null = null,
  ) {}

  private async get(path: string): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "settld-core" };
    if (this.token !== null) headers.Authorization = `Bearer ${this.token}`;
    let response: Response;
    try {
      response = await this.fetchImpl(`https://api.github.com${path}`, { headers, redirect: "error", signal: AbortSignal.timeout(10_000) });
    } catch {
      throw unreadable("GitHub did not answer.");
    }
    if (response.status === 404) throw unreadable("It does not exist or is private.");
    if (response.status === 403 || response.status === 429) throw new ProblemException("RATE_LIMITED", 429, "GitHub is busy", "Try delivering again in a minute.");
    if (!response.ok) throw unreadable(`GitHub answered status ${String(response.status)}.`);
    return (await response.json()) as Record<string, unknown>;
  }

  async resolve(url: string, commitSha: string | null | undefined): Promise<ResolvedRepository> {
    const match = GITHUB.exec(url);
    if (match === null) throw unreadable("The link is not a GitHub repository.");
    const [, owner, name] = match as unknown as [string, string, string];
    const repo = await this.get(`/repos/${owner}/${name}`);
    if (repo.private === true) throw unreadable("It is private.");
    // A commit the seller named is kept if it exists; otherwise the default branch's head.
    const ref = commitSha !== null && commitSha !== undefined && SHA.test(commitSha) ? commitSha : (typeof repo.default_branch === "string" ? repo.default_branch : "");
    if (ref === "") throw unreadable("It has no default branch.");
    const commit = await this.get(`/repos/${owner}/${name}/commits/${encodeURIComponent(ref)}`);
    const sha = typeof commit.sha === "string" ? commit.sha : "";
    if (!SHA.test(sha)) throw unreadable("Its commit could not be resolved.");
    return { url: `https://github.com/${owner}/${name}`, commitSha: sha };
  }
}
