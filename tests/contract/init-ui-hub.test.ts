// Spec 048 FR-001, FR-002, FR-005 and FR-037: the hub tells the page where the install is, how
// long each step usually takes and has taken, what the tab title says, and when the page asks to close.
import { describe, expect, it } from "vitest";
import { INIT_STEP_IDS } from "../../packages/cli/src/init/install-state.js";
import { STEP_PLAN } from "../../packages/cli/src/init/ui/journey.js";
import { ACTION_NEEDED_TITLE, createWizardHub } from "../../packages/cli/src/init/ui/state.js";

const steps = INIT_STEP_IDS.map((id) => ({ id, title: STEP_PLAN[id].title }));

function clocked() {
  let now = 1_790_000_000_000;
  const hub = createWizardHub("staging", { now: () => now, logPath: "/home/a/.agentx/logs/init-staging.log" });
  hub.setSteps(steps);
  return { hub, advance: (ms: number) => { now += ms; } };
}

describe("the hub's journey", () => {

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
    expect(hub.state().pageTitle).toBe("Install Rovara (step 3 of 5)");
    hub.showCard({ id: "github", title: "GitHub app", status: "waiting", lines: ["Create it."] });
    expect(hub.state().pageTitle).toBe(ACTION_NEEDED_TITLE);
  });

  it("drops a failure's link it cannot check, and keeps the rest of the failure", () => {
    const { hub } = clocked();
    hub.showFailure({ title: "The install stopped", what: "Set up AWS permissions did not finish.", next: "Try this step again.", details: ["bad input"], link: { url: "javascript:alert(1)", label: "Fix it" } });
    expect(hub.state().failure).not.toHaveProperty("link");
    expect(hub.state().failure).toEqual({ title: "The install stopped", what: "Set up AWS permissions did not finish.", next: "Try this step again.", details: ["bad input"] });
  });

});
