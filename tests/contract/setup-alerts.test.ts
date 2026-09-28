// FR-045 and FR-046: the alert address is subscribed to the environment's topic once, and a test
// alarm goes through CloudWatch to it. Owner decision 3 (F14): a test alarm is only sent once a
// subscription is confirmed. Owner decision 6: a Jira connector's wider-access warning is kept in
// the install progress. F29: an unknown --connectors value is refused, never dropped.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { alertsStep, connectorsStep, parseConnectorsFlag } from "../../packages/cli/src/init/finish-steps.js";
import { executeCli } from "../../packages/cli/src/main.js";
import { ensureSubscribed, sendTestAlarm, testAlarmName } from "../../packages/cli/src/setup/alerts.js";
import type { SetupCommandContext, SetupRun } from "../../packages/cli/src/setup/command-context.js";
import { writeProjectFile } from "../../packages/cli/src/setup/project-add.js";
import { initContext, memoryInitSecrets, progressHandle, sampleAnswers, scriptedPrompter, T0 } from "../support/init-fakes.js";
import type { MemoryParameterStore } from "../support/memory-parameter-store.js";
import { STAGING_SETTINGS, fakeAlerts, fakeVendors, setupServices } from "../support/setup-fakes.js";

const TOPIC = "arn:aws:sns:us-east-1:123456789012:agentx-staging-alerts";
const WEBHOOK = "https://events.pagerduty.com/integration/SECRETKEY123/enqueue";
const CONFIRMED = [{ arn: `${TOPIC}:1`, protocol: "email", endpoint: "ops@example.com" }];
function clock() { let now = T0; return { now: () => now, sleep: async (ms: number) => { now += ms; } }; }

describe("subscribing the alert address (FR-045)", () => {
  it("subscribes an email once, and waits for the person to confirm it", async () => {
    const api = fakeAlerts({ confirmAfterPolls: 2 });
    const lines: string[] = [];
    expect(await ensureSubscribed({ api, topicArn: TOPIC, target: { kind: "email", address: "ops@example.com" }, write: (line) => lines.push(line), ...clock() })).toBe("confirmed");
    expect(api.subscribed).toEqual(["email ops@example.com"]);
    expect(lines.join("\n")).toContain('AWS sent ops@example.com an email from AWS Notifications; open it and choose "Confirm subscription".');
  });

  it("does not subscribe an address that is already on the topic", async () => {
    const api = fakeAlerts({ existing: [{ arn: `${TOPIC}:1`, protocol: "email", endpoint: "OPS@example.com" }] });
    expect(await ensureSubscribed({ api, topicArn: TOPIC, target: { kind: "email", address: "ops@example.com" }, write: () => undefined, ...clock() })).toBe("confirmed");
    expect(api.subscribed).toEqual([]);
  });

  it("does not subscribe again an address still waiting for its confirmation", async () => {
    const api = fakeAlerts({ existing: [{ arn: "PendingConfirmation", protocol: "email", endpoint: "ops@example.com" }], confirmAfterPolls: 1_000 });
    expect(await ensureSubscribed({ api, topicArn: TOPIC, target: { kind: "email", address: "ops@example.com" }, write: () => undefined, ...clock() })).toBe("pending");
    expect(api.subscribed).toEqual([]);
  });

  it("returns pending when nobody confirms within 10 minutes", async () => {
    const api = fakeAlerts({ confirmAfterPolls: 1_000 });
    expect(await ensureSubscribed({ api, topicArn: TOPIC, target: { kind: "email", address: "ops@example.com" }, write: () => undefined, ...clock() })).toBe("pending");
  });

  it("subscribes a webhook without ever printing its address, only its host", async () => {
    const api = fakeAlerts({ confirmAfterPolls: 1 });
    const lines: string[] = [];
    await ensureSubscribed({ api, topicArn: TOPIC, target: { kind: "webhook", endpoint: WEBHOOK, display: "https://events.pagerduty.com/..." }, write: (line) => lines.push(line), ...clock() });
    expect(api.subscribed).toEqual([`https ${WEBHOOK}`]);
    expect(lines.join("\n")).not.toContain("SECRETKEY123");
    expect(lines.join("\n")).toContain("PagerDuty and Opsgenie confirm the subscription on their own");
  });

  it("warns that a generic webhook must confirm the subscription itself", async () => {
    const lines: string[] = [];
    await ensureSubscribed({ api: fakeAlerts({ confirmAfterPolls: 1 }), topicArn: TOPIC, target: { kind: "webhook", endpoint: "https://hooks.example.com/x", display: "https://hooks.example.com/..." }, write: (line) => lines.push(line), ...clock() });
    expect(lines.join("\n")).toContain("A webhook that is not PagerDuty or Opsgenie must confirm the subscription itself");
  });

  it("keeps the webhook address out of an error SNS raises about it", async () => {
    const api = { ...fakeAlerts(), subscribe: async (_topic: string, _protocol: string, endpoint: string) => { throw new Error(`Invalid parameter: Endpoint ${endpoint}`); } };
    const failure = await ensureSubscribed({ api, topicArn: TOPIC, target: { kind: "webhook", endpoint: WEBHOOK, display: "https://events.pagerduty.com/..." }, write: () => undefined, ...clock() })
      .then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("Invalid parameter: Endpoint https://events.pagerduty.com/...");
    expect(JSON.stringify(failure) + String((failure as Error).stack)).not.toContain("SECRETKEY123");
  });
});

