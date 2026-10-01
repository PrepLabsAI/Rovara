# Spec 048 Phase 1: Page Shell and Quick Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The install page always says where the install is, how long is left and when the user
is needed, speaks plain words, keeps a failed deploy step on the page with "Try this step again",
stays open on the ready screen, and the terminal goes quiet; the install order itself does not
change yet.

**Architecture:**
- **One journey model** (`packages/cli/src/init/ui/journey.ts`, new): the five phases, every
  step's plain name, phase and first time estimate, the status words, the welcome text and the
  terminal's step lines. Pure functions, no clock or I/O. The hub, the page, the terminal lines
  and the step titles all read it, so a name or an estimate lives in one place (FR-027).
- **The hub computes, the page lays out.** Everything the page shows as words (tab title, time
  left, status words, hints, button labels, failure text) is computed on the server into
  `WizardState`, so it is tested without a browser and the copy-lint test reads it. The page's
  module only renders state and ticks elapsed time.
- **Help travels with the question.** `Prompter` options gain an optional `help` (label, why,
  example, Learn more link, verb button labels). A catalog (`ui/question-copy.ts`, new) supplies it
  for every question on the default path, keyed by flag or by question text; the terminal ignores
  it, so the terminal and `--yes` keep their exact questions.
- **A failure is a screen.** `runInitSteps` gains an `onStepFailure` hook. On the page, a deploy
  step's failure shows a three-part failure screen with "Try this step again" and "Stop for now";
  any other failure shows the screen with "Stop for now". Without a page nothing changes.
- **Quiet terminal, full log file.** With the page, the terminal prints three start lines and one
  line per step; everything else goes to `~/.agentx/logs/init-<env>.log` (never the page's
  token) and to the page's technical log.

**Tech Stack:** TypeScript 5.9 strict, Node 22.19 to 22.x, Vitest 5, zod 4. No new dependency.
The page stays plain HTML, CSS and an ES module held as text in `page.ts` (spec 040).

**Spec:** [../spec.md](../spec.md), the binding authority. This plan delivers the spec's Phases
row 1: FR-001 to FR-004, FR-005 (tab title only), FR-006, FR-008, FR-010 to FR-012, FR-016,
FR-017, FR-023, FR-024, FR-026, FR-027, FR-037, FR-058 to FR-060, FR-070, FR-071, FR-080 to
FR-082, and the image check of FR-065. Owner approval of the spec, with all five open choices
accepted: PR #231 comment of 2026-10-01.

**Branch:** `feat/048a-page-shell`, cut from `origin/mainline` after this plan merges. One PR
against `mainline` (no stacking).

## Global Constraints

- **The install order does not change in this phase.** Steps run in `INIT_STEP_IDS` order; the
  GitHub app is shown under "Build in AWS" until phase 2 moves it (FR-031 is phase 2).
- **The terminal path and `--yes` keep their questions, flags and behavior** (FR-072, SC-015),
  except three deliberate changes this spec makes everywhere: the plain step titles (FR-080), the
  budget default (estimate plus 20%, rounded up to a whole $10, whole account; FR-023) and the app
  name default (FR-026). Every existing `--yes` test passes, with its expected values updated to
  those three changes only.
- **Exact names (later phases depend on them):** `STEP_PLAN`, `JOURNEY_PHASE_IDS`, `PHASE_TITLES`,
  `STATUS_WORDS`, `journeyOf`, `terminalStepLine`, `stageLine`, `READY_LINE`, `stoppedLine`,
  `welcomeLines`, `QuestionHelp`, `questionHelp`, `pageHint`, `askForm`, `FormField`,
  `WizardFailure`, `failureScreen`, `plainReason`, `askFailureAction`, `operatorStop`,
  `isOperatorStop`, `estimateMonthlyCost`, `suggestedBudgetUsd`, `modelPriceLabel`,
  `defaultAppName`, `releaseImageChecks`, `initLogPath`, `openInitLog`, `currentCliInvocation`,
  `cliCommandLine`, `READY_HOLD_MS = 30 * 60_000`, the hub methods `setStage`, `setPlace`,
  `showFailure`, `clearFailure`, `requestClose`, `closeRequested`, and the server route
  `POST /close`.
- **Copy:** plain words from the glossary (FR-080); Slack's own labels kept as Slack writes them
  (Signing Secret, Bot User OAuth Token, Client ID, Client Secret, OAuth & Permissions). No em
  dashes in any page text, terminal line, doc, test name or fixture.
- **Security rules of spec 040 hold:** loopback only, the session token, origin checks, secrets
  never echoed. No secret and no session token reaches the log file (FR-071).
- **Do not touch** `infra/` or any CloudFormation template. The legacy and named template
  snapshots (`tests/contract/__snapshots__/*.snap`) stay byte-identical.
- **Tests:** never `vitest -u`; no assertion removed or weakened. An existing assertion whose
  expected text this spec changes is replaced by the new exact text, never by a looser matcher
  (no `toContain` of a fragment where `toBe` or `toEqual` stood).
- **Typecheck ratchet:** `npm run typecheck:all` must not report more errors than the baseline.
- **The gate**, on Node 22: `npm run typecheck:all && npm run lint && npm run build && npm test && npm run infra:synth`.
  - Node 22: `export PATH=/private/tmp/claude-501/node-v22.20.0-darwin-arm64/bin:$PATH` (or any
    Node 22.19 or later on PATH).
  - While iterating on one task, run only its test files with `npx vitest run <files>`.
- **Build process:** the owner approves this plan, then picks the execution method.

## Review Focus

1. **A step that runs past its estimate** (a slow CloudFormation create). Expected: the time left
   never reads zero or negative; the header says "Taking longer than usual". Pinned in Task 1
   ("an overdue step says taking longer than usual, never zero or negative").
2. **The page reloads while the failure screen is up.** Expected: the reconnecting page gets the
   failure screen, its actions and the Stopped status in its first snapshot. Pinned in Task 12
   ("a page that reconnects during a failure gets the failure screen back").
3. **A form where one field is refused and another holds a secret.** Expected: the valid plain
   values stay filled, the secret field comes back empty, and the secret is in no state the page
   can read. Pinned in Task 5 ("a refused form keeps valid plain values and never echoes a secret").
4. **The longest names:** a 20-character install name and a 39-character GitHub owner.
   Expected: the GitHub and Slack default names are equal, at most 34 characters, and still name
   the install. Pinned in Task 10 ("the longest owner and install name still fit, and both apps match").
5. **A model with no price on file** (a custom Bedrock id). Expected: the plan shows "not priced",
   the total says what it leaves out, and the budget default is the priced lines plus 20% with a
   note. Pinned in Task 9 ("an unpriced model is named, left out of the total, and noted in the budget help").

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/cli/src/init/ui/journey.ts` (new) | Phases, step plan (plain titles, estimates, needs you), status words, `journeyOf`, welcome lines, terminal step lines |
| `packages/cli/src/init/ui/protocol.ts` | New state fields: journey, header, page title, failure, commands, help fields, buttons, form fields |
| `packages/cli/src/init/ui/state.ts` | Hub: step timing, stage, place, failure, close request, page title, link notes |
| `packages/cli/src/init/ui/question-copy.ts` (new) | The page's words for every default-path question: label, why, example, buttons |
| `packages/cli/src/init/ui/prompter.ts` | Attaches help, hints, verb buttons, the `actions` and `form` kinds |
| `packages/cli/src/init/ui/failure.ts` (new) | The failure screen's content, `plainReason`, the action question |
| `packages/cli/src/init/ui/cards.ts` | Plain-word cards, technical details, names not IDs, ready card |
| `packages/cli/src/init/ui/page.ts` | The page shell: header, rail, one panel, details for plan and log, a11y |
| `packages/cli/src/init/ui/server.ts` | `POST /close`; the GitHub return tab that closes itself |
| `packages/cli/src/init/ui/index.ts` | Wizard wiring: start lines, log file, new hub methods |
| `packages/cli/src/init/cost.ts` (new) | Prices, the estimate, `modelPriceLabel`, `suggestedBudgetUsd` (moved out of plan.ts) |
| `packages/cli/src/init/log-file.ts` (new) | `initLogPath`, `openInitLog` (token and secrets never written) |
| `packages/cli/src/init/cli-command.ts` (new) | The command a person can run as shown (#222) |
| `packages/cli/src/init/stop.ts` (new) | `operatorStop`, `isOperatorStop`: a stop the person chose is not a failure |
| `packages/cli/src/init/steps.ts` | `step-failed` event; `onStepFailure` retry hook |
| `packages/cli/src/init/commands.ts` | Stage and place, failure screens, quiet terminal, ready hold |
| `packages/cli/src/init/answers.ts`, `plan.ts`, `prerequisites.ts`, `aws-account.ts`, `install-state.ts`, `slack-app.ts`, `github-app.ts`, `finish-steps.ts`, `signin-step.ts`, `deploy-steps.ts`, `prompts.ts`, `context.ts` | Copy, defaults, root warning, image check, bot name, help option |
| `packages/cli/src/main.ts` | Prints nothing more after a page-mode run (the terminal already has its lines) |
| `tests/support/copy-lint.ts` (new) | The copy-lint rules and the state flattener |
| `tests/contract/init-ui-journey.test.ts`, `init-ui-copy-lint.test.ts`, `init-ui-question-copy.test.ts`, `init-ui-form.test.ts`, `init-ui-failure.test.ts`, `init-ui-page.test.ts`, `init-log-file.test.ts`, `init-cli-command.test.ts`, `init-cost.test.ts` (new) | Tests for the new modules |
| `docs/install.md` | The install page section: the progress rail, the log file |

## Interfaces Later Phases Rely On

- **Phase 2 (order and early checks):** reorders `STEP_PLAN` phases (GitHub to "Your choices") and
  `BEFORE_STEPS_SECONDS`; builds the settings screen and the one Slack form on `askForm` and
  `FormField`; extends `QUESTION_COPY` for the Advanced settings (OIDC, OpenRouter, trackers);
  reuses `suggestedBudgetUsd`, `defaultAppName`, `releaseImageChecks`, `operatorStop`.
- **Phase 3 (recovery):** adds failure kinds to `failureScreen` and new actions to
  `askFailureAction` (it already returns a string union to extend); reuses `onStepFailure`,
  `showFailure`, `cliCommandLine` for "Stop for now", and the log file.
- **Phase 4 (pickers and progress):** replaces `usualSeconds` in `STEP_PLAN` with measured values,
  fills FR-007 rows from `WizardStep.startedAt`, and adds the notification beside `pageTitle`.

---

### Task 1: The journey model

**Files:**
- Create: `packages/cli/src/init/ui/journey.ts`
- Test: `tests/contract/init-ui-journey.test.ts` (new)

**Interfaces:**
- Consumes: `InitStepId`, `INIT_STEP_IDS` from `packages/cli/src/init/install-state.ts`.
- Produces:
  - `JOURNEY_PHASE_IDS`, `type JourneyPhaseId`, `PHASE_TITLES: Record<JourneyPhaseId, string>`
  - `type JourneyStatus = "done" | "now" | "waiting" | "coming" | "stopped"`, `STATUS_WORDS`
  - `interface StepPlan { phase: JourneyPhaseId; title: string; usualSeconds: number; needsYou: boolean }`, `STEP_PLAN: Record<InitStepId, StepPlan>`
  - `BEFORE_STEPS_SECONDS`, `phaseSeconds(phase): number`, `totalMinutes(): number`, `needsYouMinutes(): number`, `minutesText(minutes): string`, `usualText(seconds): string`, `phaseNumber(phase): number`
  - `interface JourneyStepView { id: InitStepId; status: "pending" | "skipped" | "running" | "done" | "waiting" | "failed"; startedAtMs?: number }`
  - `interface JourneyView { phases: JourneyPhaseView[]; current: JourneyPhaseId; stepNumber: number; stepCount: number; timeLeftText: string; overdue: boolean }` and `interface JourneyPhaseView { id: JourneyPhaseId; title: string; status: JourneyStatus; statusWord: string; timeText: string; needsYou: boolean }`
  - `journeyOf(input: { stage: JourneyPhaseId; steps: readonly JourneyStepView[]; waitingOnYou: boolean; stopped: boolean; finished: boolean; nowMs: number }): JourneyView`
  - `welcomeLines(): string[]`, `terminalStepLine(id: InitStepId): string`, `stageLine(phase): string`, `READY_LINE`, `stoppedLine(input: { phase: JourneyPhaseId; problem: string; logPath: string }): string`

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/contract/init-ui-journey.test.ts`
Expected: FAIL with "Failed to load url ../../packages/cli/src/init/ui/journey.js" (the module does not exist).

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/cli/src/init/ui/journey.ts
// Spec 048 FR-001, FR-002, FR-006, FR-070 and FR-080: the five phases of the install, every
// step's plain name, phase and usual time, and the words for where the install is. Pure: no clock
// and no I/O, so the hub, the page, the terminal lines and the step titles read one source.
// Phase 2 moves steps between phases here; phase 4 replaces the first estimates with measured ones.
import { INIT_STEP_IDS, type InitStepId } from "../install-state.js";

export const JOURNEY_PHASE_IDS = ["get-started", "your-choices", "build", "connect-slack", "finish"] as const;
export type JourneyPhaseId = (typeof JOURNEY_PHASE_IDS)[number];

export const PHASE_TITLES: Readonly<Record<JourneyPhaseId, string>> = {
  "get-started": "Get started", "your-choices": "Your choices", build: "Build in AWS", "connect-slack": "Connect Slack", finish: "Finish",
};

export type JourneyStatus = "done" | "now" | "waiting" | "coming" | "stopped";
/** FR-001: a status word for every phase, so status is never color or a symbol alone. */
export const STATUS_WORDS: Readonly<Record<JourneyStatus, string>> = {
  done: "Done", now: "Now", waiting: "Waiting for you", coming: "Coming up", stopped: "Stopped",
};

export interface StepPlan { phase: JourneyPhaseId; title: string; usualSeconds: number; needsYou: boolean }

/** First estimates from the live run of 2026-10-01 (spec 048 Assumptions). Phase 4 replaces them
 * with numbers measured on two clean runs (FR-002). */
export const STEP_PLAN: Readonly<Record<InitStepId, StepPlan>> = {
  prerequisites: { phase: "your-choices", title: "Check your AWS account", usualSeconds: 30, needsYou: false },
  access: { phase: "build", title: "Set up AWS permissions", usualSeconds: 60, needsYou: false },
  core: { phase: "build", title: "Build the network and sign-in", usualSeconds: 240, needsYou: false },
  "github-app": { phase: "build", title: "Create the GitHub app", usualSeconds: 120, needsYou: true },
  "control-plane": { phase: "build", title: "Start the AgentX service", usualSeconds: 780, needsYou: false },
  "slack-app": { phase: "connect-slack", title: "Create the Slack app", usualSeconds: 240, needsYou: true },
  "slack-service": { phase: "connect-slack", title: "Start the Slack connection", usualSeconds: 180, needsYou: true },
  "developer-signin": { phase: "connect-slack", title: "Turn on developer sign-in", usualSeconds: 120, needsYou: true },
  "admin-user": { phase: "finish", title: "Sign in to AgentX", usualSeconds: 120, needsYou: true },
  "first-project": { phase: "finish", title: "Set up your first project", usualSeconds: 120, needsYou: true },
  connectors: { phase: "finish", title: "Connect your issue trackers", usualSeconds: 60, needsYou: true },
  alerts: { phase: "finish", title: "Turn on alerts", usualSeconds: 60, needsYou: true },
  e2e: { phase: "finish", title: "Get a first reply in Slack", usualSeconds: 60, needsYou: true },
};

/** The screens before the first step: profile, region and account; then the questions and the plan. */
export const BEFORE_STEPS_SECONDS: Readonly<Record<"get-started" | "your-choices", number>> = { "get-started": 120, "your-choices": 300 };

const stepsIn = (phase: JourneyPhaseId): InitStepId[] => INIT_STEP_IDS.filter((id) => STEP_PLAN[id].phase === phase);
const beforeSteps = (phase: JourneyPhaseId): number => (phase === "get-started" || phase === "your-choices" ? BEFORE_STEPS_SECONDS[phase] : 0);
const phaseIndex = (phase: JourneyPhaseId): number => JOURNEY_PHASE_IDS.indexOf(phase);

export const phaseNumber = (phase: JourneyPhaseId): number => phaseIndex(phase) + 1;

export function phaseSeconds(phase: JourneyPhaseId): number {
  return beforeSteps(phase) + stepsIn(phase).reduce((sum, id) => sum + STEP_PLAN[id].usualSeconds, 0);
}

const toMinutes = (seconds: number): number => Math.ceil(seconds / 60);

export function totalMinutes(): number {
  return toMinutes(JOURNEY_PHASE_IDS.reduce((sum, id) => sum + phaseSeconds(id), 0));
}

export function needsYouMinutes(): number {
  const seconds = JOURNEY_PHASE_IDS.reduce((sum, id) => sum + beforeSteps(id), 0)
    + INIT_STEP_IDS.filter((id) => STEP_PLAN[id].needsYou).reduce((sum, id) => sum + STEP_PLAN[id].usualSeconds, 0);
  return toMinutes(seconds);
}

export const minutesText = (minutes: number): string => (minutes === 1 ? "about 1 minute" : `about ${minutes} minutes`);
export const usualText = (seconds: number): string => (seconds < 60 ? "usually under a minute" : `usually ${toMinutes(seconds) === 1 ? "1 minute" : `${toMinutes(seconds)} minutes`}`);

export interface JourneyStepView { id: InitStepId; status: "pending" | "skipped" | "running" | "done" | "waiting" | "failed"; startedAtMs?: number }
export interface JourneyPhaseView { id: JourneyPhaseId; title: string; status: JourneyStatus; statusWord: string; timeText: string; needsYou: boolean }
export interface JourneyView { phases: JourneyPhaseView[]; current: JourneyPhaseId; stepNumber: number; stepCount: number; timeLeftText: string; overdue: boolean }

const finishedStatus = (status: JourneyStepView["status"]): boolean => status === "done" || status === "skipped";

/** The phase the install is in: the explicit stage before any step runs, then the phase of the
 * first step not yet finished, never earlier than the stage. */
function currentPhase(stage: JourneyPhaseId, steps: readonly JourneyStepView[], finished: boolean): JourneyPhaseId {
  if (finished) return "finish";
  const started = steps.some((step) => step.status !== "pending");
  if (!started) return stage;
  const next = steps.find((step) => !finishedStatus(step.status));
  const fromSteps = next === undefined ? "finish" : STEP_PLAN[next.id].phase;
  return phaseIndex(fromSteps) > phaseIndex(stage) ? fromSteps : stage;
}

export function journeyOf(input: { stage: JourneyPhaseId; steps: readonly JourneyStepView[]; waitingOnYou: boolean; stopped: boolean; finished: boolean; nowMs: number }): JourneyView {
  const current = currentPhase(input.stage, input.steps, input.finished);
  const at = phaseIndex(current);
  const byId = new Map(input.steps.map((step) => [step.id, step]));
  let remaining = 0;
  let overdue = false;
  for (const phase of JOURNEY_PHASE_IDS.slice(at)) {
    const ids = stepsIn(phase);
    const anyStarted = ids.some((id) => (byId.get(id)?.status ?? "pending") !== "pending");
    if (!anyStarted) remaining += beforeSteps(phase);
    for (const id of ids) {
      const step = byId.get(id);
      if (step !== undefined && finishedStatus(step.status)) continue;
      const usual = STEP_PLAN[id].usualSeconds;
      if (step?.status === "running" && step.startedAtMs !== undefined) {
        const elapsed = Math.max(0, (input.nowMs - step.startedAtMs) / 1000);
        if (elapsed > usual) overdue = true;
        else remaining += usual - elapsed;
      } else {
        remaining += usual;
      }
    }
  }
  const minutesLeft = toMinutes(remaining);
  const timeLeftText = input.finished ? "Done"
    : overdue ? `Taking longer than usual.${minutesLeft > 0 ? ` About ${minutesLeft} ${minutesLeft === 1 ? "minute" : "minutes"} after this step.` : ""}`
      : minutesLeft <= 1 ? "Less than a minute left" : `About ${minutesLeft} minutes left`;
  const phases = JOURNEY_PHASE_IDS.map((id, index): JourneyPhaseView => {
    const status: JourneyStatus = input.finished || index < at ? "done"
      : index > at ? "coming"
        : input.stopped ? "stopped" : input.waitingOnYou ? "waiting" : "now";
    return {
      id, title: PHASE_TITLES[id], status, statusWord: STATUS_WORDS[status],
      timeText: minutesText(toMinutes(phaseSeconds(id))),
      needsYou: id === "get-started" || id === "your-choices" || stepsIn(id).some((step) => STEP_PLAN[step].needsYou),
    };
  });
  return { phases, current, stepNumber: at + 1, stepCount: JOURNEY_PHASE_IDS.length, timeLeftText, overdue };
}

/** FR-006: what the first screen says. */
export function welcomeLines(): string[] {
  return [
    "AgentX installs into your AWS account and connects to GitHub and Slack, in five parts:",
    ...JOURNEY_PHASE_IDS.map((id) => `${PHASE_TITLES[id]}: ${minutesText(toMinutes(phaseSeconds(id)))}.`),
    `In all, ${minutesText(totalMinutes())}. You are needed for about ${needsYouMinutes()} of them, and this page tells you when.`,
    "Keep the terminal open and your computer awake until the install is done.",
    "You can close this tab and open the same address again at any time.",
  ];
}

const prefix = (phase: JourneyPhaseId): string => `[${phaseNumber(phase)}/${JOURNEY_PHASE_IDS.length}]`;

/** FR-070: the one terminal line a step gets when it starts, with the page open. */
export function terminalStepLine(id: InitStepId): string {
  const plan = STEP_PLAN[id];
  const head = `${prefix(plan.phase)} ${PHASE_TITLES[plan.phase]}: ${plan.title}`;
  return plan.needsYou ? `${head}. Waiting for you in the browser.` : `${head} (${minutesText(toMinutes(plan.usualSeconds))})`;
}

/** FR-070: the line for a phase that starts with questions, before any step runs. */
export const stageLine = (phase: JourneyPhaseId): string => `${prefix(phase)} ${PHASE_TITLES[phase]}: waiting for you in the browser`;

export const READY_LINE = "[5/5] Finish: done. AgentX is ready. The browser has the next steps.";

/** FR-070: the one line a failure gets in the terminal. `problem` is a plain sentence ending in a full stop. */
export const stoppedLine = (input: { phase: JourneyPhaseId; problem: string; logPath: string }): string =>
  `${prefix(input.phase)} Stopped: ${input.problem} Details in the browser and in ${input.logPath}.`;
