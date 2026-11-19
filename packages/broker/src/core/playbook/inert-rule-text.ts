// "How we work": the rules a maintainer writes for a project's process layer reach models, so the server makes them inert when the draft is saved. Hidden characters (zero-width,
// bidirectional controls, every other format character, controls except newline and tab, variation selectors) are removed, the text is trimmed, and one text is at most 4,000 characters.
// This applies to a process layer only (`purpose: "process"`); ordinary agents keep what they write.
import { PLAYBOOK_RULE_TEXT_MAX, agentXError, type RecipeOverlay } from "@agentx/contracts";

/** The most characters one rule text (project-wide rules, or one stage's instructions) can have. */
export const RULE_TEXT_MAX = PLAYBOOK_RULE_TEXT_MAX;
export const RULE_TEXT_TOO_LONG_MESSAGE = "must be at most 4,000 characters";

/**
 * The same classes as the rule-file filter (`packages/worker/src/context-text.ts`): format characters (zero-width, bidi, tags, soft hyphen), the controls that are neither
 * newline nor tab, surrogates, private-use and unassigned code points, every other default-ignorable code point (Hangul fillers, the combining grapheme joiner) and the
 * variation selectors (standard and supplementary).
 */
const HIDDEN = /[\p{Cf}\p{Cc}\p{Co}\p{Cn}\p{Cs}\p{Default_Ignorable_Code_Point}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]/gu;

/** One rule text, inert: line ends are `\n`, hidden characters are gone, and the ends are trimmed. */
export function inertRuleText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(HIDDEN, (character) => (character === "\n" || character === "\t" ? character : ""))
    .trim();
}

const tooLong = (path: string) => agentXError("CONFIG_INVALID", `${path}: ${RULE_TEXT_TOO_LONG_MESSAGE}`);

function inertOrRefuse(text: string, path: string): string {
  const inert = inertRuleText(text);
  if (Array.from(inert).length > RULE_TEXT_MAX) throw tooLong(path);
  return inert;
}

/**
 * The overlay of a process layer with its rule texts made inert: the project-wide `instructions` and each stage's `instructions`. A text over the limit (counted in characters, after the
 * hidden ones are removed) is `CONFIG_INVALID`. An agent that is not a process layer, and an overlay with no rule text, come back as they are.
 */
export function inertProcessOverlay(agent: { purpose?: string | undefined }, overlay: RecipeOverlay): RecipeOverlay {
  if (agent.purpose !== "process") return overlay;
  const next: RecipeOverlay = { ...overlay };
  if (typeof overlay.instructions === "string") next.instructions = inertOrRefuse(overlay.instructions, "instructions");
  if (overlay.steps !== undefined) {
    next.steps = Object.fromEntries(
      Object.entries(overlay.steps).map(([id, settings]) => [id, typeof settings.instructions === "string" ? { ...settings, instructions: inertOrRefuse(settings.instructions, `steps.${id}.instructions`) } : settings]),
    );
  }
  return next;
}
