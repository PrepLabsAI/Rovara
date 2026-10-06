// packages/cli/src/init/ui/journey.ts
// Spec 048 FR-001, FR-002, FR-006, FR-070 and FR-080: the five phases of the install, every
// step's plain name, phase and usual time, and the words for where the install is. Pure: no clock
// and no I/O, so the hub, the page, the terminal lines and the step titles read one source.
// Phase 2 moves steps between phases here; phase 4 replaces the first estimates with measured ones.
import type { InitStepId } from "../install-state.js";
import type { CardId, StepStatus } from "./protocol.js";

export const JOURNEY_PHASE_IDS = ["get-started", "your-choices", "build", "connect", "finish"] as const;
export type JourneyPhaseId = (typeof JOURNEY_PHASE_IDS)[number];

export const PHASE_TITLES: Readonly<Record<JourneyPhaseId, string>> = {
  "get-started": "Get started", "your-choices": "Your choices", build: "Build in AWS", connect: "Connect GitHub and Slack", finish: "Finish",
};

export type JourneyStatus = "done" | "now" | "waiting" | "coming" | "stopped";
/** FR-001: a status word for every phase, so status is never color or a symbol alone. */
export const STATUS_WORDS: Readonly<Record<JourneyStatus, string>> = {
  done: "Done", now: "Now", waiting: "Waiting for you", coming: "Coming up", stopped: "Stopped",
};

/** FR-003: which phase each card belongs to, so a finished one collapses into that phase in the rail. */
export const CARD_PHASES: Readonly<Record<CardId, JourneyPhaseId>> = {
  release: "get-started", aws: "get-started", "aws-signin": "get-started", "account-checks": "get-started", prerequisites: "your-choices", github: "connect", slack: "connect", "slack-urls": "connect",
  admin: "finish", project: "finish", channel: "finish", connectors: "finish", alerts: "finish", reply: "finish", ready: "finish",
};

export const STEP_STATUS_WORDS: Readonly<Record<StepStatus, string>> = {
  pending: "Coming up", running: "Now", done: "Done", skipped: "Done", waiting: "Waiting for you", failed: "Stopped",
};

export interface StepPlan { phase: JourneyPhaseId; title: string; usualSeconds: number; needsYou: boolean }

/** The order the steps run in: every stack in one unattended build, then the GitHub and Slack apps
 * together, so a person is needed before the build and after it, never in the middle. (Spec 048
 * FR-031 put the GitHub app before the build; the build no longer needs it.) INIT_STEP_IDS keeps
 * its own order: it is the progress schema's list, and a done step is skipped by its id wherever
 * it now stands. */
export const INSTALL_STEP_ORDER: readonly InitStepId[] = [
  "prerequisites", "access", "core", "control-plane", "slack-service", "github-app", "slack-app", "slack-check", "developer-signin",
  "admin-user", "first-project", "connectors", "alerts", "e2e",
];

/** First estimates from the live run of 2026-10-01 (spec 048 Assumptions). Phase 4 replaces them
 * with numbers measured on two clean runs (FR-002). */
export const STEP_PLAN: Readonly<Record<InitStepId, StepPlan>> = {
  prerequisites: { phase: "your-choices", title: "Check your account and choices", usualSeconds: 30, needsYou: false },
  "github-app": { phase: "connect", title: "Create the GitHub app", usualSeconds: 120, needsYou: true },
  access: { phase: "build", title: "Set up AWS permissions", usualSeconds: 60, needsYou: false },
  core: { phase: "build", title: "Build the network and sign-in", usualSeconds: 240, needsYou: false },
  "control-plane": { phase: "build", title: "Start the AgentX service", usualSeconds: 780, needsYou: false },
  "slack-service": { phase: "build", title: "Start the Slack connection", usualSeconds: 180, needsYou: false },
  "slack-app": { phase: "connect", title: "Create the Slack app", usualSeconds: 240, needsYou: true },
  "slack-check": { phase: "connect", title: "Check that Slack reaches AgentX", usualSeconds: 60, needsYou: true },
  // FR-030: part of the confirmed plan; it asks nothing (Task 13).
  "developer-signin": { phase: "connect", title: "Turn on developer sign-in", usualSeconds: 120, needsYou: false },
  "admin-user": { phase: "finish", title: "Sign in to AgentX", usualSeconds: 120, needsYou: true },
  "first-project": { phase: "finish", title: "Set up your first project", usualSeconds: 120, needsYou: true },
  connectors: { phase: "finish", title: "Connect your issue trackers", usualSeconds: 60, needsYou: true },
  alerts: { phase: "finish", title: "Turn on alerts", usualSeconds: 60, needsYou: true },
  e2e: { phase: "finish", title: "Get a first reply in Slack", usualSeconds: 60, needsYou: true },
};

/** The screens before the first step: profile, region and account; then the questions and the plan. */
export const BEFORE_STEPS_SECONDS: Readonly<Record<"get-started" | "your-choices", number>> = { "get-started": 120, "your-choices": 300 };

const stepsIn = (phase: JourneyPhaseId): InitStepId[] => INSTALL_STEP_ORDER.filter((id) => STEP_PLAN[id].phase === phase);
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
    + INSTALL_STEP_ORDER.filter((id) => STEP_PLAN[id].needsYou).reduce((sum, id) => sum + STEP_PLAN[id].usualSeconds, 0);
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
  // Owner decision, 2026-10-02: a stopped run's header says "Stopped", not a time estimate (not
  // even "Taking longer than usual"); the estimate returns once a retry resumes the run.
  const timeLeftText = input.finished ? "Done"
    : input.stopped ? "Stopped"
      : overdue ? `Taking longer than usual.${minutesLeft > 0 ? ` About ${minutesLeft} ${minutesLeft === 1 ? "minute" : "minutes"} after this step.` : ""}`
        : minutesLeft === 0 ? "Less than a minute left" : minutesLeft === 1 ? "About 1 minute left" : `About ${minutesLeft} minutes left`;
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