describe("agentx alerts test (FR-046)", () => {
  it("sets the test alarm to ALARM and back to OK, checks its history, then asks", async () => {
    const api = fakeAlerts({ existing: CONFIRMED });
    const prompter = scriptedPrompter([true]);
    await sendTestAlarm({ api, topicArn: TOPIC, env: "staging", shownAs: "ops@example.com", prompter, write: () => undefined, ...clock() });
    expect(api.states).toEqual([`${testAlarmName("staging")} ALARM`, `${testAlarmName("staging")} OK`]);
    expect(prompter.asked).toEqual(["Did a test alarm named agentx-staging-TestAlarm arrive at ops@example.com?"]);
  });

  it("says what to check when the alarm did not arrive", async () => {
    await expect(sendTestAlarm({ api: fakeAlerts({ existing: CONFIRMED }), topicArn: TOPIC, env: "staging", shownAs: "ops@example.com", prompter: scriptedPrompter([false]), write: () => undefined, ...clock() }))
      .rejects.toThrow("the test alarm did not arrive; check the subscription is confirmed (aws sns list-subscriptions-by-topic --topic-arn <the agentx-staging-alerts topic>) and your spam folder, then run agentx alerts test");
  });

  it("fails before asking when CloudWatch never recorded the ALARM change, and still sets the alarm back to OK", async () => {
    const api = fakeAlerts({ existing: CONFIRMED, historyEmpty: true });
    await expect(sendTestAlarm({ api, topicArn: TOPIC, env: "staging", shownAs: "x", prompter: scriptedPrompter([]), write: () => undefined, ...clock() }))
      .rejects.toThrow("CloudWatch did not record the test alarm going off");
    expect(api.states).toEqual(["agentx-staging-TestAlarm ALARM", "agentx-staging-TestAlarm OK"]);
  });

  it("sets the alarm back to OK even when reading its history fails", async () => {
    const api = { ...fakeAlerts({ existing: CONFIRMED }), wentToAlarm: async () => { throw new Error("throttled"); } };
    const states: string[] = [];
    api.setAlarmState = async (name, state) => { states.push(`${name} ${state}`); };
    await expect(sendTestAlarm({ api, topicArn: TOPIC, env: "staging", shownAs: "x", prompter: scriptedPrompter([]), write: () => undefined, ...clock() })).rejects.toThrow("throttled");
    expect(states).toEqual(["agentx-staging-TestAlarm ALARM", "agentx-staging-TestAlarm OK"]);
  });

  it("sends nothing while every subscription still waits for its confirmation (owner decision 3)", async () => {
    const api = fakeAlerts({ existing: [{ arn: "PendingConfirmation", protocol: "email", endpoint: "ops@example.com" }], confirmAfterPolls: 1_000 });
    const prompter = scriptedPrompter([]);
    await expect(sendTestAlarm({ api, topicArn: TOPIC, env: "staging", shownAs: "ops@example.com", prompter, write: () => undefined, ...clock() }))
      .rejects.toThrow("no subscription to the agentx-staging-alerts topic is confirmed yet; confirm it (the AWS Notifications email, or your webhook's SubscribeURL), then run agentx alerts test");
    expect(api.states).toEqual([]);
    expect(prompter.asked).toEqual([]);
  });

  it("sends nothing when nobody is subscribed at all", async () => {
    const api = fakeAlerts();
    await expect(sendTestAlarm({ api, topicArn: TOPIC, env: "staging", shownAs: "the alert address", prompter: scriptedPrompter([]), write: () => undefined, ...clock() }))
      .rejects.toThrow("nobody is subscribed to the agentx-staging-alerts topic; run agentx init --env staging to subscribe the alert address, then run agentx alerts test");
    expect(api.states).toEqual([]);
  });
});

