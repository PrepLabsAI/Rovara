// M7 slice 2 (decision 252b): GitHub's deployment facts as the code host adapter gives them. Two halves: the `deployment_status` delivery mapped to the neutral `deployment.status` event (signature first, nothing believed
// beyond which commit and environment to look at), and the read-only, bounded `deploymentStatuses` read over a fake GitHub HTTP server (tests/support/ports/github-fixture-api.ts; never the real GitHub). Every fake here proves
// the adapter's own mapping and bounds only; it does not prove GitHub answers this way.
import { describe, expect, it } from "vitest";
import { CodeHostEventSchema, DEPLOYMENT_STATES } from "@agentx/contracts";
import { FakeHostModel } from "@agentx/broker/fakes";
import { githubCodeHost } from "../../packages/broker/src/plugins/code-host/github/index.js";
import { DEPLOYMENT_STATES_OF_GITHUB, githubCodeHostEvents, neutralEventsOfGithub } from "../../packages/broker/src/plugins/code-host/github/events.js";
import { GITHUB_ORG_SCOPE, GITHUB_REPO_URL, GitHubFixtureApi, providerOver } from "../support/ports/github-fixture-api.js";
import { githubDelivery, githubPayloads, signGithubBody, webhookSecretReader } from "../support/ports/github-deliveries.js";

const SHA = "a".repeat(40);
const ID = "11111111-2222-4333-8444-555555555555";
const NOW = Date.parse("2026-10-30T10:00:00.000Z");

