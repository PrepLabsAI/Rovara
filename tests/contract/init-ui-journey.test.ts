// tests/contract/init-ui-journey.test.ts
// Spec 048 FR-001, FR-002, FR-006 and FR-070: the five phases, every step's plain name and usual
// time, where the install is, and the terminal's one line per step.
import { describe, expect, it } from "vitest";
import { INIT_STEP_IDS } from "../../packages/cli/src/init/install-state.js";
import {
  JOURNEY_PHASE_IDS, journeyOf, needsYouMinutes, PHASE_TITLES, phaseSeconds, READY_LINE, stageLine, STEP_PLAN, stoppedLine,
  terminalStepLine, totalMinutes, usualText, welcomeLines, type JourneyStepView,
} from "../../packages/cli/src/init/ui/journey.js";

const T = 1_790_000_000_000;
const pending = (): JourneyStepView[] => INIT_STEP_IDS.map((id) => ({ id, status: "pending" as const }));
const withStatus = (changes: Partial<Record<(typeof INIT_STEP_IDS)[number], JourneyStepView>>): JourneyStepView[] =>
  pending().map((step) => changes[step.id] ?? step);

describe("the journey", () => {
  it("has five phases, in order, with plain titles", () => {
    expect(JOURNEY_PHASE_IDS.map((id) => PHASE_TITLES[id])).toEqual(["Get started", "Your choices", "Build in AWS", "Connect Slack", "Finish"]);
  });

  it("gives every step a phase, a plain title and a usual time", () => {
    expect(INIT_STEP_IDS.map((id) => STEP_PLAN[id].title)).toEqual([
      "Check your AWS account", "Set up AWS permissions", "Build the network and sign-in", "Create the GitHub app",
      "Start the AgentX service", "Create the Slack app", "Start the Slack connection", "Turn on developer sign-in",
      "Sign in to AgentX", "Set up your first project", "Connect your issue trackers", "Turn on alerts", "Get a first reply in Slack",
    ]);
    for (const id of INIT_STEP_IDS) expect(STEP_PLAN[id].usualSeconds).toBeGreaterThan(0);
  });

  it("adds the phases up to the total, and says how long the user is needed", () => {
    expect(JOURNEY_PHASE_IDS.reduce((sum, id) => sum + phaseSeconds(id), 0)).toBe(2610);
    expect(totalMinutes()).toBe(44);
    expect(needsYouMinutes()).toBe(25);
    expect(usualText(780)).toBe("usually 13 minutes");
    expect(usualText(30)).toBe("usually under a minute");
  });

  it("starts at Get started, step 1 of 5, waiting for the user, with every later phase coming up", () => {
    const view = journeyOf({ stage: "get-started", steps: pending(), waitingOnYou: true, stopped: false, finished: false, nowMs: T });
    expect(view.stepNumber).toBe(1);
    expect(view.stepCount).toBe(5);
    expect(view.phases.map((phase) => phase.statusWord)).toEqual(["Waiting for you", "Coming up", "Coming up", "Coming up", "Coming up"]);
    expect(view.timeLeftText).toBe("About 44 minutes left");
  });

  it("follows the running step, and marks earlier phases Done", () => {
    const view = journeyOf({
      stage: "your-choices",
      steps: withStatus({
        prerequisites: { id: "prerequisites", status: "done" }, access: { id: "access", status: "done" },
        core: { id: "core", status: "running", startedAtMs: T - 60_000 },
      }),
      waitingOnYou: false, stopped: false, finished: false, nowMs: T,
    });
    expect(view.current).toBe("build");
    expect(view.stepNumber).toBe(3);
    expect(view.phases.map((phase) => phase.status)).toEqual(["done", "done", "now", "coming", "coming"]);
    // core has 180 of its 240 seconds left, then github-app (120) and control-plane (780), then
    // Connect Slack (540) and Finish (420): 2040 seconds.
    expect(view.timeLeftText).toBe("About 34 minutes left");
    expect(view.overdue).toBe(false);
  });

  it("an overdue step says taking longer than usual, never zero or negative", () => {
    const view = journeyOf({
      stage: "your-choices",
      steps: withStatus({
        prerequisites: { id: "prerequisites", status: "done" }, access: { id: "access", status: "done" }, core: { id: "core", status: "done" },
        "github-app": { id: "github-app", status: "done" },
        "control-plane": { id: "control-plane", status: "running", startedAtMs: T - 3_600_000 },
      }),
      waitingOnYou: false, stopped: false, finished: false, nowMs: T,
    });
    expect(view.overdue).toBe(true);
    // After this step: Connect Slack (540) and Finish (420), 960 seconds.
    expect(view.timeLeftText).toBe("Taking longer than usual. About 16 minutes after this step.");
    expect(view.timeLeftText).not.toMatch(/\b0 minutes|-\d/);
  });

  it("shows Stopped on the current phase after a failure, and Done everywhere when finished", () => {
    const failed = journeyOf({ stage: "your-choices", steps: withStatus({ prerequisites: { id: "prerequisites", status: "done" }, access: { id: "access", status: "failed" } }), waitingOnYou: true, stopped: true, finished: false, nowMs: T });
    expect(failed.phases[2]).toMatchObject({ id: "build", status: "stopped", statusWord: "Stopped" });
    const done = journeyOf({ stage: "finish", steps: INIT_STEP_IDS.map((id) => ({ id, status: "done" as const })), waitingOnYou: false, stopped: false, finished: true, nowMs: T });
    expect(done.phases.every((phase) => phase.status === "done")).toBe(true);
    expect(done.timeLeftText).toBe("Done");
  });

  it("welcomes the user with the phases, the total, the time needed, and what to keep open", () => {
    expect(welcomeLines()).toEqual([
      "AgentX installs into your AWS account and connects to GitHub and Slack, in five parts:",
      "Get started: about 2 minutes.",
      "Your choices: about 6 minutes.",
      "Build in AWS: about 20 minutes.",
      "Connect Slack: about 9 minutes.",
      "Finish: about 7 minutes.",
      "In all, about 44 minutes. You are needed for about 25 of them, and this page tells you when.",
      "Keep the terminal open and your computer awake until the install is done.",
      "You can close this tab and open the same address again at any time.",
    ]);
  });

  it("writes one terminal line per step, and one each for a wait, the end and a stop", () => {
    expect(terminalStepLine("control-plane")).toBe("[3/5] Build in AWS: Start the AgentX service (about 13 minutes)");
    expect(terminalStepLine("slack-app")).toBe("[4/5] Connect Slack: Create the Slack app. Waiting for you in the browser.");
    expect(stageLine("your-choices")).toBe("[2/5] Your choices: waiting for you in the browser");
    expect(READY_LINE).toBe("[5/5] Finish: done. AgentX is ready. The browser has the next steps.");
    expect(stoppedLine({ phase: "build", problem: "Start the AgentX service did not finish.", logPath: "/home/a/.agentx/logs/init-staging.log" }))
      .toBe("[3/5] Stopped: Start the AgentX service did not finish. Details in the browser and in /home/a/.agentx/logs/init-staging.log.");
  });
});