describe("agentx alerts test on the command line", () => {
  function fakeSetupContext(api: ReturnType<typeof fakeAlerts>, outputs: Record<string, string> | undefined = { OperatorAlertsTopicArn: TOPIC }) {
    const time = clock();
    const lines: string[] = [];
    const stacks: string[] = [];
    const run = (): Omit<SetupRun, "session"> => ({
      env: "staging", settings: { ...STAGING_SETTINGS, alertAddress: "ops@example.com" }, secrets: memoryInitSecrets(),
      services: setupServices({ alerts: api, stackOutputs: async (name) => { stacks.push(name); return outputs; } }),
      prompter: scriptedPrompter([true]), write: (line) => { lines.push(line); }, ...time,
      print: (_result, text) => { lines.push(text); },
    });
    // alerts test needs no admin session: it only talks to AWS.
    const context: SetupCommandContext = { openAws: async () => run(), open: async () => { throw new Error("test setup: an admin session is not expected"); } };
    return { context, lines, stacks };
  }
  async function cli(setup: SetupCommandContext) {
    const stderr: string[] = [];
    const code = await executeCli(["alerts", "test", "--env", "staging"], { setup, stdout: { write: () => undefined }, stderr: { write: (text: string) => stderr.push(text) } });
    return { code, stderr: stderr.join("") };
  }

  it("reads the topic from the control-plane stack, checks the subscription, and flips the test alarm", async () => {
    const api = fakeAlerts({ existing: CONFIRMED });
    const { context, lines, stacks } = fakeSetupContext(api);
    const result = await cli(context);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(stacks).toEqual(["agentx-staging-control-plane"]);
    expect(api.reads()).toBe(1);
    expect(api.states).toEqual(["agentx-staging-TestAlarm ALARM", "agentx-staging-TestAlarm OK"]);
    expect(lines).toContain("The test alarm arrived.\n");
  });

  it("refuses, sending nothing, while the subscription is not confirmed", async () => {
    const api = fakeAlerts({ existing: [{ arn: "PendingConfirmation", protocol: "email", endpoint: "ops@example.com" }], confirmAfterPolls: 1_000 });
    const result = await cli(fakeSetupContext(api).context);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("no subscription to the agentx-staging-alerts topic is confirmed yet");
    expect(api.states).toEqual([]);
  });

  it("says what to do when the control-plane stack has no alerts topic", async () => {
    const api = fakeAlerts({ existing: CONFIRMED });
    const result = await cli(fakeSetupContext(api, {}).context);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("the control-plane stack reports no OperatorAlertsTopicArn; run agentx init --env staging to update it, then run agentx alerts test");
    expect(api.states).toEqual([]);
  });
});

