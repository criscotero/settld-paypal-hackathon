// ADR-0020 decision 1A: the delivered commit is fixed when the seller delivers.
import { describe, expect, it } from "vitest";
import { ProblemException } from "../errors/problem.js";
import { GitHubRepositoryResolver } from "./repository-resolver.js";

const HEAD = "a".repeat(40);
const NAMED = "b".repeat(40);

function github(routes: Record<string, { status?: number; body?: unknown }>) {
  const seen: string[] = [];
  const fetchImpl = ((input: string | URL) => {
    const url = String(input);
    seen.push(url);
    const route = routes[url.replace("https://api.github.com", "")];
    if (route === undefined) return Promise.resolve(new Response("{}", { status: 404 }));
    return Promise.resolve(new Response(JSON.stringify(route.body ?? {}), { status: route.status ?? 200 }));
  }) as typeof fetch;
  return { resolver: new GitHubRepositoryResolver(fetchImpl), seen };
}

async function problemOf(promise: Promise<unknown>): Promise<ProblemException> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ProblemException) return error;
    throw error;
  }
  throw new Error("expected a problem");
}

describe("GitHubRepositoryResolver", () => {
  it("fixes the head of the default branch and returns the canonical url", async () => {
    const { resolver } = github({
      "/repos/acme/site": { body: { private: false, default_branch: "main" } },
      "/repos/acme/site/commits/main": { body: { sha: HEAD } },
    });
    expect(await resolver.resolve("https://github.com/acme/site.git", undefined)).toEqual({ url: "https://github.com/acme/site", commitSha: HEAD });
  });

  it("keeps a commit the seller named, after checking it exists", async () => {
    const { resolver, seen } = github({
      "/repos/acme/site": { body: { private: false, default_branch: "main" } },
      [`/repos/acme/site/commits/${NAMED}`]: { body: { sha: NAMED } },
    });
    expect((await resolver.resolve("https://github.com/acme/site/tree/feature", NAMED)).commitSha).toBe(NAMED);
    expect(seen.at(-1)).toContain(NAMED);
  });

  it("accepts the repository link with a trailing slash", async () => {
    const { resolver } = github({
      "/repos/acme/site": { body: { private: false, default_branch: "main" } },
      "/repos/acme/site/commits/main": { body: { sha: HEAD } },
    });
    expect((await resolver.resolve("https://github.com/acme/site/", null)).commitSha).toBe(HEAD);
  });

  it("pins the commit in a /commit/<sha> link instead of the branch head", async () => {
    const { resolver, seen } = github({
      "/repos/acme/site": { body: { private: false, default_branch: "main" } },
      [`/repos/acme/site/commits/${NAMED}`]: { body: { sha: NAMED } },
    });
    expect((await resolver.resolve(`https://github.com/acme/site/commit/${NAMED}`, null)).commitSha).toBe(NAMED);
    expect(seen.at(-1)).toContain(NAMED);
  });

  it("refuses a pull request, branch or file link without asking GitHub, so the default branch is never checked by mistake", async () => {
    for (const link of ["https://github.com/acme/site/pull/12", "https://github.com/acme/site/tree/feature", "https://github.com/acme/site/blob/main/index.html"]) {
      const { resolver, seen } = github({});
      const problem = await problemOf(resolver.resolve(link, null));
      expect(problem.code).toBe("REPOSITORY_UNREADABLE");
      expect(problem.message + JSON.stringify(problem)).toContain("repository link");
      expect(seen).toEqual([]);
    }
  });

  it("refuses a link that is not GitHub", async () => {
    const { resolver, seen } = github({});
    const problem = await problemOf(resolver.resolve("https://gitlab.com/acme/site", null));
    expect(problem.code).toBe("REPOSITORY_UNREADABLE");
    expect(seen).toEqual([]);
  });

  it("refuses a private or missing repository", async () => {
    const { resolver } = github({ "/repos/acme/secret": { body: { private: true, default_branch: "main" } } });
    expect((await problemOf(resolver.resolve("https://github.com/acme/secret", null))).code).toBe("REPOSITORY_UNREADABLE");
    expect((await problemOf(resolver.resolve("https://github.com/acme/gone", null))).code).toBe("REPOSITORY_UNREADABLE");
  });

  it("says GitHub is busy instead of blaming the repository", async () => {
    const { resolver } = github({ "/repos/acme/site": { status: 429 } });
    expect((await problemOf(resolver.resolve("https://github.com/acme/site", null))).code).toBe("RATE_LIMITED");
  });
});