```

The numbers the test pins: the steps add up to 2190 seconds and the screens before them to 420,
so the journey is 2610 seconds (44 minutes); "Your choices" is 300 + 30 seconds (about 6 minutes).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/contract/init-ui-journey.test.ts`
Expected: PASS (9 tests). If a minute figure differs, fix the constants in `STEP_PLAN` or
`BEFORE_STEPS_SECONDS`, never the test's numbers: the test's numbers are the plan's estimates.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/init/ui/journey.ts tests/contract/init-ui-journey.test.ts
git commit -m "feat(init): the guided install's five phases, plain step names and first estimates (048 phase 1)"
```

---

### Task 2: The copy-lint rules, proven by seeded examples

**Files:**
- Create: `tests/support/copy-lint.ts`
- Test: `tests/contract/init-ui-copy-lint.test.ts` (new; Task 16 adds the whole-journey test to it)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type CopyContext = "page" | "details" | "stop-for-now" | "lost-connection" | "ready"`
  - `interface CopyEntry { where: string; text: string; context: CopyContext; failedRun?: boolean }`
  - `interface CopyRule { id: string; pattern: RegExp; allowedIn: readonly CopyContext[]; onlyOnFailedRun?: boolean }`
  - `COPY_RULES: readonly CopyRule[]`, `lintCopy(entries: readonly CopyEntry[]): string[]`
  - `quotedStrings(source: string): string[]` (the string literals of the page's HTML and module)

- [ ] **Step 1: Write the failing test**

```ts
// tests/contract/init-ui-copy-lint.test.ts
// Spec 048 FR-081 and SC-011: the copy-lint rules. Each rule is proven by a seeded example that
// must fail it, and good copy must pass every rule. Task 16 runs the rules over the whole journey.
import { describe, expect, it } from "vitest";
import { COPY_RULES, lintCopy, quotedStrings, type CopyContext } from "../support/copy-lint.js";

const SEEDED: Record<string, string> = {
  "phase-or-spec-number": "To remove it later, follow the teardown guide (agentx destroy arrives in phase 15e).",
  "dotted-config-key": "Mentions people post through other apps: accept (slack.appPostedMessages).",
  "cloudformation-type": "Resource AWS::Lambda::Function failed to create",
  "cloudformation-logical-id": "BrokerE1355FD6 failed to create",
  "raw-slack-markup": "Talk to it: mention <@U0C6V3H9C8Y> in #payments",
  "raw-slack-id": "Slack app A0APP is installed in workspace T0TEAM.",
  "aws-arn": "Signed in as arn:aws:sts::123456789012:assumed-role/Admin/alice.",
  "enter-for": "Permission boundary policy ARN (Enter for AgentX's default boundary)",
  "empty-leave-empty-for": "Leave empty for ",
  "error-code": "AgentX error [INTERNAL_ERROR]: the step failed",
  "finished-on-failed-run": "Finished",
  "day-two-without-env": "A test alarm any time: agentx alerts test",
  "unpublished-package": "Developers sign in with: npx @charterarc/agentx login https://abc.example.com",
  "terminal-instruction": "Once it is installed, run agentx init --env staging --region us-east-1 again.",
};

const GOOD = [
  "AgentX installs into AWS account 123456789012 in us-east-1.",
  "Open github.com",
  "Pick your workspace in api.slack.com, then come back to this tab.",
  "Mention @agentx-acme-production in #payments.",
  "Leave empty to use production.",
  "Optional. Leave empty to use AgentX's default.",
  "Start the AgentX service: usually 13 minutes",
  "Claude Sonnet 4.6 (recommended; about $0.025 a turn)",
  "The Bot User OAuth Token is under OAuth & Permissions. It starts with xoxb-.",
  "Keep the terminal open and your computer awake until the install is done.",
];

describe("copy-lint rules", () => {
  it("has a seeded failing example for every rule, and no rule without one", () => {
    expect(Object.keys(SEEDED).sort()).toEqual(COPY_RULES.map((rule) => rule.id).sort());
  });

  for (const rule of COPY_RULES) {
    it(`fails the seeded example of ${rule.id}`, () => {
      const found = lintCopy([{ where: "seed", text: SEEDED[rule.id] ?? "", context: "page", failedRun: true }]);
      expect(found.some((line) => line.startsWith(`${rule.id} in seed`))).toBe(true);
    });
  }

  it("passes good copy", () => {
    expect(lintCopy(GOOD.map((text, index) => ({ where: `good ${index}`, text, context: "page" as CopyContext, failedRun: true })))).toEqual([]);
  });

  it("allows raw IDs, ARNs, codes and commands in technical details only", () => {
    const technical = [SEEDED["aws-arn"], SEEDED["raw-slack-id"], SEEDED["error-code"], SEEDED["cloudformation-type"], SEEDED["terminal-instruction"]];
    expect(lintCopy(technical.map((text) => ({ where: "details", text: text ?? "", context: "details" as CopyContext })))).toEqual([]);
  });

  it("allows a command on Stop for now, the lost connection notice and the ready screen, but never without --env", () => {
    const resume = { where: "stop", text: "agentx --env staging init --region us-east-1", context: "stop-for-now" as const };
    expect(lintCopy([resume])).toEqual([]);
    expect(lintCopy([{ where: "ready", text: "agentx alerts test", context: "ready" }])).toHaveLength(1);
  });

  it("allows Finished on a run that did not fail", () => {
    expect(lintCopy([{ where: "ok", text: "Finished", context: "page", failedRun: false }])).toEqual([]);
  });

  it("reads the string literals out of the page's source", () => {
    expect(quotedStrings(`a.textContent = "Show technical log"; b = 'x'; c = \`y\`;`)).toEqual(["Show technical log", "x", "y"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/contract/init-ui-copy-lint.test.ts`
Expected: FAIL with "Failed to load url ../support/copy-lint.js".

- [ ] **Step 3: Write minimal implementation**

```ts
// tests/support/copy-lint.ts
// Spec 048 FR-081: words that must never reach the install page. Each rule names where its words
// are allowed: technical details, the Stop for now screen, the lost connection notice and the
// ready screen (where a command with a copy button is the point).
export type CopyContext = "page" | "details" | "stop-for-now" | "lost-connection" | "ready";
export interface CopyEntry { where: string; text: string; context: CopyContext; failedRun?: boolean }
export interface CopyRule { id: string; pattern: RegExp; allowedIn: readonly CopyContext[]; onlyOnFailedRun?: boolean }

const COMMAND_PLACES: readonly CopyContext[] = ["details", "stop-for-now", "lost-connection", "ready"];

export const COPY_RULES: readonly CopyRule[] = [
  { id: "phase-or-spec-number", pattern: /\b(?:phase|spec)\s+\d+[a-z]?\d*\b|\b(?:FR|SC)-\d{3}\b/i, allowedIn: [] },
  { id: "dotted-config-key", pattern: /\b(?:slack|alerts|models|budget|github|identity|images)\.(?:[a-z]+[A-Z][A-Za-z]*|address|scope|kind|orchestrator|classifier|worker)\b/, allowedIn: ["details"] },
  { id: "cloudformation-type", pattern: /\bAWS::[A-Za-z0-9]+::[A-Za-z0-9]+/, allowedIn: ["details"] },
  { id: "cloudformation-logical-id", pattern: /\b[A-Z][a-z]+(?:[A-Z][a-z]+)*[0-9A-F]{8}\b/, allowedIn: ["details"] },
  { id: "raw-slack-markup", pattern: /<[@#!][A-Z0-9]/, allowedIn: [] },
  { id: "raw-slack-id", pattern: /\b[UWTBCGA](?=[A-Z0-9]*\d)[A-Z0-9]{4,}\b/, allowedIn: ["details"] },
  { id: "aws-arn", pattern: /\barn:aws[a-z-]*:/, allowedIn: ["details"] },
  { id: "enter-for", pattern: /\bEnter for\b/, allowedIn: [] },
  { id: "empty-leave-empty-for", pattern: /\bLeave empty for\s*(?:$|[.,;:)])/, allowedIn: [] },
  { id: "error-code", pattern: /\b[A-Z]{2,}_[A-Z_]{2,}\b/, allowedIn: ["details"] },
  { id: "finished-on-failed-run", pattern: /\bFinished\b/i, allowedIn: [], onlyOnFailedRun: true },
  { id: "day-two-without-env", pattern: /\bagentx\s+(?!--env\s)(?:doctor|destroy|connector|project|channel|alerts|config|upgrade|deploy|signin|env)\b/, allowedIn: [] },
  { id: "unpublished-package", pattern: /@charterarc\/agentx\b/, allowedIn: [] },
  {
    id: "terminal-instruction",
    pattern: /(?:^|[\s(])--[a-z][a-z0-9-]*|\b(?:run|type|pass)\s+(?:agentx|npx|aws|node|cdk)\b|\b(?:in|read|check|see) the terminal\b|\bthe terminal (?:running|shows|says)\b/i,
    allowedIn: COMMAND_PLACES,
  },
];

/** Every rule a text breaks, as "<rule> in <where>: "<match>" in "<text>"". Empty means clean. */
export function lintCopy(entries: readonly CopyEntry[]): string[] {
  const found: string[] = [];
  for (const entry of entries) {
    for (const rule of COPY_RULES) {
      if (rule.allowedIn.includes(entry.context)) continue;
      if (rule.onlyOnFailedRun === true && entry.failedRun !== true) continue;
      const match = rule.pattern.exec(entry.text);
      if (match !== null) found.push(`${rule.id} in ${entry.where}: "${match[0]}" in "${entry.text}"`);
    }
  }
  return found;
}

/** The string literals in a piece of source: what the page's HTML and module can put on screen. */
export function quotedStrings(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(/"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g)) {
    found.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return found;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/contract/init-ui-copy-lint.test.ts`
Expected: PASS (20 tests).

- [ ] **Step 5: Commit**

```bash
git add tests/support/copy-lint.ts tests/contract/init-ui-copy-lint.test.ts
git commit -m "test(init): copy-lint rules for the install page, each proven by a seeded example (048 FR-081)"
```

---

### Task 3: The hub knows where the install is (journey, header, tab title, close request)

**Files:**
- Modify: `packages/cli/src/init/ui/protocol.ts` (whole `WizardStep`, `WizardLink`, `WizardCard`, `WizardState` blocks)
- Modify: `packages/cli/src/init/ui/state.ts` (`createWizardHub`, `WizardHub`)
- Modify: `packages/cli/src/init/steps.ts:27-31` (the `InitEvent` union)
- Modify: `packages/cli/src/init/commands.ts:162-169` (`eventLine`)
- Modify: `packages/cli/src/init/ui/server.ts:186-191` (route `POST /close`)
- Test: `tests/contract/init-ui-hub.test.ts` (new), `tests/contract/init-ui-server.test.ts` (one new test)

**Interfaces:**
- Consumes: Task 1's `journeyOf`, `STEP_PLAN`, `usualText`, `welcomeLines`, `JourneyPhaseId`, `JourneyView`.
- Produces:
  - `StepStatus` gains `"failed"`; `WizardStep` gains `phase: JourneyPhaseId; usualSeconds: number; usualText: string; startedAt?: string; tookSeconds?: number`
  - `WizardLink` gains `note?: string`; `WizardCard` gains `details?: string[]; commands?: WizardCommand[]`
  - `interface WizardCommand { label: string; command: string }`
  - `interface WizardHeader { installName: string; account?: string; region?: string }`
  - `interface WizardFailure { title: string; what: string; next: string; details: string[]; link?: WizardLink }`
  - `WizardState` gains `header: WizardHeader; journey: JourneyView; pageTitle: string; waitingOnYou: boolean; welcome?: string[]; failure?: WizardFailure; commands?: WizardCommand[]; logPath?: string`
  - `InitEvent` gains `{ kind: "step-failed"; id: InitStepId; title: string; message: string }`
  - `createWizardHub(env: string, options?: { now?: () => number; logPath?: string })`
  - `WizardHub` gains `setStage(stage: JourneyPhaseId): void; setPlace(place: { account: string; region: string }): void; showFailure(failure: WizardFailure): void; clearFailure(): void; finish(outcome: string, phase?: "finished" | "failed", commands?: WizardCommand[]): void; requestClose(): void; closeRequested(): Promise<void>`
  - `NEW_TAB_NOTE = "Opens in a new tab. Come back to this tab when you are done."` (exported from `state.ts`)
  - `ACTION_NEEDED_TITLE = "(Action needed) Install AgentX"`

- [ ] **Step 1: Write the failing test**

```ts
// tests/contract/init-ui-hub.test.ts
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
    hub.applyEvent({ kind: "step-started", id: "access", title: STEP_PLAN.access.title });
    expect(hub.state().pageTitle).toBe("Install AgentX (step 3 of 5)");
    hub.showCard({ id: "github", title: "GitHub app", status: "waiting", lines: ["Create it."] });
    expect(hub.state().pageTitle).toBe(ACTION_NEEDED_TITLE);
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
```

Add to `tests/contract/init-ui-server.test.ts`, inside `describe("the install wizard's server", ...)`:

```ts
  it("POST /close tells the hub the page asked to close, behind the same checks as every route", async () => {
    const { hub, origin } = await wizard();
    let asked = false;
    void hub.closeRequested().then(() => { asked = true; });
    const refused = await fetch(`${origin}/close`, { method: "POST" });
    expect(refused.status).toBe(401);
    const accepted = await fetch(`${origin}/close`, { method: "POST", headers: { [WIZARD_TOKEN_HEADER]: TOKEN } });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ ok: true });
    await hub.closeRequested();
    expect(asked).toBe(true);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/contract/init-ui-hub.test.ts tests/contract/init-ui-server.test.ts`
Expected: FAIL: `ACTION_NEEDED_TITLE` and `NEW_TAB_NOTE` are not exported, `setPlace` is not a
function, and `POST /close` answers 404.

- [ ] **Step 3: Write minimal implementation**

In `packages/cli/src/init/ui/protocol.ts`, add the import and replace the four blocks:

```ts
import type { JourneyPhaseId, JourneyView } from "./journey.js";

export type StepStatus = "pending" | "skipped" | "running" | "done" | "waiting" | "failed";

export interface WizardStep {
  id: InitStepId;
  title: string;
  status: StepStatus;
  /** A waiting step's message: what the operator has to do before the install goes on. */
  message?: string;
  /** Spec 048 FR-001 and FR-002: which phase the step belongs to and how long it usually takes. */
  phase: JourneyPhaseId;
  usualSeconds: number;
  usualText: string;
  /** When the step last started (ISO time), so the page can tick its elapsed time. */
  startedAt?: string;
  /** How long a finished step took, in whole seconds. */
  tookSeconds?: number;
}

/** An address the operator opens from the page, in a new tab. `note` says so (FR-037). */
export interface WizardLink { url: string; label: string; note?: string }

/** A command shown with a copy button: only on the ready screen and after Stop for now (FR-061). */
export interface WizardCommand { label: string; command: string }

export interface WizardCard {
  id: CardId;
  title: string;
  status: CardStatus;
  lines: string[];
  checks?: WizardCheck[];
  link?: WizardLink;
  /** Technical details, shown collapsed: raw messages, IDs, ARNs (FR-027, FR-060). */
  details?: string[];
  commands?: WizardCommand[];
}

/** FR-001: the slim header. */
export interface WizardHeader { installName: string; account?: string; region?: string }

/** FR-060: a failure in three parts. The actions are the question asked with it. */
export interface WizardFailure { title: string; what: string; next: string; details: string[]; link?: WizardLink }

export type WizardPhase = "running" | "finished" | "failed";

export interface WizardState {
  env: string;
  phase: WizardPhase;
  steps: WizardStep[];
  header: WizardHeader;
  journey: JourneyView;
  /** FR-005: the browser tab's title. */
  pageTitle: string;
  /** A question, a link, a waiting card or a failure: the run waits on the user. */
  waitingOnYou: boolean;
  /** FR-006: the welcome text, while the install is in Get started. */
  welcome?: string[];
  question?: WizardQuestion;
  plan?: string;
  resume?: WizardResume;
  cards?: WizardCard[];
  link?: WizardLink;
  failure?: WizardFailure;
  outcome?: string;
  /** The command to continue later, after Stop for now. */
  commands?: WizardCommand[];
  /** Where the full log is (FR-059, FR-070). */
  logPath?: string;
}
```

In `packages/cli/src/init/steps.ts`, extend the union:

```ts
export type InitEvent =
  | { kind: "step-skipped"; id: InitStepId; title: string }
  | { kind: "step-started"; id: InitStepId; title: string }
  | { kind: "step-done"; id: InitStepId; title: string }
  | { kind: "step-waiting"; id: InitStepId; title: string; message: string }
  /** Spec 048 FR-060: the step threw. The run may still retry it (onStepFailure). */
  | { kind: "step-failed"; id: InitStepId; title: string; message: string };
```

In `packages/cli/src/init/commands.ts`, `eventLine` returns `string | undefined` and the terminal
path prints nothing new for a failure (its error is printed as before):

```ts
function eventLine(event: InitEvent): string | undefined {
  switch (event.kind) {
    case "step-skipped": return `already done: ${event.title}`;
    case "step-started": return `==> ${event.title}`;
    case "step-done": return `done: ${event.title}`;
    case "step-waiting": return `waiting: ${event.title}`;
    case "step-failed": return undefined;
  }
}
```

and at its one call site: `onEvent: (event) => { const line = eventLine(event); if (line !== undefined) write(line); session.wizard?.event(event); },`.

In `packages/cli/src/init/ui/state.ts`, the hub. Add imports and constants:

```ts
import { journeyOf, STEP_PLAN, usualText, welcomeLines, type JourneyPhaseId } from "./journey.js";
import type { WizardCommand, WizardFailure, WizardHeader } from "./protocol.js";

export const NEW_TAB_NOTE = "Opens in a new tab. Come back to this tab when you are done.";
export const ACTION_NEEDED_TITLE = "(Action needed) Install AgentX";

const withNote = (link: WizardLink): WizardLink => ({ ...link, note: NEW_TAB_NOTE });
```

Extend `WizardHub` with the members listed under Interfaces, change the signature to
`createWizardHub(env: string, options: { now?: () => number; logPath?: string } = {})`, and inside it:

```ts
  const now = options.now ?? Date.now;
  let stage: JourneyPhaseId = "get-started";
  let header: WizardHeader = { installName: env };
  let failure: WizardFailure | undefined;
  let commands: WizardCommand[] | undefined;
  let closeWanted: () => void = () => undefined;
  const closeRequest = new Promise<void>((resolvePromise) => { closeWanted = resolvePromise; });

  const waitingOnYou = (): boolean =>
    question !== undefined || link !== undefined || failure !== undefined || cards.some((card) => card.status === "waiting");

  const state = (): WizardState => {
    const waiting = waitingOnYou();
    const journey = journeyOf({
      stage,
      steps: steps.map((step) => ({ id: step.id, status: step.status, ...(step.startedAt === undefined ? {} : { startedAtMs: Date.parse(step.startedAt) }) })),
      waitingOnYou: waiting, stopped: failure !== undefined || phase === "failed", finished: phase === "finished", nowMs: now(),
    });
    return {
      env, phase, steps, header, journey, waitingOnYou: waiting,
      pageTitle: waiting ? ACTION_NEEDED_TITLE : `Install AgentX (step ${journey.stepNumber} of ${journey.stepCount})`,
      ...(stage === "get-started" && steps.every((step) => step.status === "pending") ? { welcome: welcomeLines() } : {}),
      ...(question === undefined ? {} : { question }),
      ...(plan === undefined ? {} : { plan }),
      ...(resume === undefined ? {} : { resume }),
      ...(cards.length === 0 ? {} : { cards }),
      ...(link === undefined ? {} : { link }),
      ...(failure === undefined ? {} : { failure }),
      ...(outcome === undefined ? {} : { outcome }),
      ...(commands === undefined ? {} : { commands }),
      ...(options.logPath === undefined ? {} : { logPath: options.logPath }),
    };
  };
```

`setSteps` fills the plan fields; `changeStep` keeps them; the events record timing:

```ts
    setSteps(next) {
      steps = next.map((step) => ({ id: step.id, title: step.title, status: "pending", phase: STEP_PLAN[step.id].phase, usualSeconds: STEP_PLAN[step.id].usualSeconds, usualText: usualText(STEP_PLAN[step.id].usualSeconds) }));
      publish();
    },
    applyEvent(event) {
      link = undefined;
      const at = new Date(now()).toISOString();
      switch (event.kind) {
        case "step-skipped": return changeStep(event.id, event.title, { status: "skipped" });
        case "step-started": return changeStep(event.id, event.title, { status: "running", startedAt: at });
        case "step-done": {
          const started = steps.find((step) => step.id === event.id)?.startedAt;
          return changeStep(event.id, event.title, { status: "done", ...(started === undefined ? {} : { tookSeconds: Math.round((now() - Date.parse(started)) / 1000) }) });
        }
        case "step-waiting": return changeStep(event.id, event.title, { status: "waiting", message: event.message });
        case "step-failed": return changeStep(event.id, event.title, { status: "failed" });
      }
    },
    setStage(next) { stage = next; publish(); },
    setPlace(place) { header = { installName: env, account: place.account, region: place.region }; publish(); },
    showFailure(next) { failure = next.link === undefined || isShowableLink(next.link.url) ? next : { ...next, link: undefined }; publish(); },
    clearFailure() { failure = undefined; publish(); },
    requestClose() { closeWanted(); },
    closeRequested: () => closeRequest,
```

`changeStep` builds an unknown step with its plan fields: replace its `known` line with

```ts
    const known = steps.some((step) => step.id === id) ? steps
      : [...steps, { id, title, status: "pending" as const, phase: STEP_PLAN[id].phase, usualSeconds: STEP_PLAN[id].usualSeconds, usualText: usualText(STEP_PLAN[id].usualSeconds) }];
```

(If `exactOptionalPropertyTypes` refuses `link: undefined` in `showFailure`, build the object
without the key: `const { link: dropped, ...rest } = next; failure = rest;`.)

In `showCard`, after the link check, set `shown = shown.link === undefined ? shown : { ...shown, link: withNote(shown.link) }`.
In `showLink`, set `link = withNote(next)`. `finish` gains the commands:

```ts
    finish(next, ended = "finished", continueWith) {
      phase = ended;
      outcome = next;
      question = undefined;
      commands = continueWith;
      publish();
    },
```

In `packages/cli/src/init/ui/server.ts`, add beside the `/answer` route:

```ts
    if (request.method === "POST" && url.pathname === "/close") {
      input.hub.requestClose();
      return send(response, 200, "application/json; charset=utf-8", JSON.stringify({ ok: true } satisfies AnswerReply));
    }
```

- [ ] **Step 4: Run tests to verify they pass, then the existing wizard suites**

Run: `npx vitest run tests/contract/init-ui-hub.test.ts tests/contract/init-ui-server.test.ts tests/contract/init-ui-cards.test.ts tests/contract/init-ui-prompter.test.ts tests/contract/init-ui-reminder.test.ts tests/contract/init-ui-cli.test.ts`
Expected: PASS. Where an existing test compares a whole `WizardStep` or `WizardState` with
`toEqual`, add the new fields to its expected value with their exact values (for example
`phase: "build", usualSeconds: 60, usualText: "usually 1 minute"`); do not switch it to
`toMatchObject`. Where an existing card test compares a whole card with a link, add
`note: NEW_TAB_NOTE` to the expected link.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck:all`
Expected: no more errors than the baseline.

```bash
git add packages/cli/src/init/ui/protocol.ts packages/cli/src/init/ui/state.ts packages/cli/src/init/ui/server.ts packages/cli/src/init/steps.ts packages/cli/src/init/commands.ts tests/contract/init-ui-hub.test.ts tests/contract/init-ui-server.test.ts tests/contract
git commit -m "feat(init): the install hub tracks phase, timing, tab title and a close request (048 FR-001, FR-002, FR-005)"
```

---
### Task 4: Help text and verb buttons on every question (FR-010, FR-011)

**Files:**
- Modify: `packages/cli/src/init/prompts.ts:9-20` (the `Prompter` interface; new `QuestionHelp`)
- Modify: `packages/cli/src/init/ui/protocol.ts` (`QuestionKind`, `WizardQuestion`, new `WizardButton`)
- Create: `packages/cli/src/init/ui/question-copy.ts`
- Modify: `packages/cli/src/init/ui/prompter.ts` (whole `browserPrompter`)
- Modify: `packages/cli/src/init/commands.ts:280` (`answeringSlackInstall`'s `choose` options type gains `help?: QuestionHelp`)
- Test: `tests/contract/init-ui-question-copy.test.ts` (new)

**Interfaces:**
- Consumes: Task 3's hub (`ask`, `NewQuestion`).
- Produces:
  - `interface QuestionHelp { label?: string; why?: string; example?: string; learnMoreUrl?: string; defaultText?: string; hint?: string; yesLabel?: string; noLabel?: string; buttons?: boolean; choiceLabels?: Readonly<Record<string, string>> }` (exported from `prompts.ts`)
  - Every `Prompter` method's options gain `help?: QuestionHelp`; terminal and unattended prompters ignore it.
  - `QuestionKind` gains `"actions"` (one button per choice, the first primary) and, in Task 5, `"form"`.
  - `interface WizardButton { value: string; label: string; primary: boolean }`; `WizardQuestion` gains `label?, why?, example?, learnMoreUrl?, hint?: string; buttons?: WizardButton[]`.
  - `questionHelp(input: { kind: QuestionKind; text: string; flag?: string; given?: QuestionHelp }): QuestionHelp`
  - `pageHint(defaultValue: string | undefined, help: QuestionHelp): string | undefined`
  - `QUESTION_COPY: readonly QuestionCopyEntry[]`, `ALERT_FLAG` (the alert questions' shared flag text)

- [ ] **Step 1: Write the failing test**

```ts
// tests/contract/init-ui-question-copy.test.ts
// Spec 048 FR-010 and FR-011: every question on the page has a label, one line on why it is
// asked, an example where one helps, the default it takes, and verb buttons. The terminal keeps
// its own words.
import { describe, expect, it } from "vitest";
import { unattendedPrompter } from "../../packages/cli/src/init/prompts.js";
import { browserPrompter } from "../../packages/cli/src/init/ui/prompter.js";
import { ALERT_FLAG, pageHint, questionHelp } from "../../packages/cli/src/init/ui/question-copy.js";
import { createWizardHub, type WizardHub } from "../../packages/cli/src/init/ui/state.js";

const shown = (hub: WizardHub) => {
  const question = hub.state().question;
  if (question === undefined) throw new Error("no question shown");
  return question;
};

/** The default path's questions, as init asks them: kind, flag, and the terminal's own text. */
const DEFAULT_PATH: Array<[kind: "ask" | "choose" | "confirm" | "secret", flag: string | undefined, text: string]> = [
  ["choose", "AWS_PROFILE", "AWS profile"],
  ["choose", "--region", "AWS region"],
  ["choose", "--engine", "Deploy engine"],
  ["choose", "--identity", "Sign-in"],
  ["choose", "--model-provider", "Model provider"],
  ["choose", "--orchestrator-model", "Orchestrator model"],
  ["choose", "--classifier-model", "Action-gate classifier model"],
  ["ask", "--worker-model", "Worker model id"],
  ["ask", "--permission-boundary", "Permission boundary policy ARN (Enter for AgentX's default boundary)"],
  ["ask", "--operator-principal", "IAM principal allowed to assume the AgentX operator role (Enter for this account)"],
  ["choose", ALERT_FLAG, "Where should AgentX send alerts?"],
  ["ask", ALERT_FLAG, "Alert email address"],
  ["ask", "--budget", "Monthly AWS budget for this environment, in US dollars (0 for none)"],
  ["choose", "--budget-scope", "Which costs should the budget count?"],
  ["ask", "--github-account", "GitHub organization or user that will own the AgentX GitHub App"],
  ["choose", "--github-account-type", "Is acme an organization or a personal account?"],
  ["ask", "--github-app-name", "GitHub App name (must be unique on GitHub)"],
  ["ask", "--slack-app-name", "Slack app name"],
  ["choose", "--slack-app-posted-messages", "Answer mentions people post through other apps with their own Slack token?"],
  ["confirm", undefined, "Create all of this?"],
  ["choose", "--slack-install", "Is the Slack app installed in your workspace?"],
  ["secret", "--slack-bot-token", "Slack bot token"],
  ["secret", "--slack-signing-secret", "Slack signing secret"],
  ["confirm", undefined, "Is this the AgentX bot in the right workspace?"],
  ["confirm", undefined, "Does Slack show the Request URL as Verified?"],
  ["choose", "--signin", "How will developers sign in to AgentX from their AI tools?"],
  ["ask", "--slack-client-id", "Slack app Client ID (Basic Information, App Credentials)"],
  ["secret", "--slack-client-secret", "Slack client secret"],
  ["confirm", undefined, "Apply this change?"],
  ["ask", "--admin-email", "Your email address, for your AgentX admin user"],
  ["choose", "--repository", "Which repository is the first project's?"],
  ["ask", "--project-name", "Project name"],
  ["confirm", undefined, "Use these commands? (npm ci, npm test)"],
  ["ask", "--channel", "Which Slack channel should the project use?"],
  ["confirm", undefined, "Connect Linear to payments-api now? (You can add it later with agentx connector add linear)"],
  ["confirm", undefined, "Did a test alarm named agentx-staging-test arrive at ops@example.com?"],
  ["confirm", undefined, "Check the prerequisites again?"],
  ["confirm", undefined, "Paste the Slack bot token and signing secret again?"],
  ["confirm", undefined, "Run the Request URL check again?"],
  ["confirm", undefined, "Sign in again?"],
  ["confirm", undefined, "Watch for the reply again?"],
  ["confirm", undefined, "Have you confirmed the subscription? Answer Yes to check again."],
];

describe("the page's words for each question", () => {
  for (const [kind, flag, text] of DEFAULT_PATH) {
    it(`FR-010: "${text}" has a label and a why line${kind === "confirm" ? ", and verb buttons" : ""}`, () => {
      const help = questionHelp({ kind, text, ...(flag === undefined ? {} : { flag }) });
      expect(help.label).toMatch(/\S/);
      expect(help.why).toMatch(/\S/);
      if (kind === "confirm") {
        expect(help.yesLabel).toMatch(/\S/);
        expect(help.noLabel).toMatch(/\S/);
        expect([help.yesLabel, help.noLabel]).not.toContain("Yes");
        expect([help.yesLabel, help.noLabel]).not.toContain("No");
      }
    });
  }

  it("lets the caller's own help win over the catalog", () => {
    expect(questionHelp({ kind: "ask", text: "x", flag: "--budget", given: { why: "About $210 a month." } }).why).toBe("About $210 a month.");
  });

  it("FR-010: says what an empty field means, and never an empty Leave empty for", () => {
    expect(pageHint(undefined, {})).toBeUndefined();
    expect(pageHint("", {})).toBe("Optional. Leave empty to use AgentX's default.");
    expect(pageHint("production", {})).toBe("Leave empty to use production.");
    expect(pageHint("us.anthropic.claude-sonnet-4-6", { defaultText: "Claude Sonnet 4.6" })).toBe("Leave empty to use Claude Sonnet 4.6.");
    expect(pageHint("", { hint: "Optional. Leave empty if the project needs none." })).toBe("Optional. Leave empty if the project needs none.");
  });
});

describe("browserPrompter with help", () => {
  it("shows the page label, why line, example and hint, and keeps the terminal's text", async () => {
    const hub = createWizardHub("staging");
    const prompter = browserPrompter(hub);
    const answer = prompter.ask("GitHub organization or user that will own the AgentX GitHub App", { flag: "--github-account" });
    expect(shown(hub)).toMatchObject({
      kind: "ask", text: "GitHub organization or user that will own the AgentX GitHub App",
      label: "GitHub owner", why: "The GitHub organization or user that will own AgentX's GitHub app.", example: "acme",
    });
    expect(shown(hub).hint).toBeUndefined();
    hub.answer(shown(hub).id, "acme");
    await expect(answer).resolves.toBe("acme");
  });

  it("FR-011: a confirm's forward button is the primary one, whatever the terminal default", async () => {
    const hub = createWizardHub("staging");
    const answer = browserPrompter(hub).confirm("Create all of this?", { defaultValue: false });
    expect(shown(hub).buttons).toEqual([
      { value: "yes", label: "Create AgentX", primary: true },
      { value: "no", label: "Cancel the install", primary: false },
    ]);
    hub.answer(shown(hub).id, "yes");
    await expect(answer).resolves.toBe(true);
  });

  it("a choose with buttons is an actions question, and only its choices are accepted", async () => {
    const hub = createWizardHub("staging");
    const answer = browserPrompter(hub).choose("Your AWS sign-in is missing or has expired. What next?", [
      { value: "signin", label: "Sign in (aws sso login --profile dev)" }, { value: "retry", label: "check again" }, { value: "stop", label: "Stop the install" },
    ], { flag: "AWS_PROFILE", defaultValue: "signin" });
    expect(shown(hub)).toMatchObject({ kind: "actions" });
    expect(shown(hub).buttons).toEqual([
      { value: "signin", label: "Sign in again", primary: true },
      { value: "retry", label: "I signed in another way, check again", primary: false },
      { value: "stop", label: "Stop for now", primary: false },
    ]);
    expect(hub.answer(shown(hub).id, "nonsense")).toBe("choose one of the options");
    hub.answer(shown(hub).id, "stop");
    await expect(answer).resolves.toBe("stop");
  });

  it("relabels choices for the page and keeps their values", async () => {
    const hub = createWizardHub("staging");
    const answer = browserPrompter(hub).choose("Deploy engine", [
      { value: "templates", label: "templates: published CloudFormation templates, no CDK setup (recommended)" },
      { value: "cdk", label: "cdk: deploy from AgentX's CDK code at the release tag" },
    ], { flag: "--engine", defaultValue: "templates" });
    expect(shown(hub).choices).toEqual([
      { value: "templates", label: "Published templates (recommended)" },
      { value: "cdk", label: "From AgentX's source code, for contributors" },
    ]);
    hub.answer(shown(hub).id, "");
    await expect(answer).resolves.toBe("templates");
  });

  it("the terminal ignores help", async () => {
    await expect(unattendedPrompter().ask("Slack app name", { flag: "--slack-app-name", defaultValue: "AgentX", help: { label: "x" } })).resolves.toBe("AgentX");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/contract/init-ui-question-copy.test.ts`
Expected: FAIL with "Failed to load url ../../packages/cli/src/init/ui/question-copy.js".

- [ ] **Step 3: Write minimal implementation**

In `packages/cli/src/init/prompts.ts`, add before `Prompter` and extend its four signatures:

```ts
/** Spec 048 FR-010 and FR-011: how the install page shows a question. The terminal ignores it. */
export interface QuestionHelp {
  /** The page's question, in plain words; the terminal keeps its own text. */
  label?: string;
  /** One line on why the question is asked. */
  why?: string;
  example?: string;
  learnMoreUrl?: string;
  /** The default in words, when the raw default is not readable (a model id). */
  defaultText?: string;
  /** Replaces the computed "Leave empty to use ..." hint. */
  hint?: string;
  /** confirm: verb labels for the two buttons. Yes is always the forward, primary one. */
  yesLabel?: string;
  noLabel?: string;
  /** choose: one button per choice instead of a list, the first one primary. */
  buttons?: boolean;
  /** choose: the page's label for a choice value. */
  choiceLabels?: Readonly<Record<string, string>>;
}
export interface Prompter {
  ask(question: string, options: PromptFlag & { defaultValue?: string; validate?: (value: string) => string | undefined; help?: QuestionHelp }): Promise<string>;
  choose<T extends string>(question: string, choices: ReadonlyArray<{ value: T; label: string }>, options: PromptFlag & { defaultValue: T; unattendedRefusal?: string; help?: QuestionHelp }): Promise<T>;
  confirm(question: string, options: { defaultValue: boolean; help?: QuestionHelp }): Promise<boolean>;
  secret(question: string, options: PromptFlag & { multiline?: boolean; validate?: (value: string) => string | undefined; help?: QuestionHelp }): Promise<string>;
}
```

In `packages/cli/src/init/ui/protocol.ts`:

```ts
export type QuestionKind = "ask" | "choose" | "confirm" | "secret" | "actions";

/** A button on the page. A confirm has two; an actions question one per choice. */
export interface WizardButton { value: string; label: string; primary: boolean }

export interface WizardQuestion {
  id: string;
  kind: QuestionKind;
  /** The terminal's text for the question; the page shows `label` when there is one. */
  text: string;
  label?: string;
  why?: string;
  example?: string;
  learnMoreUrl?: string;
  /** What an empty field means (FR-010). */
  hint?: string;
  defaultValue?: string;
  defaultConfirm?: boolean;
  choices?: WizardChoice[];
  buttons?: WizardButton[];
  masked?: boolean;
  multiline?: boolean;
  error?: string;
}
```

Create `packages/cli/src/init/ui/question-copy.ts`:

```ts
// packages/cli/src/init/ui/question-copy.ts
// Spec 048 FR-010, FR-011 and FR-080: the install page's words for every question on the default
// path, the retry questions and the Slack questions. Looked up by kind and flag, or by the
// question's own text where it has no flag (every confirm). The terminal never reads this, so its
// questions and every --yes run stay exactly as they were. Phase 2 adds the Advanced settings
// (your own OIDC, OpenRouter, Linear, Jira, Asana) when they move under one heading.
import type { QuestionHelp } from "../prompts.js";
import type { QuestionKind } from "./protocol.js";

/** The alert questions' shared flag text (answers.ts). */
export const ALERT_FLAG = "--alert-email (or --alert-webhook-file, --alert-webhook-env, --no-alerts)";

type HelpSource = QuestionHelp | ((match: RegExpExecArray) => QuestionHelp);
export interface QuestionCopyEntry { kind: QuestionKind; flag?: string; text?: RegExp; help: HelpSource }

export const QUESTION_COPY: readonly QuestionCopyEntry[] = [
  {
    kind: "choose", flag: "AWS_PROFILE", text: /sign-in is missing or has expired/,
    help: { label: "Your AWS sign-in has ended", why: "AgentX needs a current AWS sign-in to look at your account.", buttons: true, choiceLabels: { signin: "Sign in again", retry: "I signed in another way, check again", stop: "Stop for now" } },
  },
  { kind: "choose", flag: "AWS_PROFILE", help: { label: "Which AWS profile should AgentX use?", why: "AgentX installs into the AWS account this profile signs in to.", example: "default" } },
  { kind: "choose", flag: "--continue-as-root", help: { label: "Continue as the AWS root user?", why: "AgentX works with the root user. You can also stop, sign in as an admin user, and start again.", buttons: true } },
  { kind: "choose", flag: "--region", help: { label: "Which AWS region?", why: "AgentX runs in this region. Pick the one closest to your team.", learnMoreUrl: "https://docs.aws.amazon.com/global-infrastructure/latest/regions/aws-regions.html" } },
  { kind: "choose", flag: "--engine", help: { label: "How should AgentX deploy?", why: "Published templates need nothing else installed on this computer.", choiceLabels: { templates: "Published templates (recommended)", cdk: "From AgentX's source code, for contributors" } } },
  { kind: "choose", flag: "--identity", help: { label: "How will you sign in to AgentX?", why: "This is your own admin sign-in. Developers sign in with Slack, later in the install.", choiceLabels: { cognito: "AgentX sign-in, created for you (recommended)", oidc: "Your company sign-in (Okta, Entra, Google)" } } },
  { kind: "choose", flag: "--model-provider", help: { label: "Where should AgentX run its AI models?", why: "Amazon Bedrock keeps every model request inside your AWS account.", choiceLabels: { "amazon-bedrock": "Amazon Bedrock (recommended)", openrouter: "OpenRouter" } } },
  { kind: "choose", flag: "--orchestrator-model", help: { label: "Main model", why: "The main model reads each Slack message and decides what to do." } },
  { kind: "choose", flag: "--classifier-model", help: { label: "Safety check model", why: "The safety check model looks at every action before AgentX takes it." } },
  { kind: "ask", flag: "--orchestrator-model", help: { label: "Main model id", why: "The model id exactly as your provider lists it.", example: "us.anthropic.claude-sonnet-4-6" } },
  { kind: "ask", flag: "--classifier-model", help: { label: "Safety check model id", why: "The model id exactly as your provider lists it.", example: "amazon.nova-lite-v1:0" } },
  { kind: "ask", flag: "--worker-model", help: { label: "Coding model", why: "The coding model writes and tests code in your repositories.", example: "us.anthropic.claude-sonnet-4-6", defaultText: "Claude Sonnet 4.6" } },
  { kind: "ask", flag: "--permission-boundary", help: { label: "Permission boundary (advanced)", why: "Only if your company requires every IAM role to carry its own boundary policy. Your platform team gives you its address." } },
  { kind: "ask", flag: "--operator-principal", help: { label: "Who may run day-two commands (advanced)", why: "Leave it empty and anyone with admin rights in this AWS account can run them." } },
  { kind: "choose", flag: ALERT_FLAG, help: { label: "Where should AgentX send alerts?", why: "AgentX tells you here when something stops working.", choiceLabels: { email: "An email address (recommended)", webhook: "A PagerDuty or Opsgenie address (kept secret)", none: "Nowhere for now" } } },
  { kind: "ask", flag: ALERT_FLAG, help: { label: "Alert email address", why: "AWS sends a confirmation email here first. Confirm it to start getting alerts.", example: "ops@example.com" } },
  { kind: "ask", flag: "--budget", help: { label: "Monthly budget alert, in US dollars", why: "AWS emails you when this month's costs pass 80% of it. 0 turns it off." } },
  { kind: "choose", flag: "--budget-scope", help: { label: "Which costs should the budget count?", why: "The whole account is simplest. Counting only AgentX needs a billing tag that can take a day to start counting.", choiceLabels: { account: "The whole account (recommended)", tag: "Only AgentX's costs (needs a billing tag)" } } },
  { kind: "ask", flag: "--github-account", help: { label: "GitHub owner", why: "The GitHub organization or user that will own AgentX's GitHub app.", example: "acme" } },
  { kind: "choose", flag: "--github-account-type", help: { label: "Is it an organization or a personal account?", why: "GitHub keeps apps in a different place for each.", choiceLabels: { organization: "An organization", user: "A personal account" } } },
  { kind: "ask", flag: "--github-app-name", help: { label: "App name", why: "The name of AgentX's app in GitHub, and the default for Slack. GitHub needs it to be unique.", example: "AgentX acme (production)" } },
  { kind: "ask", flag: "--slack-app-name", help: { label: "Slack app name", why: "How AgentX's app shows in your Slack workspace.", example: "AgentX acme (production)" } },
  { kind: "choose", flag: "--slack-app-posted-messages", help: { label: "Answer messages other apps post for people?", why: "Some teams post to Slack through tools that use a person's own Slack token. AgentX never answers itself or other bots.", choiceLabels: { accept: "Yes, answer them (recommended)", ignore: "No, only messages typed in Slack" } } },
  { kind: "choose", flag: "--slack-install", help: { label: "Is the Slack app installed in your workspace?", why: "AgentX needs the app installed before it can use its token.", buttons: true, choiceLabels: { installed: "Installed, continue", approval: "My workspace needs an admin to approve it" } } },
  { kind: "secret", flag: "--slack-bot-token", help: { label: "Bot User OAuth Token", why: "Slack shows it under OAuth & Permissions. It starts with xoxb-.", example: "xoxb-..." } },
  { kind: "secret", flag: "--slack-signing-secret", help: { label: "Signing Secret", why: "Slack shows it under Basic Information, App Credentials. Press Show, then copy it." } },
  { kind: "choose", flag: "--signin", help: { label: "How will developers sign in from their AI tools?", why: "Developers sign in once from Claude Code, Codex or Cursor.", choiceLabels: { slack: "Sign in with Slack (recommended)", oidc: "Your company sign-in", both: "Both" } } },
  { kind: "ask", flag: "--slack-client-id", help: { label: "Client ID", why: "Slack shows it under Basic Information, App Credentials: two numbers joined by a dot.", example: "1111111111.2222222222222" } },
  { kind: "secret", flag: "--slack-client-secret", help: { label: "Client Secret", why: "Under Basic Information, App Credentials, next to the Client ID. Press Show, then copy it." } },
  { kind: "ask", flag: "--admin-email", help: { label: "Your email", why: "AgentX makes your admin sign-in with it and emails you a temporary password.", example: "you@example.com" } },
  { kind: "choose", flag: "--repository", help: { label: "Which repository is your first project?", why: "AgentX works in this repository first. You can add more later." } },
  { kind: "ask", flag: "--project-name", help: { label: "Project name", why: "How AgentX names this project in Slack.", example: "payments-api" } },
  { kind: "ask", flag: "--setup-command", help: { label: "Setup command", why: "AgentX runs it before it changes code.", example: "npm ci", hint: "Optional. Leave empty if the project needs none." } },
  { kind: "ask", flag: "--test-command", help: { label: "Test command", why: "AgentX runs it to check its own work.", example: "npm test", hint: "Optional. Leave empty if the project has none." } },
  { kind: "ask", flag: "--channel", help: { label: "Which Slack channel?", why: "AgentX answers in this channel for this project.", example: "payments" } },
  { kind: "ask", text: /^Paste that address/, help: { label: "Paste the address GitHub sent you to", why: "Only needed when GitHub could not send you back to this page." } },
  { kind: "secret", flag: "--github-private-key", help: { label: "GitHub app private key", why: "GitHub offers it as a download on the app's page. Paste the whole file." } },
  { kind: "confirm", text: /^Create all of this\?$/, help: { label: "Create AgentX with this plan?", why: "Nothing is created until you press Create AgentX.", yesLabel: "Create AgentX", noLabel: "Cancel the install" } },
  { kind: "confirm", text: /^Check the prerequisites again\?$/, help: { label: "Fix the items marked above, then check again", why: "Nothing has been created yet.", yesLabel: "Check again", noLabel: "Stop for now" } },
  { kind: "confirm", text: /^Is this the AgentX bot in the right workspace\?$/, help: { label: "Is this the right bot and workspace?", why: "This is the bot the token you pasted belongs to.", yesLabel: "Yes, continue", noLabel: "That is the wrong app" } },
  { kind: "confirm", text: /^Does Slack show the Request URL as Verified\?$/, help: { label: "Does Slack show the address as Verified?", why: "Slack checks the address it sends messages to.", yesLabel: "It shows Verified", noLabel: "It still shows an error" } },
  { kind: "confirm", text: /^Apply this change\?$/, help: { label: "Turn on developer sign-in now?", why: "This updates AgentX's sign-in settings in AWS. It takes about a minute.", yesLabel: "Turn it on", noLabel: "Not now" } },
  { kind: "confirm", text: /^Use these commands\?/, help: { label: "Use these setup and test commands?", why: "AgentX runs them before it changes code, and to check its work.", yesLabel: "Use them", noLabel: "Change them" } },
  { kind: "confirm", text: /^Connect (Linear|Jira|Asana) to .+ now\?/, help: (match) => ({ label: `Connect ${match[1] ?? "it"} to this project now?`, why: "You can also connect it later.", yesLabel: `Connect ${match[1] ?? "it"}`, noLabel: "Skip for now" }) },
  { kind: "confirm", text: /^Did a test alarm named .+ arrive at (.+)\?$/, help: (match) => ({ label: `Did the test alert arrive at ${match[1] ?? "your address"}?`, why: "AgentX just sent one, so you know alerts reach you.", yesLabel: "It arrived", noLabel: "It did not arrive" }) },
  { kind: "confirm", text: /^Have you confirmed the subscription\?/, help: { label: "Confirmed the alert email?", why: "Open the email from AWS Notifications and choose Confirm subscription.", yesLabel: "Check again", noLabel: "Skip for now" } },
  { kind: "confirm", text: /^Paste the Slack bot token and signing secret again\?$/, help: { label: "Paste the two Slack values again?", why: "Nothing was saved. Copy both values from the Slack app you just made.", yesLabel: "Paste them again", noLabel: "Stop for now" } },
  { kind: "confirm", text: /^Run the Request URL check again\?$/, help: { label: "Check the address again?", why: "Fix what is marked above first.", yesLabel: "Check again", noLabel: "Stop for now" } },
  { kind: "confirm", text: /^Sign in again\?$/, help: { label: "Sign in again?", why: "The sign-in did not finish.", yesLabel: "Sign in again", noLabel: "Stop for now" } },
  { kind: "confirm", text: /^Watch for the reply again\?$/, help: { label: "Watch for the reply again?", why: "Post the message again first if it was not answered.", yesLabel: "Watch again", noLabel: "Stop for now" } },
  { kind: "confirm", text: /^Environment .+ is locked by/, help: { label: "Another install with this name is running", why: "Take it over only if that run has stopped.", yesLabel: "Take over", noLabel: "Stop for now" } },
  { kind: "confirm", text: /^Run cdk bootstrap .+ now\?$/, help: { label: "Prepare this region for deploying from source code?", why: "This creates the CDK toolkit stack once in this account and region.", yesLabel: "Prepare it", noLabel: "Stop for now" } },
];

/** The page's words for one question: the catalog's entry, with the caller's own help on top. */
export function questionHelp(input: { kind: QuestionKind; text: string; flag?: string; given?: QuestionHelp }): QuestionHelp {
  for (const entry of QUESTION_COPY) {
    if (entry.kind !== input.kind) continue;
    if (entry.flag !== undefined && entry.flag !== input.flag) continue;
    const match = entry.text === undefined ? undefined : entry.text.exec(input.text) ?? undefined;
    if (entry.text !== undefined && match === undefined) continue;
    const base = typeof entry.help === "function" ? entry.help(match ?? Object.assign([input.text], { index: 0, input: input.text })) : entry.help;
    return { ...base, ...input.given };
  }
  return { ...input.given };
}

/** FR-010: what an empty field means. A field with no default has no hint. */
export function pageHint(defaultValue: string | undefined, help: QuestionHelp): string | undefined {
  if (help.hint !== undefined) return help.hint;
  if (defaultValue === undefined) return undefined;
  if (defaultValue === "") return "Optional. Leave empty to use AgentX's default.";
  return `Leave empty to use ${help.defaultText ?? defaultValue}.`;
}
```

(`Object.assign([input.text], { index: 0, input: input.text })` builds a `RegExpExecArray` for an
entry without a pattern; if the type does not line up, cast it with `as RegExpExecArray`. Only
entries with a `text` pattern use a function, so it is never read there.)

Rewrite `browserPrompter` in `packages/cli/src/init/ui/prompter.ts` (keep `askCheck` and
`secretCheck` as they are):

```ts
import { stripPasteMarkers, type Prompter, type QuestionHelp } from "../prompts.js";
import type { WizardButton } from "./protocol.js";
import { pageHint, questionHelp } from "./question-copy.js";
import type { AnswerCheck, NewQuestion, WizardHub } from "./state.js";

/** The help fields a question carries to the page, only those that are set. */
function pageFields(help: QuestionHelp): Pick<NewQuestion, "label" | "why" | "example" | "learnMoreUrl"> {
  return {
    ...(help.label === undefined ? {} : { label: help.label }),
    ...(help.why === undefined ? {} : { why: help.why }),
    ...(help.example === undefined ? {} : { example: help.example }),
    ...(help.learnMoreUrl === undefined ? {} : { learnMoreUrl: help.learnMoreUrl }),
  };
}

export function browserPrompter(hub: WizardHub): Prompter {
  return {
    async ask(question, options) {
      const help = questionHelp({ kind: "ask", text: question, flag: options.flag, ...(options.help === undefined ? {} : { given: options.help }) });
      const hint = pageHint(options.defaultValue, help);
      return hub.ask(
        { kind: "ask", text: question, ...(options.defaultValue === undefined ? {} : { defaultValue: options.defaultValue }), ...pageFields(help), ...(hint === undefined ? {} : { hint }) },
        askCheck(options),
      );
    },
    async choose<T extends string>(question: string, choices: ReadonlyArray<{ value: T; label: string }>, options: { flag: string; defaultValue: T; help?: QuestionHelp }): Promise<T> {
      const help = questionHelp({ kind: "choose", text: question, flag: options.flag, ...(options.help === undefined ? {} : { given: options.help }) });
      const labelled = choices.map((choice) => ({ value: choice.value, label: help.choiceLabels?.[choice.value] ?? choice.label }));
      const asButtons = help.buttons === true;
      const buttons: WizardButton[] = labelled.map((choice, index) => ({ value: choice.value, label: choice.label, primary: index === 0 }));
      const answer = await hub.ask(
        {
          kind: asButtons ? "actions" : "choose", text: question, defaultValue: options.defaultValue, choices: labelled,
          ...(asButtons ? { buttons } : {}), ...pageFields(help),
        },
        (raw) => {
          if (raw === "" && !asButtons) return { value: options.defaultValue };
          return choices.some((choice) => choice.value === raw) ? { value: raw } : { error: "choose one of the options" };
        },
      );
      return answer as T;
    },
    async confirm(question, options) {
      const help = questionHelp({ kind: "confirm", text: question, ...(options.help === undefined ? {} : { given: options.help }) });
      const buttons: WizardButton[] = [
        { value: CONFIRM_YES, label: help.yesLabel ?? "Yes", primary: true },
        { value: CONFIRM_NO, label: help.noLabel ?? "No", primary: false },
      ];
      const answer = await hub.ask(
        { kind: "confirm", text: question, defaultConfirm: options.defaultValue, buttons, ...pageFields(help) },
        (raw) => (raw === CONFIRM_YES || raw === CONFIRM_NO ? { value: raw } : { error: "answer yes or no" }),
      );
      return answer === CONFIRM_YES;
    },
    async secret(question, options) {
      const multiline = options.multiline === true;
      const help = questionHelp({ kind: "secret", text: question, flag: options.flag, ...(options.help === undefined ? {} : { given: options.help }) });
      return hub.ask(
        { kind: "secret", text: question, masked: true, ...(multiline ? { multiline: true } : {}), ...pageFields(help) },
        secretCheck(question, multiline, options.validate),
      );
    },
  };
}
```

Also give `answeringSlackInstall` in `commands.ts` the `help?: QuestionHelp` option in its
`choose` signature (it passes `options` through unchanged), and pass `help` through in
`secretFromSource` (`prompts.ts:225-251`): add `help?: QuestionHelp` to its input and spread it
into `secretOptions`.

- [ ] **Step 4: Run tests to verify they pass, then the prompter and wizard suites**

Run: `npx vitest run tests/contract/init-ui-question-copy.test.ts tests/contract/init-ui-prompter.test.ts tests/contract/init-ui-cli.test.ts tests/contract/init-prompts.test.ts`
Expected: PASS. An existing `toEqual` on a whole question gains the new fields with exact values.
Two questions are now `actions` (buttons): the AWS sign-in question and "Is the Slack app installed
in your workspace?". An empty answer to an `actions` question is refused, so a `--ui` test that
answered either with `""` now answers its value (`"signin"`, `"installed"`).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/init/prompts.ts packages/cli/src/init/ui/protocol.ts packages/cli/src/init/ui/question-copy.ts packages/cli/src/init/ui/prompter.ts packages/cli/src/init/commands.ts tests/contract
git commit -m "feat(init): every page question has a label, a why line, a hint and verb buttons (048 FR-010, FR-011)"
```

---

### Task 5: Several values on one form (FR-012)

**Files:**
- Modify: `packages/cli/src/init/prompts.ts` (new `FormField`, `Prompter.form?`, `askForm`)
- Modify: `packages/cli/src/init/ui/protocol.ts` (`QuestionKind` gains `"form"`; new `WizardField`; `WizardQuestion.fields?`)
- Modify: `packages/cli/src/init/ui/state.ts` (`AnswerCheck` may return `retry`)
- Modify: `packages/cli/src/init/ui/prompter.ts` (new `form` method)
- Test: `tests/contract/init-ui-form.test.ts` (new)

**Interfaces:**
- Consumes: Task 4's `questionHelp`, `pageHint`, `pageFields`, `askCheck`, `secretCheck`.
- Produces (phase 2's settings screen and Slack form are built on these):
  - `interface FormField { name: string; question: string; flag: string; defaultValue?: string; secret?: boolean; validate?: (value: string) => string | undefined; help?: QuestionHelp }`
  - `Prompter.form?(title: string, fields: readonly FormField[], options: { help?: QuestionHelp }): Promise<Record<string, string>>`
  - `askForm(prompter: Prompter, title: string, fields: readonly FormField[], options?: { help?: QuestionHelp }): Promise<Record<string, string>>`: the page's one form, or the same questions one by one in the terminal.
  - `interface WizardField { name: string; label: string; why?: string; example?: string; hint?: string; masked?: boolean; value?: string; error?: string }`
  - `type AnswerCheck = (raw: string) => { value: string } | { error: string; retry?: NewQuestion }`
  - A form's answer on `POST /answer` is `JSON.stringify(Record<string, string>)`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/contract/init-ui-form.test.ts
// Spec 048 FR-012: one screen can ask several related values, check each on its own field, and
// keep the valid ones when another is refused. A secret is never sent back to the page.
import { describe, expect, it } from "vitest";
import { askForm, checkSlackBotToken, fieldCheck, type FormField } from "../../packages/cli/src/init/prompts.js";
import { browserPrompter } from "../../packages/cli/src/init/ui/prompter.js";
import { createWizardHub, type WizardHub } from "../../packages/cli/src/init/ui/state.js";
import { scriptedPrompter, TEST_BOT_TOKEN } from "../support/init-fakes.js";

const FIELDS: FormField[] = [
  { name: "clientId", question: "Slack app Client ID (Basic Information, App Credentials)", flag: "--slack-client-id", validate: (value) => (/^\d+\.\d+$/.test(value) ? undefined : "the Client ID is two numbers joined by a dot") },
  { name: "botToken", question: "Slack bot token", flag: "--slack-bot-token", secret: true, validate: fieldCheck(checkSlackBotToken) },
  { name: "appName", question: "Slack app name", flag: "--slack-app-name", defaultValue: "AgentX acme (staging)" },
];

const shown = (hub: WizardHub) => {
  const question = hub.state().question;
  if (question === undefined) throw new Error("no question shown");
  return question;
};

describe("forms", () => {
  it("shows every field with its page label, masks the secret, and resolves with every value", async () => {
    const hub = createWizardHub("staging");
    const answer = browserPrompter(hub).form?.("Paste the Slack values", FIELDS, {});
    expect(shown(hub)).toMatchObject({ kind: "form", text: "Paste the Slack values" });
    expect(shown(hub).fields?.map((field) => [field.name, field.label, field.masked === true])).toEqual([
      ["clientId", "Client ID", false], ["botToken", "Bot User OAuth Token", true], ["appName", "Slack app name", false],
    ]);
    expect(shown(hub).fields?.[2]?.hint).toBe("Leave empty to use AgentX acme (staging).");
    hub.answer(shown(hub).id, JSON.stringify({ clientId: "1111.2222", botToken: TEST_BOT_TOKEN, appName: "" }));
    await expect(answer).resolves.toEqual({ clientId: "1111.2222", botToken: TEST_BOT_TOKEN, appName: "AgentX acme (staging)" });
  });

  it("a refused form keeps valid plain values and never echoes a secret", async () => {
    const hub = createWizardHub("staging");
    const answer = browserPrompter(hub).form?.("Paste the Slack values", FIELDS, {});
    const first = shown(hub).id;
    expect(hub.answer(first, JSON.stringify({ clientId: "not-an-id", botToken: TEST_BOT_TOKEN, appName: "Ours" }))).toBe("Check the field marked below.");
    const again = shown(hub);
    expect(again.id).not.toBe(first);
    expect(again.fields?.find((field) => field.name === "clientId")?.error).toBe("the Client ID is two numbers joined by a dot");
    expect(again.fields?.find((field) => field.name === "appName")?.value).toBe("Ours");
    expect(again.fields?.find((field) => field.name === "botToken")?.value).toBeUndefined();
    expect(JSON.stringify(hub.snapshot())).not.toContain(TEST_BOT_TOKEN);
    hub.answer(again.id, JSON.stringify({ clientId: "1111.2222", botToken: TEST_BOT_TOKEN, appName: "Ours" }));
    await expect(answer).resolves.toEqual({ clientId: "1111.2222", botToken: TEST_BOT_TOKEN, appName: "Ours" });
  });

  it("refuses a body that is not a form", () => {
    const hub = createWizardHub("staging");
    void browserPrompter(hub).form?.("Paste the Slack values", FIELDS, {});
    expect(hub.answer(shown(hub).id, "not json")).toBe("the form could not be read; try again");
  });

  it("asks the same values one by one in the terminal", async () => {
    const prompter = scriptedPrompter(["1111.2222", TEST_BOT_TOKEN, ""]);
    await expect(askForm(prompter, "Paste the Slack values", FIELDS)).resolves.toEqual({ clientId: "1111.2222", botToken: TEST_BOT_TOKEN, appName: "AgentX acme (staging)" });
    expect(prompter.asked).toEqual(["Slack app Client ID (Basic Information, App Credentials)", "Slack bot token", "Slack app name"]);
  });
});
```

(If `scriptedPrompter`'s `secret` does not take a string answer for "Slack bot token", look at
its implementation in `tests/support/init-fakes.ts`: it returns string answers for secrets, as the
Slack step's tests already rely on.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/contract/init-ui-form.test.ts`
Expected: FAIL: `askForm` is not exported, and `browserPrompter(hub).form` is undefined.

- [ ] **Step 3: Write minimal implementation**

In `packages/cli/src/init/prompts.ts`:

```ts
/** Spec 048 FR-012: one value of a form. `question` and `flag` are what the terminal asks. */
export interface FormField {
  name: string;
  question: string;
  flag: string;
  defaultValue?: string;
  secret?: boolean;
  validate?: (value: string) => string | undefined;
  help?: QuestionHelp;
}

// In the Prompter interface, after secret():
  /** Optional: several related values on one screen (the install page). */
  form?(title: string, fields: readonly FormField[], options: { help?: QuestionHelp }): Promise<Record<string, string>>;

/** The page's one form, or, with no form on this prompter (the terminal), the same questions in order. */
export async function askForm(prompter: Prompter, title: string, fields: readonly FormField[], options: { help?: QuestionHelp } = {}): Promise<Record<string, string>> {
  if (prompter.form !== undefined) return prompter.form(title, fields, options);
  const values: Record<string, string> = {};
  for (const field of fields) {
    const validate = field.validate === undefined ? {} : { validate: field.validate };
    values[field.name] = field.secret === true
      ? await prompter.secret(field.question, { flag: field.flag, ...validate })
      : await prompter.ask(field.question, { flag: field.flag, ...(field.defaultValue === undefined ? {} : { defaultValue: field.defaultValue }), ...validate });
  }
  return values;
}
```

In `protocol.ts`, `QuestionKind` becomes `"ask" | "choose" | "confirm" | "secret" | "actions" | "form"`, and:

```ts
/** One field of a form question. A masked field never carries a value back to the page. */
export interface WizardField { name: string; label: string; why?: string; example?: string; hint?: string; masked?: boolean; value?: string; error?: string }

// in WizardQuestion:
  /** form: its fields, in order. The answer is a JSON object of field name to value. */
  fields?: WizardField[];
```

In `state.ts`, the check may hand back the question to show again, and `answer` uses it:

```ts
export type AnswerCheck = (raw: string) => { value: string } | { error: string; retry?: NewQuestion };
// in answer():
      if ("error" in checked) {
        pending = { ...waiting, question: publishQuestion(checked.retry ?? waiting.asked, checked.error) };
        return checked.error;
      }
```

In `prompter.ts`, add the `form` method to the object `browserPrompter` returns:

```ts
    async form(title, fields, options) {
      const help = questionHelp({ kind: "form", text: title, ...(options.help === undefined ? {} : { given: options.help }) });
      const toField = (field: FormField, kept?: string, error?: string): WizardField => {
        const fieldHelp = questionHelp({ kind: field.secret === true ? "secret" : "ask", text: field.question, flag: field.flag, ...(field.help === undefined ? {} : { given: field.help }) });
        const hint = field.secret === true ? undefined : pageHint(field.defaultValue, fieldHelp);
        return {
          name: field.name, label: fieldHelp.label ?? field.question,
          ...(fieldHelp.why === undefined ? {} : { why: fieldHelp.why }),
          ...(fieldHelp.example === undefined ? {} : { example: fieldHelp.example }),
          ...(hint === undefined ? {} : { hint }),
          ...(field.secret === true ? { masked: true } : {}),
          // FR-012: only a plain value is ever sent back to the page, never a secret.
          ...(field.secret !== true && kept !== undefined ? { value: kept } : {}),
          ...(error === undefined ? {} : { error }),
        };
      };
      const question = (kept: Record<string, string> = {}, errors: Record<string, string> = {}): NewQuestion => ({
        kind: "form", text: title, ...pageFields(help), fields: fields.map((field) => toField(field, kept[field.name], errors[field.name])),
      });
      const raw = await hub.ask(question(), (posted) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(posted);
        } catch {
          return { error: "the form could not be read; try again" };
        }
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { error: "the form could not be read; try again" };
        const given = parsed as Record<string, unknown>;
        const values: Record<string, string> = {};
        const errors: Record<string, string> = {};
        for (const field of fields) {
          const value = typeof given[field.name] === "string" ? (given[field.name] as string) : "";
          const check = field.secret === true
            ? secretCheck(field.question, false, field.validate)
            : askCheck({ ...(field.defaultValue === undefined ? {} : { defaultValue: field.defaultValue }), ...(field.validate === undefined ? {} : { validate: field.validate }) });
          const result = check(value);
          if ("error" in result) errors[field.name] = result.error;
          else values[field.name] = result.value;
        }
        const refused = Object.keys(errors).length;
        if (refused === 0) return { value: JSON.stringify(values) };
        const kept = Object.fromEntries(fields.filter((field) => field.secret !== true && values[field.name] !== undefined).map((field) => [field.name, values[field.name] ?? ""]));
        return { error: refused === 1 ? "Check the field marked below." : `Check the ${refused} fields marked below.`, retry: question(kept, errors) };
      });
      return JSON.parse(raw) as Record<string, string>;
    },
```

(Import `FormField` from `../prompts.js` and `WizardField` from `./protocol.js`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/contract/init-ui-form.test.ts tests/contract/init-ui-prompter.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/init/prompts.ts packages/cli/src/init/ui/protocol.ts packages/cli/src/init/ui/state.ts packages/cli/src/init/ui/prompter.ts tests/contract/init-ui-form.test.ts
git commit -m "feat(init): a page question can be a form of several fields, checked one by one (048 FR-012)"
```

---

### Task 6: Plain step names everywhere (FR-027, FR-080)

**Files:**
- Modify: `packages/cli/src/init/commands.ts:130-160` (`accessStep`, `initSteps`)
- Modify: `packages/cli/src/init/github-app.ts:242`, `packages/cli/src/init/slack-app.ts:287`, `packages/cli/src/init/signin-step.ts:56`, `packages/cli/src/init/finish-steps.ts:50,114,191,230,296`
- Modify: every test file that names an old step title (found by the `grep` in Step 4)
- Test: `tests/contract/init-steps.test.ts` (one new test)

**Interfaces:**
- Consumes: Task 1's `STEP_PLAN`.
- Produces: `initSteps(...)[i].title === STEP_PLAN[INIT_STEP_IDS[i]].title` for every step; the
  terminal, the log, the resume screen and failure messages all use these names.

- [ ] **Step 1: Write the failing test**

Add to `tests/contract/init-steps.test.ts`:

```ts
import { initSteps } from "../../packages/cli/src/init/commands.js";
import { INIT_STEP_IDS } from "../../packages/cli/src/init/install-state.js";
import { STEP_PLAN } from "../../packages/cli/src/init/ui/journey.js";
import { fakeGitHubApi, fakeSlackApi } from "../support/init-fakes.js";

describe("step names", () => {
  it("spec 048 FR-080: every step is named in plain words, from the journey's one list", () => {
    expect(initSteps({ github: fakeGitHubApi(), slack: fakeSlackApi() }).map((step) => [step.id, step.title]))
      .toEqual(INIT_STEP_IDS.map((id) => [id, STEP_PLAN[id].title]));
  });
});
```

(Merge the imports with the file's existing ones; `fakeGitHubApi` and `fakeSlackApi` take no
required arguments.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/contract/init-steps.test.ts -t "plain words"`
Expected: FAIL: the first difference is `["prerequisites", "Check prerequisites"]` against `["prerequisites", "Check your AWS account"]`.

- [ ] **Step 3: Write minimal implementation**

Import `STEP_PLAN` from `./ui/journey.js` in each step module and replace each literal title:

```ts
// commands.ts
  const deploy = deployStep({ id: "access", title: STEP_PLAN.access.title });
  // ...
    { id: "prerequisites", title: STEP_PLAN.prerequisites.title, async run(context) { /* unchanged */ } },
    accessStep(),
    deployStep({ id: "core", title: STEP_PLAN.core.title }),
    githubAppStep(input.github),
    deployStep({ id: "control-plane", title: STEP_PLAN["control-plane"].title }),
    slackAppStep(input.slack),
    deployStep({ id: "slack-service", title: STEP_PLAN["slack-service"].title, after: verifySlackUrls }),
// github-app.ts:242     title: STEP_PLAN["github-app"].title,
// slack-app.ts:287      title: STEP_PLAN["slack-app"].title,
// signin-step.ts:56     title: STEP_PLAN["developer-signin"].title,
// finish-steps.ts:50    title: STEP_PLAN["admin-user"].title,
// finish-steps.ts:114   title: STEP_PLAN["first-project"].title,
// finish-steps.ts:191   title: STEP_PLAN.connectors.title,
// finish-steps.ts:230   title: STEP_PLAN.alerts.title,
// finish-steps.ts:296   title: STEP_PLAN.e2e.title,
```

- [ ] **Step 4: Update the old names in the tests to the new exact names**

Find them: `grep -rln "Check prerequisites\|Deploy the access stack\|Deploy the foundation and identity stacks\|Create and install the GitHub App\|Deploy the control plane and runtime\|Deploy the Slack service\|Set up developer sign-in\|Create the admin user and sign in\|Set up the first project and its channel\|Offer the Linear, Jira and Asana connectors\|Subscribe alerts, check the budget, and send a test alarm\|Check that AgentX answers in Slack" tests docs`

Replace each old name with its new one, as a whole string, in the files that list prints:

```bash
perl -pi -e '
  s/Deploy the access stack \(IAM roles, artifact bucket, image cache\)/Set up AWS permissions/g;
  s/Deploy the foundation and identity stacks/Build the network and sign-in/g;
  s/Create and install the GitHub App/Create the GitHub app/g;
  s/Deploy the control plane and runtime/Start the AgentX service/g;
  s/Deploy the Slack service/Start the Slack connection/g;
  s/Set up developer sign-in/Turn on developer sign-in/g;
  s/Create the admin user and sign in/Sign in to AgentX/g;
  s/Set up the first project and its channel/Set up your first project/g;
  s/Offer the Linear, Jira and Asana connectors/Connect your issue trackers/g;
  s/Subscribe alerts, check the budget, and send a test alarm/Turn on alerts/g;
  s/Check that AgentX answers in Slack/Get a first reply in Slack/g;
  s/(["`]|: )Check prerequisites(["`])/$1Check your AWS account$2/g;
' <the files grep listed>
```

Then read `git diff tests docs` line by line: every change must be a step title (in an expected
title, a `done: <title>` log line, a resume list, or an `init stopped at "<title>"` message).
Revert any other hit by hand. `grep -rn "Check prerequisites" tests` must then find only
"Check the prerequisites again?" (a different question) or nothing.

- [ ] **Step 5: Run the suites that name steps**

Run: `npx vitest run tests/contract/init-steps.test.ts tests/contract/init-cli.test.ts tests/contract/init-ui-cli.test.ts tests/contract/init-deploy-steps.test.ts tests/contract/init-ui-server.test.ts tests/contract/init-ui-prompter.test.ts tests/contract/init-ui-cards.test.ts tests/contract/install-docs.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/init tests docs
git commit -m "feat(init): name every install step in plain words, from one list (048 FR-027, FR-080)"
```

---

### Task 7: Plain-word cards, names not IDs, and link buttons that say where they go (FR-027, FR-037, FR-080)

**Files:**
- Modify: `packages/cli/src/init/ui/cards.ts` (every builder except `readyCard`, which is Task 14's)
- Modify: `packages/cli/src/init/install-state.ts:81` (`slack` progress gains `botName`, `teamName`)
- Modify: `packages/cli/src/init/slack-app.ts:314,319,343-345,377` (store the names; new card inputs)
- Modify: `packages/cli/src/init/github-app.ts:328,348,355` (the app's name on every card)
- Modify: `packages/cli/src/init/finish-steps.ts:150,311` (the bot by handle)
- Modify: `packages/cli/src/init/ui/server.ts:141-155` (the GitHub return tab closes itself)
- Test: `tests/contract/init-ui-cards.test.ts`, `tests/contract/init-ui-finish.test.ts`, `tests/contract/init-ui-server.test.ts`

**Interfaces:**
- Consumes: Task 2's `lintCopy`; Task 3's `WizardCard.details`, `WizardCard.commands`, `NEW_TAB_NOTE`.
- Produces:
  - `signedInAs(arn: string): string`
  - `GitHubCardInput` stages `install`, `repositories` and `done` gain `appName: string`
  - `SlackCardInput`: `approval` is `{ stage: "approval"; appName: string }` (no `rerun`); `done` is `{ stage: "done"; appName: string; appId: string; teamId: string; teamName?: string }`
  - `ChannelCardInput` `waiting` is `{ stage: "waiting"; channelName: string; botName: string }`
  - `ReplyCardInput` `waiting` is `{ stage: "waiting"; channelName: string; channelId: string; teamId: string; botName: string; minutes: number }`
  - `InstallProgress.slack` gains `botName?: string` (Slack's handle for the bot) and `teamName?: string`
  - `botNameOf(progress: InstallProgress, appName: string): string` (exported from `slack-app.ts`): the stored handle, else `slackBotDisplayName(appName)`

- [ ] **Step 1: Write the failing tests**

Add to `tests/contract/init-ui-cards.test.ts`:

```ts
import { lintCopy, type CopyEntry } from "../support/copy-lint.js";
import { awsCard, awsSignedOutCard, prerequisitesCard, signedInAs } from "../../packages/cli/src/init/ui/cards.js";
import type { WizardCard } from "../../packages/cli/src/init/ui/protocol.js";

/** A card's page words and its technical details, for the copy-lint rules. */
function cardEntries(card: WizardCard): CopyEntry[] {
  const where = `${card.id} card`;
  return [
    { where, text: card.title, context: "page" },
    ...card.lines.map((text) => ({ where, text, context: "page" as const })),
    ...(card.checks ?? []).flatMap((check) => [{ where, text: check.label, context: "page" as const }, { where, text: check.detail, context: "page" as const }]),
    ...(card.link === undefined ? [] : [{ where, text: card.link.label, context: "page" as const }]),
    ...(card.details ?? []).map((text) => ({ where, text, context: "details" as const })),
  ];
}

const EVERY_CARD: WizardCard[] = [
  awsCard({ account: "123456789012", arn: "arn:aws:sts::123456789012:assumed-role/Admin/alice", region: "us-east-1", profile: "dev" }),
  awsSignedOutCard({ profile: "dev", problem: "AUTH_REQUIRED: your AWS session has expired. Refresh your AWS session first (for example aws sso login or aws login)", signIn: "aws sso login --profile dev" }),
  prerequisitesCard({ status: "failed", checks: [{ label: "EC2 vCPU quota", ok: false, detail: "Ask AWS for more in Service Quotas." }] }),
  githubCard({ stage: "create", appName: "AgentX acme (staging)", account: "acme", startUrl: "http://127.0.0.1:5000/github/start?t=x" }),
  githubCard({ stage: "install", appName: "AgentX acme (staging)", slug: "agentx-acme-staging", account: "acme", installUrl: "https://github.com/apps/agentx-acme-staging/installations/new" }),
  githubCard({ stage: "repositories", appName: "AgentX acme (staging)", slug: "agentx-acme-staging", account: "acme", settingsUrl: "https://github.com/organizations/acme/settings/installations/1" }),
  githubCard({ stage: "done", appName: "AgentX acme (staging)", slug: "agentx-acme-staging", account: "acme" }),
  githubCard({ stage: "failed", problem: "no GitHub App was created within 15 minutes; run agentx init again" }),
  slackAppCard({ stage: "create", appName: "AgentX acme (staging)", createUrl: "https://api.slack.com/apps?new_app=1" }),
  slackAppCard({ stage: "credentials", appName: "AgentX acme (staging)" }),
  slackAppCard({ stage: "bot", user: "agentx-acme-staging", team: "Acme" }),
  slackAppCard({ stage: "refused", problem: "Slack refused the bot token (invalid_auth); copy it again from OAuth & Permissions" }),
  slackAppCard({ stage: "approval", appName: "AgentX acme (staging)" }),
  slackAppCard({ stage: "done", appName: "AgentX acme (staging)", appId: "A0APP", teamId: "T0TEAM", teamName: "Acme" }),
  slackUrlsCard({ stage: "verify", pageUrl: "https://api.slack.com/apps/A0APP/event-subscriptions" }),
  slackUrlsCard({ stage: "failed", problem: "the URL answered 401; run agentx init again", pageUrl: "https://api.slack.com/apps/A0APP/event-subscriptions" }),
  adminCard({ stage: "signing-in", who: "you@example.com", createdEmail: "you@example.com" }),
  adminCard({ stage: "failed", problem: "the AgentX sign-in did not finish within 10 minutes; run agentx init again", retry: false }),
  projectCard({ name: "payments-api", revision: 1, repository: "acme/payments-api" }),
  channelCard({ stage: "waiting", channelName: "payments", botName: "agentx-acme-staging" }),
  channelCard({ stage: "failed", channelName: "payments", problem: "the bot was not invited within 10 minutes; run agentx init again" }),
  connectorsCard({ projectName: "payments-api", connected: [] }),
  alertsCard({ stage: "confirm", shownAs: "ops@example.com" }),
  alertsCard({ stage: "failed", problem: "CloudWatch refused SetAlarmState" }),
  alertsCard({ stage: "none" }),
  replyCard({ stage: "waiting", channelName: "payments", channelId: "C0PAY00001", teamId: "T0TEAM", botName: "agentx-acme-staging", minutes: 10 }),
  replyCard({ stage: "failed", channelName: "payments", channelId: "C0PAY00001", teamId: "T0TEAM", problem: "no reply within 10 minutes; run agentx init again" }),
];

describe("spec 048 card copy", () => {
  it("SC-011: no card says an internal word, a raw ID, a flag or a command outside its technical details", () => {
    expect(lintCopy(EVERY_CARD.flatMap(cardEntries))).toEqual([]);
  });

  it("FR-027: names who is signed in, never the ARN, which is kept in the details", () => {
    expect(signedInAs("arn:aws:sts::123456789012:assumed-role/Admin/alice")).toBe("alice (role Admin)");
    expect(signedInAs("arn:aws:sts::123456789012:assumed-role/AWSReservedSSO_AdministratorAccess_0123456789abcdef/alice@example.com")).toBe("alice@example.com (AdministratorAccess, through IAM Identity Center)");
    expect(signedInAs("arn:aws:iam::123456789012:user/ops/bob")).toBe("the IAM user bob");
    expect(signedInAs("arn:aws:iam::123456789012:root")).toBe("the AWS root user");
    expect(EVERY_CARD[0]?.details).toEqual(["arn:aws:sts::123456789012:assumed-role/Admin/alice"]);
  });

  it("FR-027: the GitHub app keeps its name on every card, and its slug only in the details", () => {
    for (const card of EVERY_CARD.filter((shown) => shown.id === "github" && shown.status !== "failed")) {
      expect(card.lines.join(" ")).toContain("AgentX acme (staging)");
      expect(card.lines.join(" ")).not.toContain("agentx-acme-staging");
    }
    expect(githubCard({ stage: "done", appName: "AgentX acme (staging)", slug: "agentx-acme-staging", account: "acme" }).details).toEqual(["GitHub app slug: agentx-acme-staging"]);
  });

  it("FR-027: Slack's workspace and bot are named, and their IDs are only in the details", () => {
    const done = slackAppCard({ stage: "done", appName: "AgentX acme (staging)", appId: "A0APP", teamId: "T0TEAM", teamName: "Acme" });
    expect(done.lines).toEqual(['"AgentX acme (staging)" is installed in the Acme workspace.']);
    expect(done.details).toEqual(["Slack app ID: A0APP", "Slack workspace ID: T0TEAM"]);
    expect(channelCard({ stage: "waiting", channelName: "payments", botName: "agentx-acme-staging" }).commands).toEqual([{ label: "Invite the bot", command: "/invite @agentx-acme-staging" }]);
  });

  it("FR-034: the Slack create card says up front that a Request URL error is expected", () => {
    expect(slackAppCard({ stage: "create", appName: "AgentX acme (staging)", createUrl: "https://api.slack.com/apps?new_app=1" }).lines)
      .toContain("Slack may show a red error next to the Request URL. That is expected; AgentX fixes it in a later step.");
  });
});
```

Add to `tests/contract/init-ui-server.test.ts` (inside the GitHub callback `describe`, or a new one;
reuse the file's existing helper that mounts a manifest route, which the existing callback tests use):

```ts
  it("FR-037: GitHub's return tab closes itself where the browser allows, and says to go back otherwise", async () => {
    const { server, origin } = await wizard();
    const host = server.mountManifest({ state: "s".repeat(32), page: () => "<p>form</p>", timeoutMs: 60_000 });
    const response = await fetch(`${origin}/github/created?code=0123456789abcdef0123&state=${"s".repeat(32)}`, { headers: { "sec-fetch-site": "cross-site" } });
    expect(response.status).toBe(200);
    const csp = response.headers.get("content-security-policy") ?? "";
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeDefined();
    const body = await response.text();
    expect(body).toContain(`<script nonce="${nonce}">window.close()</script>`);
    expect(body).toContain("AgentX has the new GitHub app. You can close this tab and go back to the Install AgentX tab.");
    await expect(host.code).resolves.toBe("0123456789abcdef0123");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/contract/init-ui-cards.test.ts tests/contract/init-ui-server.test.ts`
Expected: FAIL: `signedInAs` is not exported, `lintCopy` finds the ARN, the slug, `A0APP`,
`<@`, "run agentx init", and the callback page has no script.

- [ ] **Step 3: Write minimal implementation**

In `packages/cli/src/init/install-state.ts`, the Slack progress (old records still parse):

```ts
  slack: z.object({
    appId: z.string().regex(/^A[A-Z0-9]+$/), teamId: z.string().regex(/^T[A-Z0-9]+$/), botUserId: z.string().regex(/^[UW][A-Z0-9]+$/),
    /** Spec 048 FR-026 and FR-027: the bot's handle and the workspace's name, as Slack reported them. */
    botName: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/).optional(),
    teamName: z.string().min(1).max(100).optional(),
  }).strict().optional(),
```

In `packages/cli/src/init/ui/cards.ts`, replace the builders (keep `linkLabel`, `onPageProblem`,
`slackChannelLink`, `readyCard`). `DEDICATED_ACCOUNT_NOTE` is reworded in Task 8; import it as now.

```ts
/** FR-027: who is signed in, in words. The ARN itself goes to the card's details. */
export function signedInAs(arn: string): string {
  if (/:root$/.test(arn)) return "the AWS root user";
  const sso = /:assumed-role\/AWSReservedSSO_(.+)_[0-9a-f]{16}\/(.+)$/.exec(arn);
  if (sso !== null) return `${sso[2] ?? "you"} (${sso[1] ?? "a permission set"}, through IAM Identity Center)`;
  const role = /:assumed-role\/([^/]+)\/(.+)$/.exec(arn);
  if (role !== null) return `${role[2] ?? "you"} (role ${role[1] ?? ""})`;
  const user = /:user\/(?:.*\/)?([^/]+)$/.exec(arn);
  if (user !== null) return `the IAM user ${user[1] ?? ""}`;
  return "your AWS sign-in";
}

export function awsCard(input: { account: string; arn: string; region: string; profile?: string }): WizardCard {
  return {
    id: "aws", title: "AWS account", status: "ok",
    lines: [
      `AgentX installs into AWS account ${input.account} in ${input.region}.`,
      `You are signed in as ${signedInAs(input.arn)}${input.profile === undefined ? "" : `, with the AWS profile ${input.profile}`}.`,
      DEDICATED_ACCOUNT_NOTE,
    ],
    details: [input.arn],
  };
}

export function awsSignedOutCard(input: { profile?: string; problem: string; signIn?: string; ranProblem?: string }): WizardCard {
  return {
    id: "aws", title: "AWS account", status: "failed",
    lines: [
      input.profile === undefined ? "Your AWS sign-in is missing or has ended." : `The AWS sign-in of the profile ${input.profile} is missing or has ended.`,
      input.signIn !== undefined
        ? "Choose Sign in again. A browser tab opens for the AWS sign-in; finish it there, then come back to this tab."
        : "Sign in to AWS again another way, then choose I signed in another way, check again.",
    ],
    details: [input.problem, ...(input.signIn === undefined ? [] : [`Sign-in command: ${input.signIn}`]), ...(input.ranProblem === undefined ? [] : [input.ranProblem])],
  };
}

export function prerequisitesCard(input: { status: "running" | "ok" | "failed"; checks: readonly PrerequisiteCheck[] }): WizardCard {
  const lines = input.status === "running"
    ? ["Checking your account and region. Nothing is created yet."]
    : input.status === "ok"
      ? ["Everything AgentX needs is in place."]
      : ["Nothing has been created. Fix each item marked Not ready, then choose Check again."];
  const technical = input.checks.flatMap((check) => (check.technical === undefined ? [] : [`${check.label}: ${check.technical}`]));
  return {
    id: "prerequisites", title: "Check your AWS account", status: input.status, lines,
    checks: input.checks.map((check) => ({ label: check.label, ok: check.ok, detail: check.detail })),
    ...(technical.length === 0 ? {} : { details: technical }),
  };
}

export type GitHubCardInput =
  | { stage: "create"; appName: string; account: string; startUrl: string }
  | { stage: "install"; appName: string; slug: string; account: string; installUrl: string }
  | { stage: "repositories"; appName: string; slug: string; account: string; settingsUrl: string }
  | { stage: "done"; appName: string; slug: string; account: string }
  | { stage: "failed"; problem: string };

export function githubCard(input: GitHubCardInput): WizardCard {
  const base = { id: "github" as const, title: "GitHub app" };
  const slug = (value: string) => ({ details: [`GitHub app slug: ${value}`] });
  switch (input.stage) {
    case "create": return {
      ...base, status: "waiting",
      lines: [`Create the GitHub app "${input.appName}" for ${input.account}.`, "GitHub opens with everything filled in. Press Create GitHub App there.", "This page moves on by itself when GitHub sends you back."],
      link: { url: input.startUrl, label: "Open GitHub" },
    };
    case "install": return {
      ...base, status: "waiting", ...slug(input.slug),
      lines: [`Install "${input.appName}" on ${input.account}. Choose only the repositories AgentX should work on.`, "This page moves on by itself when the app is installed."],
      link: { url: input.installUrl, label: "Choose repositories" },
    };
    case "repositories": return {
      ...base, status: "waiting", ...slug(input.slug),
      lines: [`"${input.appName}" is installed, but it can see no repositories.`, "Choose at least one. This page moves on by itself."],
      link: { url: input.settingsUrl, label: "Choose repositories" },
    };
    case "done": return { ...base, status: "ok", ...slug(input.slug), lines: [`"${input.appName}" is installed on ${input.account}.`] };
    case "failed": return { ...base, status: "failed", lines: ["The GitHub app was not set up."], details: [input.problem] };
  }
}

export type SlackCardInput =
  | { stage: "create"; appName: string; createUrl: string }
  | { stage: "credentials"; appName: string }
  | { stage: "bot"; user: string; team: string }
  | { stage: "refused"; problem: string; retry?: false }
  | { stage: "approval"; appName: string }
  | { stage: "done"; appName: string; appId: string; teamId: string; teamName?: string };

export const SLACK_APPS_URL = "https://api.slack.com/apps";

export function slackAppCard(input: SlackCardInput): WizardCard {
  const base = { id: "slack" as const, title: "Slack app" };
  switch (input.stage) {
    case "create": return {
      ...base, status: "waiting",
      lines: [
        `Create the Slack app "${input.appName}". Slack opens with everything filled in.`,
        "Pick your workspace, press Next, then Create, then Install to Workspace.",
        "Slack may show a red error next to the Request URL. That is expected; AgentX fixes it in a later step.",
        "If your workspace needs an admin to approve new apps, choose Request to Install there, then choose My workspace needs an admin to approve it below.",
      ],
      link: { url: input.createUrl, label: "Open Slack" },
    };
    case "credentials": return {
      ...base, status: "waiting",
      lines: [
        `Copy two values from the settings of "${input.appName}" and paste them below.`,
        "The Bot User OAuth Token is under OAuth & Permissions. The Signing Secret is under Basic Information, App Credentials.",
        "Both are saved in AWS Secrets Manager and never shown again.",
      ],
      link: { url: SLACK_APPS_URL, label: "Open your Slack apps" },
    };
    case "bot": return { ...base, status: "waiting", lines: [`The token belongs to the bot @${input.user} in the ${input.team} workspace.`] };
    case "refused": return {
      ...base, status: "failed",
      lines: [input.retry === false ? "Slack did not accept those values." : onPageProblem(input.problem), "Nothing was saved."],
      details: [input.problem],
    };
    case "approval": return {
      ...base, status: "waiting",
      lines: [`Slack is waiting for a workspace admin to approve "${input.appName}".`, "Your progress is saved. When the app is installed, start the install again and it continues from here."],
    };
    case "done": return {
      ...base, status: "ok",
      lines: [`"${input.appName}" is installed in the ${input.teamName ?? "chosen"} workspace.`],
      details: [`Slack app ID: ${input.appId}`, `Slack workspace ID: ${input.teamId}`],
    };
  }
}

export function slackUrlsCard(input: SlackUrlsCardInput): WizardCard {
  const base = { id: "slack-urls" as const, title: "The address Slack sends messages to" };
  const events = "Open Event Subscriptions";
  switch (input.stage) {
    case "checking": return { ...base, status: "running", lines: [`Checking that Slack can reach AgentX at ${input.eventsUrl}.`] };
    case "waiting-for-secret": return {
      ...base, status: "running",
      lines: [`Checking that Slack can reach AgentX at ${input.eventsUrl}.`, "AgentX can take up to 5 minutes to start using the new Signing Secret. Checking again every 15 seconds."],
    };
    case "verify": return {
      ...base, status: "waiting",
      lines: ["AgentX answers Slack's check.", "Open Event Subscriptions in your Slack app. If the address is not marked Verified, press Retry there, then answer below."],
      link: { url: input.pageUrl, label: events },
    };
    case "failed": return {
      ...base, status: "failed",
      lines: ["Slack's check of the address did not pass.", "Fix it, then choose Check again below."],
      details: [input.problem],
      link: { url: input.pageUrl, label: events },
    };
    case "done": return { ...base, status: "ok", lines: [`Slack has verified ${input.eventsUrl}.`] };
  }
}

export function adminCard(input: AdminCardInput): WizardCard {
  const base = { id: "admin" as const, title: "Your AgentX sign-in" };
  switch (input.stage) {
    case "signing-in": return {
      ...base, status: "waiting",
      lines: [
        ...(input.createdEmail === undefined ? [] : [`AgentX made your admin sign-in for ${input.createdEmail}. Look for an email with your temporary password; you choose your own when you first sign in.`]),
        `Sign in to AgentX as ${input.who} in the tab the Sign in button opens. This page moves on by itself when you have.`,
      ],
    };
    case "failed": return {
      ...base, status: "failed",
      lines: input.retry === false ? ["The sign-in did not finish."] : [onPageProblem(input.problem), "Choose Sign in again below."],
      details: [input.problem],
    };
    case "done": return { ...base, status: "ok", lines: [`You are signed in to AgentX as ${input.username}.`] };
  }
}

export function projectCard(input: { name: string; revision: number; repository?: string }): WizardCard {
  return {
    id: "project", title: "Your first project", status: "ok",
    lines: [`The project ${input.name} is set up${input.repository === undefined ? "" : ` for ${input.repository}`}.`],
    details: [`Project revision ${input.revision}`],
  };
}

export type ChannelCardInput =
  | { stage: "waiting"; channelName: string; botName: string }
  | { stage: "done"; channelName: string; projectName: string }
  | { stage: "failed"; channelName: string; problem: string };

export function channelCard(input: ChannelCardInput): WizardCard {
  const base = { id: "channel" as const, title: "Slack channel" };
  if (input.stage === "done") return { ...base, status: "ok", lines: [`AgentX answers in #${input.channelName} for ${input.projectName}.`] };
  if (input.stage === "failed") return { ...base, status: "failed", lines: [`AgentX's bot still cannot see #${input.channelName}.`], details: [input.problem] };
  return {
    ...base, status: "waiting",
    lines: [
      `AgentX's bot cannot see #${input.channelName} yet.`,
      `If #${input.channelName} is private, invite the bot in it with the command below. If it does not exist yet, create it in Slack.`,
      "This page moves on by itself when the bot can see it (up to 10 minutes).",
    ],
    commands: [{ label: "Invite the bot", command: `/invite @${input.botName}` }],
  };
}

export function connectorsCard(input: { projectName: string; connected: ReadonlyArray<{ label: string; warning?: string }> }): WizardCard {
  const lines = input.connected.length === 0
    ? [`No issue trackers are connected to ${input.projectName} yet. You can connect Linear, Jira or Asana later.`]
    : [
      `Connected to ${input.projectName}: ${input.connected.map((entry) => entry.label).join(", ")}.`,
      ...input.connected.flatMap((entry) => (entry.warning === undefined ? [] : [`Warning (${entry.label}): ${entry.warning}.`])),
    ];
  return { id: "connectors", title: "Issue trackers", status: "ok", lines };
}

export function alertsCard(input: AlertsCardInput): WizardCard {
  const base = { id: "alerts" as const, title: "Alerts" };
  const confirm = (shownAs: string): string => `Confirm the alert email for ${shownAs}: open the email from AWS Notifications and choose Confirm subscription.`;
  const webhook = ["A webhook confirms by opening the SubscribeURL that AWS sent it."];
  switch (input.stage) {
    case "confirm": return { ...base, status: "waiting", lines: [confirm(input.shownAs), "Then choose Check again below."], details: webhook };
    case "waiting": return { ...base, status: "waiting", lines: [confirm(input.shownAs), "This page moves on by itself when it is confirmed (up to 10 minutes)."], details: webhook };
    case "testing": return { ...base, status: "waiting", lines: [`Alerts go to ${input.shownAs}. AgentX sent a test alert; answer below whether it arrived.`] };
    case "failed": return { ...base, status: "failed", lines: ["The test alert could not be sent."], details: [input.problem] };
    case "done": return { ...base, status: "ok", lines: [`Alerts go to ${input.shownAs}, and the test alert arrived.`] };
    case "none": return { ...base, status: "info", lines: ["No alerts yet. The ready screen shows how to turn them on."] };
  }
}

export type ReplyCardInput =
  | { stage: "waiting"; channelName: string; channelId: string; teamId: string; botName: string; minutes: number }
  | { stage: "failed"; channelName: string; channelId: string; teamId: string; problem: string }
  | { stage: "done"; channelName: string; seconds: number };

export function replyCard(input: ReplyCardInput): WizardCard {
  const base = { id: "reply" as const, title: "First reply" };
  if (input.stage === "done") return { ...base, status: "ok", lines: [`AgentX replied in #${input.channelName} in ${input.seconds} seconds.`] };
  const link = { url: slackChannelLink(input.teamId, input.channelId), label: `Open #${input.channelName} in Slack` };
  if (input.stage === "failed") return { ...base, status: "failed", lines: ["AgentX did not reply.", "When it is fixed, choose Watch again below."], details: [input.problem], link };
  return {
    ...base, status: "waiting",
    lines: [
      `In #${input.channelName}, post a message that mentions @${input.botName}, for example "@${input.botName} what can you do?".`,
      `Type @ and pick ${input.botName} from Slack's list. If you see two bots with similar names, pick ${input.botName}.`,
      `Waiting up to ${input.minutes} minutes for AgentX to reply in the thread. This page moves on by itself.`,
    ],
    link,
  };
}
```

`PrerequisiteCheck` gains `technical?: string` in `prerequisites.ts` (Task 11 fills it). The
`SlackUrlsCardInput`, `AdminCardInput` and `AlertsCardInput` types stay as they are.

In `slack-app.ts`: `export function botNameOf(progress: InstallProgress, appName: string): string { return progress.slack?.botName ?? slackBotDisplayName(appName); }`;
line 314 becomes `show({ stage: "approval", appName });`; `collectBot` returns `botName: auth.user` and
`teamName: auth.team` when Slack sent them (add both, optional, to `SlackBot`); the progress
update and the done card become:

```ts
      await progress.update({ slack: { appId: bot.appId, teamId: bot.teamId, botUserId: bot.botUserId, ...(bot.botName === undefined ? {} : { botName: bot.botName }), ...(bot.teamName === undefined ? {} : { teamName: bot.teamName }) } });
      show({ stage: "done", appName, appId: bot.appId, teamId: bot.teamId, ...(bot.teamName === undefined ? {} : { teamName: bot.teamName }) });
```

(A handle Slack sends that does not match the schema's pattern is left out rather than refusing
the install: guard with `/^[a-z0-9][a-z0-9._-]{0,79}$/.test(auth.user)` before keeping it.)

In `github-app.ts`, pass `appName: context.answers.github.appName` (the variable `appName` already
in scope at line 197) to the `install`, `repositories` and `done` cards. In `finish-steps.ts`
(import `botNameOf` from `./slack-app.js`), the first-project step's waiting card becomes
`channelCard({ stage: "waiting", channelName, botName: botNameOf(progress.current(), context.answers.slack.appName) })`
and the e2e step's waiting card passes `botName: botNameOf(progress.current(), context.answers.slack.appName)`
in place of `botUserId: slack.botUserId` (both steps already receive `progress`). The calls that
pass `botUserId` to Slack itself (`waitForThreadedReply`, the channel watch) keep it.

In `server.ts`, the GitHub callback's answer carries a nonce script that closes the tab:

```ts
const CALLBACK_PAGE = (text: string, nonce?: string) =>
  `<!doctype html><meta charset="utf-8"><title>Install AgentX</title><p>${text}</p>${nonce === undefined ? "" : `<script nonce="${nonce}">window.close()</script>`}`;

// in githubCallback:
    const answer = (status: number, text: string, closeTab = false) => {
      const nonce = closeTab ? randomBytes(16).toString("base64") : undefined;
      const body = CALLBACK_PAGE(text, nonce);
      const csp = nonce === undefined ? CALLBACK_HEADERS["content-security-policy"] : `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'`;
      response.writeHead(status, { ...CALLBACK_HEADERS, "content-security-policy": csp ?? "", "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(body) });
      response.end(body);
    };
    // ...
    return answer(200, "AgentX has the new GitHub app. You can close this tab and go back to the Install AgentX tab.", true);
```

- [ ] **Step 4: Update the existing card expectations to the new exact words**

In `init-ui-cards.test.ts`, `init-ui-finish.test.ts` and `init-ui-cli.test.ts`, every assertion
on a card's `lines`, `title` or input shape now fails with the old words. For each one, replace
the expected value with the exact value the new builder returns (copy it from the builder code
above), keeping the same matcher. Where a test asserted the old text of a problem in `lines[0]`
(for example `init-ui-finish.test.ts:49`, "the AgentX sign-in did not finish within 10 minutes;
run agentx init again ..."), assert it, unchanged, on `details[0]` instead, and assert the new
plain `lines[0]` too. Where a test built a card with `botUserId` or `rerun`, pass `botName` or drop
`rerun`.

- [ ] **Step 5: Run the suites**

Run: `npx vitest run tests/contract/init-ui-cards.test.ts tests/contract/init-ui-finish.test.ts tests/contract/init-ui-server.test.ts tests/contract/init-ui-cli.test.ts tests/contract/init-ui-github.test.ts tests/contract/init-slack-app.test.ts tests/contract/init-install-state.test.ts tests/contract/init-finish-steps.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/init tests/contract
git commit -m "feat(init): cards in plain words, names instead of IDs, details collapsed, GitHub tab closes itself (048 FR-027, FR-037, FR-080)"
```

---
### Task 8: The root user warning and a plain account tip (FR-016, FR-017)

**Files:**
- Create: `packages/cli/src/init/stop.ts`
- Modify: `packages/cli/src/init/prerequisites.ts:46-47` (`DEDICATED_ACCOUNT_NOTE`; new `ROOT_WARNING`, `ADMIN_USER_GUIDE_URL`, `isRootUser`)
- Modify: `packages/cli/src/init/ui/cards.ts` (new `rootUserCard`)
- Modify: `packages/cli/src/init/aws-account.ts:121-158` (`resolveCaller`)
- Modify: `packages/cli/src/init/plan.ts:139-141` (a declined plan is the person's own stop)
- Modify: `packages/cli/src/init/commands.ts:447-452` (pass `write` to `resolveCaller`)
- Test: `tests/contract/init-aws-account.test.ts`

**Interfaces:**
- Consumes: Task 4's `buttons` help (the `--continue-as-root` catalog entry), Task 7's `awsCard`.
- Produces:
  - `operatorStop(message: string): Error`, `markOperatorStop<T>(error: T): T`, `isOperatorStop(error: unknown): boolean` (in `stop.ts`)
  - `ROOT_WARNING`, `ADMIN_USER_GUIDE_URL`, `isRootUser(arn: string): boolean` (in `prerequisites.ts`)
  - `rootUserCard(input: { account: string; arn: string; region: string; profile?: string }): WizardCard`
  - `resolveCaller` input gains `write?: (line: string) => void`

- [ ] **Step 1: Write the failing tests**

Add to `tests/contract/init-aws-account.test.ts`, inside `describe("the account the install lands in", ...)`:

```ts
  it("FR-016: warns a root user on the page, links to making an admin user, and continuing works", async () => {
    const page = surface();
    const root = "arn:aws:iam::123456789012:root";
    const prompter = scriptedPrompter([""]);
    const caller = await resolveCaller({ identity: () => ({ get: async () => ({ account: "123456789012", arn: root }) }), region: "us-east-1", prompter, runner: runner(), surface: page });
    expect(caller).toEqual({ account: "123456789012", arn: root });
    expect(prompter.asked).toEqual(["You are signed in as the AWS root user. Continue?"]);
    expect(page.cards[0]).toMatchObject({
      id: "aws", status: "waiting",
      lines: [
        "AgentX installs into AWS account 123456789012 in us-east-1.",
        "You are signed in as the AWS root user. AgentX works, but AWS advises an admin user instead.",
        "You can continue as root. A few day-two commands need an admin user instead; the ready screen says which.",
      ],
      link: { url: ADMIN_USER_GUIDE_URL, label: "How to create an admin user" },
      details: [root],
    });
    expect(page.cards[1]).toMatchObject({ id: "aws", status: "ok" });
  });

  it("FR-016: stopping at the root warning is the person's own stop, not a failure", async () => {
    const error = await resolveCaller({ identity: () => ({ get: async () => ({ account: "123456789012", arn: "arn:aws:iam::123456789012:root" }) }), region: "us-east-1", prompter: scriptedPrompter(["stop"]), runner: runner(), surface: surface() }).catch((caught: unknown) => caught);
    expect(isOperatorStop(error)).toBe(true);
  });

  it("FR-016: without a page, a root user gets the warning as a line and no question", async () => {
    const lines: string[] = [];
    const prompter = scriptedPrompter([]);
    await resolveCaller({ identity: () => ({ get: async () => ({ account: "123456789012", arn: "arn:aws:iam::123456789012:root" }) }), region: "us-east-1", prompter, runner: runner(), write: (line) => lines.push(line) });
    expect(lines).toEqual([ROOT_WARNING]);
    expect(prompter.asked).toEqual([]);
  });

  it("FR-017: the account tip is plain words with no double negative", () => {
    expect(DEDICATED_ACCOUNT_NOTE).toBe("Tip: a separate AWS account just for AgentX keeps its costs and permissions apart from your other work.");
    expect(DEDICATED_ACCOUNT_NOTE).not.toMatch(/\bnot\b|\bno\b|\bnever\b/);
  });

  it("knows the root user from its ARN only", () => {
    expect(isRootUser("arn:aws:iam::123456789012:root")).toBe(true);
    expect(isRootUser("arn:aws-us-gov:iam::123456789012:root")).toBe(true);
    expect(isRootUser("arn:aws:sts::123456789012:assumed-role/root/alice")).toBe(false);
  });
```

Add the imports: `import { ADMIN_USER_GUIDE_URL, DEDICATED_ACCOUNT_NOTE, isRootUser, ROOT_WARNING } from "../../packages/cli/src/init/prerequisites.js";` and `import { isOperatorStop } from "../../packages/cli/src/init/stop.js";`.
The existing "shows the account, the role and the profile once AWS answers" test's expected card
becomes (exact, `toEqual` kept):

```ts
    expect(page.cards).toEqual([{
      id: "aws", title: "AWS account", status: "ok",
      lines: [
        "AgentX installs into AWS account 123456789012 in us-east-1.",
        `You are signed in as ${signedInAs(HOLDER)}, with the AWS profile dev.`,
        "Tip: a separate AWS account just for AgentX keeps its costs and permissions apart from your other work.",
      ],
      details: [HOLDER],
    }]);
```

(Import `signedInAs` from `../../packages/cli/src/init/ui/cards.js`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/contract/init-aws-account.test.ts`
Expected: FAIL: `ROOT_WARNING` and `stop.ts` do not exist, and the root caller gets no question.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/cli/src/init/stop.ts
// Spec 048 FR-060: a stop the person chose (declining the plan, Stop for now, stopping at the root
// warning or a check-again question) is not a failure, so the page shows no failure screen for it.
import { agentXError } from "@agentx/contracts";

const chosen = new WeakSet<object>();

export function markOperatorStop<T>(error: T): T {
  if (typeof error === "object" && error !== null) chosen.add(error);
  return error;
}

export function operatorStop(message: string): Error {
  return markOperatorStop(agentXError("CONFIG_INVALID", message));
}

export function isOperatorStop(error: unknown): boolean {
  return typeof error === "object" && error !== null && chosen.has(error);
}
```

In `prerequisites.ts`:

```ts
/** FR-017: shown once, on the account card. */
export const DEDICATED_ACCOUNT_NOTE = "Tip: a separate AWS account just for AgentX keeps its costs and permissions apart from your other work.";
/** FR-016. */
export const ROOT_WARNING = "You are signed in as the AWS root user. AgentX works, but AWS advises an admin user instead.";
/** AWS's guide to an IAM user with admin rights. Confirm it loads before committing (curl -sI); if AWS moved it, use the IAM User Guide page on creating an administrative user. */
export const ADMIN_USER_GUIDE_URL = "https://docs.aws.amazon.com/IAM/latest/UserGuide/getting-started-account-iam.html";
export const isRootUser = (arn: string): boolean => /^arn:aws[a-z-]*:iam::\d{12}:root$/.test(arn);
```

In `cards.ts`:

```ts
export function rootUserCard(input: { account: string; arn: string; region: string; profile?: string }): WizardCard {
  return {
    id: "aws", title: "AWS account", status: "waiting",
    lines: [
      `AgentX installs into AWS account ${input.account} in ${input.region}.`,
      ROOT_WARNING,
      "You can continue as root. A few day-two commands need an admin user instead; the ready screen says which.",
    ],
    link: { url: ADMIN_USER_GUIDE_URL, label: "How to create an admin user" },
    details: [input.arn],
  };
}
```

In `aws-account.ts`, `resolveCaller`'s input gains `write?: (line: string) => void` and the success
branch becomes:

```ts
      const caller = await input.identity().get();
      const shown = { ...caller, region: input.region, ...(profile === undefined ? {} : { profile: profile.name }) };
      if (isRootUser(caller.arn)) {
        if (surface === undefined) {
          input.write?.(ROOT_WARNING);
          return caller;
        }
        surface.card(rootUserCard(shown));
        const next = await input.prompter.choose<"continue" | "stop">("You are signed in as the AWS root user. Continue?", [
          { value: "continue", label: "Continue as root" },
          { value: "stop", label: "Stop for now" },
        ], { flag: "--continue-as-root", defaultValue: "continue" });
        if (next === "stop") throw operatorStop("you chose to stop and sign in as an admin user; nothing was created");
      }
      surface?.card(awsCard(shown));
      return caller;
```

and the sign-in loop's `if (next === "stop") throw error;` becomes `if (next === "stop") throw markOperatorStop(error);`.

In `plan.ts`, the decline: `throw operatorStop("install declined; nothing was created");` (same message).
In `commands.ts`, pass `write` to `resolveCaller({ ..., write })`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/contract/init-aws-account.test.ts tests/contract/init-plan.test.ts tests/contract/init-prerequisites.test.ts tests/contract/init-ui-cli.test.ts`
Expected: PASS. A test that expected the old `DEDICATED_ACCOUNT_NOTE` text by value gets the new
exact text; one that imports the constant needs no change.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/init/stop.ts packages/cli/src/init/prerequisites.ts packages/cli/src/init/ui/cards.ts packages/cli/src/init/aws-account.ts packages/cli/src/init/plan.ts packages/cli/src/init/commands.ts tests/contract
git commit -m "feat(init): warn a root user and let them continue; a plain one-time account tip (048 FR-016, FR-017)"
```

---

### Task 9: Every model priced, the budget from the estimate, and a plan in plain words (FR-023, FR-024, FR-082)

**Files:**
- Create: `packages/cli/src/init/cost.ts` (prices and `estimateMonthlyCost` move here from `plan.ts:14-90`)
- Modify: `packages/cli/src/init/plan.ts` (re-exports the estimate; plain plan text)
- Modify: `packages/cli/src/init/answers.ts:19-37,195-210` (priced choice labels; budget default and scope)
- Test: `tests/contract/init-cost.test.ts` (new), `tests/contract/init-plan.test.ts`, `tests/contract/init-answers.test.ts`

**Interfaces:**
- Consumes: `ModelRole` (type) from `prerequisites.ts`, `QuestionHelp` (Task 4).
- Produces:
  - `estimateMonthlyCost(models, usage?): CostEstimate` (same signature; `plan.ts` re-exports it, so every existing import keeps working)
  - `PRICE_NOT_ON_FILE = "price not on file"`, `modelName(id): string`, `modelPriceLabel(role: ModelRole, id: string, provider?: string): string`
  - `suggestedBudgetUsd(estimate: CostEstimate): number` (estimate times 1.2, rounded up to a whole $10, at least $10)
  - `budgetWhy(estimate: CostEstimate): string`
  - `CostEstimate` keeps `unpriced: string[]` (model ids); an unpriced line has `usd: undefined`

- [ ] **Step 1: Write the failing test**

```ts
// tests/contract/init-cost.test.ts
// Spec 048 FR-023, FR-024 and FR-082: the default models are all priced, every model offered as a
// choice is priced or says "price not on file", and the budget default is the estimate plus 20%.
import { describe, expect, it } from "vitest";
import { CLASSIFIER_MODEL_CHOICES, DEFAULT_CLASSIFIER_MODEL, DEFAULT_ORCHESTRATOR_MODEL, DEFAULT_WORKER_MODEL, ORCHESTRATOR_MODEL_CHOICES } from "../../packages/cli/src/init/answers.js";
import { budgetWhy, estimateMonthlyCost, modelPriceLabel, PRICE_NOT_ON_FILE, suggestedBudgetUsd } from "../../packages/cli/src/init/cost.js";
import type { ModelRole } from "../../packages/cli/src/init/prerequisites.js";

const DEFAULTS = { orchestrator: DEFAULT_ORCHESTRATOR_MODEL, classifier: DEFAULT_CLASSIFIER_MODEL, worker: DEFAULT_WORKER_MODEL };
const pricedOrLabelled = (role: ModelRole, choice: { value: string; label: string }) =>
  modelPriceLabel(role, choice.value) !== PRICE_NOT_ON_FILE || choice.label.includes(PRICE_NOT_ON_FILE);

describe("model prices", () => {
  it("FR-024: prices every default model, the coding model included", () => {
    const estimate = estimateMonthlyCost(DEFAULTS);
    expect(estimate.unpriced).toEqual([]);
    expect(estimate.lines.slice(-3).map((line) => [line.item, line.usd])).toEqual([
      ["Main model (Claude Sonnet 4.6)", 25], ["Safety check model (Amazon Nova Lite)", 0.15], ["Coding model (Claude Sonnet 4.6)", 75],
    ]);
    expect(estimate.totalUsd).toBe(208.78);
  });

  it("FR-082: every model offered as a choice has a price or says price not on file", () => {
    for (const choice of ORCHESTRATOR_MODEL_CHOICES) expect(pricedOrLabelled("orchestrator", choice)).toBe(true);
    for (const choice of CLASSIFIER_MODEL_CHOICES) expect(pricedOrLabelled("classifier", choice)).toBe(true);
    for (const [role, id] of Object.entries(DEFAULTS) as Array<[ModelRole, string]>) expect(modelPriceLabel(role, id)).not.toBe(PRICE_NOT_ON_FILE);
  });

  it("FR-082: the check fails for a choice with no price and no label", () => {
    expect(pricedOrLabelled("worker", { value: "us.amazon.nova-premier-v1:0", label: "Amazon Nova Premier" })).toBe(false);
    expect(pricedOrLabelled("worker", { value: "us.amazon.nova-premier-v1:0", label: `Amazon Nova Premier (${PRICE_NOT_ON_FILE})` })).toBe(true);
  });

  it("labels prices the way the choices show them", () => {
    expect(modelPriceLabel("orchestrator", DEFAULT_ORCHESTRATOR_MODEL)).toBe("about $0.025 a turn");
    expect(modelPriceLabel("classifier", DEFAULT_CLASSIFIER_MODEL)).toBe("about $0.00015 a check");
    expect(modelPriceLabel("worker", DEFAULT_WORKER_MODEL)).toBe("about $0.75 a coding session");
    expect(modelPriceLabel("orchestrator", DEFAULT_ORCHESTRATOR_MODEL, "openrouter")).toBe(PRICE_NOT_ON_FILE);
  });
});

describe("the budget default", () => {
  it("FR-023: is the estimate plus 20%, rounded up to a whole $10", () => {
    expect(suggestedBudgetUsd(estimateMonthlyCost(DEFAULTS))).toBe(260);
    expect(suggestedBudgetUsd({ lines: [], totalUsd: 0, unpriced: [] })).toBe(10);
    expect(suggestedBudgetUsd({ lines: [], totalUsd: 100, unpriced: [] })).toBe(120);
  });

  it("an unpriced model is named, left out of the total, and noted in the budget help", () => {
    const estimate = estimateMonthlyCost({ ...DEFAULTS, worker: "us.amazon.nova-premier-v1:0" });
    expect(estimate.lines.at(-1)).toEqual({ item: "Coding model (us.amazon.nova-premier-v1:0)", usd: undefined, basis: "not priced: price not on file for us.amazon.nova-premier-v1:0" });
    expect(estimate.totalUsd).toBe(133.78);
    expect(suggestedBudgetUsd(estimate)).toBe(170);
    expect(budgetWhy(estimate)).toBe("AgentX's estimate is about $133.78 a month, not counting Coding model (us.amazon.nova-premier-v1:0), whose price is not on file. The suggested budget is the estimate plus 20%. AWS emails you when this month's costs pass 80% of it. 0 turns it off.");
  });
});
```

Add to `tests/contract/init-answers.test.ts` (in the describe that runs `collectInitAnswers` with
a scripted prompter; reuse its helper for a default first run):

```ts
  it("spec 048 FR-023: the budget's default is the estimate plus 20% for the whole account, with the estimate beside it", async () => {
    const asked: Array<{ question: string; defaultValue?: string; why?: string }> = [];
    const prompter = scriptedPrompter(["", "", "", "", "", "", "", "", "", "ops@example.com", "", "", "acme", "", "", "", ""]);
    const recording = { ...prompter, ask: (question: string, options: Parameters<typeof prompter.ask>[1]) => { asked.push({ question, ...(options.defaultValue === undefined ? {} : { defaultValue: options.defaultValue }), ...(options.help?.why === undefined ? {} : { why: options.help.why }) }); return prompter.ask(question, options); } };
    const collected = await collectInitAnswers({ env: "staging", region: "us-east-1", account: "123456789012", releaseVersion: "1.2.3", flags: {}, prompter: recording, processEnv: {}, now: () => 0 });
    expect(collected.answers.budget).toEqual({ monthlyUsd: 260, scope: "account" });
    expect(asked.find((entry) => entry.question.startsWith("Monthly AWS budget"))).toEqual({
      question: "Monthly AWS budget for this environment, in US dollars (0 for none)", defaultValue: "260",
      why: "AgentX's estimate is about $208.78 a month. The suggested budget is the estimate plus 20%. AWS emails you when this month's costs pass 80% of it. 0 turns it off.",
    });
    expect(collected.notes).not.toContain(BUDGET_TAG_NOTE);
  });
```

(The scripted answers are the default path's first-run questions in order, as `init-ui-cli.test.ts`'s
`FIRST_RUN` without its final confirm; import `BUDGET_TAG_NOTE` from `answers.js`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/contract/init-cost.test.ts tests/contract/init-answers.test.ts`
Expected: FAIL: `cost.js` does not exist; the budget default is still `100` with tag scope.

- [ ] **Step 3: Write minimal implementation**

Create `packages/cli/src/init/cost.ts` (header comment: what it is, and that it moved out of
`plan.ts` so `answers.ts` can price its choices without importing the plan; `import type { InitAnswers }
from "./install-state.js"` and `import type { ModelRole } from "./prerequisites.js"`). Move
`PRICES_CHECKED`, `HOURS_PER_MONTH`, the price comment block, `PRICES`, `ORCHESTRATOR_PER_TURN`,
`CLASSIFIER_PER_CHECK`, `ASSUMED_PRICES`, `STATED_USAGE`, `CostLine`, `CostEstimate`, `cents`,
`money` and `count` out of `plan.ts` unchanged, and export `PRICES_CHECKED`, `STATED_USAGE`,
`CostLine`, `CostEstimate`, `money` and `count` (plan.ts uses them). `WORKER_PER_SESSION` moves
with one new entry, then the rest is new:

```ts
/** About 200,000 input and 10,000 output tokens per session. Nova Pro: $0.8/1M input, $3.2/1M
 * output (AWS Bedrock pricing). Claude Sonnet 4.6 on Bedrock: $3/1M input and $15/1M output, the
 * same as Anthropic's list price, so $0.60 + $0.15 = $0.75 a session (spec 048 gap 16: the default
 * coding model had no price, so the plan left out its biggest cost). */
const WORKER_PER_SESSION: Record<string, number> = { "amazon.nova-pro-v1:0": 0.192, "us.anthropic.claude-sonnet-4-6": 0.75 };

const TABLES: Readonly<Record<ModelRole, Record<string, number>>> = { orchestrator: ORCHESTRATOR_PER_TURN, classifier: CLASSIFIER_PER_CHECK, worker: WORKER_PER_SESSION };
const UNIT: Readonly<Record<ModelRole, string>> = { orchestrator: "a turn", classifier: "a check", worker: "a coding session" };
/** FR-080: the plain names of the three models. */
export const ROLE_NAMES: Readonly<Record<ModelRole, string>> = { orchestrator: "Main model", classifier: "Safety check model", worker: "Coding model" };
export const MODEL_NAMES: Readonly<Record<string, string>> = {
  "us.anthropic.claude-sonnet-4-6": "Claude Sonnet 4.6", "zai.glm-4.7": "GLM 4.7", "amazon.nova-lite-v1:0": "Amazon Nova Lite",
  "us.anthropic.claude-haiku-4-5-20251001-v1:0": "Claude Haiku 4.5", "amazon.nova-pro-v1:0": "Amazon Nova Pro",
};
export const PRICE_NOT_ON_FILE = "price not on file";
export const modelName = (id: string): string => MODEL_NAMES[id] ?? id;

/** FR-024: a model's price as the choice that offers it shows it. */
export function modelPriceLabel(role: ModelRole, id: string, provider = "amazon-bedrock"): string {
  const each = provider === "openrouter" ? undefined : TABLES[role][id];
  return each === undefined ? PRICE_NOT_ON_FILE : `about $${each} ${UNIT[role]}`;
}

export function estimateMonthlyCost(models: InitAnswers["models"], usage = STATED_USAGE): CostEstimate {
  const unpriced: string[] = [];
  const priced = (item: string, usd: number, basis: string): CostLine => ({ item, usd: cents(usd) / 100, basis });
  const perUse = (role: ModelRole, uses: number, what: string): CostLine => {
    const id = models[role];
    const item = `${ROLE_NAMES[role]} (${modelName(id)})`;
    const each = models.providers?.[role] === "openrouter" ? undefined : TABLES[role][id];
    if (each === undefined) {
      unpriced.push(id);
      return { item, usd: undefined, basis: `not priced: ${PRICE_NOT_ON_FILE} for ${id}` };
    }
    const assumed = ASSUMED_PRICES.has(id) ? ", assumed: no confirmed Bedrock rate" : "";
    return priced(item, each * uses, `${count(uses)} ${what} at about $${each} each${assumed}`);
  };
  const lines: CostLine[] = [
    priced("Two NAT gateways", 2 * PRICES.natGatewayHour * HOURS_PER_MONTH, `2 x $${PRICES.natGatewayHour}/hour, plus $0.045 per GB processed`),
    priced("The Slack connection (Fargate, 0.5 vCPU, 1 GB, arm64)", (0.5 * PRICES.fargateArmVcpuHour + 1 * PRICES.fargateArmGbHour) * HOURS_PER_MONTH, "one task, always on"),
    priced("Coding machines (m6g.medium)", PRICES.m6gMediumHour * usage.workerInstanceHoursPerMonth, `${usage.workerInstanceHoursPerMonth} machine-hours at $${PRICES.m6gMediumHour}/hour`),
    priced(
      `Coding machine disks (${PRICES.ec2WorkerRootVolumeGiB} GiB gp3)`,
      usage.workerInstanceHoursPerMonth * PRICES.ec2WorkerRootVolumeGiB * (PRICES.gp3GbMonth / HOURS_PER_MONTH),
      `${usage.workerInstanceHoursPerMonth} machine-hours at ${PRICES.ec2WorkerRootVolumeGiB} GiB gp3 and $${PRICES.gp3GbMonth}/GB-month, the same usage as the coding machines above; each disk is deleted with its machine, unlike the kept workspaces below`,
    ),
    priced("Kept workspaces", usage.keptWorkspaces * PRICES.workspaceGiB * PRICES.gp3GbMonth, `${usage.keptWorkspaces} kept workspaces x ${PRICES.workspaceGiB} GiB gp3 at $${PRICES.gp3GbMonth}/GB-month`),
    priced("API Gateway, Lambda, DynamoDB, SQS, Secrets Manager, KMS and CloudWatch", PRICES.smallServicesMonth, "about, at this usage"),
    perUse("orchestrator", usage.turnsPerMonth, "turns"),
    perUse("classifier", usage.turnsPerMonth, "checks"),
    perUse("worker", usage.workerSessionsPerMonth, "coding sessions"),
  ];
  const totalCents = lines.reduce((sum, line) => sum + (line.usd === undefined ? 0 : cents(line.usd)), 0);
  return { lines, totalUsd: totalCents / 100, unpriced };
}

/** FR-023: the estimate plus 20%, rounded up to a whole $10 so it is easy to read, and at least $10.
 * Worked in cents, so a total such as $100.00 gives $120, not $130 from floating point. */
export function suggestedBudgetUsd(estimate: CostEstimate): number {
  return Math.max(10, Math.ceil(Math.round(estimate.totalUsd * 120) / 1000) * 10);
}

/** The lines the total leaves out because their price is not on file. */
export function notCounted(estimate: CostEstimate): string[] {
  return estimate.lines.filter((line) => line.usd === undefined).map((line) => line.item);
}

/** FR-023 and FR-024: the line beside the budget field. */
export function budgetWhy(estimate: CostEstimate): string {
  const missing = notCounted(estimate);
  const left = missing.length === 0 ? "" : `, not counting ${missing.join(" and ")}, whose price is not on file`;
  return `AgentX's estimate is about ${money(estimate.totalUsd)} a month${left}. The suggested budget is the estimate plus 20%. AWS emails you when this month's costs pass 80% of it. 0 turns it off.`;
}

```

`plan.ts` keeps `installPlanText` and `confirmInstallPlan`, imports what it needs from `./cost.js`,
and re-exports the moved names so existing imports keep working:

```ts
export { estimateMonthlyCost, STATED_USAGE, type CostEstimate, type CostLine } from "./cost.js";
```

and its text loses the internal words (the stacks, roles and secrets lines stay as they are):

```ts
  const provider = (role: "orchestrator" | "classifier" | "worker") => (answers.models.providers?.[role] === "openrouter" ? "OpenRouter" : "Amazon Bedrock");
  const engine = answers.engine === "templates" ? "published templates" : "AgentX's source code";
  // lines[0]:
    `AgentX will create the install ${env} in AWS account ${answers.account} (${answers.region}), from release ${answers.releaseVersion} with ${engine}:`,
  // the Models line:
    `- Models: main model ${modelName(answers.models.orchestrator)} (${provider("orchestrator")}), safety check model ${modelName(answers.models.classifier)} (${provider("classifier")}), coding model ${modelName(answers.models.worker)} (${provider("worker")})`,
  // the Alerts line ends: ", subscribed and tested at the end of the install"
  // the Slack messages line:
    `- AgentX never answers itself or other bots. Messages other apps post for people: ${answers.slack.appPostedMessages === "accept" ? "answered" : "ignored"}.`,
  // the cost lines and total:
    ...estimate.lines.map((line) => `  ${(line.usd === undefined ? "not priced" : money(line.usd)).padStart(10)}  ${line.item} (${line.basis})`),
    `Estimated monthly total: ${money(estimate.totalUsd)} at ${count(STATED_USAGE.turnsPerMonth)} turns, ${count(STATED_USAGE.workerSessionsPerMonth)} coding sessions and ${STATED_USAGE.workerInstanceHoursPerMonth} machine-hours a month (us-east-1 list prices, ${PRICES_CHECKED}; your bill will differ)${notCounted(estimate).length > 0 ? `, not counting ${notCounted(estimate).join(" and ")}, whose price is not on file` : ""}.`,
  // the last line:
    "To remove everything later, use the remove command on the ready screen. It deletes the coding machines' disks too.",
```

(`plan.ts` imports `count`, `money`, `modelName`, `notCounted`, `PRICES_CHECKED` and `STATED_USAGE` from `./cost.js`.)

In `answers.ts`, the choice labels read their prices from `cost.ts`, and the budget question gets
its default and its help from the estimate of the models just chosen:

```ts
import { budgetWhy, estimateMonthlyCost, modelPriceLabel, suggestedBudgetUsd } from "./cost.js";

export const ORCHESTRATOR_MODEL_CHOICES: ReadonlyArray<{ value: string; label: string }> = [
  { value: DEFAULT_ORCHESTRATOR_MODEL, label: `Claude Sonnet 4.6 (recommended; ${modelPriceLabel("orchestrator", DEFAULT_ORCHESTRATOR_MODEL)})` },
  { value: GLM, label: `GLM 4.7 (lower cost; ${modelPriceLabel("orchestrator", GLM)})` },
];
export const CLASSIFIER_MODEL_CHOICES: ReadonlyArray<{ value: string; label: string }> = [
  { value: DEFAULT_CLASSIFIER_MODEL, label: `Amazon Nova Lite (recommended; ${modelPriceLabel("classifier", DEFAULT_CLASSIFIER_MODEL)})` },
  { value: HAIKU, label: `Claude Haiku 4.5 (${modelPriceLabel("classifier", HAIKU)}; needs a one-time Anthropic form in Bedrock)` },
];

// in collectInitAnswers, the budget:
  const estimate = estimateMonthlyCost(platform.models);
  const suggested = suggestedBudgetUsd(estimate);
  const rawBudget = flags.budget ?? (await prompter.ask("Monthly AWS budget for this environment, in US dollars (0 for none)", {
    flag: budgetFlag, defaultValue: String(suggested),
    validate: budgetProblem,
    help: { why: budgetWhy(estimate), example: String(suggested) },
  }));
  // ...
    const scope = flags.budgetScope ?? (await prompter.choose<"tag" | "account">("Which costs should the budget count?", [
      { value: "account", label: "The whole account (recommended)" },
      { value: "tag", label: "Only this environment's (tagged agentx:env; the tag must be activated in Billing)" },
    ], { flag: "--budget-scope", defaultValue: "account" }));
```

Note: `"Only this environment's (tagged agentx:env; ...)"` is the terminal's label; the page shows
the catalog's `choiceLabels`. The worker question passes
`help: { defaultText: `Claude Sonnet 4.6 (${modelPriceLabel("worker", DEFAULT_WORKER_MODEL)})` }` when
its default is `DEFAULT_WORKER_MODEL`.

- [ ] **Step 4: Update the expectations this changes, with new exact values**

- `init-plan.test.ts`: the cost lines' items and bases (the new names above, same numbers for
  `sampleAnswers()`), the plan text assertions (the new first line, Models line, Slack messages
  line and last line), and the "n/a" column (now "not priced"). The totals do not change.
- `init-answers.test.ts`, `init-cli.test.ts`, `init-ui-cli.test.ts` and `tests/support/setup-fakes.ts`
  or `init-fakes.ts`: a default run's budget is now `{ monthlyUsd: 260, scope: "account" }` and
  adds no `BUDGET_TAG_NOTE`. Where a fake budget is hard-coded at 100 for a default run (the
  harness's `fakeAlerts({ budgetUsd: 100 })`), set it to `suggestedBudgetUsd(estimateMonthlyCost(DEFAULTS))`
  imported from `cost.ts`, so the number has one source. Runs that pass `--budget` keep their value.
- The classifier choice labels, wherever a test asserts them by value.

- [ ] **Step 5: Run the suites**

Run: `npx vitest run tests/contract/init-cost.test.ts tests/contract/init-plan.test.ts tests/contract/init-answers.test.ts tests/contract/init-cli.test.ts tests/contract/init-ui-cli.test.ts tests/contract/init-finish-steps.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/init/cost.ts packages/cli/src/init/plan.ts packages/cli/src/init/answers.ts tests
git commit -m "feat(init): price every model, suggest a budget of the estimate plus 20% for the account, plain plan words (048 FR-023, FR-024, FR-082)"
```

---

### Task 10: One name for both apps, with the install name in it (FR-026)

**Files:**
- Modify: `packages/cli/src/init/answers.ts:220-226` (the two app name defaults; new `defaultAppName`)
- Test: `tests/contract/init-answers.test.ts`, `tests/contract/init-slack-app.test.ts`

**Interfaces:**
- Consumes: Task 7's `botNameOf`.
- Produces: `GITHUB_APP_NAME_LIMIT = 34`, `defaultAppName(input: { owner: string; env: string }): string`.

Before Step 3, check GitHub's "Registering a GitHub App" documentation for the characters an app
name may hold. The design uses parentheses ("AgentX (production)"). If GitHub refuses them, use
`AgentX <owner> <install name>` and `AgentX <install name>` instead, change the test's expected
values to match, and say so in the PR description.

- [ ] **Step 1: Write the failing tests**

Add to `tests/contract/init-answers.test.ts`:

```ts
describe("spec 048 FR-026: app names", () => {
  it("names both apps AgentX <owner> (<install name>)", () => {
    expect(defaultAppName({ owner: "acme", env: "staging" })).toBe("AgentX acme (staging)");
  });

  it("the longest owner and install name still fit, and both apps match", async () => {
    const owner = "a".repeat(39);
    const env = "abcdefghij-klmnopqrs";
    expect(env.length).toBe(20);
    const name = defaultAppName({ owner, env });
    expect(name).toBe("AgentX (abcdefghij-klmnopqrs)");
    expect(name.length).toBeLessThanOrEqual(GITHUB_APP_NAME_LIMIT);

    const prompter = scriptedPrompter(["", "", "", "", "", "", "", "", "", "ops@example.com", "", "", owner, "", "", "", ""]);
    const collected = await collectInitAnswers({ env, region: "us-east-1", account: "123456789012", releaseVersion: "1.2.3", flags: {}, prompter, processEnv: {}, now: () => 0 });
    expect(collected.answers.github.appName).toBe(name);
    expect(collected.answers.slack.appName).toBe(name);
  });

  it("the Slack name follows a GitHub name the user typed", async () => {
    const prompter = scriptedPrompter(["", "", "", "", "", "", "", "", "", "ops@example.com", "", "", "acme", "", "Our AgentX", "", ""]);
    const collected = await collectInitAnswers({ env: "staging", region: "us-east-1", account: "123456789012", releaseVersion: "1.2.3", flags: {}, prompter, processEnv: {}, now: () => 0 });
    expect(collected.answers.slack.appName).toBe("Our AgentX");
  });
});
```

Add to `tests/contract/init-slack-app.test.ts`:

```ts
  it("spec 048 FR-026: uses the bot handle Slack assigned from then on", () => {
    const progress = { ...emptyProgress("staging", 0), slack: { appId: "A0APP", teamId: "T0TEAM", botUserId: "U0BOT", botName: "agentx-acme-staging2" } };
    expect(botNameOf(progress, "AgentX acme (staging)")).toBe("agentx-acme-staging2");
    expect(botNameOf(emptyProgress("staging", 0), "AgentX acme (staging)")).toBe("agentx-acme-staging");
  });
```

(Imports: `defaultAppName`, `GITHUB_APP_NAME_LIMIT` from `answers.js`; `botNameOf` from
`slack-app.js`; `emptyProgress` from `install-state.js`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/contract/init-answers.test.ts tests/contract/init-slack-app.test.ts`
Expected: FAIL: `defaultAppName` is not exported; the Slack default is still "AgentX".

- [ ] **Step 3: Write minimal implementation**

```ts
export const GITHUB_APP_NAME_LIMIT = 34;

/** Spec 048 FR-026: one default name for the GitHub app and the Slack app, with the install name in
 * it. GitHub app names are unique across GitHub, so the owner is in it too; when that is longer
 * than GitHub's 34 characters, the owner is dropped at its word boundary. "AgentX (<install name>)"
 * always fits: install names are at most 20 characters. */
export function defaultAppName(input: { owner: string; env: string }): string {
  const full = `AgentX ${input.owner} (${input.env})`;
  return full.length <= GITHUB_APP_NAME_LIMIT ? full : `AgentX (${input.env})`;
}

// in collectInitAnswers:
  const appName = flags.githubAppName ?? (await prompter.ask("GitHub App name (must be unique on GitHub)", {
    flag: "--github-app-name", defaultValue: defaultAppName({ owner: githubAccount, env: input.env }),
    validate: (value) => (value.length <= GITHUB_APP_NAME_LIMIT ? undefined : `must be at most ${GITHUB_APP_NAME_LIMIT} characters`),
  }));
  const slackAppName = flags.slackAppName ?? (await prompter.ask("Slack app name", {
    flag: "--slack-app-name", defaultValue: appName, validate: (value) => (value.length <= 35 ? undefined : "must be at most 35 characters"),
  }));
```

- [ ] **Step 4: Update the old default names in the tests, with new exact values**

`grep -rn '"AgentX acme staging"\|appName: "AgentX"\|AgentX \${' tests` lists the expectations of a
default run's names. Each becomes `"AgentX acme (staging)"` (or `defaultAppName(...)` of its own
owner and install name). A test that passes `--github-app-name` or `--slack-app-name` keeps its value.

- [ ] **Step 5: Run the suites, then commit**

Run: `npx vitest run tests/contract/init-answers.test.ts tests/contract/init-slack-app.test.ts tests/contract/init-cli.test.ts tests/contract/init-ui-cli.test.ts tests/contract/init-github-app.test.ts`
Expected: PASS.

```bash
git add packages/cli/src/init/answers.ts tests
git commit -m "feat(init): one default name for the GitHub and Slack apps, with the install name in it (048 FR-026)"
```

---

### Task 11: The release's images are checked before anything is created, in page words (FR-065 image check, SC-009)

**Files:**
- Modify: `packages/cli/src/init/prerequisites.ts` (`PrerequisiteCheck.technical`; new `releaseImageChecks`; `checkPrerequisites` gains `images` and `audience`)
- Modify: `packages/cli/src/init/commands.ts:531-554` (`runPrerequisites` passes both)
- Test: `tests/contract/init-prerequisites.test.ts`, `tests/contract/init-ui-cli.test.ts`

**Interfaces:**
- Consumes: Task 7's `prerequisitesCard` (shows `technical` in its details).
- Produces:
  - `PrerequisiteCheck` gains `technical?: string`
  - `type CheckAudience = "page" | "terminal"`, `interface ReleaseImages { worker?: string; slack?: string }`
  - `releaseImageChecks(input: { version: string; images: ReleaseImages; overrides?: ReleaseImages; audience: CheckAudience }): PrerequisiteCheck[]`
  - `checkPrerequisites` input gains `images?: ReleaseImages; audience?: CheckAudience` (default `"terminal"`: the terminal's problems are exactly as before)

- [ ] **Step 1: Write the failing tests**

Add to `tests/contract/init-prerequisites.test.ts`:

```ts
const PUBLIC = `public.ecr.aws/agentx/worker@sha256:${"a".repeat(64)}`;
const PRIVATE = `123456789012.dkr.ecr.us-east-1.amazonaws.com/agentx/worker@sha256:${"a".repeat(64)}`;
const SLACK = `public.ecr.aws/agentx/slack@sha256:${"b".repeat(64)}`;

describe("spec 048 FR-065: the release's images", () => {
  it("passes images AWS can pull through the image cache", () => {
    expect(releaseImageChecks({ version: "1.2.3", images: { worker: PUBLIC, slack: SLACK }, audience: "page" }).map((check) => [check.label, check.ok])).toEqual([
      ["The coding image", true], ["The Slack connection image", true],
    ]);
  });

  it("refuses an image that is not on Amazon ECR Public, in page words on the page and with the flag in the terminal", () => {
    const [page] = releaseImageChecks({ version: "1.2.3", images: { worker: PRIVATE, slack: SLACK }, audience: "page" });
    expect(page).toEqual({
      label: "The coding image", ok: false,
      detail: "This release's coding image is not on Amazon ECR Public, so AWS cannot pull it. Use a published AgentX release, or start the install again with an image address AWS can reach.",
      technical: PRIVATE,
    });
    const [terminal] = releaseImageChecks({ version: "1.2.3", images: { worker: PRIVATE, slack: SLACK }, audience: "terminal" });
    expect(terminal?.detail).toBe(`release 1.2.3's worker image ${PRIVATE} is not a public.ecr.aws/ reference, so the install would fail after about 15 minutes; use a published release, or pass --worker-image <repository@sha256:...> with an image AWS can pull`);
  });

  it("refuses an image not pinned to a digest, and accepts one the answers name instead", () => {
    const [unpinned] = releaseImageChecks({ version: "1.2.3", images: { worker: "public.ecr.aws/agentx/worker:latest", slack: SLACK }, audience: "page" });
    expect(unpinned?.ok).toBe(false);
    const [overridden] = releaseImageChecks({ version: "1.2.3", images: { worker: PRIVATE, slack: SLACK }, overrides: { worker: PRIVATE }, audience: "page" });
    expect(overridden).toMatchObject({ ok: true, detail: "uses the image address you gave" });
  });

  it("SC-009: checkPrerequisites reports a private image with every other problem, before anything is created", async () => {
    const found: PrerequisiteCheck[] = [];
    await expect(checkPrerequisites({
      answers: sampleAnswers(), release: { manifest: { version: "1.2.3" }, regions: () => ["us-east-1"] }, caller: { account: "123456789012", arn: HOLDER },
      checks: passingChecks(), prompter: scriptedPrompter([]), write: () => undefined, images: { worker: PRIVATE, slack: SLACK }, onCheck: (check) => found.push(check),
    })).rejects.toThrow(`init cannot start; nothing was created:\n- release 1.2.3's worker image ${PRIVATE} is not a public.ecr.aws/ reference`);
    expect(found.find((check) => check.label === "The coding image")?.ok).toBe(false);
  });

  it("on the page, a model problem says what to do on the page, not which flag to pass", async () => {
    const checks = { ...passingChecks(), converse: async () => { throw Object.assign(new Error("model identifier is invalid"), { name: "ValidationException" }); } };
    const error = await checkPrerequisites({
      answers: sampleAnswers(), release: { manifest: { version: "1.2.3" }, regions: () => ["us-east-1"] }, caller: { account: "123456789012", arn: HOLDER },
      checks, prompter: scriptedPrompter([]), write: () => undefined, audience: "page",
    }).catch((caught: unknown) => caught as Error);
    expect(error.message).not.toMatch(/--[a-z]/);
    expect(error.message).toContain("or choose another with the model question");
  });
});
```

(Merge imports: `checkPrerequisites`, `releaseImageChecks`, `type PrerequisiteCheck` from
`prerequisites.js`; `HOLDER`, `passingChecks`, `sampleAnswers`, `scriptedPrompter` from
`../support/init-fakes.js`.)

Add to `tests/contract/init-ui-cli.test.ts` (expose `release` from `harness()`'s returned object first):

```ts
  it("spec 048 SC-009: a release with a private image is refused on the page before anything is created", async () => {
    const h = await harness();
    const manifest = JSON.parse(await readFile(join(h.release, "release.json"), "utf8")) as { images: Record<string, string> };
    manifest.images.worker = `123456789012.dkr.ecr.us-east-1.amazonaws.com/agentx/worker@sha256:${"a".repeat(64)}`;
    await writeFile(join(h.release, "release.json"), JSON.stringify(manifest));
    const { code, operator } = await h.runUi([...FIRST_RUN.slice(0, -1), false]);
    expect(code).not.toBe(0);
    const card = operator.states.flatMap((state) => state.cards ?? []).filter((shown) => shown.id === "prerequisites").at(-1);
    expect(card?.checks?.find((check) => check.label === "The coding image")).toMatchObject({ ok: false });
    expect(h.deployer.requests).toEqual([]);
    expect(h.store.values.has(installAnswersParameterName("staging"))).toBe(false);
  });
```

(The last scripted answer is `false` for "Check the prerequisites again?": Stop for now. The
release's `sha256` entries cover templates only, so editing `images` keeps it loadable; if
`loadRelease` checks the manifest's own hash, rebuild it with `releaseDir()` taking an `images`
override instead.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/contract/init-prerequisites.test.ts tests/contract/init-ui-cli.test.ts -t "image|model problem"`
Expected: FAIL: `releaseImageChecks` is not exported, and the private image passes every check.

- [ ] **Step 3: Write minimal implementation**

In `prerequisites.ts`:

```ts
/** One prerequisite's result. `technical` (an image address, a CLI command) goes to the card's details. */
export interface PrerequisiteCheck { label: string; ok: boolean; detail: string; technical?: string }

export type CheckAudience = "page" | "terminal";
export interface ReleaseImages { worker?: string; slack?: string }

const IMAGE_WORDS = { worker: "coding", slack: "Slack connection" } as const;
const IMAGE_FLAGS = { worker: "--worker-image", slack: "--slack-image" } as const;

/** Spec 048 FR-065 and SC-009: each image the release deploys must be one AWS pulls through this
 * install's image cache (public.ecr.aws, pinned to a digest), unless the answers name their own.
 * The live check of 2026-10-01 met this only 15 minutes into the build. */
export function releaseImageChecks(input: { version: string; images: ReleaseImages; overrides?: ReleaseImages; audience: CheckAudience }): PrerequisiteCheck[] {
  return (["worker", "slack"] as const).map((which): PrerequisiteCheck => {
    const label = `The ${IMAGE_WORDS[which]} image`;
    const override = input.overrides?.[which];
    if (override !== undefined) return { label, ok: true, detail: "uses the image address you gave", technical: override };
    const ref = input.images[which];
    const problem = ref === undefined ? "missing" : !ref.startsWith("public.ecr.aws/") ? "not-public" : !/@sha256:[a-f0-9]{64}$/.test(ref) ? "not-pinned" : undefined;
    if (problem === undefined) return { label, ok: true, detail: "AWS can pull it", ...(ref === undefined ? {} : { technical: ref }) };
    const words = IMAGE_WORDS[which];
    const flag = `${IMAGE_FLAGS[which]} <repository@sha256:...>`;
    const detail = input.audience === "page"
      ? {
        missing: `This release has no ${words} image. Use a published AgentX release.`,
        "not-public": `This release's ${words} image is not on Amazon ECR Public, so AWS cannot pull it. Use a published AgentX release, or start the install again with an image address AWS can reach.`,
        "not-pinned": `This release's ${words} image is not pinned to one exact version, so AWS cannot pull it safely. Use a published AgentX release.`,
      }[problem]
      : {
        missing: `release ${input.version} has no ${which} image digest; use a published release, or pass ${flag}`,
        "not-public": `release ${input.version}'s ${which} image ${ref ?? ""} is not a public.ecr.aws/ reference, so the install would fail after about 15 minutes; use a published release, or pass ${flag} with an image AWS can pull`,
        "not-pinned": `release ${input.version}'s ${which} image ${ref ?? ""} is not pinned to a digest; use a published release, or pass ${flag}`,
      }[problem];
    return { label, ok: false, detail, ...(ref === undefined ? {} : { technical: ref }) };
  });
}

/** How a model problem reads on the page: what to do there, not a flag. */
const pageWording = (): ModelProblemWording => ({ changeModel: "the model question", rerun: "choose Check again", region: "start again in another region" });
```

In `checkPrerequisites`: add `images?: ReleaseImages; audience?: CheckAudience` to the input; set
`const audience = input.audience ?? "terminal";`; let `failed` take an optional third argument
`technical` and pass it to `onCheck`; right after the region check, add:

```ts
  if (input.images !== undefined) {
    for (const check of releaseImageChecks({ version: input.release.manifest.version, images: input.images, ...(answers.images === undefined ? {} : { overrides: answers.images }), audience })) {
      if (check.ok) input.onCheck?.(check);
      else failed(check.label, check.detail, check.technical);
    }
  }
```

Every `modelCheckProblem({ ... })` call passes `...(audience === "page" ? { wording: pageWording() } : {})`.
The Elastic IP failure, on the page, reads
`this install needs ${NAT_ELASTIC_IPS} Elastic IPs for its network, but ${allocated} of the ${quota} allowed in ${region} are already in use. Release addresses you no longer use, or ask AWS for more EC2-VPC Elastic IPs in Service Quotas.`
with the `aws service-quotas request-service-quota-increase ...` command as its `technical`;
the terminal keeps today's text. The OIDC problems, on the page, replace a trailing
`; check --oidc-issuer` with `; check the sign-in issuer address`. The cdk bootstrap refusal, on the
page, reads `This region is not prepared for deploying from source code. Prepare it, or deploy with published templates, which need no preparation.`

In `commands.ts`'s `runPrerequisites`, pass `images: release.manifest.images` and
`audience: surface === undefined ? "terminal" : "page"` to `checkPrerequisites`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/contract/init-prerequisites.test.ts tests/contract/init-ui-cli.test.ts tests/contract/init-cli.test.ts`
Expected: PASS. Existing prerequisite tests run with the default `"terminal"` audience and no
`images`, so their expected problems do not change.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/init/prerequisites.ts packages/cli/src/init/commands.ts tests/contract
git commit -m "feat(init): check the release's images before anything is created; page words for prerequisite problems (048 FR-065, SC-009)"
```

---
### Task 12: A failure is a screen, with "Try this step again" for deploy steps (FR-060)

**Files:**
- Create: `packages/cli/src/init/ui/failure.ts`
- Create: `packages/cli/src/init/cli-command.ts`
- Modify: `packages/cli/src/init/steps.ts:48-104` (`runInitSteps` gains `onStepFailure`)
- Modify: `packages/cli/src/init/retry.ts:31` (saying no to "check again" is the person's own stop)
- Modify: `packages/cli/src/init/ui/index.ts` (`InstallWizard` gains `setStage`, `setPlace`, `showFailure`, `clearFailure`, `closeRequested`, `token`, `logPath?`)
- Modify: `packages/cli/src/init/commands.ts` (`InitCliDependencies.cliInvocation?`, the session, `runInit`'s catch, `onStepFailure`, `setStage`, `setPlace`)
- Test: `tests/contract/init-ui-failure.test.ts` (new), `tests/contract/init-cli-command.test.ts` (new), `tests/contract/init-steps.test.ts`, `tests/contract/init-ui-cli.test.ts`

**Interfaces:**
- Consumes: Task 3's `showFailure`, `clearFailure`, `finish(outcome, phase, commands)`, `step-failed`; Task 4's `buttons` help; Task 8's `isOperatorStop`, `markOperatorStop`.
- Produces:
  - `runInitSteps` input `onStepFailure?: (failure: { id: InitStepId; title: string; error: unknown }) => Promise<"retry" | "stop">`; it emits `step-failed` before asking, and `step-started` again on a retry
  - `type FailureAction = "retry" | "stop"`, `FAILURE_TITLE = "The install stopped"`, `isRetryableStep(id): boolean`
  - `plainReason(error: unknown): string | undefined`
  - `failureScreen(input: { env: string; region: string; stepTitle?: string; stepId?: InitStepId; error: unknown; logPath?: string }): WizardFailure`
  - `askFailureAction(prompter: Prompter, input: { retry: boolean }): Promise<FailureAction>` (asks "The install stopped. What next?", flag `--on-failure`; a prompter that throws counts as "stop")
  - `STOPPED_OUTCOME = "The install stopped. Your progress is saved."`
  - `interface CliInvocation { published: boolean; version?: string; cliPath: string }`, `currentCliInvocation(argv1?: string, version?: string): CliInvocation`, `cliCommandLine(invocation: CliInvocation, args: string): string`
  - `InitCliDependencies.cliInvocation?: CliInvocation` (tests pin it; the real one is `currentCliInvocation()`)

- [ ] **Step 1: Write the failing tests**

```ts
// tests/contract/init-cli-command.test.ts
// Issue #222: a command on the page works as shown. The published package is named only when this
// CLI runs from it; a build from source is shown by its own path.
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cliCommandLine, currentCliInvocation } from "../../packages/cli/src/init/cli-command.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe("the command a person can run", () => {
  it("names the published package, at this version, when the CLI runs from it, even through npx's bin link", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentx-cli-")); dirs.push(dir);
    const main = join(dir, "node_modules", "@charterarc", "agentx", "dist", "main.js");
    await mkdir(join(dir, "node_modules", "@charterarc", "agentx", "dist"), { recursive: true });
    await mkdir(join(dir, "node_modules", ".bin"), { recursive: true });
    await writeFile(main, "");
    await symlink(main, join(dir, "node_modules", ".bin", "agentx"));
    const invocation = currentCliInvocation(join(dir, "node_modules", ".bin", "agentx"), "1.2.3");
    expect(invocation.published).toBe(true);
    expect(cliCommandLine(invocation, "login https://abc.example.com")).toBe("npx @charterarc/agentx@1.2.3 login https://abc.example.com");
  });

  it("shows a build from source by its own path, quoted when it has a space", () => {
    expect(cliCommandLine({ published: false, cliPath: "/opt/agentx/dist/main.js" }, "--env staging doctor")).toBe("node /opt/agentx/dist/main.js --env staging doctor");
    expect(cliCommandLine({ published: false, cliPath: "/Users/a b/agentx/dist/main.js" }, "login https://x")).toBe('node "/Users/a b/agentx/dist/main.js" login https://x');
    expect(currentCliInvocation("/opt/agentx/packages/cli/dist/main.js", undefined).published).toBe(false);
  });
});
```

```ts
// tests/contract/init-ui-failure.test.ts
// Spec 048 FR-060: what a failure screen says, kept in plain words, with raw messages, codes and
// stack names in the technical details.
import { describe, expect, it } from "vitest";
import { agentXError } from "@agentx/contracts";
import { askFailureAction, failureScreen, plainReason } from "../../packages/cli/src/init/ui/failure.js";
import { scriptedPrompter } from "../support/init-fakes.js";

describe("the failure screen", () => {
  it("says what happened in plain words, what to do, and keeps the raw message and the stacks in the details", () => {
    const screen = failureScreen({ env: "staging", region: "us-east-1", stepTitle: "Start the AgentX service", stepId: "control-plane", error: new Error("Resource limit exceeded"), logPath: "/home/a/.agentx/logs/init-staging.log" });
    expect(screen).toEqual({
      title: "The install stopped",
      what: "Start the AgentX service did not finish. Resource limit exceeded.",
      next: "Nothing is lost: the steps that finished are kept. Try this step again, or stop for now and continue later.",
      details: ["Resource limit exceeded", "Stack: agentx-staging-control-plane", "Stack: agentx-staging-runtime", "Log file: /home/a/.agentx/logs/init-staging.log"],
      link: { url: "https://us-east-1.console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks?filteringText=agentx-staging-", label: "Open the stacks in the AWS console" },
    });
  });

  it("keeps error codes, ARNs and flags out of what happened", () => {
    expect(plainReason(agentXError("INTERNAL_ERROR", "image x is not a public.ecr.aws/ reference"))).toBe("Image x is not a public.ecr.aws/ reference.");
    expect(plainReason(new Error("AccessDenied for arn:aws:iam::123456789012:role/x"))).toBeUndefined();
    expect(plainReason(new Error("--account 1 does not match"))).toBeUndefined();
    expect(failureScreen({ env: "staging", region: "us-east-1", error: new Error("--account 1 does not match") })).toMatchObject({
      what: "The install could not go on.", next: "Your progress is saved. Stop for now and continue later.", details: ["--account 1 does not match"],
    });
  });

  it("offers Try this step again only for a step that can run again in place, and stops when no one answers", async () => {
    await expect(askFailureAction(scriptedPrompter(["retry"]), { retry: true })).resolves.toBe("retry");
    await expect(askFailureAction(scriptedPrompter([]), { retry: true })).resolves.toBe("stop");
    await expect(askFailureAction(scriptedPrompter(["retry"]), { retry: false })).resolves.toBe("stop");
  });
});
```

(`askFailureAction(scriptedPrompter(["retry"]), { retry: false })`: "retry" is not a choice, so the
scripted prompter throws and the answer is "stop".)

Add to `tests/contract/init-steps.test.ts` (reuse the file's existing in-memory store and step helpers):

```ts
  it("spec 048 FR-060: a failed step is reported, then run again when onStepFailure says retry", async () => {
    let runs = 0;
    const events: string[] = [];
    const flaky: InitStep<null> = { id: "access", title: "Set up AWS permissions", run: async () => { runs += 1; if (runs === 1) throw new Error("Rate exceeded"); return { status: "done" }; } };
    const result = await runInitSteps({
      env: "staging", region: "us-east-1", store: new MemoryParameterStore(), holder: HOLDER, steps: [flaky], context: null,
      onEvent: (event) => events.push(`${event.kind} ${event.id}`),
      onStepFailure: async ({ id, error }) => { events.push(`asked ${id} ${(error as Error).message}`); return "retry"; },
    });
    expect(result).toMatchObject({ status: "complete", ran: ["access"] });
    expect(events).toEqual(["step-started access", "step-failed access", "asked access Rate exceeded", "step-started access", "step-done access"]);
  });

  it("spec 048 FR-060: stop throws the same error the run always threw", async () => {
    const failing: InitStep<null> = { id: "access", title: "Set up AWS permissions", run: async () => { throw new Error("Rate exceeded"); } };
    await expect(runInitSteps({ env: "staging", region: "us-east-1", store: new MemoryParameterStore(), holder: HOLDER, steps: [failing], context: null, onStepFailure: async () => "stop" }))
      .rejects.toThrow('init stopped at "Set up AWS permissions": Rate exceeded. Run agentx init --env staging --region us-east-1 again to continue from this step.');
  });
```

Add to `tests/contract/init-ui-cli.test.ts` (and add `cliInvocation: { published: false, cliPath: "/opt/agentx/dist/main.js" }`
to the harness's `base` dependencies):

```ts
  it("spec 048 FR-060: a failed deploy step stays on the page, and Try this step again finishes the install", async () => {
    const h = await harness();
    h.deployer.fail.set(environmentStackName("staging", "control-plane"), new Error("Resource limit exceeded"));
    let reconnected: WizardSnapshot | undefined;
    const operator = fakeWizardOperator([...FIRST_RUN, "retry", ...SLACK, ...SIGNIN, ...FINISH], {
      beforeAnswer: async (question, wizardUrl) => {
        if (question.text !== "The install stopped. What next?") return;
        reconnected = await snapshotOnReconnect(wizardUrl);
        h.deployer.fail.clear();
      },
    });
    expect(await h.run(["--ui"], { openBrowser: operator.open })).toBe(0);
    await operator.settled();
    expect(operator.remaining()).toBe(0);
    expect(h.deployer.requests.filter((request) => request.part === "control-plane")).toHaveLength(2);
    expect(operator.states.at(-1)?.failure).toBeUndefined();
  });

  it("a page that reconnects during a failure gets the failure screen back", async () => {
    const h = await harness();
    h.deployer.fail.set(environmentStackName("staging", "control-plane"), new Error("Resource limit exceeded"));
    let reconnected: WizardSnapshot | undefined;
    const operator = fakeWizardOperator([...FIRST_RUN, "stop"], {
      beforeAnswer: async (question, wizardUrl) => { if (question.text === "The install stopped. What next?") reconnected = await snapshotOnReconnect(wizardUrl); },
    });
    expect(await h.run(["--ui"], { openBrowser: operator.open })).not.toBe(0);
    await operator.settled();
    expect(reconnected?.failure?.what).toBe("Start the AgentX service did not finish. Resource limit exceeded.");
    expect(reconnected?.question?.buttons?.map((button) => button.label)).toEqual(["Try this step again", "Stop for now"]);
    expect(reconnected?.steps.find((step) => step.id === "control-plane")?.status).toBe("failed");
    expect(reconnected?.journey.phases[2]).toMatchObject({ statusWord: "Stopped" });
    const last = operator.states.at(-1);
    expect(last).toMatchObject({ phase: "failed", outcome: "The install stopped. Your progress is saved." });
    expect(last?.commands).toEqual([{ label: "Continue later with", command: "node /opt/agentx/dist/main.js --env staging init --region us-east-1" }]);
    expect(`${last?.outcome ?? ""} ${last?.failure?.what ?? ""}`).not.toMatch(/Finished|INTERNAL_ERROR|CONFIG_INVALID/);
  });

  it("spec 048 FR-060: a failure outside a step still shows the screen, with Stop for now only", async () => {
    const h = await harness();
    const operator = fakeWizardOperator(["stop"]);
    expect(await h.run(["--ui", "--account", "999999999999"], { openBrowser: operator.open })).not.toBe(0);
    await operator.settled();
    const failing = operator.states.find((state) => state.failure !== undefined);
    expect(failing?.failure?.what).toBe("The install could not go on.");
    expect(failing?.failure?.details[0]).toContain("--account 999999999999 does not match your AWS credentials");
    expect(failing?.question?.buttons?.map((button) => button.label)).toEqual(["Stop for now"]);
  });
```

(Import `WizardSnapshot` from `../../packages/cli/src/init/ui/protocol.js`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/contract/init-cli-command.test.ts tests/contract/init-ui-failure.test.ts tests/contract/init-steps.test.ts tests/contract/init-ui-cli.test.ts`
Expected: FAIL: the two modules do not exist, `onStepFailure` is ignored, and the page run ends on the first failure.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/cli/src/init/cli-command.ts
// Issue #222 and spec 048 FR-059 and FR-061: a command shown on the page works as shown. The
// published package is named only when this CLI runs from it; a CLI built from source is shown by
// its own path.
import { realpathSync } from "node:fs";
import { RELEASE_VERSION } from "../version.js";

export interface CliInvocation { published: boolean; version?: string; cliPath: string }

const resolved = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

export function currentCliInvocation(argv1: string = process.argv[1] ?? "agentx", version: string | undefined = RELEASE_VERSION): CliInvocation {
  const cliPath = resolved(argv1);
  const published = version !== undefined && /[\\/]node_modules[\\/]@charterarc[\\/]agentx[\\/]/.test(cliPath);
  return { published, ...(version === undefined ? {} : { version }), cliPath };
}

const quoted = (path: string): string => (/^[A-Za-z0-9_./:@-]+$/.test(path) ? path : `"${path.replaceAll('"', '\\"')}"`);

export function cliCommandLine(invocation: CliInvocation, args: string): string {
  return invocation.published && invocation.version !== undefined
    ? `npx @charterarc/agentx@${invocation.version} ${args}`
    : `node ${quoted(invocation.cliPath)} ${args}`;
}
```

```ts
// packages/cli/src/init/ui/failure.ts
// Spec 048 FR-060 (and the first action of FR-061): a failure is a screen, not the end of the page.
// What happened in plain words, what to do as page actions, and the technical details collapsed.
// Phase 3 adds the other kinds of failure and their actions here.
import { environmentStackName } from "@agentx/contracts";
import { cliErrorFor } from "../../deploy/commands.js";
import { DEPLOY_STEP_PARTS, type DeployStepId } from "../deploy-steps.js";
import type { InitStepId } from "../install-state.js";
import { messageWithoutCode, type Prompter } from "../prompts.js";
import { onPageProblem } from "./cards.js";
import type { WizardFailure } from "./protocol.js";

export type FailureAction = "retry" | "stop";
export const FAILURE_TITLE = "The install stopped";
export const STOPPED_OUTCOME = "The install stopped. Your progress is saved.";

/** A deploy step can run again in place: its stacks are created or updated where they stand. */
export const isRetryableStep = (id: InitStepId): id is DeployStepId => Object.hasOwn(DEPLOY_STEP_PARTS, id);

/** Words that belong in technical details only (FR-060, FR-081). */
const TECHNICAL = /arn:aws|\b[A-Z]{2,}_[A-Z_]{2,}\b|AWS::|(?:^|\s)--[a-z]|<[@#!]|\b[A-Z][a-z]+(?:[A-Z][a-z]+)*[0-9A-F]{8}\b/;
const RESUME_TAIL = /\.? Run agentx init --env \S+ --region \S+ again to continue from this step\..*$/s;

const capitalize = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

/** The error's first line as a plain sentence for "what happened", or undefined when it carries a
 * code, an ARN, a flag or a logical ID: those stay in the technical details. */
export function plainReason(error: unknown): string | undefined {
  const mapped = cliErrorFor(error);
  const message = mapped instanceof Error ? messageWithoutCode(mapped) : String(mapped);
  const first = onPageProblem(message.replace(RESUME_TAIL, "")).split(/\r?\n/, 1)[0]?.trim().replace(/^init stopped at "[^"]+": /, "").replace(/[:;,]$/, "") ?? "";
  if (first === "" || TECHNICAL.test(first)) return undefined;
  return capitalize(/[.!?]$/.test(first) ? first : `${first}.`);
}

export function failureScreen(input: { env: string; region: string; stepTitle?: string; stepId?: InitStepId; error: unknown; logPath?: string }): WizardFailure {
  const mapped = cliErrorFor(input.error);
  const raw = mapped instanceof Error ? messageWithoutCode(mapped) : String(mapped);
  const reason = plainReason(input.error);
  const head = input.stepTitle === undefined ? "The install could not go on." : `${input.stepTitle} did not finish.`;
  const stacks = input.stepId !== undefined && isRetryableStep(input.stepId) ? DEPLOY_STEP_PARTS[input.stepId].map((part) => environmentStackName(input.env, part)) : [];
  const retry = input.stepId !== undefined && isRetryableStep(input.stepId);
  return {
    title: FAILURE_TITLE,
    what: reason === undefined ? head : `${head} ${reason}`,
    next: retry
      ? "Nothing is lost: the steps that finished are kept. Try this step again, or stop for now and continue later."
      : "Your progress is saved. Stop for now and continue later.",
    details: [raw, ...stacks.map((stack) => `Stack: ${stack}`), ...(input.logPath === undefined ? [] : [`Log file: ${input.logPath}`])],
    ...(stacks.length === 0 ? {} : {
      link: { url: `https://${input.region}.console.aws.amazon.com/cloudformation/home?region=${input.region}#/stacks?filteringText=agentx-${input.env}-`, label: "Open the stacks in the AWS console" },
    }),
  };
}

export async function askFailureAction(prompter: Prompter, input: { retry: boolean }): Promise<FailureAction> {
  try {
    return await prompter.choose<FailureAction>("The install stopped. What next?", [
      ...(input.retry ? [{ value: "retry" as const, label: "Try this step again" }] : []),
      { value: "stop" as const, label: "Stop for now" },
    ], { flag: "--on-failure", defaultValue: input.retry ? "retry" : "stop", help: { label: "What would you like to do?", why: "Nothing is lost either way.", buttons: true } });
  } catch {
    // No one to ask (the page closed under the question, a test's script ran out): stopping is safe.
    return "stop";
  }
}
```

(The failure's raw detail keeps the error's text without its "CODE: " prefix; the code itself is in
the log. The tests assume `cliErrorFor(new Error("Resource limit exceeded"))` keeps that message;
check it in `deploy/commands.ts` first, and if it rewrites a plain `Error`'s message, expect the
rewritten text in every test of this task and the next that names it. `Object.hasOwn` needs `lib: es2022`, which the repo's tsconfig has; otherwise use `id in DEPLOY_STEP_PARTS`.)

In `steps.ts`, the step loop runs a step until it succeeds or the hook says stop:

```ts
  /** Spec 048 FR-060: asked after a step throws. "retry" runs the step again; "stop" (or no hook)
   * throws the step's error as before. */
  onStepFailure?: (failure: { id: InitStepId; title: string; error: unknown }) => Promise<"retry" | "stop">;

// inside withEnvironmentLock's callback, replacing the try/catch around step.run:
      const runStep = async (step: InitStep<C>): Promise<StepOutcome> => {
        for (;;) {
          input.onEvent?.({ kind: "step-started", id: step.id, title: step.title });
          try {
            return await step.run(input.context, handle);
          } catch (error) {
            input.onEvent?.({ kind: "step-failed", id: step.id, title: step.title, message: error instanceof Error ? error.message : String(error) });
            const next = (await input.onStepFailure?.({ id: step.id, title: step.title, error })) ?? "stop";
            if (next === "stop") throw initStepFailure(step.title, error, { env: input.env, region: input.region });
          }
        }
      };
      // ...in the for loop, after the skip check:
        const outcome = await runStep(step);
```

(Remove the old `input.onEvent?.({ kind: "step-started", ... })` line before the old `try`.)

In `retry.ts`, `if (!(await input.prompter.confirm(input.question, { defaultValue: true }))) throw markOperatorStop(error);`.

In `ui/index.ts`, `InstallWizard` exposes the hub's new methods and the token:
`setStage: (stage) => hub.setStage(stage)`, `setPlace: (place) => hub.setPlace(place)`,
`showFailure: (failure) => hub.showFailure(failure)`, `clearFailure: () => hub.clearFailure()`,
`closeRequested: () => hub.closeRequested()`, `token: server.token`, and `logPath` from a new
optional `startInstallWizard` input `logPath?: string` (Task 13 passes it; it is also given to
`createWizardHub(input.env, { logPath })`).

In `commands.ts`: `InitCliDependencies` gains `cliInvocation?: CliInvocation`; `InitSession` gains
`prompter?: Prompter; region?: string; failureShown?: boolean; invocation: CliInvocation`
(`runInit` sets `invocation: deps.cliInvocation ?? currentCliInvocation()`); `init()` sets
`session.prompter = prompter` once chosen, `session.region = region` once known, calls
`session.wizard?.setStage("your-choices")` just before `collectInitAnswers` (and before the resume
branch's screen), and `session.wizard?.setPlace({ account: caller.account, region })` after the
caller is resolved. `runInitSteps` gets the hook on the page only:

```ts
      ...(session.wizard === undefined ? {} : {
        onStepFailure: async ({ id, title, error }: { id: InitStepId; title: string; error: unknown }) => {
          const wizard = session.wizard;
          if (wizard === undefined) return "stop";
          wizard.showFailure(failureScreen({ env, region, stepTitle: title, stepId: id, error, ...(wizard.logPath === undefined ? {} : { logPath: wizard.logPath }) }));
          const action = await askFailureAction(activePrompter, { retry: isRetryableStep(id) });
          if (action === "retry") {
            wizard.clearFailure();
            return "retry";
          }
          session.failureShown = true;
          return "stop";
        },
      }),
```

`runInit`'s catch shows the screen for any other failure, then ends the page with the command to
continue:

```ts
  } catch (error) {
    const mapped = cliErrorFor(error);
    const wizard = session.wizard;
    if (wizard !== undefined) {
      const region = session.region ?? options.region ?? "<region>";
      if (session.failureShown !== true && !isOperatorStop(error)) {
        wizard.showFailure(failureScreen({ env: options.env, region, error, ...(wizard.logPath === undefined ? {} : { logPath: wizard.logPath }) }));
        await askFailureAction(session.prompter ?? wizard.prompter, { retry: false });
      }
      const outcome = isOperatorStop(error) ? (plainReason(error) ?? STOPPED_OUTCOME) : STOPPED_OUTCOME;
      wizard.finish(outcome, "failed", [{ label: "Continue later with", command: cliCommandLine(session.invocation, `--env ${options.env} init --region ${region}`) }]);
    }
    throw mapped;
  }
```

- [ ] **Step 4: Update the runs that now end on a failure screen**

The `--from-bundle` test (`init-ui-cli.test.ts`, the run stopped at foundation) now meets the
failure screen: append `"stop"` to its operator's script, and replace
`expect(operator.states.at(-1)?.outcome).toContain("stop after access");` with
`expect(operator.states.flatMap((state) => (state.failure === undefined ? [] : [state.failure])).at(-1)?.details[0]).toContain("stop after access");`
(the same text, now where the page keeps it). Run `npx vitest run tests/contract/init-ui-*.test.ts`;
any other `--ui` run that now waits on the failure question fails with "no scripted answer for
"The install stopped. What next?"": give it the answer `"stop"` and assert its `failure.what` with
the exact text the run shows.

- [ ] **Step 5: Run the suites**

Run: `npx vitest run tests/contract/init-cli-command.test.ts tests/contract/init-ui-failure.test.ts tests/contract/init-steps.test.ts tests/contract/init-ui-cli.test.ts tests/contract/init-cli.test.ts tests/contract/init-retry.test.ts`
Expected: PASS. The terminal path (`init-cli.test.ts`) has no hook and no page: its errors are unchanged.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/init tests/contract
git commit -m "feat(init): a failure is a screen on the page; Try this step again reruns a deploy step (048 FR-060)"
```

---

### Task 13: A quiet terminal and a log file (FR-070, FR-071)

**Files:**
- Create: `packages/cli/src/init/log-file.ts`
- Modify: `packages/cli/src/init/ui/index.ts:76-99` (`startInstallWizard`'s start lines)
- Modify: `packages/cli/src/init/commands.ts` (the session's `write`, `say` and `output`; the runner; the plan; step lines; the stopped line)
- Modify: `packages/cli/src/main.ts:928-941` (nothing more is printed after a page-mode run)
- Modify: `docs/install.md` (the "The install page" section)
- Test: `tests/contract/init-log-file.test.ts` (new), `tests/contract/init-ui-cli.test.ts`, `tests/contract/install-docs.test.ts`

**Interfaces:**
- Consumes: Task 1's `terminalStepLine`, `stageLine`, `stoppedLine`, `READY_LINE`, `totalMinutes`, `minutesText`; Task 12's session and `plainReason`.
- Produces:
  - `initLogPath(home: string, env: string): string` (`<home>/.agentx/logs/init-<env>.log`)
  - `interface InitLog { path: string; write(text: string): void; hide(value: string): void; close(): Promise<void> }`, `openInitLog(path: string): Promise<InitLog>`
  - `InitResult.pageMode?: true`: `main.ts` prints nothing more for it (the terminal already has its lines)

- [ ] **Step 1: Write the failing tests**

```ts
// tests/contract/init-log-file.test.ts
// Spec 048 FR-070 and FR-071: the page-mode log file gets everything the terminal no longer
// shows, and never the page's session token.
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initLogPath, openInitLog } from "../../packages/cli/src/init/log-file.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe("the install log file", () => {
  it("lives under ~/.agentx/logs, readable by its owner only, and hides what it is told to hide", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentx-log-")); dirs.push(home);
    const path = initLogPath(home, "staging");
    expect(path).toBe(join(home, ".agentx", "logs", "init-staging.log"));
    const log = await openInitLog(path);
    log.hide("test-session-token-aaaaaaaaaaaaaaaaaaa");
    log.write("done: Set up AWS permissions\n");
    log.write("opened http://127.0.0.1:5000/?t=test-session-token-aaaaaaaaaaaaaaaaaaa\n");
    await log.close();
    const text = await readFile(path, "utf8");
    expect(text).toBe("done: Set up AWS permissions\nopened http://127.0.0.1:5000/?t=<hidden>\n");
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});
```

Add to `tests/contract/init-ui-cli.test.ts`:

```ts
  it("spec 048 FR-070: with the page open, the terminal prints three start lines and one line per step", async () => {
    const h = await harness();
    const { code } = await h.runUi([...FIRST_RUN, ...SLACK, ...SIGNIN, ...FINISH]);
    expect(code).toBe(0);
    const lines = h.err.join("").trimEnd().split("\n");
    expect(lines[0]).toMatch(/^The AgentX installer is open in your browser: http:\/\/127\.0\.0\.1:\d+\/\?t=/);
    expect(lines.slice(1)).toEqual([
      "Keep this terminal open and your computer awake (about 44 minutes).",
      `Full log: ${initLogPath(h.home, "staging")}`,
      stageLine("get-started"),
      stageLine("your-choices"),
      ...INIT_STEP_IDS.map((id) => terminalStepLine(id)),
      READY_LINE,
    ]);
    expect(h.out.join("")).toBe("");
    // FR-070 and FR-071: the plan, the progress lines and the ready summary are in the log file, the token is not.
    const log = await readFile(initLogPath(h.home, "staging"), "utf8");
    expect(log).toContain("Estimated monthly total");
    expect(log).toContain("done: Start the AgentX service");
    expect(log).toContain("AgentX environment staging is ready.");
    const token = new URL(lines[0]?.split(": ").at(-1) ?? "http://x").searchParams.get("t") ?? "missing";
    expect(token.length).toBeGreaterThan(20);
    expect(log).not.toContain(token);
  });

  it("spec 048 FR-070: a failure is one line in the terminal, with the log file named", async () => {
    const h = await harness();
    h.deployer.fail.set(environmentStackName("staging", "control-plane"), new Error("Resource limit exceeded"));
    const { code } = await h.runUi([...FIRST_RUN, "stop"]);
    expect(code).not.toBe(0);
    expect(h.err.join("")).toContain(`[3/5] Stopped: Start the AgentX service did not finish. Resource limit exceeded. Details in the browser and in ${initLogPath(h.home, "staging")}.`);
    expect(h.err.join("")).not.toContain("==> ");
  });
```

The FR-012 secret tests in this file add the log file to `everywhere()`:
`await readFile(initLogPath(home, "staging"), "utf8").catch(() => "")`, so no secret reaches it either.
(Imports: `initLogPath` from `log-file.js`; `READY_LINE`, `stageLine`, `terminalStepLine` from `ui/journey.js`.)

Add to `tests/contract/install-docs.test.ts`, in the install guide test's list of required words:
`"Action needed"`, `"init-<env>.log"`, `"Try this step again"`, `"Close installer"`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/contract/init-log-file.test.ts tests/contract/init-ui-cli.test.ts tests/contract/install-docs.test.ts`
Expected: FAIL: `log-file.js` does not exist; the terminal still prints every progress line.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/cli/src/init/log-file.ts
// Spec 048 FR-059, FR-070 and FR-071: with the install page open, what the terminal used to show
// goes here (and to the page's technical log). Never the page's session token: the wizard hides it
// the moment the server has one.
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

export function initLogPath(home: string, env: string): string {
  return join(home, ".agentx", "logs", `init-${env}.log`);
}

export interface InitLog {
  path: string;
  write(text: string): void;
  /** Every later write replaces this value with <hidden>. */
  hide(value: string): void;
  close(): Promise<void>;
}

export async function openInitLog(path: string): Promise<InitLog> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const stream = createWriteStream(path, { flags: "a", mode: 0o600 });
  const hidden: string[] = [];
  return {
    path,
    write(text) {
      let safe = text;
      for (const value of hidden) safe = safe.split(value).join("<hidden>");
      stream.write(safe);
    },
    hide(value) {
      if (value.length >= 8) hidden.push(value);
    },
    close: () => new Promise<void>((resolvePromise) => { stream.end(() => resolvePromise()); }),
  };
}
```

`startInstallWizard` writes exactly the start lines:

```ts
  const opened = input.openBrowser === undefined ? false : await input.openBrowser(server.url);
  input.write(opened ? `The AgentX installer is open in your browser: ${server.url}` : `The AgentX installer is at ${server.url}`);
  if (!opened) {
    input.write(`Open that address in a browser on this machine. From another machine, first run: ssh -L ${server.port}:127.0.0.1:${server.port} <this host>`);
  }
  input.write(`Keep this terminal open and your computer awake (${minutesText(totalMinutes())}).`);
  if (input.logPath !== undefined) input.write(`Full log: ${input.logPath}`);
```

(The SSH line appears only when no browser opened: without it the page cannot be reached.)

In `commands.ts`, the session routes each kind of output:

```ts
interface InitSession {
  wizard?: InstallWizard;
  log?: InitLog;
  prompter?: Prompter;
  region?: string;
  failureShown?: boolean;
  invocation: CliInvocation;
  /** A progress line: the terminal without the page; the log file and the page's technical log with it. */
  write: (line: string) => void;
  /** The terminal always, and the log: with the page, only the start lines, one line per step, and the last line. */
  say: (line: string) => void;
  /** Child process output and the plan's text: the terminal without the page, the log file with it. */
  output: Writer;
}

  const session: InitSession = {
    invocation: deps.cliInvocation ?? currentCliInvocation(),
    write: (line) => {
      if (session.wizard === undefined) { services.stderr.write(`${line}\n`); return; }
      session.log?.write(`${line}\n`);
      session.wizard.log(line);
    },
    say: (line) => { services.stderr.write(`${line}\n`); session.log?.write(`${line}\n`); },
    output: { write: (text: string) => (session.wizard === undefined ? services.stderr.write(text) : session.log?.write(text)) },
  };
```

and, in `init()`:
- `const runner = deployDeps.commandRunner ?? realCommandRunner(session.output);`
- before `startInstallWizard`: `session.log = await openInitLog(initLogPath(services.home, env));`; call
  `startInstallWizard({ env, write: (line) => services.stderr.write(`${line}\n`), logPath: session.log.path, ... })`
  (the start lines go to the terminal only: the first holds the token); then
  `session.log.hide(wizard.token)`, `session.wizard = wizard`, and `session.say(stageLine("get-started"))`;
- next to `setStage("your-choices")` on a first run: `session.say(stageLine("your-choices"))`;
- `confirmInstallPlan({ ..., write: (text) => { session.output.write(text); session.wizard?.plan(text); } })`;
- `prepareDeployment({ ..., stderr: session.output })`;
- `onEvent`: as in Task 3, plus `if (session.wizard !== undefined && event.kind === "step-started") session.say(terminalStepLine(event.id));`;
- the result carries `...(session.wizard === undefined ? {} : { pageMode: true as const })`.

In `runInit`: on success with the page, write `result.ready` to the log; in the catch, with the
page, write the full error to the log, say the one stopped line, and throw an error with that line
as its message (same code, the original as `cause`), so `main.ts` prints that line once:

```ts
    if (wizard !== undefined) {
      // ... the failure screen and finish, from Task 12 ...
      session.log?.write(`${mapped instanceof Error ? mapped.message : String(mapped)}\n`);
      const what = wizard.hub.state().failure?.what ?? plainReason(error) ?? "The install could not go on.";
      const line = stoppedLine({ phase: wizard.hub.state().journey.current, problem: what, logPath: session.log?.path ?? "the log" });
      throw Object.assign(mapped instanceof AgentXError ? agentXError(mapped.code, line) : new Error(line), { cause: error });
    }
```

(`wizard.finish` clears nothing about the failure, so `state().failure` still holds the screen's
`what`; `stoppedLine` is computed before `finish` if that is easier to read. `main.ts` prints
"AgentX error [CODE]: <line>": one line. `finally` closes `session.log` after the wizard.)

`main.ts`, after the `--json` branch: `if (result.pageMode === true) return;`.

`docs/install.md`, the first two paragraphs of "### The install page" become:

```markdown
In a terminal on your own computer, `init` opens a page in your browser, served from this computer
only (`127.0.0.1`). The page shows the five parts of the install (Get started, Your choices, Build
in AWS, Connect Slack, Finish), how long each usually takes, which one you are in, and the time
left. The browser tab's title reads "(Action needed) Install AgentX" whenever the install waits for
you. Everything `init` asks is asked there, each question with a line on why it is asked: which
AWS profile and account it installs into (with a Sign in choice when your session has expired, and
a warning if you are signed in as the AWS root user), the account checks as a checklist, the plan
and its monthly cost with Create AgentX and Cancel the install buttons, then each step. The GitHub
app and the Slack app are made from link buttons on the page, and the page moves on by itself once
GitHub sends you back. Secrets (the Slack token and signing secret, connector keys) are typed into
hidden fields. Each goes straight to AWS Secrets Manager and is never shown again, and the field is
emptied as soon as it is sent. If a deploy step fails, the page says what happened and offers Try
this step again; Stop for now shows the command that continues later. The install ends on a ready
screen with the commands for your team, which stays open until you press Close installer, or for
30 minutes.

While the page is open, the terminal prints the page's address, how long the install takes, the
path of the full log (`~/.agentx/logs/init-<env>.log`), then one line per step. Everything else
(the plan, the deploy output, the output of the tools `init` runs) goes to that log file and to the
page's technical log. The log file never holds the page's access token.

Keep the terminal open and your computer awake until the install finishes. If the tab is closed,
`init` keeps waiting and, after a minute, prints the address again in the terminal. Open it to
carry on, or press Ctrl-C and run `init` again later (it continues where it stopped).
```

- [ ] **Step 4: Update the start-line expectations to the new exact lines**

`grep -rn "Every question agentx init asks is on that page\|The AgentX installer is at" tests` lists
the old start lines. A run whose fake browser opened now prints "The AgentX installer is open in
your browser: <url>"; one with `--no-browser` still prints "The AgentX installer is at <url>" and the
SSH line. Replace each expectation with the new exact line. The old FR-052 test's
`expect(h.out.join("")).toContain("  Developers sign in with: ...")` moves to the log file (Task 14
changes that line's command).

- [ ] **Step 5: Run the suites**

Run: `npx vitest run tests/contract/init-log-file.test.ts tests/contract/init-ui-cli.test.ts tests/contract/init-ui-reminder.test.ts tests/contract/install-docs.test.ts tests/contract/init-cli.test.ts`
Expected: PASS; `init-cli.test.ts` (no page) prints exactly what it printed before.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/init packages/cli/src/main.ts docs/install.md tests/contract
git commit -m "feat(init): with the page open, the terminal prints one line per step and the rest goes to a log file without the token (048 FR-070, FR-071)"
```

---

### Task 14: The ready screen that stays, and commands that work as shown (FR-058, FR-059, #222)

**Files:**
- Modify: `packages/cli/src/init/ui/cards.ts` (`readyCard`)
- Modify: `packages/cli/src/init/finish-steps.ts:332-350` (`readyText`)
- Modify: `packages/cli/src/init/signin-step.ts:96` (the developer sign-in line)
- Modify: `packages/cli/src/init/context.ts` (`InitContext.cliInvocation`)
- Modify: `packages/cli/src/init/commands.ts:673-688` and `runInit` (the ready card's input, the outcome, the hold)
- Test: `tests/contract/init-ui-cards.test.ts`, `tests/contract/init-ui-cli.test.ts`, `tests/contract/init-finish-steps.test.ts`, `tests/contract/init-cli.test.ts`

**Interfaces:**
- Consumes: Task 12's `cliCommandLine`, `CliInvocation`; Task 7's `botNameOf`; Task 8's `isRootUser`; Task 3's `closeRequested`, `POST /close`.
- Produces:
  - `readyCard(input: { env: string; controlPlaneUrl: string; progress: InstallProgress; botName: string; invocation: CliInvocation; root: boolean; alertsOn: boolean; created: string[]; logPath?: string }): WizardCard`
  - `readyText(input: { env: string; controlPlaneUrl: string; progress: InstallProgress; botName: string; invocation: CliInvocation }): string`
  - `READY_HOLD_MS = 30 * 60_000`, `READY_OUTCOME = "AgentX is installed."`
  - `holdReadyScreen(input: { closeRequested: Promise<void>; ms: number; sleep?: (ms: number) => Promise<void> }): Promise<void>` (exported from `commands.ts`)

- [ ] **Step 1: Write the failing tests**

Add to `tests/contract/init-ui-cards.test.ts`:

```ts
const FROM_SOURCE = { published: false, cliPath: "/opt/agentx/dist/main.js" };
const READY_PROGRESS = {
  ...emptyProgress("staging", 0),
  slack: { appId: "A0APP", teamId: "T0TEAM", botUserId: "U0BOT", botName: "agentx-acme-staging" },
  project: { name: "payments-api", revision: 1, channelName: "payments", channelId: "C0PAY00001", teamId: "T0TEAM" },
};

describe("spec 048 the ready screen", () => {
  it("FR-059 and #222: says how to try AgentX by name, and gives commands that work as shown, each with --env", () => {
    const card = readyCard({ env: "staging", controlPlaneUrl: "https://abc.execute-api.us-east-1.amazonaws.com", progress: READY_PROGRESS, botName: "agentx-acme-staging", invocation: FROM_SOURCE, root: false, alertsOn: true, created: ["agentx-staging-access"], logPath: "/home/a/.agentx/logs/init-staging.log" });
    expect(card.lines).toEqual([
      "Try it: in #payments, mention @agentx-acme-staging and ask it something.",
      "Send your developers the sign-in command below. They run it once, then use AgentX from Claude Code, Codex or Cursor.",
      "The AgentX CLI is not published yet, so this command works on this computer. Other computers need their own copy of the AgentX CLI first.",
      "No issue trackers connected yet.",
      "Everything here is also in /home/a/.agentx/logs/init-staging.log.",
    ]);
    expect(card.commands).toEqual([
      { label: "Developer sign-in", command: "node /opt/agentx/dist/main.js login https://abc.execute-api.us-east-1.amazonaws.com" },
      { label: "Check the install", command: "node /opt/agentx/dist/main.js --env staging doctor" },
      { label: "Connect an issue tracker", command: "node /opt/agentx/dist/main.js --env staging connector add linear --project payments-api" },
      { label: "Add a project", command: "node /opt/agentx/dist/main.js --env staging project add" },
      { label: "Send a test alert", command: "node /opt/agentx/dist/main.js --env staging alerts test" },
      { label: "Remove AgentX", command: "node /opt/agentx/dist/main.js --env staging destroy" },
    ]);
    expect(card.details).toEqual(["What was created: agentx-staging-access"]);
    expect(lintCopy([...cardEntries(card).map((entry) => ({ ...entry, context: entry.context === "page" ? ("ready" as const) : entry.context })), ...(card.commands ?? []).map((command) => ({ where: "ready", text: command.command, context: "ready" as const }))])).toEqual([]);
  });

  it("FR-016: names the commands that need an admin user when the install ran as root", () => {
    const card = readyCard({ env: "staging", controlPlaneUrl: "https://abc.example.com", progress: READY_PROGRESS, botName: "agentx-acme-staging", invocation: FROM_SOURCE, root: true, alertsOn: true, created: [] });
    expect(card.lines).toContain("You installed as the AWS root user. The day-two commands below need an admin user: AWS does not let the root user use the AgentX operator role.");
  });

  it("names the published package only when the CLI is the published one", () => {
    const card = readyCard({ env: "staging", controlPlaneUrl: "https://abc.example.com", progress: READY_PROGRESS, botName: "agentx-acme-staging", invocation: { published: true, version: "1.2.3", cliPath: "/x" }, root: false, alertsOn: true, created: [] });
    expect(card.commands?.[0]?.command).toBe("npx @charterarc/agentx@1.2.3 login https://abc.example.com");
    expect(card.lines.join(" ")).not.toContain("not published");
  });
});
```

Add to `tests/contract/init-finish-steps.test.ts`:

```ts
  it("#222: the ready summary names the bot by handle and gives a sign-in command that works as shown", () => {
    const text = readyText({ env: "staging", controlPlaneUrl: "https://abc.example.com", progress: READY_PROGRESS_FIXTURE, botName: "agentx-acme-staging", invocation: { published: false, cliPath: "/opt/agentx/dist/main.js" } });
    expect(text).not.toMatch(/<@/);
    expect(text).toContain("  Talk to it: mention @agentx-acme-staging in #payments (project payments-api).");
    expect(text).toContain("  Developers sign in with: node /opt/agentx/dist/main.js login https://abc.example.com");
    expect(text).not.toContain("@charterarc/agentx");
  });
```

(`READY_PROGRESS_FIXTURE` is the same object as `READY_PROGRESS` above; define it in that file.)

Add to `tests/contract/init-ui-cli.test.ts`, and update the old FR-052 test (its name says "the
outcome is still readyText", which FR-058 changes):

```ts
  it("spec 048 FR-058 and FR-059: the ready screen is shown once, and the installer stays up until Close installer or 30 minutes", async () => {
    const h = await harness();
    let during: WizardSnapshot | undefined;
    const operator = fakeWizardOperator([...FIRST_RUN, ...SLACK, ...SIGNIN, ...FINISH]);
    const code = await h.run(["--ui"], {
      openBrowser: operator.open,
      sleep: async (ms) => {
        if (ms !== READY_HOLD_MS) return h.advance(ms);
        const { origin, searchParams } = new URL(operator.opened[0] ?? "http://x");
        during = (await (await fetch(`${origin}/state`, { headers: { [WIZARD_TOKEN_HEADER]: searchParams.get("t") ?? "" } })).json()) as WizardSnapshot;
      },
    });
    await operator.settled();
    expect(code).toBe(0);
    const ready = during?.cards?.find((card) => card.id === "ready");
    expect(ready?.status).toBe("ok");
    expect(during?.outcome).toBe(READY_OUTCOME);
    for (const line of ready?.lines ?? []) expect(during?.outcome ?? "").not.toContain(line);
  });

  it("holds until Close installer, and no longer", async () => {
    let resolveClose: () => void = () => undefined;
    const closeRequested = new Promise<void>((resolvePromise) => { resolveClose = resolvePromise; });
    const waited: number[] = [];
    const holding = holdReadyScreen({ closeRequested, ms: READY_HOLD_MS, sleep: (ms) => { waited.push(ms); return new Promise(() => undefined); } });
    resolveClose();
    await holding;
    expect(waited).toEqual([30 * 60_000]);
  });
```

(Imports: `READY_HOLD_MS`, `READY_OUTCOME`, `holdReadyScreen` from `commands.js`; `WIZARD_TOKEN_HEADER`
from `ui/protocol.js`. The harness gains `advance: (ms: number) => { clock += ms; }` in its returned
object, so this override keeps the harness clock moving for every other wait.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/contract/init-ui-cards.test.ts tests/contract/init-finish-steps.test.ts tests/contract/init-ui-cli.test.ts -t "ready|222|Close installer"`
Expected: FAIL: `readyCard` still names the member ID and `npx @charterarc/agentx`, and the installer closes as soon as the run ends.

- [ ] **Step 3: Write minimal implementation**

`cards.ts`:

```ts
export function readyCard(input: {
  env: string; controlPlaneUrl: string; progress: InstallProgress; botName: string; invocation: CliInvocation;
  root: boolean; alertsOn: boolean; created: string[]; logPath?: string;
}): WizardCard {
  const cli = (args: string) => cliCommandLine(input.invocation, `--env ${input.env} ${args}`);
  const { project } = input.progress;
  const connectors = input.progress.connectors ?? [];
  const teamId = project?.teamId ?? input.progress.slack?.teamId;
  return {
    id: "ready", title: "AgentX is ready", status: "ok",
    lines: [
      ...(project?.channelName === undefined ? [] : [`Try it: in #${project.channelName}, mention @${input.botName} and ask it something.`]),
      "Send your developers the sign-in command below. They run it once, then use AgentX from Claude Code, Codex or Cursor.",
      ...(input.invocation.published ? [] : ["The AgentX CLI is not published yet, so this command works on this computer. Other computers need their own copy of the AgentX CLI first."]),
      connectors.length === 0 ? "No issue trackers connected yet." : `Connected: ${connectors.map((entry) => CONNECTOR_LABELS[entry.type]).join(", ")}.`,
      ...connectors.flatMap((entry) => (entry.warning === undefined ? [] : [`Warning (${CONNECTOR_LABELS[entry.type]}): ${entry.warning}.`])),
      ...(input.alertsOn ? [] : ["Alerts are off. You can turn them on later; the day-two guide says how."]),
      ...(input.root ? ["You installed as the AWS root user. The day-two commands below need an admin user: AWS does not let the root user use the AgentX operator role."] : []),
      ...(input.logPath === undefined ? [] : [`Everything here is also in ${input.logPath}.`]),
    ],
    commands: [
      { label: "Developer sign-in", command: cliCommandLine(input.invocation, `login ${input.controlPlaneUrl}`) },
      { label: "Check the install", command: cli("doctor") },
      ...(project === undefined ? [] : [{ label: "Connect an issue tracker", command: cli(`connector add linear --project ${project.name}`) }]),
      { label: "Add a project", command: cli("project add") },
      ...(input.alertsOn ? [{ label: "Send a test alert", command: cli("alerts test") }] : []),
      { label: "Remove AgentX", command: cli("destroy") },
    ],
    ...(input.created.length === 0 ? {} : { details: [`What was created: ${input.created.join(", ")}`] }),
    ...(project?.channelId === undefined || project.channelName === undefined || teamId === undefined
      ? {} : { link: { url: slackChannelLink(teamId, project.channelId), label: `Open #${project.channelName} in Slack` } }),
  };
}
```

`finish-steps.ts`'s `readyText` takes `botName` and `invocation`, mentions `@${input.botName}` (no
`<@...>`), drops the revision from the mention line (it is in the project's details), and builds
every command with `cliCommandLine(input.invocation, ...)`:

```ts
export function readyText(input: { env: string; controlPlaneUrl: string; progress: InstallProgress; botName: string; invocation: CliInvocation }): string {
  const { env, progress } = input;
  const cli = (args: string) => cliCommandLine(input.invocation, `--env ${env} ${args}`);
  const { project } = progress;
  const connectors = progress.connectors ?? [];
  const connected = connectors.map((entry) => CONNECTOR_LABELS[entry.type]);
  return [
    `AgentX environment ${env} is ready.`,
    ...(project?.channelName === undefined ? [] : [`  Talk to it: mention @${input.botName} in #${project.channelName} (project ${project.name}).`]),
    `  Developers sign in with: ${cliCommandLine(input.invocation, `login ${input.controlPlaneUrl}`)}`,
    ...(project === undefined ? [] : [`  ${connected.length === 0 ? "No connectors yet." : `Connected: ${connected.join(", ")}.`} Add ${connected.length === 0 ? "one" : "more"} with ${cli(`connector add linear|jira|asana --project ${project.name}`)}.`]),
    ...connectors.flatMap((entry) => (entry.warning === undefined ? [] : [`  Warning (${CONNECTOR_LABELS[entry.type]}): ${entry.warning}.`])),
    `  More projects: ${cli("project add")}, then ${cli("channel add")}.`,
    `  Send a test alarm any time: ${cli("alerts test")}.`,
  ].join("\n");
}
```

`context.ts`: `InitContext` gains `cliInvocation: CliInvocation`; `commands.ts` sets it to
`session.invocation`. `signin-step.ts:96`:
`context.write(`Developers sign in with: ${cliCommandLine(context.cliInvocation, `login ${settings.controlPlaneUrl}`)}`);`

`commands.ts`:

```ts
export const READY_HOLD_MS = 30 * 60_000;
export const READY_OUTCOME = "AgentX is installed.";

/** FR-059: the ready screen stays until the page asks to close, or for 30 minutes. A real run
 * clears its timer, so the process exits as soon as Close installer is pressed. */
export async function holdReadyScreen(input: { closeRequested: Promise<void>; ms: number; sleep?: (ms: number) => Promise<void> }): Promise<void> {
  if (input.sleep !== undefined) {
    await Promise.race([input.closeRequested, input.sleep(input.ms)]);
    return;
  }
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([input.closeRequested, new Promise<void>((resolvePromise) => { timer = setTimeout(resolvePromise, input.ms); })]);
  clearTimeout(timer);
}
```

The ready card's input (where `readyCard` is called today):

```ts
      surface.card(readyCard({
        env, controlPlaneUrl: settings.controlPlaneUrl, progress,
        botName: botNameOf(progress, finalAnswers.slack.appName), invocation: session.invocation,
        root: isRootUser(caller.arn), alertsOn: finalAnswers.alert.kind !== "none",
        created: installOrder(finalAnswers.identity.mode).map((part) => environmentStackName(env, part)),
        ...(session.log === undefined ? {} : { logPath: session.log.path }),
      }));
```

and `readyText(...)` gets `botName` and `invocation: session.invocation` the same way. In `runInit`'s
success path, with the page: finish with `READY_OUTCOME` (complete), the waiting message's plain
form `"The install is paused. Your progress is saved."` with the continue command (waiting), or
the stop-after text (stopped after); then, for a complete install only:

```ts
      session.say(READY_LINE);
      await holdReadyScreen({ closeRequested: wizard.closeRequested(), ms: READY_HOLD_MS, ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }) });
```

For a waiting run, also `session.say(stoppedLine(...))` with the waiting message's plain words
("Waiting for a Slack admin to approve the app.") in place of the problem.

- [ ] **Step 4: Update the old ready expectations to the new exact words**

`grep -rn "Developers sign in with\|mention <@\|is still readyText\|member ID" tests` lists them. In
`init-cli.test.ts` (terminal) the summary lines change to the new `readyText` lines (pin the
harness's `cliInvocation` as in Task 12). In `init-ui-cli.test.ts`, the outcome assertions become
`expect(last?.outcome).toBe(READY_OUTCOME)` plus the ready card's exact lines and commands; the old
test titled "...and the outcome is still readyText" is renamed "...and the outcome does not repeat it
(spec 048 FR-058)".

- [ ] **Step 5: Run the suites**

Run: `npx vitest run tests/contract/init-ui-cards.test.ts tests/contract/init-finish-steps.test.ts tests/contract/init-ui-cli.test.ts tests/contract/init-cli.test.ts tests/contract/init-signin-step.test.ts tests/contract/init-ui-finish.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/init tests/contract
git commit -m "feat(init): a ready screen that stays, names the bot, and gives commands that work as shown (048 FR-058, FR-059, #222)"
```

---

### Task 15: The page shell: header, progress rail, one panel (FR-001, FR-003, FR-004, FR-006, FR-008, FR-011)

**Files:**
- Modify: `packages/cli/src/init/ui/page.ts` (whole file: `wizardHtml`, `WIZARD_CSS`, `WIZARD_JS`)
- Modify: `packages/cli/src/init/ui/journey.ts` (export `CARD_PHASES`, `STEP_STATUS_WORDS`)
- Test: `tests/contract/init-ui-page.test.ts` (new)

**Interfaces:**
- Consumes: every state field from Tasks 3, 4, 5, 7, 12 and 14 (`journey`, `header`, `pageTitle`,
  `welcome`, `failure`, `commands`, `logPath`, question `label`/`why`/`example`/`hint`/`buttons`/`fields`,
  card `details`/`commands`/link `note`), and `POST /close`.
- Produces: `CARD_PHASES: Readonly<Record<CardId, JourneyPhaseId>>`, `STEP_STATUS_WORDS: Readonly<Record<StepStatus, string>>`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/contract/init-ui-page.test.ts
// Spec 048 FR-001, FR-003, FR-004, FR-006, FR-008 and FR-011: the page shell. The page has no DOM
// here, so these read its source: it must parse, render every word from state, and keep spec
// 040's rules (no inline script or style, text only through textContent).
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WIZARD_CSS, WIZARD_JS, wizardHtml } from "../../packages/cli/src/init/ui/page.js";
import { lintCopy, quotedStrings } from "../support/copy-lint.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const html = wizardHtml("token-aaaaaaaa");

describe("the page shell", () => {
  it("is a module node can parse", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentx-page-")); dirs.push(dir);
    await writeFile(join(dir, "app.mjs"), WIZARD_JS);
    expect(() => execFileSync(process.execPath, ["--check", join(dir, "app.mjs")])).not.toThrow();
  });

  it("FR-001 and FR-003: has a header, a progress rail and one current-step panel", () => {
    for (const id of ['id="place"', 'id="time-left"', 'id="phases"', 'id="panel"', 'id="step-of"', 'id="question"', 'id="failure"']) expect(html).toContain(id);
    expect(html).toContain('aria-label="Install progress"');
  });

  it("FR-004: the plan and the technical log are behind links", () => {
    expect(html).toMatch(/<details id="plan"[^>]*><summary>View the plan<\/summary>/);
    expect(html).toMatch(/<details id="log-box"[^>]*><summary>Show technical log<\/summary>/);
  });

  it("FR-008: announces the panel, ties labels and errors to fields, and shows the question large and in plain case", () => {
    expect(html).toContain('<main id="panel" aria-live="polite">');
    expect(html).toContain('role="alert"');
    expect(WIZARD_JS).toContain("aria-describedby");
    expect(WIZARD_JS).toContain("htmlFor");
    expect(WIZARD_JS).toContain('setAttribute("aria-labelledby", "question-text")');
    expect(WIZARD_CSS).not.toMatch(/text-transform:\s*uppercase/);
    expect(WIZARD_CSS).toMatch(/\.question h2 \{[^}]*font-size: 1\.35rem/);
  });

  it("FR-005 and FR-011: takes the tab title, buttons and hints from state, and asks to close on Close installer", () => {
    expect(WIZARD_JS).toContain("document.title = state.pageTitle");
    expect(WIZARD_JS).toContain("question.buttons");
    expect(WIZARD_JS).toContain("question.hint");
    expect(WIZARD_JS).toContain('"/close"');
    expect(WIZARD_JS).not.toContain("defaultConfirm");
    expect(WIZARD_JS).not.toContain("Leave empty for");
  });

  it("keeps spec 040's rules: no inline handler or style, and no markup built from text", () => {
    expect(html).not.toMatch(/\son[a-z]+=|\sstyle=/);
    expect(WIZARD_JS).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });

  it("FR-060 and SC-011: no static page text is an internal word, and none says Finished", () => {
    const strings = [...quotedStrings(WIZARD_JS), ...quotedStrings(html.replace(/<[^>]+>/g, '"').replace(/&hellip;/g, "..."))];
    expect(strings.join(" ")).not.toMatch(/\bFinished\b/);
    const entries = strings.map((text, index) => ({ where: `page string ${index}`, text, context: (/Lost the connection/.test(text) ? "lost-connection" : "page") as "page" | "lost-connection", failedRun: true }));
    expect(lintCopy(entries)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/contract/init-ui-page.test.ts`
Expected: FAIL: no `id="place"`, the plan is a `<section>`, `<h2>Finished</h2>` is in the page, and the CSS uppercases headings.

- [ ] **Step 3: Write minimal implementation**

`journey.ts` additions:

```ts
import type { CardId, StepStatus } from "./protocol.js";

/** FR-003: which phase each card belongs to, so a finished one collapses into that phase in the rail. */
export const CARD_PHASES: Readonly<Record<CardId, JourneyPhaseId>> = {
  aws: "get-started", prerequisites: "your-choices", github: "build", slack: "connect-slack", "slack-urls": "connect-slack",
  admin: "finish", project: "finish", channel: "finish", connectors: "finish", alerts: "finish", reply: "finish", ready: "finish",
};

export const STEP_STATUS_WORDS: Readonly<Record<StepStatus, string>> = {
  pending: "Coming up", running: "Now", done: "Done", skipped: "Done", waiting: "Waiting for you", failed: "Stopped",
};
```

`page.ts` (the CSP, the module-by-URL token hand-off and the event stream stay as spec 040 made them):

```ts
import { CARD_PHASES, STEP_STATUS_WORDS } from "./journey.js";
import { WIZARD_TOKEN_HEADER, WIZARD_TOKEN_QUERY } from "./protocol.js";

export function wizardHtml(token: string): string {
  const script = `/app.js?${WIZARD_TOKEN_QUERY}=${encodeURIComponent(token)}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="same-origin">
<title>Install AgentX</title>
<link rel="stylesheet" href="/app.css">
</head>
<body>
<header class="top">
  <div><h1>Install AgentX</h1><p id="place">Connecting to the installer&hellip;</p></div>
  <p id="time-left" class="time-left"></p>
</header>
<div class="layout">
  <nav class="rail" aria-label="Install progress"><ol id="phases"></ol></nav>
  <main id="panel" aria-live="polite">
    <p id="step-of" class="step-of"></p>
    <section id="welcome" class="card hidden"><h2>Before you start</h2><div id="welcome-body"></div></section>
    <section id="resume" class="card hidden"><h2>Welcome back</h2><div id="resume-body"></div></section>
    <section id="failure" class="card status failed hidden" role="alert">
      <h2 id="failure-title"></h2>
      <h3>What happened</h3><p id="failure-what"></p>
      <h3>What to do</h3><p id="failure-next"></p>
      <details><summary>Technical details</summary><div id="failure-details"></div></details>
    </section>
    <div id="cards"></div>
    <section id="next" class="card hidden"><h2>Open this</h2><div id="next-link"></div></section>
    <section id="question" class="card question hidden">
      <h2 id="question-text"></h2>
      <p id="question-why" class="why hidden"></p>
      <p id="question-example" class="hint hidden"></p>
      <div id="question-body"></div>
      <p id="question-error" class="error hidden" role="alert"></p>
    </section>
    <section id="outcome" class="card hidden"><h2 id="outcome-title"></h2><p id="outcome-body"></p><div id="outcome-commands"></div></section>
    <details id="plan" class="card hidden"><summary>View the plan</summary><pre id="plan-body"></pre></details>
    <details id="log-box" class="card"><summary>Show technical log</summary><pre id="log"></pre></details>
    <p id="closed-note" class="note hidden"></p>
  </main>
</div>
<script type="module" src="${script}"></script>
</body>
</html>
`;
}

export const WIZARD_CSS = `:root { color-scheme: light dark; --line: rgba(128,128,128,.35); --accent: #1a56db; --ok: #2e7d32; --wait: #b06000; --bad: #c62828; }
body { font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0 auto; max-width: 72rem; padding: 0 1rem 4rem; }
.top { align-items: baseline; border-bottom: 1px solid var(--line); display: flex; flex-wrap: wrap; gap: .5rem 1.5rem; justify-content: space-between; padding: 1rem 0; }
h1 { font-size: 1.3rem; margin: 0; }
.top p { margin: 0; opacity: .85; }
.time-left { font-weight: 600; }
.layout { display: grid; gap: 1.5rem; grid-template-columns: 1fr; padding-top: 1rem; }
@media (min-width: 48rem) { .layout { grid-template-columns: 15rem 1fr; } }
.rail ol { list-style: none; margin: 0; padding: 0; }
.rail li.phase { border-left: 3px solid var(--line); margin-bottom: .75rem; padding: .25rem 0 .25rem .75rem; }
.rail li.phase.now, .rail li.phase.waiting { border-color: var(--accent); }
.rail li.phase.done { border-color: var(--ok); }
.rail li.phase.stopped { border-color: var(--bad); }
.phase-title { display: block; font-weight: 600; }
.phase-status, .phase-time { display: block; font-size: .85rem; opacity: .85; }
.rail ul.steps { font-size: .85rem; list-style: none; margin: .35rem 0 0; padding: 0; }
.rail details { font-size: .85rem; margin-top: .25rem; }
.step-of { font-size: .85rem; margin: 0 0 .5rem; opacity: .85; }
.card { border: 1px solid var(--line); border-radius: .5rem; margin-bottom: 1rem; padding: 1rem; }
.card h2 { font-size: 1.05rem; margin: 0 0 .5rem; }
.card h3 { font-size: .9rem; margin: .75rem 0 .25rem; }
.card p { margin: 0 0 .35rem; }
.question h2 { font-size: 1.35rem; font-weight: 600; }
.why { margin: 0 0 .5rem; }
.hidden { display: none; }
pre { font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; margin: .5rem 0 0; max-height: 26rem; overflow: auto; white-space: pre-wrap; word-break: break-word; }
summary { cursor: pointer; }
.field { margin-bottom: 1rem; }
.field-label { display: block; font-weight: 600; margin-bottom: .25rem; }
input[type=text], input[type=password], textarea { border: 1px solid rgba(128,128,128,.5); border-radius: .35rem; box-sizing: border-box; font: inherit; padding: .45rem .6rem; width: 100%; }
textarea { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; min-height: 8rem; }
.choices { display: grid; gap: .35rem; margin-bottom: .75rem; }
.choices label { align-items: baseline; display: flex; gap: .5rem; margin: 0; }
.buttons { display: flex; flex-wrap: wrap; gap: .5rem; margin-top: .75rem; }
button, a.button { border: 1px solid rgba(128,128,128,.5); border-radius: .35rem; cursor: pointer; display: inline-block; font: inherit; padding: .45rem 1rem; text-decoration: none; }
button.primary, a.button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
button[disabled] { cursor: progress; opacity: .6; }
.error { color: var(--bad); margin: .6rem 0 0; }
.hint, .note { font-size: .85rem; margin: .35rem 0 0; opacity: .8; }
.card.status.ok { border-color: var(--ok); }
.card.status.waiting { border-color: var(--wait); }
.card.status.failed { border-color: var(--bad); }
ul.checks { list-style: none; margin: .5rem 0 0; padding: 0; }
ul.checks li { padding: .15rem 0; }
.command { align-items: center; display: flex; flex-wrap: wrap; gap: .5rem; margin: .35rem 0; }
.command code { background: rgba(128,128,128,.12); border-radius: .25rem; padding: .2rem .4rem; word-break: break-all; }
`;

export const WIZARD_JS = `// AgentX install wizard. Served from 127.0.0.1 by the AgentX installer; loopback only.
const token = new URL(import.meta.url).searchParams.get(${JSON.stringify(WIZARD_TOKEN_QUERY)}) ?? "";
const TOKEN_HEADER = ${JSON.stringify(WIZARD_TOKEN_HEADER)};
const CARD_PHASES = ${JSON.stringify(CARD_PHASES)};
const STEP_WORDS = ${JSON.stringify(STEP_STATUS_WORDS)};
const byId = (id) => document.getElementById(id);
const show = (id, on) => { byId(id).classList.toggle("hidden", !on); };
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const setText = (id, text) => { byId(id).textContent = text ?? ""; show(id, Boolean(text)); };

let renderedQuestion = null;
let sending = false;
let lastState = null;
let installerClosed = false;

function post(path, body) {
  return fetch(path, { method: "POST", headers: { "content-type": "application/json", [TOKEN_HEADER]: token }, body: JSON.stringify(body ?? {}) });
}

function clockText(seconds) {
  return Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
}

function elapsedText(node) {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(node.dataset.started)) / 1000));
  const usual = Number(node.dataset.usual);
  return " (" + clockText(seconds) + " so far, " + (seconds > usual ? "taking longer than usual" : node.dataset.usualText) + ")";
}

function linkBlock(link) {
  const wrap = el("p");
  const anchor = el("a", "button primary", link.label);
  anchor.href = link.url;
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer";
  wrap.append(anchor);
  if (link.note) wrap.append(el("span", "hint", " " + link.note));
  return wrap;
}

function commandRow(command) {
  const row = el("div", "command");
  const copy = el("button", "", "Copy");
  copy.type = "button";
  copy.addEventListener("click", () => {
    const done = () => { copy.textContent = "Copied"; };
    const failed = () => { copy.textContent = "Select it and copy"; };
    if (navigator.clipboard) navigator.clipboard.writeText(command.command).then(done, failed); else failed();
  });
  row.append(el("span", "", command.label + ":"), el("code", "", command.command), copy);
  return row;
}

function detailsBlock(lines) {
  const details = el("details");
  details.append(el("summary", "", "Technical details"));
  for (const line of lines) details.append(el("p", "", line));
  return details;
}

function renderRail(state) {
  const list = byId("phases");
  list.replaceChildren();
  for (const phase of state.journey.phases) {
    const item = el("li", "phase " + phase.status);
    if (phase.id === state.journey.current) item.setAttribute("aria-current", "step");
    item.append(el("span", "phase-title", phase.title), el("span", "phase-status", phase.statusWord), el("span", "phase-time", phase.timeText));
    const steps = state.steps.filter((step) => step.phase === phase.id);
    if (phase.id === state.journey.current && steps.length > 0) {
      const ul = el("ul", "steps");
      for (const step of steps) {
        const li = el("li", "step " + step.status, step.title + ": " + (STEP_WORDS[step.status] ?? ""));
        if (step.status === "running" && step.startedAt) {
          const time = el("span", "elapsed");
          time.dataset.started = step.startedAt;
          time.dataset.usual = String(step.usualSeconds);
          time.dataset.usualText = step.usualText;
          time.textContent = elapsedText(time);
          li.append(time);
        }
        ul.append(li);
      }
      item.append(ul);
    } else if (phase.status === "done") {
      const finished = steps.filter((step) => step.status === "done" || step.status === "skipped");
      const cards = (state.cards ?? []).filter((card) => CARD_PHASES[card.id] === phase.id && card.status === "ok" && card.id !== "ready");
      if (finished.length + cards.length > 0) {
        const details = el("details");
        details.append(el("summary", "", "Details"));
        for (const step of finished) details.append(el("p", "", step.title + (step.tookSeconds === undefined ? ": done" : ": took " + clockText(step.tookSeconds))));
        for (const card of cards) for (const line of card.lines) details.append(el("p", "", line));
        item.append(details);
      }
    }
    list.append(item);
  }
}

function renderCard(card) {
  const section = el("section", "card status " + card.status);
  section.append(el("h2", "", card.title));
  for (const line of card.lines) section.append(el("p", "", line));
  if (card.checks) {
    const list = el("ul", "checks");
    for (const check of card.checks) list.append(el("li", check.ok ? "ok" : "failed", (check.ok ? "Ready: " : "Not ready: ") + check.label + ". " + check.detail));
    section.append(list);
  }
  if (card.link) section.append(linkBlock(card.link));
  for (const command of card.commands ?? []) section.append(commandRow(command));
  if (card.id === "ready" && !installerClosed) {
    const buttons = el("div", "buttons");
    const close = el("button", "primary", "Close installer");
    close.type = "button";
    close.addEventListener("click", () => { close.disabled = true; post("/close"); });
    buttons.append(close);
    section.append(buttons);
  }
  if (card.details && card.details.length > 0) section.append(detailsBlock(card.details));
  return section;
}

function renderPanelCards(state) {
  const holder = byId("cards");
  holder.replaceChildren();
  const offered = new Set();
  for (const card of state.cards ?? []) {
    const current = CARD_PHASES[card.id] === state.journey.current;
    if (card.status === "ok" && !current && card.id !== "ready") continue;
    holder.append(renderCard(card));
    if (card.link) offered.add(card.link.url);
  }
  const next = state.link && !offered.has(state.link.url) ? state.link : null;
  show("next", Boolean(next));
  byId("next-link").replaceChildren(...(next ? [linkBlock(next)] : []));
}

function renderFailure(failure) {
  show("failure", Boolean(failure));
  if (!failure) return;
  byId("failure-title").textContent = failure.title;
  byId("failure-what").textContent = failure.what;
  byId("failure-next").textContent = failure.next;
  const details = byId("failure-details");
  details.replaceChildren(...failure.details.map((line) => el("p", "", line)));
  if (failure.link) details.append(linkBlock(failure.link));
}

function submit(id, value) {
  if (sending) return;
  sending = true;
  for (const button of document.querySelectorAll("#question button")) button.disabled = true;
  post("/answer", { id, value }).then((response) => response.json()).then((reply) => {
    if (!reply.ok) sending = false;
  }).catch((error) => {
    sending = false;
    setText("question-error", "Could not reach the installer: " + error);
  });
}

function buttonRow(question) {
  const row = el("div", "buttons");
  for (const choice of question.buttons ?? []) {
    const button = el("button", choice.primary ? "primary" : "", choice.label);
    button.type = "button";
    button.addEventListener("click", () => submit(question.id, choice.value));
    row.append(button);
  }
  return row;
}

function sendButton(onSend) {
  const row = el("div", "buttons");
  const send = el("button", "primary", "Continue");
  send.type = "button";
  send.addEventListener("click", onSend);
  row.append(send);
  return row;
}

function hideFromPasswordManagers(field) {
  field.autocomplete = "off";
  field.spellcheck = false;
  field.setAttribute("data-1p-ignore", "");
  field.setAttribute("data-lpignore", "true");
  field.setAttribute("data-bwignore", "");
}

function buildForm(question, body) {
  const inputs = [];
  for (const field of question.fields ?? []) {
    const id = "field-" + field.name;
    const wrap = el("div", "field");
    const label = el("label", "field-label", field.label);
    label.htmlFor = id;
    const input = el("input");
    input.id = id;
    input.type = field.masked ? "password" : "text";
    if (field.masked) hideFromPasswordManagers(input);
    if (field.value) input.value = field.value;
    const notes = [];
    for (const [suffix, text, className] of [["why", field.why, "hint"], ["example", field.example ? "For example: " + field.example : undefined, "hint"], ["hint", field.hint, "hint"], ["error", field.error, "error"]]) {
      if (!text) continue;
      const note = el("p", className, text);
      note.id = id + "-" + suffix;
      notes.push(note);
    }
    if (field.error) input.setAttribute("aria-invalid", "true");
    input.setAttribute("aria-describedby", notes.map((note) => note.id).join(" "));
    wrap.append(label, input, ...notes);
    body.append(wrap);
    inputs.push([field, input]);
  }
  body.append(sendButton(() => {
    const values = Object.fromEntries(inputs.map(([field, input]) => [field.name, input.value]));
    if (!sending) for (const [field, input] of inputs) if (field.masked) input.value = "";
    submit(question.id, JSON.stringify(values));
  }));
}

function buildQuestion(question) {
  const body = byId("question-body");
  body.replaceChildren();
  byId("question-text").textContent = question.label ?? question.text;
  setText("question-why", question.why);
  setText("question-example", question.example ? "For example: " + question.example : undefined);
  setText("question-error", question.error);
  if (question.learnMoreUrl) {
    const more = el("a", "", "Learn more");
    more.href = question.learnMoreUrl;
    more.target = "_blank";
    more.rel = "noopener noreferrer";
    body.append(el("p", "hint"));
    body.lastChild.append(more, " (opens in a new tab)");
  }
  if (question.kind === "confirm" || question.kind === "actions") { body.append(buttonRow(question)); return; }
  if (question.kind === "form") { buildForm(question, body); return; }
  const described = ["question-why", "question-example", "question-error"].filter((id) => !byId(id).classList.contains("hidden"));
  let read;
  if (question.kind === "choose") {
    const group = el("div", "choices");
    group.setAttribute("role", "radiogroup");
    group.setAttribute("aria-labelledby", "question-text");
    for (const choice of question.choices ?? []) {
      const label = el("label");
      const radio = el("input");
      radio.type = "radio";
      radio.name = "choice-" + question.id;
      radio.value = choice.value;
      radio.checked = choice.value === question.defaultValue;
      label.append(radio, el("span", "", choice.label));
      group.append(label);
    }
    body.append(group);
    read = () => { const picked = group.querySelector("input:checked"); return picked ? picked.value : ""; };
  } else {
    const field = question.multiline ? el("textarea") : el("input");
    field.id = "answer-field";
    if (!question.multiline) field.type = question.masked ? "password" : "text";
    if (question.masked) hideFromPasswordManagers(field); else field.autocomplete = "on";
    field.setAttribute("aria-labelledby", "question-text");
    if (question.defaultValue && !question.masked) field.placeholder = question.defaultValue;
    body.append(field);
    if (question.hint) {
      const hint = el("p", "hint", question.hint);
      hint.id = "question-hint";
      described.push(hint.id);
      body.append(hint);
    }
    field.setAttribute("aria-describedby", described.join(" "));
    if (question.error) field.setAttribute("aria-invalid", "true");
    read = () => {
      const value = field.value;
      if (sending) return value;
      if (question.masked) field.value = "";
      return value;
    };
    if (!question.multiline) field.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); submit(question.id, read()); } });
    queueMicrotask(() => field.focus());
  }
  body.append(sendButton(() => submit(question.id, read())));
}

