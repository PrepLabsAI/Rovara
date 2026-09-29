import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { e2eStep, finishSteps, readyText } from "../../packages/cli/src/init/finish-steps.js";
import { emptyProgress } from "../../packages/cli/src/init/install-state.js";
import { initContext, progressHandle, T0, type TestInitContext } from "../support/init-fakes.js";
import { fakeControlPlane, setupServices, turn } from "../support/setup-fakes.js";

let context: TestInitContext | undefined;
afterEach(async () => { if (context !== undefined) await rm(context.home, { recursive: true, force: true }); });

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

describe("the message init ends with", () => {
  it("says where to talk to AgentX and what to do next", () => {
    const text = readyText({ env: "staging", controlPlaneUrl: "https://cp.example.test", progress: {
      ...emptyProgress("staging", T0),
      slack: { appId: "A0APP00001", teamId: "T0123456789", botUserId: "U0BOT00001" },
      project: { name: "payments-api", revision: 2, channelName: "payments", channelId: "C0PAY00001" },
      connectors: [{ type: "linear", ref: "linear" }],
    } });
    expect(text).toBe([
      "AgentX environment staging is ready.",
      "  Talk to it: mention <@U0BOT00001> in #payments (project payments-api, revision 2).",
      "  Developers sign in with: npx @charterarc/agentx login https://cp.example.test",
      "  Connected: Linear. Add more with agentx --env staging connector add linear|jira|asana --project payments-api.",
      "  More projects: agentx --env staging project add, then agentx --env staging channel add.",
      "  Send a test alarm any time: agentx --env staging alerts test.",
    ].join("\n"));
  });

  it("says no connectors yet when none was added", () => {
    const text = readyText({ env: "staging", controlPlaneUrl: "https://cp.example.test", progress: {
      ...emptyProgress("staging", T0),
      project: { name: "payments-api", revision: 1 },
    } });
    expect(text).toContain("  No connectors yet. Add one with agentx --env staging connector add linear|jira|asana --project payments-api.");
  });

  it("repeats a connector's warning at the end (owner decision 6)", () => {
    const text = readyText({ env: "staging", controlPlaneUrl: "https://cp.example.test", progress: {
      ...emptyProgress("staging", T0),
      project: { name: "payments-api", revision: 2 },
      connectors: [{ type: "jira", ref: "jira", warning: "the Jira service account can also see issues in HR" }],
    } });
    expect(text).toContain("  Warning (Jira): the Jira service account can also see issues in HR.");
  });
});
