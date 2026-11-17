// Guided onboarding PR 6: the helpers behind the multi-repository and bulk creates and the picker, and the contract schemas.
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { BulkCreateClientProjectsRequestSchema, CreateClientProjectRequestSchema, CreateClientProjectsRequestSchema, CreateProjectBodySchema, CreateProjectsBodySchema } from "@agentx/contracts";
import { bulkCreate, ClientProjectRefused, eachLimited, nameTaken, notAvailable, onCompanyInstallations, projectRepositoryName, repositoryChoices, uniqueRepositoryNames } from "../../packages/broker/src/aws/client-project-create.js";
import { boundedCompanyReads } from "../../packages/broker/src/aws/company-check.js";
import { GitHubAppCredentialProvider } from "../../packages/broker/src/github-app.js";

const KEY = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const A = "org_aaaaaaaaaaaaaaaaaaaa";

describe("repository names inside one project", () => {
  it("keeps the single create's name, and makes repeats unique within 63 characters", () => {
    expect(projectRepositoryName("My.Repo")).toBe("my-repo");
    expect(projectRepositoryName("9lives")).toBe("r-9lives");
    expect(uniqueRepositoryNames(["web", "Web", "WEB", "api"])).toEqual(["web", "web-2", "web-3", "api"]);
    const long = "a".repeat(80);
    const names = uniqueRepositoryNames([long, long]);
    expect(names[1]).toBe(`${"a".repeat(61)}-2`);
    expect(names.every((name) => name.length <= 63)).toBe(true);
  });
});