function render(state) {
  lastState = state;
  document.title = state.pageTitle;
  const where = [state.header.installName, state.header.account ? "AWS account " + state.header.account : "", state.header.region ?? ""].filter(Boolean);
  byId("place").textContent = "Install name: " + where.join(", ");
  byId("time-left").textContent = state.journey.timeLeftText;
  const current = state.journey.phases.find((phase) => phase.id === state.journey.current);
  byId("step-of").textContent = "Step " + state.journey.stepNumber + " of " + state.journey.stepCount + (current ? ": " + current.title : "");
  renderRail(state);
  show("welcome", Boolean(state.welcome));
  byId("welcome-body").replaceChildren(...(state.welcome ?? []).map((line) => el("p", "", line)));
  show("resume", Boolean(state.resume));
  if (state.resume) {
    byId("resume-body").replaceChildren(
      el("p", "", state.resume.continueFrom ? "Welcome back. Continuing with: " + state.resume.continueFrom + "." : "Welcome back. Every step is already done."),
      el("p", "", state.resume.completed.length > 0 ? "Already done: " + state.resume.completed.join(", ") + "." : "Nothing has finished yet."),
    );
  }
  renderFailure(state.failure);
  renderPanelCards(state);
  show("plan", Boolean(state.plan));
  if (state.plan) {
    byId("plan-body").textContent = state.plan;
    byId("plan").open = state.steps.every((step) => step.status === "pending");
  }
  const hasReady = (state.cards ?? []).some((card) => card.id === "ready");
  show("outcome", Boolean(state.outcome) && !hasReady);
  if (state.outcome) {
    byId("outcome-title").textContent = state.phase === "failed" ? "The install stopped" : "The install is paused";
    byId("outcome-body").textContent = state.outcome;
    byId("outcome-commands").replaceChildren(...(state.commands ?? []).map(commandRow));
  }
  if (!state.question) {
    renderedQuestion = null;
    sending = false;
    byId("question-body").replaceChildren();
    show("question", false);
    return;
  }
  show("question", true);
  if (state.question.id !== renderedQuestion) {
    renderedQuestion = state.question.id;
    sending = false;
    buildQuestion(state.question);
  }
}

