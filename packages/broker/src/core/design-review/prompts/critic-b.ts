// Adapted from the Elephant-Goldfish Model (github.com/google/elephant-goldfish-model, commit 464db031e), `agents/design_critic.md` and `agents/synthesizer.md` (its A/B sampling of each reviewer), Copyright 2026 Google LLC, Apache License 2.0.
// Modified by Rovara (PrepLabsAI): the second sample is a separate fresh session of the critic with an independence reminder, used by the Thorough tier only, with the same strict JSON findings.
import { COMMON_RULES, CITATION_TEXT, DESIGN_TEMPLATE_TEXT, SEVERITY_TEXT, assemblePrompt, reviewerOutputText, type ReviewPrompt } from "./common.js";
import { CRITIC_ROLE_TEXT, CRITIC_STEPS_TEXT } from "./critic.js";

export const CRITIC_B_PROMPT: ReviewPrompt = {
  id: "design-review-critic-b",
  version: 3,
  text: assemblePrompt([
    COMMON_RULES,
    CRITIC_ROLE_TEXT,
    "You are the second, independent critic. Another critic is reviewing the same design in a separate session and you cannot see their work. Do not try to guess what they will say. Work through the design on your own, and give extra attention to the places a first pass tends to skim: the seams between sections, error and failure paths, what happens on the second run or the thousandth, and what the design assumes without saying so.",
    DESIGN_TEMPLATE_TEXT,
    CRITIC_STEPS_TEXT,
    SEVERITY_TEXT,
    CITATION_TEXT,
    reviewerOutputText(false),
  ]),
};