describe("the alerts step", () => {
  function context(input: { api: ReturnType<typeof fakeAlerts>; script?: boolean[]; answers?: Parameters<typeof sampleAnswers>[0]; secrets?: Record<string, string> }) {
    const made = initContext({
      answers: sampleAnswers(input.answers),
      secrets: memoryInitSecrets(input.secrets),
      setup: setupServices({ alerts: input.api, stackOutputs: async () => ({ OperatorAlertsTopicArn: TOPIC }) }),
      prompter: scriptedPrompter(input.script ?? []),
    });
    (made.store as MemoryParameterStore).values.set("/agentx/staging/settings", JSON.stringify(STAGING_SETTINGS));
    return made;
  }

  it("waits, exiting 0, when the email is not confirmed, and resumes at the test alarm without subscribing again", async () => {
    const api = fakeAlerts({ confirmAfterPolls: 1_000 });
    const progress = progressHandle();
    const first = await alertsStep().run(context({ api }), progress);
    expect(first).toMatchObject({ status: "waiting", message: "Confirm the alert subscription for ops@example.com (the AWS Notifications email, or your webhook's SubscribeURL), then run agentx init --env staging --region us-east-1 again." });
    expect(progress.value().alerts).toBeUndefined();
    expect(api.states).toEqual([]);

    // The person confirms; the rerun finds the subscription, sends the test alarm and asks.
    api.confirmAll();
    const rerun = context({ api, script: [true] });
    expect(await alertsStep().run(rerun, progress)).toEqual({ status: "done", note: "alerts to ops@example.com, test alarm received" });
    expect(api.subscribed).toEqual(["email ops@example.com"]);
    expect(api.states).toEqual(["agentx-staging-TestAlarm ALARM", "agentx-staging-TestAlarm OK"]);
    expect(progress.value().alerts).toEqual({ subscribed: true, tested: true });
  });

  it("records subscribed before the test alarm, so a failed test does not subscribe twice", async () => {
    const api = fakeAlerts({ confirmAfterPolls: 0 });
    const progress = progressHandle();
    await expect(alertsStep().run(context({ api, script: [false] }), progress)).rejects.toThrow("the test alarm did not arrive");
    expect(progress.value().alerts).toEqual({ subscribed: true, tested: false });

    await alertsStep().run(context({ api, script: [true] }), progress);
    expect(api.subscribed).toEqual(["email ops@example.com"]);
    expect(progress.value().alerts).toEqual({ subscribed: true, tested: true });
  });

  it("subscribes the webhook read from its secret, and never prints the address", async () => {
    const api = fakeAlerts({ confirmAfterPolls: 0 });
    const made = context({
      api, script: [true],
      answers: { alert: { kind: "webhook", display: "https://events.pagerduty.com/...", secretName: "agentx/staging/alert-endpoint" } },
      secrets: { "agentx/staging/alert-endpoint": WEBHOOK },
    });
    const progress = progressHandle();
    const outcome = await alertsStep().run(made, progress);
    expect(api.subscribed).toEqual([`https ${WEBHOOK}`]);
    expect(JSON.stringify(outcome)).not.toContain("SECRETKEY123");
    expect(made.lines.join("\n")).not.toContain("SECRETKEY123");
    expect(JSON.stringify(progress.value())).not.toContain("SECRETKEY123");
  });

  it("says how to store the webhook again when its secret is missing", async () => {
    const made = context({ api: fakeAlerts(), answers: { alert: { kind: "webhook", display: "https://events.pagerduty.com/...", secretName: "agentx/staging/alert-endpoint" } } });
    await expect(alertsStep().run(made, progressHandle())).rejects.toThrow("secret agentx/staging/alert-endpoint is missing; run agentx init with --alert-webhook-file or --alert-webhook-env to store it again");
  });

  it("skips cleanly with --no-alerts: no subscription, no test alarm, no question", async () => {
    const api = fakeAlerts();
    const progress = progressHandle();
    expect(await alertsStep().run(context({ api, answers: { alert: { kind: "none" } } }), progress))
      .toEqual({ status: "done", note: "no alert address (agentx config set alerts.address, phase 15e)" });
    expect(api.reads()).toBe(0);
    expect(api.subscribed).toEqual([]);
    expect(api.states).toEqual([]);
    expect(progress.value().alerts).toBeUndefined();
  });

  it("shows the budget, with the tag note for a tag-scoped budget", async () => {
    const api = fakeAlerts({ budgetUsd: 250 });
    const made = context({ api, answers: { alert: { kind: "none" }, budget: { monthlyUsd: 250, scope: "tag" } } });
    await alertsStep().run(made, progressHandle());
    expect(made.lines[0]).toMatch(/^Budget agentx-staging-monthly: \$250 a month\. The budget counts costs tagged agentx:env\./);
  });

  it("fails with what to check when the budget does not exist", async () => {
    const made = context({ api: fakeAlerts(), answers: { alert: { kind: "none" }, budget: { monthlyUsd: 250, scope: "account" } } });
    await expect(alertsStep().run(made, progressHandle())).rejects.toThrow("the budget agentx-staging-monthly does not exist; check the control-plane stack's BudgetMonthlyUsd parameter, then run agentx init again");
  });
});

