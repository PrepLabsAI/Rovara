// L4-RC: the "Rovara" Check is on for everyone (owner decision 2026-11-17). The hosted job services and the laptop's tracking both ask for it; the hosted code host (company-scoped) can write it for the
// company's own repository only; an install without the Checks permission fails soft; a personal token cannot write a Check, so the laptop's token host offers none. All over fakes (never the real GitHub).
import { readFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { FakeHostModel } from "@agentx/broker/fakes";
import { SecretValue, type OrgId } from "@agentx/contracts";
import { createLocalSecretStore } from "../../packages/broker/src/ports/index.js";
import { createHostedBrokerCoreServices, createBrokerCoreServices } from "../../packages/broker/src/aws/core-job-services.js";
import { companyScopedGitHubProvider } from "../../packages/broker/src/aws/core-code-host.js";
import { SUMMARY_CHECK_PERMISSION_RETRY_MS, summaryCheckKey, syncSummaryCheck, type SummaryCheckPass } from "../../packages/broker/src/core/merge/index.js";
import { createLocalMilestones, createLocalTracking } from "../../packages/broker/src/local/app/tracking.js";
import { githubCodeHost } from "../../packages/broker/src/plugins/code-host/github/index.js";
import { GitHubAppCredentialProvider } from "../../packages/broker/src/plugins/code-host/github/client.js";
import { githubTokenCodeHost } from "../../packages/broker/src/plugins/code-host/github/token-code-host.js";
import { rovaraCheckSource } from "../../packages/broker/src/services/index.js";
import { GITHUB_ORG_SCOPE, GITHUB_REPO_URL, GitHubFixtureApi } from "../support/ports/github-fixture-api.js";
import { ORG, TASK_ID, mergeWorld } from "../support/merge-world.js";
import { host as serviceHost } from "../support/service-host.js";

const B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const NOW = Date.parse("2026-11-09T10:00:00.000Z");
const task = (orgId: OrgId) => ({ taskId: TASK_ID, orgId, project: "web", startingRevision: 1, workspaceId: "ws-1", ownerId: "owner-1", ownerName: "Priya" });

describe("the source a host passes", () => {
  it("is on for every task of every company, and says nothing about a link unless the host gives one", () => {
    const source = rovaraCheckSource();
    expect("detailsUrl" in source).toBe(false);
    expect(source.verdict).toBeUndefined();
    for (const orgId of [ORG, B]) expect(source.enabled(task(orgId))).toBe(true);
    const linked = rovaraCheckSource({ detailsUrl: (t) => `https://rovara.example.test/tasks/${t.taskId}` });
    expect(linked.detailsUrl?.(task(ORG))).toBe(`https://rovara.example.test/tasks/${TASK_ID}`);
  });
});

describe("the hosted job services", () => {
  const optionsOf = (w: Awaited<ReturnType<typeof serviceHost>>) => ({ companyId: ORG, flow: w.h.flow, registry: w.registry, ciMode: async () => "their_ci_fix" as const, people: w.people, summary: { facts: w.sessions.deps.facts, cost: w.sessions.deps.cost }, notification: { companyOf: async () => ORG }, now: () => new Date(w.clock.ms) });

  // Mutant H1: the hosted job services do not pass summaryCheck.
  it("write the Check for the company's pull request on a merge-tracking pass", async () => {
    const w = await serviceHost();
    const services = createHostedBrokerCoreServices(optionsOf(w));
    expect(await services["merge-tracking"].pass({ budgetMs: 1000 })).toMatchObject({ attempted: 1 });
    const written = w.world.prs[0]!.model.summaryChecks;
    expect(written).toHaveLength(1);
    expect(written[0]!.revision).toBe(w.world.prs[0]!.head);
    expect(written[0]!.detailsUrl).toBeUndefined();
    // A pass again, with nothing changed: the same run, not a second.
    await services["merge-tracking"].pass({ budgetMs: 1000 });
    expect(w.world.prs[0]!.model.summaryChecks).toHaveLength(1);
  });

  it("the plain composition, with no summaryCheck, still writes nothing (the option is the only way in)", async () => {
    const w = await serviceHost();
    await createBrokerCoreServices(optionsOf(w))["merge-tracking"].pass({ budgetMs: 1000 });
    expect(w.world.prs[0]!.model.summaryChecks).toEqual([]);
  });

  // Mutant H2: the deployed broker builds its services with the plain composition again.
  it("the deployed broker's root uses the hosted composition", () => {
    const text = readFileSync(new URL("../../packages/broker/src/aws/broker.ts", import.meta.url), "utf8");
    expect(text).toContain("createHostedBrokerCoreServices({ companyId, flow, registry, ciMode: wiring.ciMode! })");
    expect(text).not.toMatch(/createBrokerCoreServices\(/u);
  });

  it("a permission refusal on the code host fails soft: the pass still counts the row and finishes", async () => {
    const w = await serviceHost();
    const model = w.world.prs[0]!.model;
    model.summaryCheckPermission = false;
    const services = createHostedBrokerCoreServices(optionsOf(w));
    expect(await services["merge-tracking"].pass({ budgetMs: 1000 })).toMatchObject({ attempted: 1, failed: 0 });
    expect(model.summaryChecks).toEqual([]);
    expect(model.summaryCheckWrites).toBe(0);
  });
});

describe("the laptop's tracking", () => {
  const trackingOf = async (override?: ReturnType<typeof rovaraCheckSource>) => {
    const w = await serviceHost();
    const tracking = createLocalTracking({
      flow: w.h.deps, registry: w.registry, companyId: ORG, milestones: createLocalMilestones({ store: w.h.store, now: () => w.clock.ms }), now: () => w.clock.ms,
      ...(override === undefined ? {} : { summaryCheck: override }),
    });
    return { w, tracking };
  };

  // Mutant L1: the laptop's tracking does not ask for the Check.
  it("asks for the Check by default, and a host that can write one gets it", async () => {
    const { w, tracking } = await trackingOf();
    expect(tracking.deps.summaryCheck?.enabled(task(ORG))).toBe(true);
    await tracking.sweep();
    expect(w.world.prs[0]!.model.summaryChecks).toHaveLength(1);
  });

  it("keeps the source a host passes itself (a gate it closes stays closed)", async () => {
    const { w, tracking } = await trackingOf({ enabled: () => false });
    await tracking.sweep();
    expect(w.world.prs[0]!.model.summaryChecks).toEqual([]);
  });

  it("the app's laptop wiring leaves the default in place (it passes no summaryCheck of its own)", () => {
    const text = readFileSync(new URL("../../packages/broker/src/local/app/app.ts", import.meta.url), "utf8");
    const line = text.split("\n").find((entry) => entry.includes("createLocalTracking({"))!;
    expect(line).toBeDefined();
    expect(line).not.toContain("summaryCheck");
  });

  // Mutant L2: the token client's method list gains the Check write (a personal token cannot write a Check run).
  it("a laptop signed in with a personal token offers no Check, so the pass sends nothing to GitHub", async () => {
    const api = new GitHubFixtureApi(new FakeHostModel({ url: GITHUB_REPO_URL, id: "4242", fullName: "acme/app", webBase: "https://github.com" }), { personalToken: "fixture-personal-token" });
    const fetchSpy = vi.fn<typeof fetch>((input, init) => api.fetch(input, init));
    const secrets = createLocalSecretStore({ environment: {}, keyFile: { get: async () => new SecretValue("fixture-personal-token"), providers: async () => ["github"] } });
    const codeHost = githubTokenCodeHost({ companyId: GITHUB_ORG_SCOPE.orgId, secrets, environment: {}, gh: async () => undefined, fetch: fetchSpy, now: () => NOW, registeredRepositories: () => [GITHUB_REPO_URL] });
    expect("upsertSummaryCheck" in codeHost).toBe(false);
    expect("summaryCheckSource" in codeHost).toBe(false);
    const w = await mergeWorld();
    const pr = w.prs[0]!;
    const pass: SummaryCheckPass = {
      task: { ...(await w.host.loadTask(TASK_ID))!, orgId: ORG }, pullRequest: { repositoryId: "app", number: pr.number }, codeHost, repositoryUrl: GITHUB_REPO_URL, scope: { orgId: ORG },
      status: { headRevision: pr.head, draft: false, state: "open" }, ci: "passing", ciMode: "their_ci_fix", headByRovara: true, ready: true, proofHoldOn: false,
    };
    expect(await syncSummaryCheck({ store: w.store, now: () => NOW, source: rovaraCheckSource() }, pass)).toBe("off");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("the hosted code host writes the Check through the company's own rules (real client over the fake GitHub)", () => {
  async function bridged(options: { deny?: boolean; refuseWrite?: boolean; repositories?: Record<string, string[]> } = {}) {
    let api: GitHubFixtureApi | undefined;
    const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const w = await mergeWorld({
      codeHost: (model) => {
        api = new GitHubFixtureApi(model);
        if (options.deny === true) api.deniedPermissions.add("checks:write");
        const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
        const client = new GitHubAppCredentialProvider({
          credentialRef: "github", appId: "5002502", getPrivateKey: async () => privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
          fetchImplementation: options.refuseWrite !== true ? api.fetch : (async (input, init) => (init?.method === "POST" && String(input instanceof Request ? input.url : input).endsWith("/check-runs")
            ? new Response(JSON.stringify({ message: "Resource not accessible by integration" }), { status: 403 }) : api!.fetch(input, init))),
          now: () => NOW, requireInstallationBound: async () => undefined,
        });
        const repositories = options.repositories ?? { [ORG]: ["acme/app"], [B]: ["bcorp/own"] };
        return githubCodeHost(companyScopedGitHubProvider(client, { repositoriesOf: async (companyId) => new Set(repositories[companyId] ?? []), now: () => NOW }), { credentialRef: "github" });
      },
    });
    const pr = w.prs[0]!;
    const passOf = async (orgId: OrgId): Promise<SummaryCheckPass> => ({
      task: { ...(await w.host.loadTask(TASK_ID))!, orgId }, pullRequest: { repositoryId: "app", number: pr.number }, codeHost: (await w.host.repository("web", 1, "app", ORG))!.codeHost, repositoryUrl: GITHUB_REPO_URL, scope: { orgId },
      status: { headRevision: pr.head, draft: false, state: "open" }, ci: "passing", ciMode: "their_ci_fix", headByRovara: true, ready: true, proofHoldOn: false,
    });
    const deps = { store: w.store, now: () => w.now.value, source: rovaraCheckSource(), log: (event: string, fields: Record<string, unknown>) => { logs.push({ event, fields }); } };
    return { w, pr, api: () => api!, passOf, deps, logs };
  }

  it("writes the company's own Check with a token that asks for Checks write on that one repository", async () => {
    const { api, passOf, deps, w, pr } = await bridged();
    expect(await syncSummaryCheck(deps, await passOf(ORG))).toBe("written");
    expect(api().checkRuns).toHaveLength(1);
    expect(api().checkRuns[0]).toMatchObject({ name: "Rovara", head_sha: pr.head, status: "completed", conclusion: "success" });
    const writers = api().tokens.filter((token) => token.permissions["checks"] === "write");
    expect(writers.length).toBeGreaterThan(0);
    expect(writers.every((token) => Object.keys(token.permissions).join() === "checks" && token.repositories?.join() === "app")).toBe(true);
    expect((await w.store.get(summaryCheckKey(ORG, TASK_ID, "app", pr.number)))?.["runId"]).toBeTypeOf("string");
  });

  // Mutant C1: the bridge passes the Check write through without the company's repository check.
  it("never writes for a company whose projects do not name the repository (no token, no request, nothing stored)", async () => {
    const { api, passOf, deps, w, pr, logs } = await bridged();
    expect(await syncSummaryCheck(deps, await passOf(B))).toBe("failed");
    expect(api().checkRuns).toEqual([]);
    expect(api().tokens).toEqual([]);
    expect(await w.store.get(summaryCheckKey(B, TASK_ID, "app", pr.number))).toBeUndefined();
    expect(logs.map((entry) => entry.event)).toEqual(["summary_check.failed"]);
    expect(JSON.stringify(logs)).not.toContain("acme");
  });

  it("refuses a system scope and a scope that is not a company's, before GitHub is asked", async () => {
    const { api, passOf } = await bridged();
    const codeHost = (await passOf(ORG)).codeHost;
    const post = { headRevision: "a".repeat(40), payload: { status: "completed" as const, conclusion: "success" as const, title: "t", summary: "s", text: "x" } };
    for (const scope of [{ system: "webhook" }, { system: "install" }, {}, { orgId: "not-an-org" }, null]) {
      await expect(codeHost.upsertSummaryCheck!({ url: GITHUB_REPO_URL }, post, scope as never)).rejects.toBeDefined();
    }
    expect(api().requests).toEqual([]);
  });

  // Mutant C2: the bridge checks the company from the scope it was given but hands the client that same object (a scope that changes company after the check).
  it("hands the client only the company scope that was checked", async () => {
    const seen: unknown[] = [];
    const client = { upsertRovaraCheck: async (_url: string, _input: unknown, scope: unknown) => { seen.push(scope); return { runId: "1" }; }, summaryCheckSource: async () => "5002502" } as unknown as Parameters<typeof companyScopedGitHubProvider>[0];
    const provider = companyScopedGitHubProvider(client, { repositoriesOf: async () => new Set(["acme/app"]) });
    let reads = 0;
    const shifting = { get orgId() { reads += 1; return reads === 1 ? ORG : B; } };
    await provider.upsertRovaraCheck!(GITHUB_REPO_URL, { headSha: "a".repeat(40), payload: { status: "completed", conclusion: "success", title: "t", summary: "s", text: "x" } }, shifting);
    expect(seen).toEqual([{ orgId: ORG }]);
  });

  // Mutant S1: the bridge offers the Check write without the App's id (the adapter then offers neither, so no Check and no way to tell it from the customer's CI).
  it("offers the Check write and the App's id together, or neither", async () => {
    const both = { upsertRovaraCheck: async () => ({ runId: "1" }), summaryCheckSource: async () => "5002502" } as unknown as Parameters<typeof companyScopedGitHubProvider>[0];
    const provider = companyScopedGitHubProvider(both, { repositoriesOf: async () => new Set() });
    expect(typeof provider.upsertRovaraCheck).toBe("function");
    expect(await provider.summaryCheckSource!()).toBe("5002502");
    const half = companyScopedGitHubProvider({ upsertRovaraCheck: async () => ({ runId: "1" }) } as unknown as Parameters<typeof companyScopedGitHubProvider>[0], { repositoriesOf: async () => new Set() });
    expect("upsertRovaraCheck" in half).toBe(false);
    expect("summaryCheckSource" in half).toBe(false);
  });

  // Mutant F1: a permission refusal throws (or is retried) instead of being remembered for an hour.
  it("an install without the Checks permission: no Check, one log line, no retry within the hour, asked again after", async () => {
    const { api, passOf, deps, w, pr, logs } = await bridged({ deny: true });
    expect(await syncSummaryCheck(deps, await passOf(ORG))).toBe("no_permission");
    expect(api().checkRuns).toEqual([]);
    expect(api().tokens.filter((token) => token.permissions["checks"] === "write")).toEqual([]);
    expect(logs).toEqual([{ event: "summary_check.no_permission", fields: { taskId: TASK_ID, number: pr.number } }]);
    const asked = api().requests.length;
    // Every later pass inside the hour: no token mint, no request, no new log line, the same answer.
    for (let n = 0; n < 5; n += 1) expect(await syncSummaryCheck(deps, await passOf(ORG))).toBe("no_permission");
    expect(api().requests.length).toBe(asked);
    expect(logs).toHaveLength(1);
    // After the hour the install is asked once more (still refused: one more request, one more line).
    w.now.value += SUMMARY_CHECK_PERMISSION_RETRY_MS + 1;
    expect(await syncSummaryCheck(deps, await passOf(ORG))).toBe("no_permission");
    expect(api().requests.length).toBeGreaterThan(asked);
    expect(logs).toHaveLength(2);
    // Nothing else changed: the pull request itself is as it was.
    expect(pr.model.getChangeRequest(String(pr.number)).draft).toBe(false);
  });

  it("GitHub refusing the write itself (403) is the same soft answer", async () => {
    const { passOf, deps, logs, api } = await bridged({ refuseWrite: true });
    expect(await syncSummaryCheck(deps, await passOf(ORG))).toBe("no_permission");
    expect(api().checkRuns).toEqual([]);
    expect(logs.map((entry) => entry.event)).toEqual(["summary_check.no_permission"]);
  });
});
