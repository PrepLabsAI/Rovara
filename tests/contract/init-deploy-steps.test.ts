// agentx init's deploy steps: each drives deployEnvironment for its own parts under the lock the
// step runner already holds, and first waits out any of its stacks an interrupted run left busy
// (Review Focus 2). No test here reaches AWS, GitHub or Slack.
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEPLOY_STEP_PARTS, deployStep, initDeployAnswers, waitForIdleStacks } from "../../packages/cli/src/init/deploy-steps.js";
import { emptyProgress } from "../../packages/cli/src/init/install-state.js";
import { readEnvironmentSettings } from "../../packages/cli/src/environments/settings.js";
import { environmentCachePath } from "../../packages/cli/src/environments/cache.js";
import { MemoryParameterStore } from "../support/memory-parameter-store.js";
import { initContext, progressHandle, sampleAnswers, T0 } from "../support/init-fakes.js";

const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true }))); });

const GITHUB = { account: "acme", appId: "42", slug: "agentx-acme-staging", privateKeySecretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/staging/github-app-AbCdEf", installationId: "777" };

describe("init deploy answers", () => {
  it("maps the install answers, and fills GitHub only once the app is installed", () => {
    const answers = sampleAnswers({ images: { worker: `123456789012.dkr.ecr.us-east-1.amazonaws.com/w@sha256:${"a".repeat(64)}` }, permissionsBoundaryArn: "arn:aws:iam::123456789012:policy/B" });
    const early = initDeployAnswers(answers, emptyProgress("staging", T0), ["access"]);
    expect(early).toEqual({
      env: "staging", region: "us-east-1", account: "123456789012",
      models: answers.models, identity: { mode: "cognito" },
      github: { account: "", appId: "", installationId: "", privateKeySecretArn: "" },
      permissionsBoundaryArn: "arn:aws:iam::123456789012:policy/B",
      images: answers.images,
      slackAppPostedMessages: "accept",
    });
    const later = initDeployAnswers(answers, { ...emptyProgress("staging", T0), github: GITHUB }, ["control-plane", "runtime"]);
    expect(later.github).toEqual({ account: "acme", appId: "42", installationId: "777", privateKeySecretArn: GITHUB.privateKeySecretArn });
  });

  it("carries your own OIDC provider's fields through unchanged", () => {
    const identity = { mode: "oidc" as const, issuer: "https://id.example.com", audience: "a", clientId: "c", adminClaim: "groups", adminValues: ["x"] };
    expect(initDeployAnswers(sampleAnswers({ identity }), emptyProgress("staging", T0), ["access"]).identity).toEqual(identity);
  });

  it("refuses to deploy the control plane before the GitHub App is installed", () => {
    const notInstalled = { account: GITHUB.account, appId: GITHUB.appId, slug: GITHUB.slug, privateKeySecretArn: GITHUB.privateKeySecretArn };
    expect(() => initDeployAnswers(sampleAnswers(), { ...emptyProgress("staging", T0), github: notInstalled }, ["control-plane"]))
      .toThrow("the control plane needs the GitHub App's installation; the github-app step must finish first");
  });
});

describe("init deploy steps", () => {
  it("names each step's parts", () => {
    expect(DEPLOY_STEP_PARTS).toEqual({ access: ["access"], core: ["foundation", "identity"], "control-plane": ["control-plane", "runtime"], "slack-service": ["slack"] });
  });

  it("deploys its parts under the runner's lock, never taking or releasing the lock itself", async () => {
    const context = initContext();
    homes.push(context.home);
    await deployStep({ id: "access", title: "Deploy the access stack" }).run(context, progressHandle());
    await deployStep({ id: "core", title: "Deploy the foundation and identity stacks" }).run(context, progressHandle());
    expect(context.deployer.requests.map((request) => request.part)).toEqual(["access", "foundation", "identity"]);
    expect(context.deployer.requests[1]?.roleArn).toBe("arn:aws:iam::123456789012:role/agentx-staging-cloudformation");
    // deployEnvironment reads the lock to confirm the runner holds it; it never writes or deletes it.
    const store = context.store as MemoryParameterStore;
    expect(store.calls.filter((call) => call.name.endsWith("/lock") && call.op !== "get")).toEqual([]);
    expect(context.lines).toContain("deployed agentx-staging-access");
  });

  it("refuses when the runner does not hold the lock", async () => {
    const context = initContext({ store: new MemoryParameterStore() });
    homes.push(context.home);
    await expect(deployStep({ id: "access", title: "a" }).run(context, progressHandle())).rejects.toThrow("lock is not held by");
    expect(context.deployer.requests).toEqual([]);
  });

  it("skips the identity stack when the environment brings its own OIDC provider", async () => {
    const context = initContext({ answers: sampleAnswers({ identity: { mode: "oidc", issuer: "https://id.example.com", audience: "a", clientId: "c", adminClaim: "groups", adminValues: ["x"] } }) });
    homes.push(context.home);
    await deployStep({ id: "access", title: "a" }).run(context, progressHandle());
    await deployStep({ id: "core", title: "c" }).run(context, progressHandle());
    expect(context.deployer.requests.map((request) => request.part)).toEqual(["access", "foundation"]);
  });

  it("passes the Slack app-posted-messages choice to the control plane", async () => {
    const context = initContext({ answers: sampleAnswers({ slack: { appName: "AgentX", appPostedMessages: "ignore" } }) });
    homes.push(context.home);
    const progress = progressHandle({ ...emptyProgress("staging", T0), github: GITHUB });
    for (const id of ["access", "core", "control-plane"] as const) await deployStep({ id, title: id }).run(context, progress);
    expect(context.deployer.requests.find((request) => request.part === "control-plane")?.parameters.SlackAppPostedMessages).toBe("ignore");
  });

  it("after the Slack service, requires settings, writes the local cache and runs the after hook", async () => {
    const context = initContext();
    homes.push(context.home);
    const progress = progressHandle({ ...emptyProgress("staging", T0), github: GITHUB });
    for (const id of ["access", "core", "control-plane"] as const) await deployStep({ id, title: id }).run(context, progress);
    const after = vi.fn(async () => undefined);
    await deployStep({ id: "slack-service", title: "Deploy the Slack service", after }).run(context, progress);
    const settings = await readEnvironmentSettings(context.store, "staging");
    expect(settings?.controlPlaneUrl).toBe("https://abc123.execute-api.us-east-1.amazonaws.com");
    expect(context.lines.join("\n")).toContain(environmentCachePath(context.home, "staging"));
    expect(after).toHaveBeenCalledOnce();
  });
});

describe("waiting for stacks left busy by an interrupted run (Review Focus 2)", () => {
  it("waits while a stack is in progress, saying so once, then returns", async () => {
    const statuses = ["UPDATE_IN_PROGRESS", "UPDATE_IN_PROGRESS", "UPDATE_COMPLETE"];
    let clock = T0;
    const lines: string[] = [];
    await waitForIdleStacks({ reader: { status: async () => statuses.shift() }, stackNames: ["agentx-staging-foundation"], sleep: async (ms) => { clock += ms; }, write: (line) => lines.push(line), now: () => clock });
    expect(lines).toEqual(["Waiting for agentx-staging-foundation: it is UPDATE_IN_PROGRESS from an earlier run"]);
    expect(clock - T0).toBe(30_000);
  });

  it("does not wait for a stack that does not exist or is under review", async () => {
    const sleep = vi.fn(async () => undefined);
    await waitForIdleStacks({ reader: { status: async (name) => (name.endsWith("a") ? undefined : "REVIEW_IN_PROGRESS") }, stackNames: ["x-a", "x-b"], sleep, write: () => undefined, now: () => T0 });
    expect(sleep).not.toHaveBeenCalled();
  });

  it("gives up after 60 minutes with what to do", async () => {
    let clock = T0;
    await expect(waitForIdleStacks({ reader: { status: async () => "ROLLBACK_IN_PROGRESS" }, stackNames: ["agentx-staging-core"], sleep: async (ms) => { clock += ms; }, write: () => undefined, now: () => clock }))
      .rejects.toThrow("stack agentx-staging-core is still ROLLBACK_IN_PROGRESS after 60 minutes; check it in the CloudFormation console, then run agentx init again");
    expect(clock - T0).toBe(60 * 60 * 1000);
  });

  it("is what a deploy step does before deploying", async () => {
    const statuses = ["CREATE_IN_PROGRESS", "CREATE_COMPLETE"];
    const context = initContext({ stackStatus: { status: async () => statuses.shift() } });
    homes.push(context.home);
    await deployStep({ id: "access", title: "a" }).run(context, progressHandle());
    expect(context.lines[0]).toBe("Waiting for agentx-staging-access: it is CREATE_IN_PROGRESS from an earlier run");
    expect(context.deployer.requests).toHaveLength(1);
  });
});
