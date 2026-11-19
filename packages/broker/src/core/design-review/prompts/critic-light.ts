// Adapted from the Elephant-Goldfish Model (github.com/google/elephant-goldfish-model, commit 464db031e), `agents/design_critic.md` and `agents/zoom_out.md`, Copyright 2026 Google LLC, Apache License 2.0.
// Modified by Rovara (PrepLabsAI): the two roles are one critic with two lenses (failure modes, then over-building and reuse), REVIEW mode only, the target standard is the fixed design template, and findings are strict JSON with citations.
import { LIGHT_CRITIC_PROMPT_ID } from "@agentx/contracts";
import { COMMON_RULES, CITATION_TEXT, DESIGN_TEMPLATE_TEXT, SEVERITY_TEXT, assemblePrompt, reviewerOutputText, type ReviewPrompt } from "./common.js";
import { CRITIC_ROLE_TEXT, CRITIC_STEPS_TEXT } from "./critic.js";

/** The Light tier runs one Critic and no Comprehension reviewer, so this Critic also writes the paraphrase the approver compares with the request. */
export const PARAPHRASE_STEP_TEXT = [
  "FIRST, THE PARAPHRASE",
  "Before you look for problems, write in your own words what the design proposes, and how the existing system works as the design describes it (2 to 5 sentences each). The approver compares your paraphrase with the request, so a wrong or thin paraphrase is itself useful. If you cannot paraphrase a section, say so in a finding. You are not given the request; paraphrase from the design alone.",
].join("\n");

export const CRITIC_LIGHT_PROMPT: ReviewPrompt = {
  id: LIGHT_CRITIC_PROMPT_ID,
  version: 2,
  text: assemblePrompt([COMMON_RULES, CRITIC_ROLE_TEXT, DESIGN_TEMPLATE_TEXT, PARAPHRASE_STEP_TEXT, CRITIC_STEPS_TEXT, SEVERITY_TEXT, CITATION_TEXT, reviewerOutputText(true)]),
};