function appendLog(line) {
  const pane = byId("log");
  const atBottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 40;
  pane.append(line + "\\n");
  if (atBottom) pane.scrollTop = pane.scrollHeight;
}

setInterval(() => { for (const node of document.querySelectorAll("[data-started]")) node.textContent = elapsedText(node); }, 1000);

const source = new EventSource("/events?" + ${JSON.stringify(WIZARD_TOKEN_QUERY)} + "=" + encodeURIComponent(token));
source.addEventListener("snapshot", (event) => {
  const snapshot = JSON.parse(event.data);
  byId("log").replaceChildren(snapshot.log.join("\\n") + (snapshot.log.length > 0 ? "\\n" : ""));
  render(snapshot);
});
source.addEventListener("state", (event) => render(JSON.parse(event.data)));
source.addEventListener("log", (event) => appendLog(JSON.parse(event.data)));
source.addEventListener("closed", () => {
  source.close();
  installerClosed = true;
  show("question", false);
  const ready = lastState && (lastState.cards ?? []).some((card) => card.id === "ready");
  const logPath = lastState && lastState.logPath ? lastState.logPath : "the install log";
  byId("closed-note").textContent = ready ? "The installer has closed. Everything on this page is also in " + logPath + "." : "The installer has stopped. You can close this tab.";
  show("closed-note", true);
  if (lastState) render(lastState);
});
source.addEventListener("error", () => {
  if (source.readyState !== EventSource.CLOSED || installerClosed) return;
  byId("closed-note").textContent = "Lost the connection to the installer. If it stopped, start the install again in a terminal; it continues where it left off.";
  show("closed-note", true);
});
`;
```

