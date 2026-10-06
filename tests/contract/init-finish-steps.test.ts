import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { writeEnvironmentSettings } from "../../packages/cli/src/environments/settings.js";
import { adminUserStep, e2eStep, finishSteps, readyText, subscribeAlertsAfterDeploy } from "../../packages/cli/src/init/finish-steps.js";
import { emptyProgress } from "../../packages/cli/src/init/install-state.js";
import { subscribeAlertsEarly, type AlertsApi } from "../../packages/cli/src/setup/alerts.js";
import { initContext, progressHandle, sampleAnswers, scriptedPrompter, T0, TEST_CLI_INVOCATION, type TestInitContext } from "../support/init-fakes.js";
import { ADMIN_EMAIL, ALERTS_TOPIC_ARN, fakeAlerts, fakeCognito, fakeControlPlane, setupServices, STAGING_SETTINGS, turn } from "../support/setup-fakes.js";

const TOPIC = ALERTS_TOPIC_ARN;

// Contexts finishContext builds, so afterEach cleans up their home directories alongside the
// file's own `context` variable (initContext's own contract: a test that uses it deletes its home).
const finishContexts: TestInitContext[] = [];

/** A context for subscribeAlertsAfterDeploy: the control-plane stack reports TOPIC, and the alerts
 * api and write are fakeAlerts() and a no-op unless overridden. */
async function finishContext(overrides: { answers?: ReturnType<typeof sampleAnswers>; alerts?: AlertsApi; write?: (line: string) => void } = {}): Promise<{ context: TestInitContext }> {
  const built = initContext({
    answers: overrides.answers ?? sampleAnswers(),
    setup: setupServices({ alerts: overrides.alerts ?? fakeAlerts(), stackOutputs: async () => ({ OperatorAlertsTopicArn: TOPIC }) }),
    ...(overrides.write === undefined ? {} : { write: overrides.write }),
  });
  finishContexts.push(built);
  return { context: built };
}

const READY_PROGRESS_FIXTURE = {
  ...emptyProgress("staging", 0),
  slack: { appId: "A0APP", teamId: "T0TEAM", botUserId: "U0BOT", botName: "agentx-acme-staging" },
  project: { name: "payments-api", revision: 1, channelName: "payments", channelId: "C0PAY00001", teamId: "T0TEAM" },
};

let context: TestInitContext | undefined;
afterEach(async () => {
  if (context !== undefined) await rm(context.home, { recursive: true, force: true });
  await Promise.all(finishContexts.splice(0).map((built) => rm(built.home, { recursive: true, force: true })));
});

describe("the e2e step (FR-018 step 11)", () => {
  const progress = () => progressHandle({
    ...emptyProgress("staging", T0),
    slack: { appId: "A0APP00001", teamId: "T0123456789", botUserId: "U0BOT00001" },
    project: { name: "payments-api", revision: 1, channelName: "payments", channelId: "C0PAY00001", teamId: "T0123456789" },
  });

  it("finishes when a person's mention gets an answered reply in its thread", async () => {
    const plane = fakeControlPlane();
    plane.turns = [turn({ subject: "T0123456789/C0PAY00001/1790000000.000100", receivedAt: new Date(T0 + 2000).toISOString(), disposition: "answered", durationMs: 12_000 })];
    context = initContext({ setup: setupServices({ fetch: plane.fetch }), adminSession: async () => ({ controlPlaneUrl: "https://cp.example.test", accessToken: "t" }) });
    expect(await e2eStep().run(context, progress())).toEqual({ status: "done", note: "a mention in #payments got a threaded reply in 12 seconds" });
  });

  it("tells the engineer to run agentx init again when the reply failed", async () => {
    const plane = fakeControlPlane();
    plane.turns = [turn({ subject: "T0123456789/C0PAY00001/1790000000.000100", receivedAt: new Date(T0 + 2000).toISOString(), disposition: "error" })];
    context = initContext({ setup: setupServices({ fetch: plane.fetch }), adminSession: async () => ({ controlPlaneUrl: "https://cp.example.test", accessToken: "t" }) });
    await expect(e2eStep().run(context, progress())).rejects.toThrow("but the turn ended as error; see agentx --env staging admin turns export --since 15m, fix it, then run agentx --env staging init again");
  });

  it("needs the channel from the first-project step", async () => {
    context = initContext();
    await expect(e2eStep().run(context, progressHandle())).rejects.toThrow("install progress has no bound channel; the first-project step must finish first, so run agentx init again");
  });
});

describe("the finishing steps", () => {
  it("run admin-user, first-project, connectors, alerts and e2e, in that order", () => {
    expect(finishSteps().map((step) => step.id)).toEqual(["admin-user", "first-project", "connectors", "alerts", "e2e"]);
  });
});

