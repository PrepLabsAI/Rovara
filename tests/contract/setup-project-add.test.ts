import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { E2EPolicySchema, type E2EPolicy } from "@agentx/contracts";
import { inspectE2ERepository, proposeE2ESetup } from "../../packages/broker/src/e2e/discovery.js";
import { loadProjectConfig } from "../../packages/cli/src/config.js";
import { firstProjectStep } from "../../packages/cli/src/init/finish-steps.js";
import { executeCli } from "../../packages/cli/src/main.js";
import { realSetupContext, type SetupCommandContext, type SetupRun } from "../../packages/cli/src/setup/command-context.js";
import { unattendedPrompter } from "../../packages/cli/src/init/prompts.js";
import { addProject, ec2Binding, registerRevision } from "../../packages/cli/src/setup/project-add.js";
import { addConnectorRevision } from "../../packages/cli/src/setup/connectors/revision.js";
import { SETUP_TIMEOUT, TEST_TIMEOUT } from "../../packages/cli/src/setup/project-files.js";
import { fakeGitHubApi, initContext, memoryInitSecrets, progressHandle, scriptedPrompter, TEST_PRIVATE_KEY, type TestInitContext } from "../support/init-fakes.js";
import { MemoryParameterStore } from "../support/memory-parameter-store.js";
import { CONTROL_PLANE, STAGING_SETTINGS, accessToken, bindSetupSourceProvider, fakeControlPlane, fakeRepositories, fakeSlackChannels, memoryTokenStore, setupServices } from "../support/setup-fakes.js";

const FOUNDATION = { Ec2WorkerLaunchTemplateId: "lt-0123456789abcdef0", Ec2WorkerSubnets: "us-east-1a=subnet-0aaa1111bbbb2222c,us-east-1b=subnet-0ddd3333eeee4444f" };
let configDir: string;
beforeEach(async () => { configDir = await mkdtemp(join(tmpdir(), "agentx-projects-")); });
afterEach(async () => { await rm(configDir, { recursive: true, force: true }); });

const repositoriesFake = () => fakeRepositories({
  "acme/payments-api": { files: { "package.json": JSON.stringify({ name: "payments-api", scripts: { test: "vitest run" } }), "package-lock.json": "{}" } },
  "acme/docs": { files: {} },
});
const services = (plane = fakeControlPlane(), repositories = repositoriesFake()) => {
  bindSetupSourceProvider(plane, repositories);
  return { fetch: plane.fetch, repositories, configDir, stackOutputs: async (name: string) => (name === "agentx-staging-foundation" ? FOUNDATION : undefined) };
};
const session = { controlPlaneUrl: CONTROL_PLANE, accessToken: "admin-token" };
const sourceBackedSetup = async (bytes: Buffer) => {
  const repositories = fakeRepositories({ "acme/payments-api": { files: { "package.json": bytes.toString("utf8"), "package-lock.json": "{}" } } });
  const snapshot = await repositories.snapshotAll("synthetic-source-read", "acme/payments-api", "main");
  const candidate = snapshot.candidate;
  const inspection = inspectE2ERepository(snapshot, candidate).inspection;
  const proposal = proposeE2ESetup({ inspection, snapshot, expectedCandidate: candidate });
  const policy: E2EPolicy = { schemaVersion: 1, policyRevision: 1, executionMode: "trusted-scenarios", baselineScenarioIds: [], targets: proposal.targets, defaultSandboxProfileId: "default-sandbox", fallback: "mock-unconnected", modelRouteRevision: null, capture: { screenshots: false, traces: false, video: false, downloads: false }, limits: { runTimeoutMs: 60_000, startupTimeoutMs: 10_000, preparationTimeoutMs: 10_000, caseTimeoutMs: 10_000, maxActionsPerCase: 10, maxModelRequests: 1, maxInputTokens: 1, maxOutputTokens: 1, maxSpendUsd: null } };
  return { proposal, policy, snapshot, repositories };
};

describe("the ec2-ebs binding from the foundation's outputs", () => {
  it("uses the launch template and every zone's subnet, 20 GiB gp3", () => {
    expect(ec2Binding(FOUNDATION, "agentx-staging-foundation")).toEqual({
      deploymentMode: "ec2-ebs", launchTemplateId: "lt-0123456789abcdef0",
      subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0aaa1111bbbb2222c" }, { availabilityZone: "us-east-1b", subnetId: "subnet-0ddd3333eeee4444f" }],
      volumeSizeGiB: 20, volumeType: "gp3",
    });
  });

  it("says which output is missing and what to do", () => {
    expect(() => ec2Binding({}, "agentx-staging-foundation")).toThrow("stack agentx-staging-foundation has no Ec2WorkerLaunchTemplateId output; upgrade the environment to a release with EC2 workers, then run this again");
    expect(() => ec2Binding({ Ec2WorkerLaunchTemplateId: FOUNDATION.Ec2WorkerLaunchTemplateId }, "agentx-staging-foundation")).toThrow("stack agentx-staging-foundation has no Ec2WorkerSubnets output");
  });

  it("says when the foundation stack does not exist at all, rather than blaming a missing output", () => {
    expect(() => ec2Binding(undefined, "agentx-staging-foundation")).toThrow("stack agentx-staging-foundation does not exist in this account and region; check --env and --region, or finish agentx init first");
  });
});