describe("the deployment_status delivery", () => {
  it.each([
    ["success", "success"], ["failure", "failure"], ["error", "failure"], ["pending", "in_progress"], ["queued", "in_progress"], ["in_progress", "in_progress"],
  ])("maps GitHub's %s to %s", (state, expected) => {
    const events = neutralEventsOfGithub("deployment_status", githubPayloads.deploymentStatus(state), ID);
    expect(events).toEqual([{ eventId: ID, host: "github", type: "deployment.status", repository: { url: "https://github.com/acme/app" }, revision: SHA, environment: "staging", state: expected }]);
    expect(CodeHostEventSchema.safeParse(events[0]).success).toBe(true);
  });

  it("says nothing for `inactive` (a newer deployment took over), for any state GitHub adds later, and for an action other than created", () => {
    for (const state of ["inactive", "waiting", "weird", "", "Success"]) {
      if (state === "") continue;
      expect(neutralEventsOfGithub("deployment_status", githubPayloads.deploymentStatus(state), ID), state).toEqual([]);
    }
    expect(neutralEventsOfGithub("deployment_status", githubPayloads.deploymentStatus("success", { action: "edited" }), ID)).toEqual([]);
  });

  it("never takes an inherited property name as a state", () => {
    for (const state of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
      expect(DEPLOYMENT_STATES_OF_GITHUB[state], state).toBeUndefined();
      expect(neutralEventsOfGithub("deployment_status", githubPayloads.deploymentStatus(state), ID), state).toEqual([]);
    }
  });

  it("takes the environment from the status, else from the deployment, and says nothing for one it cannot name", () => {
    expect((neutralEventsOfGithub("deployment_status", githubPayloads.deploymentStatus("success", { environment: null, deploymentEnvironment: "qa" }), ID)[0] as { environment: string }).environment).toBe("qa");
    expect((neutralEventsOfGithub("deployment_status", githubPayloads.deploymentStatus("success", { environment: "prod", deploymentEnvironment: "qa" }), ID)[0] as { environment: string }).environment).toBe("prod");
    expect(neutralEventsOfGithub("deployment_status", githubPayloads.deploymentStatus("success", { environment: null }), ID)).toEqual([]);
    expect(neutralEventsOfGithub("deployment_status", githubPayloads.deploymentStatus("success", { environment: "" }), ID)).toEqual([]);
    expect(neutralEventsOfGithub("deployment_status", githubPayloads.deploymentStatus("success", { environment: "e".repeat(65) }), ID)).toEqual([]);
    expect(neutralEventsOfGithub("deployment_status", githubPayloads.deploymentStatus("success", { environment: "e".repeat(64) }), ID)).toHaveLength(1);
  });

  it("builds the repository address from GitHub's own name, never from a url in the body", () => {
    const body = { ...githubPayloads.deploymentStatus("success"), repository: { id: 4242, full_name: "acme/app", html_url: "https://evil.example.test/x/y" }, deployment_status: { state: "success", environment: "staging", repository_url: "https://evil.example.test/x/y" } };
    expect((neutralEventsOfGithub("deployment_status", body, ID)[0] as { repository: { url: string } }).repository.url).toBe("https://github.com/acme/app");
  });

  it("refuses a body that does not read, with fixed words that echo nothing from it", () => {
    for (const body of [{}, { ...githubPayloads.deploymentStatus("success"), deployment: { id: 1, sha: "not-a-sha-canary" } }, { ...githubPayloads.deploymentStatus("success"), deployment_status: "canary-secret" }, { ...githubPayloads.deploymentStatus("success"), repository: { full_name: "no slash canary" } }]) {
      let message = "";
      try { neutralEventsOfGithub("deployment_status", body, ID); } catch (error) { message = (error as Error).message; }
      expect(message).not.toBe("");
      expect(message).not.toMatch(/canary/u);
    }
  });

  it("verifies the signature before it reads the body, and maps a verified delivery", async () => {
    const events = githubCodeHostEvents(webhookSecretReader());
    const delivery = githubDelivery("deployment_status", githubPayloads.deploymentStatus("success"), { deliveryId: ID });
    expect(await events.normalise!(delivery, GITHUB_ORG_SCOPE)).toHaveLength(1);
    const forged = githubDelivery("deployment_status", githubPayloads.deploymentStatus("success"), { deliveryId: ID, signature: signGithubBody("{}") });
    await expect(events.normalise!(forged, GITHUB_ORG_SCOPE)).rejects.toMatchObject({ code: "CALLBACK_FORBIDDEN" });
    const unreadable = githubDelivery("deployment_status", null, { deliveryId: ID, raw: "{not json canary" });
    await expect(events.normalise!(unreadable, GITHUB_ORG_SCOPE)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
});

function world() {
  const model = new FakeHostModel({ url: GITHUB_REPO_URL, id: "4242", fullName: "acme/app", webBase: "https://github.com" });
  const api = new GitHubFixtureApi(model);
  const provider = providerOver(api);
  const host = githubCodeHost(provider, { credentialRef: "github", now: () => NOW, webhookSecret: webhookSecretReader() });
  const sha = model.commit("feature/x", { "src/a.ts": "export const a = 1;\n" });
  return { model, api, provider, host, sha, repository: { url: GITHUB_REPO_URL } };
}

describe("the deploymentStatuses read", () => {
  it("is read only: a token with deployments and metadata read for this one repository, and nothing but GET requests besides the token mint", async () => {
    const { model, api, host, sha, repository } = world();
    model.setDeployment(sha, "staging", "success");
    await host.deploymentStatuses!(repository, sha, GITHUB_ORG_SCOPE);
    expect(api.tokens.at(-1)).toMatchObject({ permissions: { deployments: "read", metadata: "read" }, repositories: ["app"] });
    expect(Object.keys(api.tokens.at(-1)!.permissions).sort()).toEqual(["deployments", "metadata"]);
    const writes = api.requests.filter((request) => request.method !== "GET" && !/\/access_tokens$/u.test(request.path));
    expect(writes).toEqual([]);
  });

  it("reads one list and one status request per deployment (at most ten), each counted against the allowance", async () => {
    const { api, host, sha, repository } = world();
    api.deploymentReads.rows = Array.from({ length: 10 }, (_, index) => ({ id: 100 + index, environment: `env${String(index)}`, statuses: [{ state: "success" }] }));
    let counted = 0;
    const read = await host.deploymentStatuses!(repository, sha, GITHUB_ORG_SCOPE, { beforeRequest: () => { counted += 1; } });
    expect(read.statuses).toHaveLength(10);
    expect(counted).toBe(11);
    expect(api.requests.filter((request) => request.method === "GET" && /\/deployments/u.test(request.path))).toHaveLength(11);
  });

  it("stops when the allowance is used up, and the error is the budget's, not an empty answer", async () => {
    const { api, host, sha, repository } = world();
    api.deploymentReads.rows = [{ id: 1, environment: "a", statuses: [{ state: "success" }] }, { id: 2, environment: "b", statuses: [{ state: "success" }] }];
    let left = 2;
    const exhausted = new Error("allowance used up");
    await expect(host.deploymentStatuses!(repository, sha, GITHUB_ORG_SCOPE, { beforeRequest: () => { if (left === 0) throw exhausted; left -= 1; } })).rejects.toBe(exhausted);
  });

  it("takes the newest deployment (highest id) of an environment, skips `inactive`, and maps every state to the port's words", async () => {
    const { api, host, sha, repository } = world();
    api.deploymentReads.rows = [
      { id: 5, environment: "staging", statuses: [{ state: "failure" }] },
      { id: 9, environment: "staging", statuses: [{ state: "success" }] },
      { id: 7, environment: "production", statuses: [{ state: "inactive" }] },
      { id: 8, environment: "qa", statuses: [{ state: "error" }] },
      { id: 6, environment: "preview", statuses: [{ state: "queued" }] },
      { id: 4, environment: "other", statuses: [] },
    ];
    const read = await host.deploymentStatuses!(repository, sha, GITHUB_ORG_SCOPE);
    expect([...read.statuses].sort((a, b) => (a.environment < b.environment ? -1 : 1))).toEqual([
      { environment: "preview", state: "in_progress" }, { environment: "qa", state: "failure" }, { environment: "staging", state: "success" },
    ]);
    expect(read.complete).toBe(true);
    for (const state of DEPLOYMENT_STATES) expect(Object.values(DEPLOYMENT_STATES_OF_GITHUB)).toContain(state);
  });

  it("says the answer is not the whole of it when GitHub has another page, and when an environment cannot be named", async () => {
    const { api, host, sha, repository } = world();
    api.deploymentReads.rows = [{ id: 1, environment: "staging", statuses: [{ state: "success" }] }];
    api.deploymentReads.next = true;
    expect((await host.deploymentStatuses!(repository, sha, GITHUB_ORG_SCOPE)).complete).toBe(false);
    api.deploymentReads.next = false;
    api.deploymentReads.rows = [{ id: 1, environment: "e".repeat(65), statuses: [{ state: "success" }] }, { id: 2, environment: "ok", statuses: [{ state: "success" }] }];
    const read = await host.deploymentStatuses!(repository, sha, GITHUB_ORG_SCOPE);
    expect(read).toEqual({ statuses: [{ environment: "ok", state: "success" }], complete: false });
  });

  it("refuses to believe GitHub's filter: a deployment of another commit is an error, never a state", async () => {
    const { api, host, sha, repository } = world();
    api.deploymentReads.rows = [{ id: 1, sha: "b".repeat(40), environment: "staging", statuses: [{ state: "success" }] }];
    await expect(host.deploymentStatuses!(repository, sha, GITHUB_ORG_SCOPE)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });

  it("throws for a refused read (an App without the permission), never an empty answer", async () => {
    const { api, host, sha, repository } = world();
    api.deploymentReads.rows = [{ id: 1, environment: "staging", statuses: [{ state: "success" }] }];
    api.deploymentReads.listHttp = 403;
    await expect(host.deploymentStatuses!(repository, sha, GITHUB_ORG_SCOPE)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    api.deploymentReads.listHttp = undefined;
    api.deploymentReads.statusHttp = 404;
    await expect(host.deploymentStatuses!(repository, sha, GITHUB_ORG_SCOPE)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });

  it("refuses a malformed answer", async () => {
    const { api, host, sha, repository } = world();
    for (const rows of [[{ id: 0, environment: "x", statuses: [] }], [{ id: 1.5, environment: "x", statuses: [] }]]) {
      api.deploymentReads.rows = rows;
      await expect(host.deploymentStatuses!(repository, sha, GITHUB_ORG_SCOPE)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    }
  });

  it("refuses an invalid revision before any request, and a scope that names no company or system", async () => {
    const { api, host, repository } = world();
    for (const revision of ["", "abc", "A".repeat(40), `${"a".repeat(39)}/`, "../etc"]) {
      await expect(host.deploymentStatuses!(repository, revision, GITHUB_ORG_SCOPE), revision).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    }
    expect(api.requests).toEqual([]);
    await expect(host.deploymentStatuses!(repository, SHA, {} as never)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
});
