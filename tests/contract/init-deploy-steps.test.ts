import { installGatewayFixture } from "../support/install-gateway.js";
// agentx init's deploy steps: each drives deployEnvironment for its own parts under the lock the
// step runner already holds, and first waits out any of its stacks an interrupted run left busy
// (Review Focus 2). No test here reaches AWS, GitHub or Slack.
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { deployStep, initDeployAnswers, waitForIdleStacks } from "../../packages/cli/src/init/deploy-steps.js";
import { emptyProgress } from "../../packages/cli/src/init/install-state.js";
import { MemoryParameterStore } from "../support/memory-parameter-store.js";
import { initContext, progressHandle, sampleAnswers, T0 } from "../support/init-fakes.js";

installGatewayFixture();

const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true }))); });

const GITHUB = { account: "acme", appId: "42", slug: "agentx-acme-staging", privateKeySecretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/staging/github-app-AbCdEf", installationId: "777" };

describe("init deploy answers", () => {
  it("maps the install answers, and fills GitHub only once the app is installed", () => {
    const answers = sampleAnswers({ images: { worker: `123456789012.dkr.ecr.us-east-1.amazonaws.com/w@sha256:${"a".repeat(64)}` }, permissionsBoundaryArn: "arn:aws:iam::123456789012:policy/B" });
    const early = initDeployAnswers(answers, emptyProgress("staging", T0), ["access"]);
    expect(early).toEqual({
      env: "staging", region: "us-east-1", account: "123456789012",
      coreEngine: answers.coreEngine,
      models: answers.models, identity: { mode: "cognito" },
      github: { account: "", appId: "", installationId: "", privateKeySecretArn: "" },
      permissionsBoundaryArn: "arn:aws:iam::123456789012:policy/B",
      images: answers.images,
      slackAppPostedMessages: "accept",
    });
    const later = initDeployAnswers(answers, { ...emptyProgress("staging", T0), github: GITHUB }, ["control-plane", "runtime"]);
    expect(later.github).toEqual({ account: "acme", appId: "42", installationId: "777", privateKeySecretArn: GITHUB.privateKeySecretArn });
  });

  it("deploys the control plane before the GitHub App with the app's empty secret and no app id", () => {
    const deploy = initDeployAnswers(sampleAnswers(), emptyProgress("staging", T0), ["control-plane"], GITHUB.privateKeySecretArn);
    expect(deploy.github).toEqual({ account: "", appId: "", installationId: "", privateKeySecretArn: GITHUB.privateKeySecretArn });
    expect(() => initDeployAnswers(sampleAnswers(), emptyProgress("staging", T0), ["control-plane"]))
      .toThrow("the control plane needs the GitHub App's secret; run agentx init again");
  });
});

describe("init deploy steps", () => {

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

  it("hands deployEnvironment the deployment's declared parameters, the cdk engine's synth (issue 152)", async () => {
    const context = initContext({ answers: sampleAnswers({ engine: "cdk" }) });
    homes.push(context.home);
    await context.store.put("/agentx/staging/slack/teamId", "T0TEAM1");
    await context.store.put("/agentx/staging/signin", JSON.stringify({ schemaVersion: 1, env: "staging", slack: true, updatedAt: "2026-09-27T00:00:00.000Z", updatedBy: "arn:aws:iam::123456789012:user/alice" }));
    const inner = context.deployment.bind(context);
    // fakeRelease's template() throws: only the synth's set can answer for the control plane.
    context.deployment = async () => ({ ...(await inner()), declaredParameters: (part) => new Set(part === "control-plane" ? ["SlackTeamId"] : []) });
    const progress = progressHandle({ ...emptyProgress("staging", T0), github: GITHUB });
    for (const id of ["access", "core", "control-plane"] as const) await deployStep({ id, title: id }).run(context, progress);
    const controlPlane = context.deployer.requests.find((request) => request.part === "control-plane")!;
    expect(controlPlane.parameters.SlackTeamId).toBe("T0TEAM1");
    expect(controlPlane.parameters).not.toHaveProperty("DeveloperSignInSlack");
  });

});

describe("waiting for stacks left busy by an interrupted run (Review Focus 2)", () => {

  it("gives up after 60 minutes with what to do", async () => {
    let clock = T0;
    await expect(waitForIdleStacks({ reader: { status: async () => "ROLLBACK_IN_PROGRESS" }, stackNames: ["agentx-staging-core"], sleep: async (ms) => { clock += ms; }, write: () => undefined, now: () => clock }))
      .rejects.toThrow("stack agentx-staging-core is still ROLLBACK_IN_PROGRESS after 60 minutes; check it in the CloudFormation console, then run agentx init again");
    expect(clock - T0).toBe(60 * 60 * 1000);
  });


});