describe("agentx project add (FR-040)", () => {
  it("offers the repositories, proposes the commands, registers revision 1 on ec2-ebs and writes the file", async () => {
    const plane = fakeControlPlane();
    // repository, project name (default), use the proposed commands
    const prompter = scriptedPrompter(["acme/payments-api", "", true]);
    const lines: string[] = [];
    const result = await addProject({ env: "staging", session, githubToken: "ghs_x", prompter, write: (line) => lines.push(line), services: services(plane), flags: {} });
    expect(result).toEqual({ name: "payments-api", revision: 1, file: join(configDir, "payments-api.yaml") });
    const sent = plane.registered[0] as { definition: Record<string, unknown>; runtimeBinding: { deploymentMode: string } };
    expect(sent.runtimeBinding.deploymentMode).toBe("ec2-ebs");
    expect(sent.definition).toMatchObject({
      name: "payments-api", revision: 1,
      repositories: [{ name: "payments-api", url: "https://github.com/acme/payments-api.git", path: "repo/payments-api", defaultBranch: "main", credentialRef: "github-agentx-sdlc" }],
      setup: [{ executable: "npm", args: ["ci"] }], readiness: [{ executable: "npm", args: ["test"] }],
    });
    expect(lines.join("\n")).toContain("Detected source-backed E2E setup.");
    const file = await readFile(result.file, "utf8");
    expect(file).toContain("name: payments-api");
    expect(file).not.toContain("admin-token");
    expect(file).not.toContain("ghs_x");
  });

  it("registers a source-backed E2E setup proposal after one plan confirmation and asks for no typed commands", async () => {
    const plane = fakeControlPlane();
    const bytes = Buffer.from(JSON.stringify({ name: "payments-api", scripts: { test: "vitest run" } }));
    const { proposal, policy, snapshot, repositories } = await sourceBackedSetup(bytes);
    const prompter = scriptedPrompter(["acme/payments-api", "", true]);
    await addProject({ env: "staging", session, githubToken: "ghs_x", prompter, write: () => undefined, services: services(plane, repositories), flags: {}, e2eSetup: { proposal, policy, snapshot } });
    const definition = (plane.registered[0] as { definition: { e2e?: E2EPolicy } }).definition;
    expect(definition.e2e).toEqual(policy);
    expect(prompter.asked.some((question) => question.startsWith("Setup command") || question.startsWith("Test command"))).toBe(false);
    expect(prompter.asked.filter((question) => question.startsWith("Use this project setup plan?")).length).toBe(1);
  });

  describe("AI navigation consent (D5, M1.4 Task 4.2)", () => {
    const SENTENCE = "AI navigation: Anthropic `claude-haiku-5-5`; at most 8 actions per step; checks decide";
    /** The control plane's proposal, as an installation with an AI navigation route would answer it: the policy pins a revision and the response says what it is. */
    async function pinned(options: { sentence?: unknown; pin?: boolean } = {}) {
      const plane = fakeControlPlane();
      const bytes = Buffer.from(JSON.stringify({ name: "payments-api", scripts: { test: "vitest run" } }));
      const { proposal, policy, snapshot, repositories } = await sourceBackedSetup(bytes);
      const pinnedPolicy = E2EPolicySchema.parse({ ...policy, modelRouteRevision: options.pin === false ? null : "r1-0123456789ab" });
      const base = services(plane, repositories);
      const wrapped = { ...base, fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        const response = await plane.fetch(url, init);
        const path = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url).pathname;
        if (path !== "/v1/admin/projects/setup-proposals") return response;
        const body = await response.json() as Record<string, unknown>;
        const stored = plane.setupProposals.get(String(body.proposalSha256))!;
        plane.setupProposals.set(String(body.proposalSha256), { ...stored, policy: pinnedPolicy });
        return new Response(JSON.stringify({ ...body, policy: pinnedPolicy, ...(options.sentence === undefined ? {} : { aiNavigation: options.sentence }) }), { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch };
      return { plane, wrapped, proposal, policy: pinnedPolicy, snapshot };
    }

    it("shows the administrator the AI navigation sentence, in the output and in the one confirmation they answer", async () => {
      const { plane, wrapped, proposal, policy, snapshot } = await pinned({ sentence: SENTENCE });
      const lines: string[] = [];
      const prompter = scriptedPrompter(["acme/payments-api", "", true]);
      await addProject({ env: "staging", session, githubToken: "ghs_x", prompter, write: (line) => lines.push(line), services: wrapped, flags: {}, e2eSetup: { proposal, policy, snapshot } });
      expect(lines.join("\n")).toContain(SENTENCE);
      const confirmation = prompter.asked.filter((question) => question.startsWith("Use this project setup plan?"));
      expect(confirmation).toHaveLength(1);
      expect(confirmation[0]).toContain(SENTENCE);
      expect(plane.requests.some((request) => request.path === "/v1/admin/projects/setup-approvals")).toBe(true);
    });

    it("does not ask for approval of a setup whose policy pins a route that the response does not describe", async () => {
      const { plane, wrapped, proposal, policy, snapshot } = await pinned();
      const lines: string[] = [];
      await addProject({ env: "staging", session, githubToken: "ghs_x", prompter: scriptedPrompter(["acme/payments-api", "", true]), write: (line) => lines.push(line), services: wrapped,
        flags: { setupCommand: "npm ci", testCommand: "npm test" } });
      expect(plane.requests.some((request) => request.path === "/v1/admin/projects/setup-approvals")).toBe(false);
      expect(lines.join("\n")).toContain("source-backed proposal was malformed or unbound");
      void proposal; void policy; void snapshot;
    });

    it("says that AI navigation steps will not run when the setup pins no route", async () => {
      const plane = fakeControlPlane();
      const bytes = Buffer.from(JSON.stringify({ name: "payments-api", scripts: { test: "vitest run" } }));
      const { proposal, policy, snapshot, repositories } = await sourceBackedSetup(bytes);
      const lines: string[] = [];
      await addProject({ env: "staging", session, githubToken: "ghs_x", prompter: scriptedPrompter(["acme/payments-api", "", true]), write: (line) => lines.push(line), services: services(plane, repositories),
        flags: {}, e2eSetup: { proposal, policy, snapshot } });
      expect(lines.join("\n")).toMatch(/AI navigation steps will not run/);
    });
  });

  it("does not register E2E enablement when the single setup-plan confirmation is declined", async () => {
    const plane = fakeControlPlane();
    const bytes = Buffer.from(JSON.stringify({ name: "payments-api", scripts: { test: "vitest run" } }));
    const { proposal, policy, snapshot, repositories } = await sourceBackedSetup(bytes);
    await addProject({ env: "staging", session, githubToken: "ghs_x", prompter: scriptedPrompter(["acme/payments-api", "", false]), write: () => undefined, services: services(plane, repositories), flags: {}, e2eSetup: { proposal, policy, snapshot } });
    const definition = (plane.registered[0] as { definition: { e2e?: E2EPolicy; setup: unknown[]; readiness: unknown[] } }).definition;
    expect(definition.e2e).toBeUndefined();
    // RUN-5: declining drops only the E2E part. The project keeps the commands it was proposed.
    expect(definition.setup).toMatchObject([{ executable: "npm", args: ["ci"] }]);
    expect(definition.readiness).toMatchObject([{ executable: "npm", args: ["test"] }]);
  });

  // Evaluation fix RUN-5: the decline used to erase the commands, including the ones the user typed as flags, and said only "Registered project X".
  it("keeps the commands the user passed as flags when the setup plan is declined, records the decline, and says the commands were kept", async () => {
    const plane = fakeControlPlane();
    const bytes = Buffer.from(JSON.stringify({ name: "payments-api", scripts: { test: "vitest run" } }));
    const { proposal, policy, snapshot, repositories } = await sourceBackedSetup(bytes);
    const lines: string[] = [];
    await addProject({ env: "staging", session, githubToken: "ghs_x", prompter: scriptedPrompter([false]), write: (line) => lines.push(line), services: services(plane, repositories),
      flags: { repository: "acme/payments-api", projectName: "payments-api", setupCommand: "pnpm install", testCommand: "make check" }, e2eSetup: { proposal, policy, snapshot } });
    const registration = plane.registered[0] as { definition: { e2e?: E2EPolicy; setup: Array<{ executable: string; args: string[] }>; readiness: Array<{ executable: string; args: string[] }> }; setupApproval?: { decision: string } };
    expect(registration.definition.e2e).toBeUndefined();
    expect(registration.definition.setup).toMatchObject([{ executable: "pnpm", args: ["install"] }]);
    expect(registration.definition.readiness).toMatchObject([{ executable: "make", args: ["check"] }]);
    expect(registration.setupApproval).toMatchObject({ decision: "decline" });
    expect(plane.requests.filter((request) => request.path === "/v1/admin/projects/setup-approvals").map((request) => (request.body as { decision: string }).decision)).toEqual(["decline"]);
    expect(lines.join("\n")).toContain("Browser and API checks are off for payments-api; its setup command (pnpm install) and test command (make check) are kept.");
  });

  it("says no commands were set when the plan is declined and the project has none", async () => {
    const plane = fakeControlPlane();
    const lines: string[] = [];
    await addProject({ env: "staging", session, githubToken: "ghs_x", prompter: scriptedPrompter([false]), write: (line) => lines.push(line), services: services(plane),
      flags: { repository: "acme/docs", projectName: "docs", setupCommand: "", testCommand: "" } });
    expect(lines.join("\n")).toContain("Browser and API checks are off for docs; it has no setup or test command.");
  });

  it("connects the project when bounded source testing exploration is unavailable, and keeps the missing evidence visible", async () => {
    const plane = fakeControlPlane();
    const base = services(plane);
    const unavailable = { ...base, fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url).pathname;
      if (path === "/v1/admin/projects/setup-proposals") {
        return new Response(JSON.stringify({ error: { code: "RUNTIME_UNAVAILABLE", message: "selected immutable source set exceeds 4 MiB" } }), { status: 503, headers: { "content-type": "application/json" } });
      }
      return plane.fetch(url, init);
    }) as typeof fetch };
    const lines: string[] = [];
    await addProject({ env: "staging", session, githubToken: "ghs_x", prompter: scriptedPrompter([true]), write: (line) => lines.push(line), services: unavailable,
      flags: { repository: "acme/payments-api", projectName: "payments-api", setupCommand: "npm ci", testCommand: "npm test" } });
    const registration = plane.registered[0] as { definition: { setup: unknown[]; readiness: unknown[]; e2e?: unknown }; setupApproval?: unknown };
    expect(registration.definition).toMatchObject({ setup: [{ executable: "npm", args: ["ci"] }], readiness: [{ executable: "npm", args: ["test"] }] });
    expect(registration.definition.e2e).toBeUndefined();
    expect(registration.setupApproval).toBeUndefined();
    expect(plane.requests.some((request) => request.path === "/v1/admin/projects/setup-approvals")).toBe(false);
    expect(lines.join("\n")).toContain("Testing exploration not done: source capture exceeded its time or size bound, or the discovery service was unavailable; E2E evidence remains unknown.");
    expect(lines.findIndex((line) => line.startsWith("Registered project payments-api"))).toBeLessThan(lines.findIndex((line) => line.startsWith("Testing exploration not done:")));
    expect(lines.join("\n")).toContain("Registered project payments-api");
  });

  it("does not treat setup-discovery authorization failures as an unavailable exploration", async () => {
    const plane = fakeControlPlane();
    const base = services(plane);
    const forbidden = { ...base, fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url).pathname;
      if (path === "/v1/admin/projects/setup-proposals") {
        return new Response(JSON.stringify({ error: { code: "FORBIDDEN", message: "administrator claim is required" } }), { status: 403, headers: { "content-type": "application/json" } });
      }
      return plane.fetch(url, init);
    }) as typeof fetch };
    await expect(addProject({ env: "staging", session, githubToken: "ghs_x", prompter: scriptedPrompter([]), write: () => undefined, services: forbidden,
      flags: { repository: "acme/payments-api", projectName: "payments-api", setupCommand: "npm ci", testCommand: "npm test" } })).rejects.toThrow("FORBIDDEN");
    expect(plane.registered).toEqual([]);
  });

  it("does not degrade an HTTP authentication failure with an untrusted error code", async () => {
    const plane = fakeControlPlane();
    const base = services(plane);
    const unauthorized = { ...base, fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url).pathname;
      if (path === "/v1/admin/projects/setup-proposals") {
        return new Response(JSON.stringify({ error: { code: "RUNTIME_UNAVAILABLE", message: "authentication required" } }), { status: 401, headers: { "content-type": "application/json" } });
      }
      return plane.fetch(url, init);
    }) as typeof fetch };
    await expect(addProject({ env: "staging", session, githubToken: "ghs_x", prompter: scriptedPrompter([]), write: () => undefined, services: unauthorized,
      flags: { repository: "acme/payments-api", projectName: "payments-api", setupCommand: "npm ci", testCommand: "npm test" } })).rejects.toThrow("AUTH_REQUIRED");
    expect(plane.registered).toEqual([]);
  });

  it("continues configured project setup after a source-capture transport error without exposing its raw text", async () => {
    const plane = fakeControlPlane();
    const base = services(plane);
    const unavailable = { ...base, fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url).pathname;
      if (path === "/v1/admin/projects/setup-proposals") {
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        throw new TypeError("transport included credential=private-value");
      }
      return plane.fetch(url, init);
    }) as typeof fetch };
    const lines: string[] = [];
    await addProject({ env: "staging", session, githubToken: "ghs_x", prompter: scriptedPrompter([true]), write: (line) => lines.push(line), services: unavailable,
      flags: { repository: "acme/payments-api", projectName: "payments-api", setupCommand: "npm ci", testCommand: "npm test" } });
    expect(plane.registered).toHaveLength(1);
    expect(lines.join("\n")).not.toContain("private-value");
    expect(lines.join("\n")).toContain("E2E evidence remains unknown.");
  });

  it.each([
    ["QUEUED", "Warning: E2E testing setup was queued; project registration is complete, but testing is not ready."],
    ["UNAVAILABLE", "Warning: E2E testing setup is unavailable; project registration is complete, but testing is not ready."],
  ])("reports a registered project separately from E2E setup execution (%s)", async (setupRuntime, notice) => {
    const plane = fakeControlPlane();
    const base = services(plane);
    const setupUnavailable = { ...base, fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      const response = await plane.fetch(url, init);
      const path = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url).pathname;
      if (path !== "/v1/admin/projects" || !response.ok) return response;
      const body = await response.json() as Record<string, unknown>;
      return new Response(JSON.stringify({ ...body, setupRuntime }), { status: response.status, headers: { "content-type": "application/json" } });
    }) as typeof fetch };
    const { proposal, policy, snapshot, repositories } = await sourceBackedSetup(Buffer.from(JSON.stringify({ name: "payments-api", scripts: { test: "vitest run" } })));
    const servicesWithRuntimeNotice = { ...setupUnavailable, repositories };
    const lines: string[] = [];
    await addProject({ env: "staging", session, githubToken: "ghs_x", prompter: scriptedPrompter(["acme/payments-api", "", true]), write: (line) => lines.push(line), services: servicesWithRuntimeNotice, flags: {}, e2eSetup: { proposal, policy, snapshot } });
    expect(lines.join("\n")).toContain(notice);
    expect(lines.join("\n")).toContain("Registered project payments-api");
  });

  it("quarantines malformed proposal evidence and completes ordinary project setup", async () => {
    const plane = fakeControlPlane();
    const base = services(plane);
    const malformed = { ...base, fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url).pathname;
      if (path === "/v1/admin/projects/setup-proposals") return new Response(JSON.stringify({ proposal: {} }), { status: 200, headers: { "content-type": "application/json" } });
      return plane.fetch(url, init);
    }) as typeof fetch };
    const lines: string[] = [];
    await addProject({ env: "staging", session, githubToken: "ghs_x", prompter: scriptedPrompter([true]), write: (line) => lines.push(line), services: malformed,
      flags: { repository: "acme/payments-api", projectName: "payments-api", setupCommand: "npm ci", testCommand: "npm test" } });
    const registration = plane.registered[0] as { definition: { e2e?: unknown }; setupApproval?: unknown };
    expect(registration.definition.e2e).toBeUndefined();
    expect(registration.setupApproval).toBeUndefined();
    expect(plane.requests.some((request) => request.path === "/v1/admin/projects/setup-approvals")).toBe(false);
    expect(lines.join("\n")).toContain("Testing exploration not done: source-backed proposal was malformed or unbound; E2E evidence remains unknown.");
  });

  it("quarantines an unbound proposal digest without registering its policy", async () => {
    const plane = fakeControlPlane();
    const base = services(plane);
    const unbound = { ...base, fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      const response = await plane.fetch(url, init);
      const path = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url).pathname;
      if (path !== "/v1/admin/projects/setup-proposals" || !response.ok) return response;
      const body = await response.json() as Record<string, unknown>;
      return new Response(JSON.stringify({ ...body, candidateDigest: "f".repeat(64) }), { status: response.status, headers: { "content-type": "application/json" } });
    }) as typeof fetch };
    const lines: string[] = [];
    await addProject({ env: "staging", session, githubToken: "ghs_x", prompter: scriptedPrompter(["acme/payments-api", "", true]), write: (line) => lines.push(line), services: unbound, flags: {} });
    const registration = plane.registered[0] as { definition: { e2e?: unknown }; setupApproval?: unknown };
    expect(registration.definition.e2e).toBeUndefined();
    expect(registration.setupApproval).toBeUndefined();
    expect(plane.requests.some((request) => request.path === "/v1/admin/projects/setup-approvals")).toBe(false);
    expect(lines.join("\n")).toContain("Testing exploration not done: source-backed proposal was malformed or unbound; E2E evidence remains unknown.");
  });

  it.each([
    ["invalid JSON", "{"],
    ["null", "null"],
    ["array", "[]"],
    ["primitive", "42"],
  ])("quarantines an HTTP-200 %s discovery response and completes ordinary project setup", async (_label, responseText) => {
    const plane = fakeControlPlane();
    const base = services(plane);
    const malformed = { ...base, fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url).pathname;
      if (path === "/v1/admin/projects/setup-proposals") return new Response(responseText, { status: 200, headers: { "content-type": "application/json" } });
      return plane.fetch(url, init);
    }) as typeof fetch };
    const lines: string[] = [];
    await addProject({ env: "staging", session, githubToken: "ghs_x", prompter: scriptedPrompter([true]), write: (line) => lines.push(line), services: malformed,
      flags: { repository: "acme/payments-api", projectName: "payments-api", setupCommand: "npm ci", testCommand: "npm test" } });
    const registration = plane.registered[0] as { definition: { e2e?: unknown }; setupApproval?: unknown };
    expect(registration.definition.e2e).toBeUndefined();
    expect(registration.setupApproval).toBeUndefined();
    expect(plane.requests.some((request) => request.path === "/v1/admin/projects/setup-approvals")).toBe(false);
    expect(lines.join("\n")).toContain("Testing exploration not done: source-backed proposal was malformed or unbound; E2E evidence remains unknown.");
  });

  it("does not carry a declined setup decision into a later non-E2E connector revision", async () => {
    const plane = fakeControlPlane();
    await addProject({ env: "staging", session, githubToken: "ghs_x", prompter: scriptedPrompter(["acme/payments-api", "", false]), write: () => undefined, services: services(plane), flags: {} });
    const result = await addConnectorRevision({
      env: "staging", session, projectName: "payments-api", services: { fetch: plane.fetch, configDir, stackOutputs: async () => FOUNDATION },
      write: () => undefined, rerun: "agentx --env staging connector add linear --project payments-api",
      connector: { name: "linear", type: "linear", credentialRef: "linear", scopes: [{ alias: "pay", teamId: "c408e946-78aa-4db8-923e-f78053dd954f" }], tools: [{ name: "list_issues", access: "read" }] },
    });
    expect(result).toEqual({ revision: 2 });
    expect(plane.registered.at(-1)).toMatchObject({ definition: { revision: 2 } });
    expect((plane.registered.at(-1) as { definition: { e2e?: unknown } }).definition.e2e).toBeUndefined();
    expect((plane.registered.at(-1) as { setupApproval?: unknown }).setupApproval).toBeUndefined();
  });

  it("writes a file agentx admin project register --file reads back, whose header gives the whole register command (F27)", async () => {
    const result = await addProject({ env: "staging", session, githubToken: "ghs_x", prompter: scriptedPrompter(["acme/payments-api", "", true]), write: () => undefined, services: services(), flags: {} });
    const file = await readFile(result.file, "utf8");
    expect(file).toContain(`agentx admin project register --env staging --file ${result.file} --deployment-mode ec2-ebs --launch-template-id lt-0123456789abcdef0 --subnets us-east-1a=subnet-0aaa1111bbbb2222c,us-east-1b=subnet-0ddd3333eeee4444f`);
    expect(file).toContain("agentx connector add");
    const loaded = await loadProjectConfig({ projectName: "payments-api", configDirectory: configDir });
    expect(loaded).toMatchObject({ name: "payments-api", revision: 1 });
  });

  it("uses the shared timeouts for the proposed and the typed commands (F22)", async () => {
    const plane = fakeControlPlane();
    await addProject({ env: "staging", session, githubToken: "ghs_x", prompter: scriptedPrompter(["acme/payments-api", "", true]), write: () => undefined, services: services(plane), flags: {} });
    const definition = (plane.registered[0] as { definition: { setup: Array<{ timeoutSeconds: number }>; readiness: Array<{ timeoutSeconds: number }> } }).definition;
    expect(definition.setup[0]!.timeoutSeconds).toBe(SETUP_TIMEOUT);
    expect(definition.readiness[0]!.timeoutSeconds).toBe(TEST_TIMEOUT);
  });

  it("uses command flags while still asking for the source-backed setup-plan decision", async () => {
    const plane = fakeControlPlane();
    const prompter = scriptedPrompter([true]);
    const result = await addProject({
      env: "staging", session, githubToken: "ghs_x", prompter, write: () => undefined, services: services(plane),
      flags: { repository: "acme/docs", projectName: "docs", setupCommand: "", testCommand: "make check" },
    });
    expect(result.name).toBe("docs");
    expect(prompter.asked).toHaveLength(1);
    expect(prompter.asked[0]).toContain("Use this project setup plan?");
    expect((plane.registered[0] as { definition: { setup: unknown[]; readiness: Array<{ executable: string }> } }).definition.setup).toEqual([]);
    expect((plane.registered[0] as { definition: { readiness: Array<{ executable: string; args: string[] }> } }).definition.readiness).toMatchObject([{ executable: "make", args: ["check"] }]);
  });

  it("keeps the proposed ordinary commands when the owner declines the source-backed plan (RUN-5; they used to be erased)", async () => {
    const plane = fakeControlPlane();
    await addProject({ env: "staging", session, githubToken: "ghs_x", prompter: scriptedPrompter(["acme/payments-api", "", false]), write: () => undefined, services: services(plane), flags: {} });
    expect((plane.registered[0] as { definition: { setup: unknown[]; readiness: unknown[]; e2e?: unknown } }).definition).toMatchObject({ setup: [{ executable: "npm", args: ["ci"] }], readiness: [{ executable: "npm", args: ["test"] }] });
    expect((plane.registered[0] as { definition: { e2e?: unknown } }).definition.e2e).toBeUndefined();
  });

  it("keeps empty-target obligations visible when no build file is known", async () => {
    const plane = fakeControlPlane();
    const prompter = scriptedPrompter(["acme/docs", "", true]);
    await addProject({ env: "staging", session, githubToken: "ghs_x", prompter, write: () => undefined, services: services(plane), flags: {} });
    expect(prompter.asked.some((question) => question.includes("no targets detected (no package.json found; browser and API checks need a Node 22 app, see docs/e2e-onboarding.md, Supported stacks)"))).toBe(true);
    expect((plane.registered[0] as { definition: { setup: unknown[]; readiness: unknown[]; e2e?: E2EPolicy } }).definition).toMatchObject({ setup: [], readiness: [], e2e: { targets: [] } });
  });

  it("refuses a repository the app cannot see, naming the ones it can", async () => {
    await expect(addProject({ env: "staging", session, githubToken: "ghs_x", prompter: scriptedPrompter([]), write: () => undefined, services: services(), flags: { repository: "acme/secret" } }))
      .rejects.toThrow("the GitHub App cannot see acme/secret; it sees acme/payments-api, acme/docs. Add the repository to the app's installation, or choose one of those");
  });

  it("refuses a --project-name that is not a project name, before anything is registered or written", async () => {
    const plane = fakeControlPlane();
    await expect(addProject({ env: "staging", session, githubToken: "ghs_x", prompter: scriptedPrompter([]), write: () => undefined, services: services(plane), flags: { repository: "acme/docs", projectName: "../escape", setupCommand: "", testCommand: "" } }))
      .rejects.toThrow('--project-name "../escape" is not valid; a project name is 1 to 63 lowercase letters, digits and hyphens, starting with a letter');
    expect(plane.registered).toEqual([]);
  });

  it("refuses when the app sees no repository, saying where to choose some", async () => {
    await expect(addProject({ env: "staging", session, githubToken: "ghs_x", prompter: scriptedPrompter([]), write: () => undefined, services: services(fakeControlPlane(), fakeRepositories({})), flags: {} }))
      .rejects.toThrow("the GitHub App sees no repositories; choose at least one in the app's installation settings, then run this again");
  });

  it("refuses when the control plane lists no GitHub App credential, before registering", async () => {
    const plane = fakeControlPlane();
    plane.credentials.length = 0;
    await expect(addProject({ env: "staging", session, githubToken: "ghs_x", prompter: scriptedPrompter([true]), write: () => undefined, services: services(plane), flags: { repository: "acme/docs", projectName: "docs", setupCommand: "", testCommand: "" } }))
      .rejects.toThrow("the control plane lists no GitHub App credential; check the control-plane stack's GitHubAppId parameter");
    expect(plane.registered).toEqual([]);
  });

  it("registers no second revision when run again with the same answers, and asks GitHub and the control plane nothing (fix round 1)", async () => {
    const plane = fakeControlPlane();
    const flags = { repository: "acme/payments-api", projectName: "payments-api", setupCommand: "npm ci", testCommand: "npm test" };
    const first = await addProject({ env: "staging", session, githubToken: "ghs_x", prompter: scriptedPrompter([true]), write: () => undefined, services: services(plane), flags });
    const requestsBefore = plane.requests.length;
    const repositories = repositoriesFake();
    let listed = 0;
    const counting = { ...repositories, list: async (token: string) => { listed += 1; return repositories.list(token); } };
    const lines: string[] = [];
    const again = await addProject({ env: "staging", session, githubToken: "ghs_x", prompter: scriptedPrompter([]), write: (line) => lines.push(line), services: services(plane, counting), flags });
    expect(again).toEqual(first);
    expect(plane.registered).toHaveLength(1);
    expect(plane.requests.length).toBe(requestsBefore);
    expect(listed).toBe(0);
    expect(repositories.reads).toEqual([]);
    expect(lines.join("\n")).toContain("Project payments-api is already registered (revision 1) with these settings; nothing to change.");
  });

  it("an interactive rerun names the same repository and project, and registers nothing", async () => {
    const plane = fakeControlPlane();
    await addProject({ env: "staging", session, githubToken: "ghs_x", prompter: scriptedPrompter(["acme/payments-api", "", true]), write: () => undefined, services: services(plane), flags: {} });
    const again = await addProject({ env: "staging", session, githubToken: "ghs_x", prompter: scriptedPrompter(["acme/payments-api", ""]), write: () => undefined, services: services(plane), flags: {} });
    expect(again.revision).toBe(1);
    expect(plane.registered).toHaveLength(1);
  });

  it("refuses when a file at the project's path is not an AgentX project file (fix round 1)", async () => {
    const plane = fakeControlPlane();
    await writeFile(join(configDir, "docs.yaml"), "just: some notes\n");
    await expect(addProject({ env: "staging", session, githubToken: "ghs_x", prompter: scriptedPrompter([]), write: () => undefined, services: services(plane), flags: { repository: "acme/docs", projectName: "docs", setupCommand: "", testCommand: "" } }))
      .rejects.toThrow(`a file already exists at ${join(configDir, "docs.yaml")} that is not an AgentX project file; move it or choose another --project-name`);
    expect(plane.registered).toEqual([]);
  });

  it("with --yes, refuses to guess among several repositories, naming --repository and some of them (fix round 1)", async () => {
    const many = fakeRepositories(Object.fromEntries(["acme/a1", "acme/a2", "acme/a3", "acme/a4", "acme/a5", "acme/a6", "acme/a7"].map((name) => [name, { files: {} }])));
    const plane = fakeControlPlane();
    await expect(addProject({ env: "staging", session, githubToken: "ghs_x", prompter: unattendedPrompter(), write: () => undefined, services: services(plane, many), flags: {} }))
      .rejects.toThrow("the GitHub App sees 7 repositories (for example acme/a1, acme/a2, acme/a3, acme/a4, acme/a5, and 2 more); pass --repository <owner/name> to choose the first project's");
    expect(plane.registered).toEqual([]);
  });

  it("with --yes, takes the only repository the app sees", async () => {
    const plane = fakeControlPlane();
    const one = fakeRepositories({ "acme/docs": { files: {} } });
    const result = await addProject({ env: "staging", session, githubToken: "ghs_x", prompter: unattendedPrompter(), write: () => undefined, services: services(plane, one), flags: {} });
    expect(result.name).toBe("docs");
    expect(plane.registered).toHaveLength(1);
  });

  it("refuses to overwrite an existing project with different answers, saying how to change it", async () => {
    const plane = fakeControlPlane();
    await addProject({ env: "staging", session, githubToken: "ghs_x", prompter: scriptedPrompter(["", true]), write: () => undefined, services: services(plane), flags: { repository: "acme/payments-api", setupCommand: "npm ci", testCommand: "npm test" } });
    await expect(addProject({ env: "staging", session, githubToken: "ghs_x", prompter: scriptedPrompter([""]), write: () => undefined, services: services(plane), flags: { repository: "acme/payments-api", setupCommand: "npm install", testCommand: "npm test" } }))
      .rejects.toThrow(`project payments-api already exists (${join(configDir, "payments-api.yaml")}) with a different setup command; to change it, edit that file, raise its revision, and register it as its header says, or choose another --project-name`);
    expect(plane.registered).toHaveLength(1);
  });

  it("refuses a rerun that names a different repository for an existing project", async () => {
    const plane = fakeControlPlane();
    await addProject({ env: "staging", session, githubToken: "ghs_x", prompter: scriptedPrompter([true]), write: () => undefined, services: services(plane), flags: { repository: "acme/payments-api", projectName: "payments-api", setupCommand: "", testCommand: "" } });
    await expect(addProject({ env: "staging", session, githubToken: "ghs_x", prompter: scriptedPrompter([]), write: () => undefined, services: services(plane), flags: { repository: "acme/docs", projectName: "payments-api", setupCommand: "", testCommand: "" } }))
      .rejects.toThrow("project payments-api already exists");
    expect(plane.registered).toHaveLength(1);
  });

  it("registers a later revision from the file with the preflight's report", async () => {
    const plane = fakeControlPlane();
    const first = await addProject({ env: "staging", session, githubToken: "ghs_x", prompter: scriptedPrompter(["acme/payments-api", "", true]), write: () => undefined, services: services(plane), flags: {} });
    const definition = { ...(plane.registered[0] as { definition: Record<string, unknown> }).definition, revision: 2 } as never;
    const approvalRequest = plane.requests.find((request) => request.path === "/v1/admin/projects/setup-approvals")?.body as { proposalRef: string; proposalSha256: string; decision: "approve" | "decline" };
    const again = await registerRevision({ env: "staging", session, definition, services: services(plane), setupApproval: approvalRequest });
    expect(again.revision).toBe(2);
    expect(again.file).toBe(first.file);
    expect(YAML.parse(await readFile(first.file, "utf8"))).toMatchObject({ revision: 2 });
  });

  it("carries the exact stored source decision through an unchanged E2E connector revision", async () => {
    const plane = fakeControlPlane();
    const { proposal, policy, snapshot, repositories } = await sourceBackedSetup(Buffer.from(JSON.stringify({ name: "payments-api", scripts: { test: "vitest run" } })));
    await addProject({ env: "staging", session, githubToken: "ghs_x", prompter: scriptedPrompter(["acme/payments-api", "", true]), write: () => undefined,
      services: services(plane, repositories), flags: {}, e2eSetup: { proposal, policy, snapshot } });
    const approvalRequest = plane.requests.find((request) => request.path === "/v1/admin/projects/setup-approvals")?.body as { projectName: string; proposalRef: string; proposalSha256: string; decision: "approve" };
    expect(approvalRequest).toMatchObject({ projectName: "payments-api", decision: "approve" });
    expect(typeof approvalRequest.proposalSha256).toBe("string");
    const originalDecision = { proposalRef: approvalRequest.proposalRef, proposalSha256: approvalRequest.proposalSha256, decision: approvalRequest.decision };
    const sidecar = JSON.parse(await readFile(join(configDir, "payments-api.yaml.setup-approval.json"), "utf8")) as Record<string, unknown>;
    expect(sidecar).toMatchObject({ schemaVersion: 1, env: "staging", controlPlaneUrl: CONTROL_PLANE, projectName: "payments-api", repositoryUrl: "https://github.com/acme/payments-api.git", setupApproval: originalDecision });
    const before = plane.requests.length;
    const result = await addConnectorRevision({
      env: "staging", session, projectName: "payments-api", services: { fetch: plane.fetch, configDir, stackOutputs: async () => FOUNDATION },
      write: () => undefined, rerun: "agentx --env staging connector add linear --project payments-api",
      connector: { name: "linear", type: "linear", credentialRef: "linear", scopes: [{ alias: "pay", teamId: "c408e946-78aa-4db8-923e-f78053dd954f" }], tools: [{ name: "list_issues", access: "read" }] },
    });
    expect(result).toEqual({ revision: 2 });
    const registration = plane.requests.slice(before).find((request) => request.path === "/v1/admin/projects")?.body as { setupApproval?: unknown; definition?: { e2e?: E2EPolicy } };
    expect(registration.setupApproval).toEqual(originalDecision);
    expect(registration.definition?.e2e).toEqual(policy);
    expect(plane.requests.slice(before).some((request) => request.path === "/v1/admin/projects/setup-approvals")).toBe(false);
    expect(plane.registered.at(-1)).toMatchObject({ definition: { revision: 2, e2e: policy } });
  });

  it("retains the normal registration refusal when an E2E revision has no stored owner decision", async () => {
    const plane = fakeControlPlane();
    const { policy } = await sourceBackedSetup(Buffer.from(JSON.stringify({ name: "payments-api", scripts: { test: "vitest run" } })));
    const definition = {
      name: "payments-api", revision: 1,
      repositories: [{ name: "payments-api", url: "https://github.com/acme/payments-api.git", path: "repo/payments-api", defaultBranch: "main", credentialRef: "github-agentx-sdlc" }],
      setup: [], readiness: [], orchestratorInstructions: "Delegate every repository read, edit, build, and test to the remote AgentX worker.", e2e: policy,
    };
    await expect(registerRevision({ env: "staging", session, definition, services: services(plane) })).rejects.toThrow("project registration failed with HTTP 403");
    expect(plane.registered).toEqual([]);
    expect(plane.requests.at(-1)?.path).toBe("/v1/admin/projects");
  });

  it("holds connector registration when the local decision no longer matches the E2E policy", async () => {
    const plane = fakeControlPlane();
    const { proposal, policy, snapshot, repositories } = await sourceBackedSetup(Buffer.from(JSON.stringify({ name: "payments-api", scripts: { test: "vitest run" } })));
    const first = await addProject({ env: "staging", session, githubToken: "ghs_x", prompter: scriptedPrompter(["acme/payments-api", "", true]), write: () => undefined,
      services: services(plane, repositories), flags: {}, e2eSetup: { proposal, policy, snapshot } });
    const fileText = await readFile(first.file, "utf8");
    await writeFile(first.file, fileText.replace("policyRevision: 1", "policyRevision: 2"));
    const requestCount = plane.requests.length;
    await expect(addConnectorRevision({
      env: "staging", session, projectName: "payments-api", services: { fetch: plane.fetch, configDir, stackOutputs: async () => FOUNDATION },
      write: () => undefined, rerun: "agentx --env staging connector add linear --project payments-api",
      connector: { name: "linear", type: "linear", credentialRef: "linear", scopes: [{ alias: "pay", teamId: "c408e946-78aa-4db8-923e-f78053dd954f" }], tools: [{ name: "list_issues", access: "read" }] },
    })).rejects.toThrow("no longer matches its project, environment, control plane, repository, or E2E policy");
    expect(plane.requests).toHaveLength(requestCount);
    expect(plane.registered).toHaveLength(1);
    expect(policy.policyRevision).toBe(1);
  });

  it("preserves the broker refusal when an otherwise matching sidecar carries a foreign proposal reference", async () => {
    const plane = fakeControlPlane();
    const { proposal, policy, snapshot, repositories } = await sourceBackedSetup(Buffer.from(JSON.stringify({ name: "payments-api", scripts: { test: "vitest run" } })));
    await addProject({ env: "staging", session, githubToken: "ghs_x", prompter: scriptedPrompter(["acme/payments-api", "", true]), write: () => undefined,
      services: services(plane, repositories), flags: {}, e2eSetup: { proposal, policy, snapshot } });
    const sidecarPath = join(configDir, "payments-api.yaml.setup-approval.json");
    const sidecar = JSON.parse(await readFile(sidecarPath, "utf8")) as { setupApproval: { proposalRef: string } };
    sidecar.setupApproval.proposalRef = `project-setup-proposals/foreign/${"f".repeat(64)}.json`;
    await writeFile(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`);
    await expect(addConnectorRevision({
      env: "staging", session, projectName: "payments-api", services: { fetch: plane.fetch, configDir, stackOutputs: async () => FOUNDATION },
      write: () => undefined, rerun: "agentx --env staging connector add linear --project payments-api",
      connector: { name: "linear", type: "linear", credentialRef: "linear", scopes: [{ alias: "pay", teamId: "c408e946-78aa-4db8-923e-f78053dd954f" }], tools: [{ name: "list_issues", access: "read" }] },
    })).rejects.toThrow("project registration failed with HTTP 403");
    expect(plane.registered).toHaveLength(1);
    expect(plane.requests.at(-1)?.path).toBe("/v1/admin/projects");
  });

  it("writes no file when the control plane refuses the registration", async () => {
    const plane = fakeControlPlane();
    const refusing = { ...services(plane), fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url).pathname;
      return init?.method === "POST" && path === "/v1/admin/projects"
        ? new Response(JSON.stringify({ error: { code: "CONFIG_INVALID", message: "revision 1 of payments-api already exists" } }), { status: 409, headers: { "content-type": "application/json" } })
        : plane.fetch(url, init);
    }) as typeof fetch };
    await expect(addProject({ env: "staging", session, githubToken: "ghs_x", prompter: scriptedPrompter(["", true]), write: () => undefined, services: refusing, flags: { repository: "acme/payments-api", setupCommand: "", testCommand: "" } }))
      .rejects.toThrow("project registration failed with HTTP 409: revision 1 of payments-api already exists");
    await expect(readFile(join(configDir, "payments-api.yaml"), "utf8")).rejects.toThrow("ENOENT");
  });

  it("tells the install page which repository it chose, and returns what it always returned", async () => {
    const chosen: string[] = [];
    const result = await addProject({
      env: "staging", session, githubToken: "ghs_x", prompter: scriptedPrompter(["acme/payments-api", "", true]), write: () => undefined, services: services(), flags: {},
      onRepository: (fullName) => { chosen.push(fullName); },
    });
    expect(chosen).toEqual(["acme/payments-api"]);
    expect(result).toEqual({ name: "payments-api", revision: 1, file: join(configDir, "payments-api.yaml") });
  });
});

describe("the first-project init step", () => {
  let context: TestInitContext | undefined;
  afterEach(async () => { if (context !== undefined) await rm(context.home, { recursive: true, force: true }); });

  // Task 8: the step also binds the channel, from the recorded Slack facts and the stored bot token.
  const githubSecret = () => memoryInitSecrets({
    "agentx/staging/github-app": JSON.stringify({ appId: "42", slug: "agentx-acme", account: "acme", privateKey: TEST_PRIVATE_KEY }),
    "agentx/staging/slack": JSON.stringify({ botToken: "xoxb-fake-bot-token-value" }),
  });
  const SLACK = { appId: "A0APP00001", teamId: "T0123456789", botUserId: "U0BOT00001" };
  const slackChannels = () => fakeSlackChannels([{ id: "C0PAY00001", name: "payments", isPrivate: false, isMember: true }, { id: "C0DOCS0001", name: "docs", isPrivate: false, isMember: true }]);

  it("registers the first project with the recorded installation and records it", async () => {
    const plane = fakeControlPlane();
    const github = fakeGitHubApi({ installationId: 777 });
    context = initContext({
      secrets: githubSecret(), prompter: scriptedPrompter(["acme/payments-api", "", true, "#payments"]),
      setup: setupServices({ fetch: plane.fetch, repositories: repositoriesFake(), github, configDir, stackOutputs: async (name) => (name === "agentx-staging-foundation" ? FOUNDATION : undefined), slackChannels: slackChannels() }),
    });
    (context.store as MemoryParameterStore).values.set("/agentx/staging/settings", JSON.stringify(STAGING_SETTINGS));
    const progress = progressHandle({ ...progressHandle().value(), slack: SLACK, github: { account: "acme", appId: "42", slug: "agentx-acme", privateKeySecretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/staging/github-app-AbCdEf", installationId: "777" } });
    expect(await firstProjectStep().run(context, progress)).toEqual({ status: "done", note: "project payments-api in #payments" });
    expect(progress.value().project).toEqual({ name: "payments-api", revision: 1, channelId: "C0PAY00001", channelName: "payments", teamId: "T0123456789" });
    expect(github.polls()).toBe(0);
    expect(plane.registered).toHaveLength(1);
    expect(context.lines.join("\n")).toContain("Registered project payments-api, revision 1, on EC2 workers.");
    expect(context.lines.join("\n")).not.toContain("ghs_installation-token-value");
  });

  it("takes the answers from init's flags", async () => {
    const plane = fakeControlPlane();
    context = initContext({
      secrets: githubSecret(), prompter: scriptedPrompter([true]),
      flags: { repository: "acme/docs", projectName: "docs", setupCommand: "", testCommand: "make check", channel: "docs" },
      setup: setupServices({ fetch: plane.fetch, repositories: repositoriesFake(), configDir, stackOutputs: async () => FOUNDATION, slackChannels: slackChannels() }),
    });
    (context.store as MemoryParameterStore).values.set("/agentx/staging/settings", JSON.stringify(STAGING_SETTINGS));
    const progress = progressHandle({ ...progressHandle().value(), slack: SLACK });
    await firstProjectStep().run(context, progress);
    expect(progress.value().project).toEqual({ name: "docs", revision: 1, channelId: "C0DOCS0001", channelName: "docs", teamId: "T0123456789" });
  });

  it("registers nothing again on a rerun that already recorded the project", async () => {
    const plane = fakeControlPlane();
    context = initContext({ prompter: scriptedPrompter([]), setup: setupServices({ fetch: plane.fetch, configDir }) });
    (context.store as MemoryParameterStore).values.set("/agentx/staging/settings", JSON.stringify(STAGING_SETTINGS));
    const progress = progressHandle({ ...progressHandle().value(), project: { name: "payments-api", revision: 1, channelId: "C0PAY00001", channelName: "payments", teamId: "T0123456789" } });
    expect(await firstProjectStep().run(context, progress)).toEqual({ status: "done", note: "project payments-api in #payments" });
    expect(plane.registered).toEqual([]);
    expect(plane.bindings).toEqual([]);
  });
});

describe("agentx project add on the command line", () => {
  function fakeSetupContext(plane = fakeControlPlane()): SetupCommandContext & { regions: Array<string | undefined> } {
    const regions: Array<string | undefined> = [];
    const run = (command: Command): Omit<SetupRun, "session"> => {
      regions.push(command.optsWithGlobals<{ region?: string }>().region);
      return {
        env: "staging", settings: STAGING_SETTINGS,
        secrets: memoryInitSecrets({ "agentx/staging/github-app": JSON.stringify({ appId: "42", slug: "agentx-acme", account: "acme", privateKey: TEST_PRIVATE_KEY }) }),
        services: setupServices({ fetch: plane.fetch, repositories: repositoriesFake(), configDir, stackOutputs: async () => FOUNDATION }),
        prompter: scriptedPrompter([true]), write: () => undefined,
        sleep: async () => undefined, now: () => Date.parse("2026-09-27T00:00:00.000Z"),
        print: () => undefined,
      };
    };
    return {
      regions,
      openAws: async (command) => run(command),
      open: async (command) => ({ ...run(command), session: { controlPlaneUrl: CONTROL_PLANE, accessToken: accessToken({ "cognito:groups": ["agentx-admin"] }) } }),
    };
  }

  it("takes --region and every answer by flag, and registers the project", async () => {
    const plane = fakeControlPlane();
    const setup = fakeSetupContext(plane);
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await executeCli(
      ["project", "add", "--env", "staging", "--region", "us-east-1", "--repository", "acme/docs", "--project-name", "docs", "--setup-command", "", "--test-command", "make check"],
      { setup, stdout: { write: (text: string) => stdout.push(text) }, stderr: { write: (text: string) => stderr.push(text) } },
    );
    expect(stderr.join("")).toBe("");
    expect(code).toBe(0);
    expect(setup.regions).toEqual(["us-east-1"]);
    expect(plane.registered).toHaveLength(1);
  });

  it("project setup-approve proposes a registered project's setup again and registers the approved next revision (M1.4 Task 4.9)", async () => {
    const plane = fakeControlPlane();
    const setup = fakeSetupContext(plane);
    const io = { setup, stdout: { write: () => undefined }, stderr: { write: () => undefined } };
    expect(await executeCli(["project", "add", "--env", "staging", "--repository", "acme/payments-api", "--project-name", "payments-api"], io)).toBe(0);
    const stderr: string[] = [];
    const code = await executeCli(["project", "setup-approve", "--env", "staging", "--region", "us-east-1", "--project-name", "payments-api"], { ...io, stderr: { write: (text: string) => stderr.push(text) } });
    expect(stderr.join("")).toBe("");
    expect(code).toBe(0);
    expect(plane.registered).toHaveLength(2);
    expect((plane.registered[1] as { definition: { revision: number } }).definition.revision).toBe(2);
    expect(plane.requests.filter((request) => request.path === "/v1/admin/projects/setup-approvals")).toHaveLength(2);
  });
});

describe("the real setup command context", () => {
  const command = (region?: string) => ({ optsWithGlobals: () => ({ env: "staging", json: false, configDir, ...(region === undefined ? {} : { region }) }) }) as unknown as Command;
  const context = (store: MemoryParameterStore) => realSetupContext({
    parameterStore: () => store, fetch: fakeControlPlane().fetch, tokenStore: memoryTokenStore(), stdout: { write: () => undefined }, stderr: { write: () => undefined },
  });

  it("says where it looked when the environment has no settings, and what to do", async () => {
    await expect(context(new MemoryParameterStore()).openAws(command("eu-west-1"))).rejects.toThrow("environment staging has no settings in eu-west-1; pass --region, or run agentx env list");
  });

  it("with no terminal, never guesses between several choices, but takes the only one", async () => {
    const store = new MemoryParameterStore();
    store.values.set("/agentx/staging/settings", JSON.stringify(STAGING_SETTINGS));
    const run = await context(store).openAws(command("us-east-1"));
    expect(run.services.configDir).toBe(configDir);
    const choices = [{ value: "acme/a", label: "acme/a" }, { value: "acme/b", label: "acme/b" }];
    await expect(run.prompter.choose("Which repository is the first project's?", choices, { flag: "--repository", defaultValue: "acme/a" }))
      .rejects.toThrow("Which repository is the first project's? needs an answer; with no terminal, pass --repository");
    expect(await run.prompter.choose("Which?", choices.slice(0, 1), { flag: "--repository", defaultValue: "acme/a" })).toBe("acme/a");
  });
});