describe("the connectors step", () => {
  const withProject = () => progressHandle({ ...progressHandle().value(), project: { name: "payments-api", revision: 1 } });

  it("records a Jira connector's wider-access warning in the install progress (owner decision 6)", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "agentx-projects-"));
    try {
      await writeProjectFile(configDir, {
        name: "payments-api", revision: 1,
        repositories: [{ name: "payments-api", url: "https://github.com/acme/payments-api.git", path: "repo/payments-api", defaultBranch: "main", credentialRef: "github-agentx-sdlc" }],
        setup: [], readiness: [], orchestratorInstructions: "Delegate every repository read, edit, build, and test to the remote AgentX worker.",
      });
      const vendors = fakeVendors({ jiraCloudId: "0f1e2d3c-4b5a-4968-8776-655443322110", jiraInside: ["PAY-1"], jiraOutside: ["HR-4"] });
      const made = initContext({
        prompter: scriptedPrompter([]),
        flags: { connectors: "jira", jiraSite: "acme", jiraProject: "PAY", jiraToken: { envName: "JIRA" } },
        processEnv: { JIRA: `ATATT${"t".repeat(187)}` },
        setup: setupServices({ vendors, configDir, stackOutputs: async () => ({ Ec2WorkerLaunchTemplateId: "lt-0123456789abcdef0", Ec2WorkerSubnets: "us-east-1a=subnet-0aaa1111bbbb2222c" }) }),
        adminSession: async () => ({ controlPlaneUrl: "https://cp.example.test", accessToken: "t" }),
      });
      const progress = withProject();
      expect(await connectorsStep().run(made, progress)).toEqual({ status: "done", note: "connected Jira" });
      expect(progress.value().connectors).toEqual([{ type: "jira", ref: "jira", warning: expect.stringContaining("can also see issues in HR") as unknown }]);
      expect(progress.value().project).toEqual({ name: "payments-api", revision: 2 });
    } finally {
      await rm(configDir, { recursive: true, force: true });
    }
  });

  it("does not offer again a connector the install already connected", async () => {
    const prompter = scriptedPrompter([false, false]);
    const progress = progressHandle({ ...withProject().value(), connectors: [{ type: "linear", ref: "linear" }] });
    expect(await connectorsStep().run(initContext({ prompter }), progress)).toEqual({ status: "done", note: "connected Linear" });
    expect(prompter.asked).toEqual([
      "Connect Jira to payments-api now? (You can add it later with agentx connector add jira)",
      "Connect Asana to payments-api now? (You can add it later with agentx connector add asana)",
    ]);
  });

  it("connects nothing and asks three times when the engineer says no to each", async () => {
    const prompter = scriptedPrompter([false, false, false]);
    expect(await connectorsStep().run(initContext({ prompter }), withProject())).toEqual({ status: "done", note: "no connectors" });
    expect(prompter.asked).toHaveLength(3);
  });

  it("asks nothing with --connectors none", async () => {
    const made = initContext({ prompter: scriptedPrompter([]), flags: { connectors: "none" } });
    expect(await connectorsStep().run(made, withProject())).toEqual({ status: "done", note: "no connectors" });
  });

  it("refuses an unknown --connectors value, a typo or github, naming the valid ones (F29)", async () => {
    for (const value of ["lnear", "linear,github"]) {
      const prompter = scriptedPrompter([]);
      const progress = withProject();
      const bad = value === "lnear" ? "lnear" : "github";
      await expect(connectorsStep().run(initContext({ prompter, flags: { connectors: value } }), progress))
        .rejects.toThrow(`--connectors ${bad} is not a connector; use linear, jira, asana or none, separated by commas`);
      expect(prompter.asked).toEqual([]);
      expect(progress.value().connectors).toBeUndefined();
    }
  });

  it("refuses none together with a connector", () => {
    expect(() => parseConnectorsFlag("none,jira")).toThrow("--connectors none means no connectors; do not list it with linear, jira or asana");
  });

  it("reads --connectors case-blind and with spaces", () => {
    expect(parseConnectorsFlag(" Linear , asana ")).toEqual(new Set(["linear", "asana"]));
    expect(parseConnectorsFlag("none")).toEqual(new Set());
  });
});
