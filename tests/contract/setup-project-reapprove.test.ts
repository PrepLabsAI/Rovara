import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { E2EPolicySchema, type E2EPolicy } from "@agentx/contracts";
import { addProject, reapproveProjectSetup } from "../../packages/cli/src/setup/project-add.js";
import { scriptedPrompter } from "../support/init-fakes.js";
import { CONTROL_PLANE, bindSetupSourceProvider, fakeControlPlane, fakeRepositories } from "../support/setup-fakes.js";

// M1.4 Task 4.9 step 4: an already registered project gets its setup proposed and approved again, so the approval pins the installation's AI navigation route
// (D5: the administrator consents to it with the same sentence `project add` shows).

const FOUNDATION = { Ec2WorkerLaunchTemplateId: "lt-0123456789abcdef0", Ec2WorkerSubnets: "us-east-1a=subnet-0aaa1111bbbb2222c,us-east-1b=subnet-0ddd3333eeee4444f" };
const SENTENCE = "AI navigation: Amazon Bedrock `us.anthropic.claude-haiku-5-5`; at most 8 actions per step; checks decide";
const PINNED = "r1-0123456789ab";
const session = { controlPlaneUrl: CONTROL_PLANE, accessToken: "admin-token" };
let configDir: string;
beforeEach(async () => { configDir = await mkdtemp(join(tmpdir(), "agentx-reapprove-")); });
afterEach(async () => { await rm(configDir, { recursive: true, force: true }); });

