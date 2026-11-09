// The one-screen plan (design proof-test-env, 3.8): a plan read at a glance, derived from the plan document with no model call. It holds the problem, the approach, the files that change,
// the top three risks, the cost and time, and how Rovara will know each top claim works. The whole text is capped at about 1,500 characters; a plan that does not fit is "too big" (a
// finding, never a block) and the person is told to split it. Browser-safe: nothing here imports a Node module.
import { z } from "zod";

/** The most characters the one-screen text holds. */
export const PLAN_ONE_SCREEN_MAX_CHARS = 1_500;
/** The most claims, files and risks the one-screen plan lists. */
export const PLAN_ONE_SCREEN_APPROACH_MAX = 5;
export const PLAN_ONE_SCREEN_FILES_MAX = 8;
export const PLAN_ONE_SCREEN_RISKS_MAX = 3;

/** How a top claim will be proved, in fixed words. `not_planned` means no check in the plan names the claim. */
export const PLAN_ONE_SCREEN_PROOF_KINDS = ["test", "api", "browser", "check", "not_planned"] as const;
export type PlanOneScreenProofKind = (typeof PLAN_ONE_SCREEN_PROOF_KINDS)[number];

const oneLine = (max: number) => z.string().min(1).max(max).regex(/^[^\p{Cc}\p{Cf}]*$/u, "one plain line");

export const PlanOneScreenSchema = z
  .object({
    problem: oneLine(240),
    approach: z.array(oneLine(160)).min(1).max(PLAN_ONE_SCREEN_APPROACH_MAX),
    files: z.array(oneLine(80)).max(PLAN_ONE_SCREEN_FILES_MAX),
    /** How many more files the plan names than this lists. */
    filesMore: z.number().int().min(0).max(100_000),
    risks: z.array(oneLine(120)).max(PLAN_ONE_SCREEN_RISKS_MAX),
    /** "about $1.20 to $3.10, 12 to 25 minutes"; absent when the task has no estimate. */
    cost: oneLine(120).optional(),
    proof: z.array(z.object({ claim: oneLine(120), how: z.enum(PLAN_ONE_SCREEN_PROOF_KINDS) }).strict()).max(PLAN_ONE_SCREEN_APPROACH_MAX),
    /** The characters the text below takes on screen (always at most the cap). */
    characters: z.number().int().min(0).max(PLAN_ONE_SCREEN_MAX_CHARS),
    /** The characters the plan would take with nothing cut. */
    fullCharacters: z.number().int().min(0).max(1_000_000),
    /** True when the plan would not fit uncut: split it. */
    tooBig: z.boolean(),
  })
  .strict()
  .refine((view) => view.tooBig === view.fullCharacters > PLAN_ONE_SCREEN_MAX_CHARS, { message: "tooBig says whether the full plan is over the cap", path: ["tooBig"] });
export type PlanOneScreen = z.infer<typeof PlanOneScreenSchema>;

export const PLAN_PROOF_WORDS: Record<PlanOneScreenProofKind, string> = {
  test: "a test",
  api: "an API check",
  browser: "a browser check",
  check: "a check",
  not_planned: "no check planned",
};

/** What a plan too big for one screen says to the owner. */
export const planTooBigSentence = (characters: number): string =>
  `The plan is about ${String(characters)} characters, more than fits on one screen (${String(PLAN_ONE_SCREEN_MAX_CHARS)}). Consider splitting it into smaller tasks.`;
