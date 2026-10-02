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

/** An address is kept as it is written: "Https://" is not an address. */
const capitalize = (text: string): string => (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `${text.charAt(0).toUpperCase()}${text.slice(1)}`);

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