function setup(options: { pin?: boolean } = {}) {
  const plane = fakeControlPlane();
  const repositories = fakeRepositories({ "acme/payments-api": { files: { "package.json": JSON.stringify({ name: "payments-api", scripts: { test: "vitest run" } }), "package-lock.json": "{}" } } });
  bindSetupSourceProvider(plane, repositories);
  let pin = false;
  // Once `pin` is on, the control plane answers as an installation whose route is approvable: the policy pins a revision and the response says what it is.
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const response = await plane.fetch(url, init);
    const path = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url).pathname;
    if (!pin || path !== "/v1/admin/projects/setup-proposals") return response;
    const body = await response.json() as Record<string, unknown>;
    const stored = plane.setupProposals.get(String(body.proposalSha256))!;
    const policy = E2EPolicySchema.parse({ ...(body.policy as E2EPolicy), modelRouteRevision: options.pin === false ? null : PINNED });
    plane.setupProposals.set(String(body.proposalSha256), { ...stored, policy });
    return new Response(JSON.stringify({ ...body, policy, ...(options.pin === false ? {} : { aiNavigation: SENTENCE }) }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const services = { fetch, repositories, configDir, stackOutputs: async (name: string) => (name === "agentx-staging-foundation" ? FOUNDATION : undefined) };
  return { plane, services, pinNow: () => { pin = true; } };
}

async function registered(context: ReturnType<typeof setup>) {
  await addProject({ env: "staging", session, githubToken: "ghs_x", prompter: scriptedPrompter(["acme/payments-api", "", true]), write: () => undefined, services: context.services, flags: {} });
  expect(context.plane.registered).toHaveLength(1);
}

describe("agentx project setup-approve (re-approval of an already registered project)", () => {
  it("project add alone never proposes again for a registered project (why the re-approval path exists)", async () => {
    const context = setup();
    await registered(context);
    context.pinNow();
    const before = context.plane.requests.length;
    await addProject({ env: "staging", session, githubToken: "ghs_x", prompter: scriptedPrompter([]), write: () => undefined, services: context.services, flags: { repository: "acme/payments-api", projectName: "payments-api" } });
    expect(context.plane.requests.slice(before).map((request) => request.path)).toEqual([]);
  });

  it("re-proposes from the registered repository, shows the AI navigation sentence in the one confirmation, approves, and registers the next revision pinning the route", async () => {
    const context = setup();
    await registered(context);
    context.pinNow();
    const lines: string[] = [];
    const prompter = scriptedPrompter([true]);
    const result = await reapproveProjectSetup({ env: "staging", session, prompter, write: (line) => lines.push(line), services: context.services, projectName: "payments-api" });
    expect(result).toMatchObject({ name: "payments-api", revision: 2, decision: "approve", modelRouteRevision: PINNED });
    const proposed = context.plane.requests.filter((request) => request.path === "/v1/admin/projects/setup-proposals").at(-1);
    expect(proposed?.body).toEqual({ repositoryUrl: "https://github.com/acme/payments-api.git", ref: "main" });
    expect(lines.join("\n")).toContain(SENTENCE);
    const confirmation = prompter.asked.filter((question) => question.startsWith("Use this project setup plan?"));
    expect(confirmation).toHaveLength(1);
    expect(confirmation[0]).toContain(SENTENCE);
    const approval = context.plane.requests.filter((request) => request.path === "/v1/admin/projects/setup-approvals").at(-1);
    expect(approval?.body).toMatchObject({ projectName: "payments-api", decision: "approve" });
    expect(context.plane.registered).toHaveLength(2);
    const second = context.plane.registered[1] as { definition: { revision: number; e2e?: E2EPolicy; setup: unknown[]; readiness: unknown[] }; setupApproval?: { decision: string } };
    expect(second.definition.revision).toBe(2);
    expect(second.definition.e2e?.modelRouteRevision).toBe(PINNED);
    expect(second.setupApproval?.decision).toBe("approve");
    // The project's own commands are kept: only the setup approval is new.
    const first = context.plane.registered[0] as { definition: { setup: unknown[]; readiness: unknown[] } };
    expect(second.definition.setup).toEqual(first.definition.setup);
    expect(second.definition.readiness).toEqual(first.definition.readiness);
  });

  it("records a decline and registers nothing new", async () => {
    const context = setup();
    await registered(context);
    context.pinNow();
    const result = await reapproveProjectSetup({ env: "staging", session, prompter: scriptedPrompter([false]), write: () => undefined, services: context.services, projectName: "payments-api" });
    expect(result).toMatchObject({ name: "payments-api", revision: 1, decision: "decline", modelRouteRevision: null });
    expect(context.plane.requests.filter((request) => request.path === "/v1/admin/projects/setup-approvals").at(-1)?.body).toMatchObject({ decision: "decline" });
    expect(context.plane.registered).toHaveLength(1);
  });

  it("says when the setup pins no route, so the operator sees AI navigation will not run", async () => {
    const context = setup({ pin: false });
    await registered(context);
    context.pinNow();
    const lines: string[] = [];
    const result = await reapproveProjectSetup({ env: "staging", session, prompter: scriptedPrompter([true]), write: (line) => lines.push(line), services: context.services, projectName: "payments-api" });
    expect(result.modelRouteRevision).toBeNull();
    expect(lines.join("\n")).toMatch(/AI navigation steps will not run/);
  });

  it("refuses a project that is not registered here, before asking the control plane anything", async () => {
    const context = setup();
    await expect(reapproveProjectSetup({ env: "staging", session, prompter: scriptedPrompter([]), write: () => undefined, services: context.services, projectName: "payments-api" }))
      .rejects.toThrow("project payments-api is not registered from this machine");
    expect(context.plane.requests).toEqual([]);
  });

  it("refuses a malformed project name", async () => {
    const context = setup();
    await expect(reapproveProjectSetup({ env: "staging", session, prompter: scriptedPrompter([]), write: () => undefined, services: context.services, projectName: "Bad Name" }))
      .rejects.toThrow("is not valid");
  });

  it("does not ask for approval when the control plane cannot propose, and registers nothing", async () => {
    const context = setup();
    await registered(context);
    const broken = { ...context.services, fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url).pathname;
      if (path === "/v1/admin/projects/setup-proposals") return new Response(JSON.stringify({ error: { code: "RUNTIME_UNAVAILABLE", message: "unavailable" } }), { status: 503, headers: { "content-type": "application/json" } });
      return context.services.fetch(url, init);
    }) as typeof fetch };
    const prompter = scriptedPrompter([]);
    await expect(reapproveProjectSetup({ env: "staging", session, prompter, write: () => undefined, services: broken, projectName: "payments-api" })).rejects.toThrow();
    expect(prompter.asked).toEqual([]);
    expect(context.plane.registered).toHaveLength(1);
  });
});