(Only `MARKS` goes; nothing else imports it. The page still sets every text through `textContent`
or `el(..., text)`. In `buildQuestion`, `body.lastChild.append(more, " (opens in a new tab)")` appends
a text node, not markup.)

- [ ] **Step 4: Run tests to verify they pass, then every wizard suite**

Run: `npx vitest run tests/contract/init-ui-page.test.ts tests/contract/init-ui-*.test.ts`
Expected: PASS. An existing page test that asserted removed markup (the `Steps` and `Log` cards, the
`<h2>Finished</h2>`, the `MARKS` symbols, "Leave empty for") is replaced by the matching new
assertion from this task's test, with the same strength (an exact string or pattern).

- [ ] **Step 5: Look at it once in a browser**

Run `npm run build`, then a scratch script (in the session's scratch directory, not the repo) that
calls `startInstallWizard({ env: "staging", write: console.log })` from
`packages/cli/dist/init/ui/index.js`, feeds its hub a few states (`setSteps`, a question, a card, a
failure, a ready card), and keeps running; open the printed address. Check, at about 1280 and about 400 pixels wide:
the rail is on the left (on top when narrow), one panel, the tab title changes, and the plan and log
are collapsed. Fix layout bugs in `WIZARD_CSS` only. Do not commit the scratch script.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/init/ui/page.ts packages/cli/src/init/ui/journey.ts tests/contract
git commit -m "feat(init): the install page shell, a progress rail and one current-step panel (048 FR-001, FR-003, FR-004, FR-006, FR-008)"
```

---

### Task 16: The whole journey passes the copy-lint, every question has its help, then the gate (FR-010, FR-081, SC-001, SC-011)

**Files:**
- Modify: `tests/support/copy-lint.ts` (new `stateEntries`)
- Modify: `tests/contract/init-ui-copy-lint.test.ts` (the whole-journey tests)
- Modify: whatever source the lint names (the fixes it forces)

**Interfaces:**
- Consumes: every earlier task.
- Produces: `stateEntries(state: WizardState, where: string): CopyEntry[]` (phase 2 and 3 reuse it for their screens).

- [ ] **Step 1: Write the failing test**

Add to `tests/support/copy-lint.ts`:

```ts
import type { WizardState } from "../../packages/cli/src/init/ui/protocol.js";

/** Every word a state puts on the page, with where it may say what (FR-081). The question's own
 * terminal text is left out when the page shows its label instead. */
export function stateEntries(state: WizardState, where: string): CopyEntry[] {
  const failedRun = state.phase === "failed";
  const at = (text: string, part: string, context: CopyContext = "page"): CopyEntry => ({ where: `${where}: ${part}`, text, context, failedRun });
  const entries: CopyEntry[] = [at(state.pageTitle, "tab title"), at(state.journey.timeLeftText, "time left")];
  for (const phase of state.journey.phases) entries.push(at(phase.title, "rail"), at(phase.statusWord, "rail"), at(phase.timeText, "rail"));
  for (const step of state.steps) entries.push(at(step.title, "step"), at(step.usualText, "step"));
  for (const line of state.welcome ?? []) entries.push(at(line, "welcome"));
  if (state.resume !== undefined) entries.push(...state.resume.completed.map((title) => at(title, "resume")), ...(state.resume.continueFrom === undefined ? [] : [at(state.resume.continueFrom, "resume")]));
  const question = state.question;
  if (question !== undefined) {
    entries.push(at(question.label ?? question.text, "question"));
    for (const text of [question.why, question.example, question.hint, question.error]) if (text !== undefined) entries.push(at(text, "question help"));
    for (const choice of question.choices ?? []) entries.push(at(choice.label, "choice"));
    for (const button of question.buttons ?? []) entries.push(at(button.label, "button"));
    for (const field of question.fields ?? []) for (const text of [field.label, field.why, field.example, field.hint, field.error]) if (text !== undefined) entries.push(at(text, "form field"));
  }
  for (const card of state.cards ?? []) {
    const context: CopyContext = card.id === "ready" ? "ready" : "page";
    entries.push(at(card.title, `${card.id} card`, context), ...card.lines.map((line) => at(line, `${card.id} card`, context)));
    for (const check of card.checks ?? []) entries.push(at(check.label, `${card.id} check`), at(check.detail, `${card.id} check`));
    if (card.link !== undefined) entries.push(at(card.link.label, `${card.id} link`), ...(card.link.note === undefined ? [] : [at(card.link.note, `${card.id} link`)]));
    for (const command of card.commands ?? []) entries.push(at(command.label, `${card.id} command`, context), at(command.command, `${card.id} command`, context));
    for (const line of card.details ?? []) entries.push(at(line, `${card.id} details`, "details"));
  }
  if (state.link !== undefined) entries.push(at(state.link.label, "run link"));
  if (state.failure !== undefined) {
    entries.push(at(state.failure.title, "failure"), at(state.failure.what, "failure"), at(state.failure.next, "failure"));
    entries.push(...state.failure.details.map((line) => at(line, "failure details", "details")));
    if (state.failure.link !== undefined) entries.push(at(state.failure.link.label, "failure details", "details"));
  }
  if (state.outcome !== undefined) entries.push(at(state.outcome, "outcome"));
  for (const command of state.commands ?? []) entries.push(at(command.label, "stop for now", "stop-for-now"), at(command.command, "stop for now", "stop-for-now"));
  if (state.plan !== undefined) for (const line of state.plan.split("\n")) if (line.trim() !== "") entries.push(at(line, "plan"));
  return entries;
}
```

Add to `tests/contract/init-ui-copy-lint.test.ts` a whole-journey section. It reuses the
`init-ui-cli.test.ts` harness: move `harness()`, `releaseDir()`, `FIRST_RUN`, `SLACK`, `SIGNIN`,
`FINISH` and `finishStackOutputs()` into `tests/support/init-ui-harness.ts` (exported, unchanged) and
import them in both files.

```ts
import { environmentStackName } from "@agentx/contracts";
import { FINISH, FIRST_RUN, harness, SIGNIN, SLACK } from "../support/init-ui-harness.js";
import { fakeWizardOperator } from "../support/wizard-browser.js";
import { stateEntries } from "../support/copy-lint.js";

describe("SC-011: the whole install, as the page shows it", () => {
  it("a first install says no internal word anywhere on the page", async () => {
    const h = await harness();
    const { code, operator } = await h.runUi([...FIRST_RUN, ...SLACK, ...SIGNIN, ...FINISH]);
    expect(code).toBe(0);
    expect(lintCopy(operator.states.flatMap((state, index) => stateEntries(state, `state ${index}`)))).toEqual([]);
  });

  it("a failed and retried step says no internal word either", async () => {
    const h = await harness();
    h.deployer.fail.set(environmentStackName("staging", "control-plane"), new Error("Resource limit exceeded"));
    const operator = fakeWizardOperator([...FIRST_RUN, "retry", ...SLACK, ...SIGNIN, ...FINISH], {
      beforeAnswer: async (question) => { if (question.text === "The install stopped. What next?") h.deployer.fail.clear(); },
    });
    expect(await h.run(["--ui"], { openBrowser: operator.open })).toBe(0);
    await operator.settled();
    expect(lintCopy(operator.states.flatMap((state, index) => stateEntries(state, `state ${index}`)))).toEqual([]);
  });

  it("a stopped install says no internal word, and never Finished", async () => {
    const h = await harness();
    h.deployer.fail.set(environmentStackName("staging", "control-plane"), new Error("Resource limit exceeded"));
    const { operator } = await h.runUi([...FIRST_RUN, "stop"]);
    expect(lintCopy(operator.states.flatMap((state, index) => stateEntries(state, `state ${index}`)))).toEqual([]);
  });

  it("FR-010 and FR-011: every question of a first install has a label, a why line, and verb buttons", async () => {
    const h = await harness();
    const { operator } = await h.runUi([...FIRST_RUN, ...SLACK, ...SIGNIN, ...FINISH]);
    const questions = new Map(operator.states.flatMap((state) => (state.question === undefined ? [] : [[state.question.id, state.question] as const])));
    expect(questions.size).toBeGreaterThan(20);
    for (const question of questions.values()) {
      expect({ text: question.text, label: question.label }).toMatchObject({ label: expect.stringMatching(/\S/) });
      expect({ text: question.text, why: question.why }).toMatchObject({ why: expect.stringMatching(/\S/) });
      if (question.kind === "ask" && question.defaultValue !== undefined) expect({ text: question.text, hint: question.hint }).toMatchObject({ hint: expect.stringMatching(/\S/) });
      for (const button of question.buttons ?? []) expect(["Yes", "No"]).not.toContain(button.label);
    }
  });

  it("SC-001: every state shows the phase, step N of 5 and the time left", async () => {
    const h = await harness();
    const { operator } = await h.runUi([...FIRST_RUN, ...SLACK, ...SIGNIN, ...FINISH]);
    for (const state of operator.states) {
      expect(state.journey.stepCount).toBe(5);
      expect(state.journey.stepNumber).toBeGreaterThanOrEqual(1);
      expect(state.journey.phases.find((phase) => phase.id === state.journey.current)?.title).toMatch(/\S/);
      expect(state.journey.timeLeftText).toMatch(/\S/);
    }
  });
});
```

(`{ text, label }` objects make a failure name the question that broke the rule.)

- [ ] **Step 2: Run the tests and read every finding**

Run: `npx vitest run tests/contract/init-ui-copy-lint.test.ts`
Expected: FAIL at first with a list of findings; each names the rule, the state part, the match
and the whole text, for example
`terminal-instruction in state 41: question: "--signin" in "..."`.

- [ ] **Step 3: Fix each finding at its source**

For each finding, change the words where they are made, never the rule and never the test:
- a question without a catalog entry: add its entry to `QUESTION_COPY` (label, why, and for a confirm
  its two verb labels);
- a card line or a check detail: reword it in `cards.ts` or `prerequisites.ts` (page wording),
  moving a raw value into `details` or `technical`;
- a plan line: reword it in `plan.ts` (the plan is page text in this phase);
- a log line is technical (details) and never a finding.

Rerun after each fix until the list is empty. If a finding is a false positive of a rule (a plain
word the pattern catches by accident), narrow that rule's pattern in `tests/support/copy-lint.ts`,
add the plain word to Task 2's `GOOD` list and keep its seeded example failing, so the rule is
still proven.

- [ ] **Step 4: Run the whole gate on Node 22**

```bash
export PATH=/private/tmp/claude-501/node-v22.20.0-darwin-arm64/bin:$PATH
node --version
npm run typecheck:all && npm run lint && npm run build && npm test && npm run infra:synth
git status --short tests/contract/__snapshots__
```

Expected: `node --version` prints v22.x; every command exits 0; `typecheck:all` reports no more
errors than the baseline; the snapshot directory shows no change (this phase does not touch
templates).

- [ ] **Step 5: Check the copy rules once more by hand**

```bash
git diff origin/mainline -- packages docs | grep -nP '^\+.*\x{2014}' && echo "em dash found" || echo "no em dash"
git diff origin/mainline --stat
```

Expected: "no em dash"; only files under `packages/cli`, `tests`, `docs/install.md` changed.

- [ ] **Step 6: Commit**

```bash
git add tests packages docs
git commit -m "test(init): the whole install passes the copy-lint, and every question has its help (048 FR-010, FR-081, SC-001, SC-011)"
```

---

## Self-Review

**1. Spec coverage (phase 1 row of the spec's Phases table):**

| Requirement | Task |
|---|---|
| FR-001 rail, statuses in words, slim header | 1, 3, 15 |
| FR-002 estimates stored with the steps, elapsed time, "taking longer than usual" (first estimates; measured numbers are phase 4) | 1, 3, 15 |
| FR-003 one current-step panel; finished steps collapse with Details | 15 |
| FR-004 plan and log behind links | 15 |
| FR-005 tab title (the notification is phase 4) | 3, 15 |
| FR-006 welcome screen | 1, 3, 15 |
| FR-008 aria-live, labels, errors tied to fields, large plain-case question | 15 |
| FR-010 label, why, example, default, Learn more | 4, 16 |
| FR-011 verb buttons; forward action primary | 4, 15 |
| FR-012 forms with per-field checks | 5 |
| FR-016 root warning, Continue as root, ready screen names day-two limits | 8, 14 |
| FR-017 plain one-time account tip | 8 |
| FR-023 budget default, whole account, estimate beside it, tag scope's sentence | 9 (the tag scope is still offered with the question, as today; moving it under Advanced is phase 2's FR-021) |
| FR-024, FR-082 every model priced or "price not on file", total names what it leaves out | 9 |
| FR-026 one name pattern, assigned handle used from then on | 7, 10 |
| FR-027 one name per thing, names not IDs | 6, 7, 14 |
| FR-037 link buttons that say they open a new tab; GitHub tab closes itself | 3, 7 |
| FR-058, FR-059 ready screen once, stays up to 30 minutes, commands with `--env`, log has the summary, #222 | 13, 14 |
| FR-060 failure screen in three parts, Stopped in the rail, no "Finished", codes only in details | 12, 15, 16 |
| FR-070, FR-071 quiet terminal, log file without the token | 13 |
| FR-080, FR-081 glossary words, copy-lint over every source of page text | 2, 6, 7, 9, 11, 16 |
| FR-065 (image check only) and SC-009 for it | 11 |

Not in this phase, by the spec's table: FR-007 (real build rows), FR-009 (download on the page),
FR-015, FR-018, FR-020 to FR-022, FR-025, FR-028 to FR-036, FR-038, FR-050 to FR-057, FR-061 to
FR-067 beyond "Try this step again" and "Stop for now", FR-072. "Change the worker image" as a page
action (User Story 4, scenario 1) is FR-061's, phase 3; this phase reports the image problem before
anything is created, in plain words, which is the FR-065 part phase 1 owns.

**2. Placeholder scan:** no "TBD" or "similar to Task N"; every code step has its code. Two steps
are verification, not code: Task 10's GitHub name-character check and Task 15's look in a browser.

**3. Type consistency:** `STEP_PLAN`, `journeyOf`, `WizardFailure`, `CliInvocation`,
`cliCommandLine`, `botNameOf`, `readyCard`'s input and `askFailureAction` are used with the
signatures their producing tasks define. `ModelRole` comes from `prerequisites.ts` everywhere.
`StepStatus` gains `"failed"` in Task 3 before Task 15's `STEP_STATUS_WORDS` uses it.

**4. Review Focus:** each of the five lines has its pinned test in the named task (Tasks 1, 12, 5,
10, 9).

## Rulings On Spec Ambiguities

1. **The GitHub app name includes the owner.** FR-026's example is "AgentX (<install name>)", but
   GitHub app names are unique across GitHub, so that name would clash for the second team to use
   it. The default is "AgentX <owner> (<install name>)", dropping the owner when it does not fit in
   34 characters; both apps share it. Task 10 also checks that GitHub accepts parentheses.
2. **The welcome screen has no Start button.** FR-006 lists what it says, not a button; the welcome
   shows above the first question, which saves a page action toward SC-007.
3. **The ready hold is a page button, not a question.** "Close installer" posts to `POST /close`,
   so a test driving questions never has to answer it, and the 30-minute timer is cleared the moment
   it is pressed.
4. **An unpublished CLI is shown by its own path** (`node <path> ...`), with a line saying other
   computers need a copy first (#222). The published package is named only when the CLI runs from it.
5. **The AWS account ID stays on the page** (FR-015 asks for it); the copy-lint bans ARNs, Slack IDs
   and other raw IDs outside technical details.
6. **The SSH line is a fourth start line, only when no browser opened**: without it the page
   cannot be reached.
7. **The GitHub app stays under "Build in AWS"** until phase 2 moves it before the build.
8. **A stop the person chose is not a failure**: declining the plan, Stop for now, stopping at the
   root warning, or saying no to "check again" shows no second failure screen.
9. **Questions off the default path** (your own OIDC, OpenRouter, Linear, Jira, Asana) get their
   page help in phase 2, when they move under Advanced settings; phase 1 covers the default path,
   the retry questions and the Slack questions, which is what the journey test can prove.

## Execution Handoff

Plan complete and saved to `specs/048-guided-install/plans/phase-1-page-shell.md`. Please review
the plan. Which execution approach would you prefer?

- **Subagent-driven:** a fresh subagent implements each task and a fresh reviewer checks it before
  the next one starts, then a whole-branch review at the end. Most thorough; costs a fresh context
  per task and per review.
- **Native:** one session implements every task, then one fresh reviewer on the most capable model
  checks the whole branch. Cheapest and fastest; no independent review until the end.

**Recommendation: subagent-driven**, because the 16 tasks share protocol types that later tasks
consume (the page shell renders fields from six earlier tasks), and several tasks rewrite existing
test expectations, where a per-task reviewer is the cheapest way to catch a weakened assertion
before it ships.
