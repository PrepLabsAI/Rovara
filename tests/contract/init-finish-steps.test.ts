import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { e2eStep, readyText, subscribeAlertsAfterDeploy } from "../../packages/cli/src/init/finish-steps.js";
import { emptyProgress } from "../../packages/cli/src/init/install-state.js";
import { subscribeAlertsEarly, type AlertsApi } from "../../packages/cli/src/setup/alerts.js";
import { initContext, progressHandle, sampleAnswers, T0, TEST_CLI_INVOCATION, type TestInitContext } from "../support/init-fakes.js";
import { ALERTS_TOPIC_ARN, fakeAlerts, setupServices } from "../support/setup-fakes.js";

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

let context: TestInitContext | undefined;
afterEach(async () => {
  if (context !== undefined) await rm(context.home, { recursive: true, force: true });
  await Promise.all(finishContexts.splice(0).map((built) => rm(built.home, { recursive: true, force: true })));
});

describe("the e2e step (FR-018 step 11)", () => {

  it("needs the channel from the first-project step", async () => {
    context = initContext();
    await expect(e2eStep().run(context, progressHandle())).rejects.toThrow("install progress has no bound channel; the first-project step must finish first, so run agentx init again");
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

describe("the message init ends with", () => {

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

});
