import { installGatewayFixture } from "../support/install-gateway.js";
// tests/contract/init-ui-journey.test.ts
// Spec 048 FR-001, FR-002, FR-006 and FR-070: the five phases, every step's plain name and usual
// time, where the install is, and the terminal's one line per step.
import { describe, expect, it } from "vitest";
import { initSteps } from "../../packages/cli/src/init/commands.js";
import { INIT_STEP_IDS } from "../../packages/cli/src/init/install-state.js";
import { INSTALL_STEP_ORDER, JOURNEY_PHASE_IDS, journeyOf, needsYouMinutes, PHASE_TITLES, phaseSeconds, totalMinutes, usualText, type JourneyStepView } from "../../packages/cli/src/init/ui/journey.js";
import { fakeGitHubApi, fakeSlackApi } from "../support/init-fakes.js";

installGatewayFixture();

const T = 1_790_000_000_000;
const pending = (): JourneyStepView[] => INSTALL_STEP_ORDER.map((id) => ({ id, status: "pending" as const }));
const withStatus = (changes: Partial<Record<(typeof INIT_STEP_IDS)[number], JourneyStepView>>): JourneyStepView[] =>
  pending().map((step) => changes[step.id] ?? step);

describe("the journey", () => {
  it("has five phases, in order, with plain titles", () => {
    expect(JOURNEY_PHASE_IDS.map((id) => PHASE_TITLES[id])).toEqual(["Get started", "Your choices", "Build in AWS", "Connect GitHub and Slack", "Finish"]);
  });

  it("adds the phases up to the total, and says how long the user is needed", () => {
    expect(JOURNEY_PHASE_IDS.reduce((sum, id) => sum + phaseSeconds(id), 0)).toBe(2700); // #1612: the company step's 30 seconds
    expect(phaseSeconds("your-choices")).toBe(330);
    expect(phaseSeconds("build")).toBe(1260);
    expect(phaseSeconds("connect")).toBe(540);
    expect(totalMinutes()).toBe(45);
    expect(needsYouMinutes()).toBe(21);
    expect(usualText(780)).toBe("usually 13 minutes");
    expect(usualText(30)).toBe("usually under a minute");
  });

  it("an overdue step says taking longer than usual, never zero or negative", () => {
    const view = journeyOf({
      stage: "your-choices",
      steps: withStatus({
        prerequisites: { id: "prerequisites", status: "done" }, access: { id: "access", status: "done" }, core: { id: "core", status: "done" },
        "control-plane": { id: "control-plane", status: "running", startedAtMs: T - 3_600_000 },
      }),
      waitingOnYou: false, stopped: false, finished: false, nowMs: T,
    });
    expect(view.overdue).toBe(true);
    // After this step: slack-service (180), Connect GitHub and Slack (540) and Finish (420), 1140 seconds.
    expect(view.timeLeftText).toBe("Taking longer than usual. About 20 minutes after this step.");
    expect(view.timeLeftText).not.toMatch(/\b0 minutes|-\d/);
  });

});

describe("the run order: every stack first, then the GitHub and Slack apps", () => {
  it("deploys every stack before the GitHub app, and lists every step once", () => {
    expect(INSTALL_STEP_ORDER).toEqual([
      "prerequisites", "access", "core", "control-plane", "slack-service", "github-app", "slack-app", "slack-check", "developer-signin",
      "admin-user", "first-project", "connectors", "company", "alerts", "e2e",
    ]);
    expect([...INSTALL_STEP_ORDER].sort()).toEqual([...INIT_STEP_IDS].sort());
    expect(initSteps({ github: fakeGitHubApi(), slack: fakeSlackApi() }).map((step) => step.id)).toEqual([...INSTALL_STEP_ORDER]);
  });

});