describe("spec 048 FR-025: the alert address is subscribed early", () => {
  it("subscribes once, without waiting for the confirmation", async () => {
    const api = fakeAlerts({ confirmAfterPolls: 1000 });
    const target = { kind: "email" as const, address: "ops@example.com" };
    await subscribeAlertsEarly({ api, topicArn: TOPIC, target, write: () => undefined });
    await subscribeAlertsEarly({ api, topicArn: TOPIC, target, write: () => undefined });
    expect(api.subscribed).toEqual(["email ops@example.com"]);
  });

  it("does nothing for no alerts, and a failure never stops the build", async () => {
    const lines: string[] = [];
    const none = await finishContext({ answers: sampleAnswers({ alert: { kind: "none" } }) });
    await expect(subscribeAlertsAfterDeploy(none.context)).resolves.toBeUndefined();
    const broken = await finishContext({ alerts: { ...fakeAlerts(), subscribe: async () => { throw new Error("SNS is down"); } }, write: (line) => lines.push(line) });
    await expect(subscribeAlertsAfterDeploy(broken.context)).resolves.toBeUndefined();
    expect(lines.at(-1)).toBe("could not subscribe the alert address yet (SNS is down); the alerts step tries again");
  });
});

describe("the admin user (spec 048 FR-020)", () => {
  it("takes your email from the settings, asking nothing", async () => {
    const prompter = scriptedPrompter([]);
    const cognito = fakeCognito();
    context = initContext({ answers: sampleAnswers({ adminEmail: ADMIN_EMAIL }), prompter, setup: setupServices({ cognito }), adminSession: async () => ({ controlPlaneUrl: "https://cp.example.test", accessToken: "t" }) });
    await writeEnvironmentSettings(context.store, STAGING_SETTINGS);
    expect(await adminUserStep().run(context, progressHandle())).toEqual({ status: "done", note: `admin ${ADMIN_EMAIL}` });
    expect(prompter.asked).toEqual([]);
    expect(cognito.created).toEqual([ADMIN_EMAIL]);
  });
});

describe("the message init ends with", () => {
  it("says where to talk to AgentX and what to do next", () => {
    const text = readyText({
      env: "staging", controlPlaneUrl: "https://cp.example.test", botName: "agentx-acme-staging", invocation: TEST_CLI_INVOCATION,
      progress: {
        ...emptyProgress("staging", T0),
        slack: { appId: "A0APP00001", teamId: "T0123456789", botUserId: "U0BOT00001" },
        project: { name: "payments-api", revision: 2, channelName: "payments", channelId: "C0PAY00001" },
        connectors: [{ type: "linear", ref: "linear" }],
      },
    });
    expect(text).toBe([
      "AgentX environment staging is ready.",
      "  Talk to it: mention @agentx-acme-staging in #payments (project payments-api).",
      "  Developers sign in with: node /opt/agentx/dist/main.js login https://cp.example.test",
      "  Connected: Linear. Add more with node /opt/agentx/dist/main.js --env staging connector add linear|jira|asana --project payments-api.",
      "  More projects: node /opt/agentx/dist/main.js --env staging project add, then node /opt/agentx/dist/main.js --env staging channel add.",
      "  Send a test alarm any time: node /opt/agentx/dist/main.js --env staging alerts test.",
      "  Remove it: node /opt/agentx/dist/main.js --env staging destroy. It deletes the coding machines' disks too.",
    ].join("\n"));
  });

  it("says no connectors yet when none was added", () => {
    const text = readyText({
      env: "staging", controlPlaneUrl: "https://cp.example.test", botName: "agentx-acme-staging", invocation: TEST_CLI_INVOCATION,
      progress: { ...emptyProgress("staging", T0), project: { name: "payments-api", revision: 1 } },
    });
    expect(text).toContain("  No connectors yet. Add one with node /opt/agentx/dist/main.js --env staging connector add linear|jira|asana --project payments-api.");
  });

  it("repeats a connector's warning at the end (owner decision 6)", () => {
    const text = readyText({
      env: "staging", controlPlaneUrl: "https://cp.example.test", botName: "agentx-acme-staging", invocation: TEST_CLI_INVOCATION,
      progress: {
        ...emptyProgress("staging", T0),
        project: { name: "payments-api", revision: 2 },
        connectors: [{ type: "jira", ref: "jira", warning: "the Jira service account can also see issues in HR" }],
      },
    });
    expect(text).toContain("  Warning (Jira): the Jira service account can also see issues in HR.");
  });

  it("#222: the ready summary names the bot by handle and gives a sign-in command that works as shown", () => {
    const text = readyText({
      env: "staging", controlPlaneUrl: "https://abc.example.com", progress: READY_PROGRESS_FIXTURE,
      botName: "agentx-acme-staging", invocation: { published: false, cliPath: "/opt/agentx/dist/main.js" },
    });
    expect(text).not.toMatch(/<@/);
    expect(text).toContain("  Talk to it: mention @agentx-acme-staging in #payments (project payments-api).");
    expect(text).toContain("  Developers sign in with: node /opt/agentx/dist/main.js login https://abc.example.com");
    expect(text).not.toContain("@preplabsai/rovara-code");
  });
});
