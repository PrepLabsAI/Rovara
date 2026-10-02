// Spec 048 FR-001, FR-002, FR-005 and FR-037: the hub tells the page where the install is, how
// long each step usually takes and has taken, what the tab title says, and when the page asks to close.
import { describe, expect, it } from "vitest";
import { INIT_STEP_IDS } from "../../packages/cli/src/init/install-state.js";
import { STEP_PLAN } from "../../packages/cli/src/init/ui/journey.js";
import { ACTION_NEEDED_TITLE, createWizardHub, NEW_TAB_NOTE } from "../../packages/cli/src/init/ui/state.js";

const steps = INIT_STEP_IDS.map((id) => ({ id, title: STEP_PLAN[id].title }));

function clocked() {
  let now = 1_790_000_000_000;
  const hub = createWizardHub("staging", { now: () => now, logPath: "/home/a/.agentx/logs/init-staging.log" });
  hub.setSteps(steps);
  return { hub, advance: (ms: number) => { now += ms; } };
}

describe("the hub's journey", () => {
  it("starts at Get started with the welcome, the install name and step 1 of 5", () => {
    const { hub } = clocked();
    const state = hub.state();
    expect(state.header).toEqual({ installName: "staging" });
    expect(state.journey.stepNumber).toBe(1);
    expect(state.welcome?.[0]).toBe("AgentX installs into your AWS account and connects to GitHub and Slack, in five parts:");
    expect(state.steps[4]).toMatchObject({ id: "control-plane", phase: "build", usualSeconds: 780, usualText: "usually 13 minutes" });
    expect(state.logPath).toBe("/home/a/.agentx/logs/init-staging.log");
  });

  it("shows the account and region once known, and drops the welcome after Get started", () => {
    const { hub } = clocked();
    hub.setPlace({ account: "123456789012", region: "us-east-1" });
    hub.setStage("your-choices");
    expect(hub.state().header).toEqual({ installName: "staging", account: "123456789012", region: "us-east-1" });
    expect(hub.state().welcome).toBeUndefined();
    expect(hub.state().journey.stepNumber).toBe(2);
  });

  it("records when a step started and how long it took", () => {
    const { hub, advance } = clocked();
    hub.applyEvent({ kind: "step-started", id: "access", title: STEP_PLAN.access.title });
    expect(hub.state().steps[1]).toMatchObject({ status: "running", startedAt: "2026-09-21T14:13:20.000Z" });
    advance(41_000);
    hub.applyEvent({ kind: "step-done", id: "access", title: STEP_PLAN.access.title });
    expect(hub.state().steps[1]).toMatchObject({ status: "done", tookSeconds: 41 });
  });

  it("marks a failed step Stopped in the rail", () => {
    const { hub } = clocked();
    // Controller ruling 1: mark prerequisites done before access starts, so journeyOf puts the
    // install in the build phase (the phase of the first unfinished step) rather than prerequisites'.
    hub.applyEvent({ kind: "step-started", id: "prerequisites", title: STEP_PLAN.prerequisites.title });
    hub.applyEvent({ kind: "step-done", id: "prerequisites", title: STEP_PLAN.prerequisites.title });
    hub.applyEvent({ kind: "step-started", id: "access", title: STEP_PLAN.access.title });
    hub.applyEvent({ kind: "step-failed", id: "access", title: STEP_PLAN.access.title, message: "Resource limit exceeded" });
    hub.showFailure({ title: "The install stopped", what: "Set up AWS permissions did not finish.", next: "Try this step again.", details: ["Resource limit exceeded"] });
    expect(hub.state().steps[1]?.status).toBe("failed");
    expect(hub.state().journey.phases[2]).toMatchObject({ status: "stopped", statusWord: "Stopped" });
    hub.clearFailure();
    expect(hub.state().failure).toBeUndefined();
  });

  it("FR-005: the tab title asks for action whenever the run waits on the user, and gives the step otherwise", () => {
    const { hub } = clocked();
    hub.setStage("your-choices");
    void hub.ask({ kind: "ask", text: "GitHub owner" }, (raw) => ({ value: raw }));
    expect(hub.state().pageTitle).toBe(ACTION_NEEDED_TITLE);
    expect(hub.state().waitingOnYou).toBe(true);
    hub.answer(hub.state().question?.id ?? "", "acme");
    // Controller ruling 1: prerequisites is marked done before access starts, so stepNumber lands on
    // step 3 of 5 (access, in the build phase) as the test's expected value requires.
    hub.applyEvent({ kind: "step-started", id: "prerequisites", title: STEP_PLAN.prerequisites.title });
    hub.applyEvent({ kind: "step-done", id: "prerequisites", title: STEP_PLAN.prerequisites.title });
    hub.applyEvent({ kind: "step-started", id: "access", title: STEP_PLAN.access.title });
    expect(hub.state().pageTitle).toBe("Install AgentX (step 3 of 5)");
    hub.showCard({ id: "github", title: "GitHub app", status: "waiting", lines: ["Create it."] });
    expect(hub.state().pageTitle).toBe(ACTION_NEEDED_TITLE);
  });

  it("FR-005: once the run has ended, the tab title no longer asks for action", () => {
    const { hub } = clocked();
    hub.showCard({ id: "slack", title: "Slack app", status: "waiting", lines: ["Waiting for a Slack admin."] });
    hub.showLink({ url: "https://api.slack.com/apps", label: "Open Slack" });
    expect(hub.state().waitingOnYou).toBe(true);
    hub.finish("The install is paused. Your progress is saved.", "paused");
    expect(hub.state().waitingOnYou).toBe(false);
    expect(hub.state().pageTitle).toBe("Install AgentX (step 1 of 5)");
    hub.close();
    expect(hub.state().waitingOnYou).toBe(false);
  });

  it("drops a failure's link it cannot check, and keeps the rest of the failure", () => {
    const { hub } = clocked();
    hub.showFailure({ title: "The install stopped", what: "Set up AWS permissions did not finish.", next: "Try this step again.", details: ["bad input"], link: { url: "javascript:alert(1)", label: "Fix it" } });
    expect(hub.state().failure).not.toHaveProperty("link");
    expect(hub.state().failure).toEqual({ title: "The install stopped", what: "Set up AWS permissions did not finish.", next: "Try this step again.", details: ["bad input"] });
  });

  it("FR-037: every link says it opens in a new tab and to come back", () => {
    const { hub } = clocked();
    hub.showCard({ id: "github", title: "GitHub app", status: "waiting", lines: [], link: { url: "https://github.com/settings/apps/new", label: "Open GitHub" } });
    hub.showLink({ url: "https://auth.example.com/login", label: "Sign in to AgentX" });
    expect(hub.state().cards?.[0]?.link?.note).toBe(NEW_TAB_NOTE);
    expect(hub.state().link?.note).toBe(NEW_TAB_NOTE);
  });

  it("resolves closeRequested once the page asks to close", async () => {
    const { hub } = clocked();
    let closed = false;
    void hub.closeRequested().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    hub.requestClose();
    await hub.closeRequested();
    expect(closed).toBe(true);
  });

  it("carries the continue command when the run stops", () => {
    const { hub } = clocked();
    hub.finish("The install stopped. Your progress is saved.", "failed", [{ label: "Continue later with", command: "agentx --env staging init --region us-east-1" }]);
    expect(hub.state()).toMatchObject({ phase: "failed", commands: [{ label: "Continue later with", command: "agentx --env staging init --region us-east-1" }] });
  });
});