describe("bulkCreate", () => {
  it("one row per repository in order; unknown failures are 'unavailable', never the cause", async () => {
    const answer = await bulkCreate(["o/a", "o/b", "o/c", "o/d"], {
      now: () => 0, nameOf: (repository) => repository,
      create: async (repository) => {
        if (repository === "o/b") throw notAvailable();
        if (repository === "o/c") throw nameTaken("c");
        if (repository === "o/d") throw new Error("private-canary");
        return "a";
      },
    });
    expect(answer.results).toEqual([
      { repository: "o/a", outcome: "created", project: "a" }, { repository: "o/b", outcome: "refused", reason: "not_available" },
      { repository: "o/c", outcome: "refused", reason: "name_taken" }, { repository: "o/d", outcome: "refused", reason: "unavailable" }]);
    expect(JSON.stringify(answer)).not.toContain("canary");
  });

  it("starts nothing after the deadline: the rest are not_started", async () => {
    let clock = 0;
    const create = vi.fn(async () => { clock += 10_000; return "p"; });
    const answer = await bulkCreate(["o/a", "o/b", "o/c", "o/d"], { now: () => clock, nameOf: (repository) => repository, create, deadlineMs: 20_000, concurrency: 1 });
    expect(answer.results.map((row) => row.outcome === "created" ? "created" : row.reason)).toEqual(["created", "created", "not_started", "not_started"]);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("runs repositories that make the same project name one after another", async () => {
    const order: string[] = [];
    let active = 0; let most = 0;
    await bulkCreate(["x/web", "y/web", "z/web"], { now: () => 0, nameOf: () => "web", concurrency: 4, create: async (repository) => {
      active++; most = Math.max(most, active); order.push(repository); await new Promise((resolve) => setTimeout(resolve, 5)); active--; return repository;
    } });
    expect(most).toBe(1);
    expect(order).toEqual(["x/web", "y/web", "z/web"]);
  });
});

describe("eachLimited", () => {
  it("never runs more than the limit at once and rethrows the first failure", async () => {
    let active = 0; let most = 0;
    await eachLimited(Array.from({ length: 20 }, (_, index) => index), 3, async () => { active++; most = Math.max(most, active); await new Promise((resolve) => setTimeout(resolve, 1)); active--; });
    expect(most).toBe(3);
    await expect(eachLimited([1, 2, 3], 2, async (item) => { if (item === 2) throw new Error("two"); })).rejects.toThrow("two");
  });
});

describe("onCompanyInstallations", () => {
  const budget = () => boundedCompanyReads({ send: async () => undefined });
  const bindings = (owner: string | undefined) => ({ withBudget: () => ({ requireBound: async (companyId: string) => { if (owner !== companyId) throw new Error("not bound"); } }) }) as never;
  it("no bindings: the legacy install refuses nothing", async () => {
    expect(await onCompanyInstallations({}, undefined, ["https://github.com/o/r.git"], budget())).toBe(true);
  });
  it("with bindings: no company, a bad company, no live lookup, a suspended or foreign installation are all false", async () => {
    const live = async () => ({ installationId: 7, suspended: false });
    expect(await onCompanyInstallations({ bindings: bindings(A), live }, A, ["https://github.com/o/r.git"], budget())).toBe(true);
    expect(await onCompanyInstallations({ bindings: bindings(A), live }, undefined, ["https://github.com/o/r.git"], budget())).toBe(false);
    expect(await onCompanyInstallations({ bindings: bindings("private-canary"), live }, "private-canary", ["https://github.com/o/r.git"], budget())).toBe(false);
    expect(await onCompanyInstallations({ bindings: bindings(A) }, A, ["https://github.com/o/r.git"], budget())).toBe(false);
    expect(await onCompanyInstallations({ bindings: bindings(A), live: async () => ({ installationId: 7, suspended: true }) }, A, ["https://github.com/o/r.git"], budget())).toBe(false);
    expect(await onCompanyInstallations({ bindings: bindings("org_bbbbbbbbbbbbbbbbbbbb"), live }, A, ["https://github.com/o/r.git"], budget())).toBe(false);
    expect(await onCompanyInstallations({ bindings: bindings(A), live: async () => { throw new Error("down"); } }, A, ["https://github.com/o/r.git"], budget())).toBe(false);
  });
});

describe("repositoryChoices", () => {
  const install = (id: number, status: "active" | "suspended", names: string[]) => ({ installationId: id, accountLogin: `acct-${id}`, accountType: "Organization" as const, repositorySelection: "all" as const, status,
    repositories: names.map((fullName, index) => ({ fullName, githubRepositoryId: id * 1000 + index, private: false, defaultBranch: "main" })) });
  it("skips suspended installations, filters, sorts, pages and copies the marks", () => {
    const marks = new Map([["o/b", ["p1"]]]);
    const page = repositoryChoices([install(1, "active", ["o/c", "O/b", "o/a"]), install(2, "suspended", ["s/z"])], marks, { limit: 2 });
    expect(page.repositories.map((row) => [row.fullName, row.projects])).toEqual([["o/a", []], ["O/b", ["p1"]]]);
    expect(page.next).toBe("O/b");
    expect(repositoryChoices([install(1, "active", ["o/c", "o/b", "o/a"])], marks, { after: "o/b" }).repositories.map((row) => row.fullName)).toEqual(["o/c"]);
    page.repositories[1]!.projects.push("mutated");
    expect(marks.get("o/b")).toEqual(["p1"]);
  });
});

describe("contract schemas", () => {
  it("the single-repository bodies parse exactly as before", () => {
    const body = { requestId: "11111111-1111-4111-8111-111111111111", repository: "acme/web", setupCommand: "npm ci" };
    expect(JSON.stringify(CreateProjectBodySchema.parse(body))).toBe(JSON.stringify(body));
    expect(CreateProjectBodySchema.safeParse({ ...body, repositories: ["acme/web"] }).success).toBe(false);
    expect(JSON.stringify(CreateClientProjectRequestSchema.parse({ repository: "acme/web", testCommands: ["npm test"] }))).toBe('{"repository":"acme/web","testCommands":["npm test"]}');
    expect(CreateClientProjectRequestSchema.safeParse({ repositories: ["acme/web"] }).success).toBe(false);
  });
  it("several repositories: 1 to 32, no repeats ignoring case, no unknown keys", () => {
    const ok = Array.from({ length: 32 }, (_, index) => `o/r${index}`);
    expect(CreateClientProjectsRequestSchema.safeParse({ repositories: ok }).success).toBe(true);
    expect(CreateClientProjectsRequestSchema.safeParse({ repositories: [...ok, "o/x"] }).success).toBe(false);
    expect(CreateClientProjectsRequestSchema.safeParse({ repositories: ["o/a", "O/A"] }).success).toBe(false);
    expect(CreateClientProjectsRequestSchema.safeParse({ repositories: ["o/a"], companyId: A }).success).toBe(false);
    expect(BulkCreateClientProjectsRequestSchema.safeParse({ repositories: ["o/a"], name: "x" }).success).toBe(false);
    const app = { requestId: "11111111-1111-4111-8111-111111111111", repositories: ["o/a", "o/b"] };
    expect(CreateProjectsBodySchema.safeParse(app).success).toBe(true);
    expect(CreateProjectsBodySchema.safeParse({ ...app, separate: true }).success).toBe(true);
    expect(CreateProjectsBodySchema.safeParse({ ...app, separate: true, name: "x" }).success).toBe(false);
    expect(CreateProjectsBodySchema.safeParse({ ...app, repositories: ["o/a", "o/A"] }).success).toBe(false);
  });
  it("a refusal is an AgentXError with its reason", () => {
    const error = notAvailable();
    expect(error).toBeInstanceOf(ClientProjectRefused);
    expect([error.code, error.statusCode, error.reason]).toEqual(["CONFIG_INVALID", 400, "not_available"]);
  });
});

describe("GitHubAppCredentialProvider.repositoryInstallation", () => {
  const provider = (answer: () => Response) => {
    const fetchImplementation = vi.fn(async () => answer());
    return { fetchImplementation, github: new GitHubAppCredentialProvider({ credentialRef: "github-app", appId: "123", getPrivateKey: async () => KEY, fetchImplementation }) };
  };
  it("reads GitHub every time, and reports suspension", async () => {
    const { github, fetchImplementation } = provider(() => Response.json({ id: 77, account: { login: "Acme" }, suspended_at: null }));
    expect(await github.repositoryInstallation("https://github.com/acme/web.git")).toEqual({ installationId: 77, suspended: false });
    expect(await github.repositoryInstallation("https://github.com/acme/web.git")).toEqual({ installationId: 77, suspended: false });
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(String((fetchImplementation.mock.calls[0] as unknown[])[0])).toBe("https://api.github.com/repos/acme/web/installation");
    const suspended = provider(() => Response.json({ id: 77, account: { login: "acme" }, suspended_at: "2026-11-17T00:00:00Z" }));
    expect(await suspended.github.repositoryInstallation("https://github.com/acme/web.git")).toEqual({ installationId: 77, suspended: true });
  });
  it("throws on 404, another account, or a malformed answer", async () => {
    for (const answer of [() => new Response("{}", { status: 404 }), () => Response.json({ id: 77, account: { login: "other" } }), () => Response.json({ id: "77", account: { login: "acme" } }), () => Response.json({ id: 77, account: { login: "acme" }, suspended_at: 5 })]) {
      await expect(provider(answer).github.repositoryInstallation("https://github.com/acme/web.git")).rejects.toMatchObject({ code: "GITHUB_NOT_CONNECTED" });
    }
  });
});
