// "How we work" in Rovara Code is a file in the project's repository: `.rovara/playbook.yaml`, reviewed in a pull request like any other change. This file is the contract of that
// file. Cloud keeps the same settings in its own store and edits them in a web page; the two are one model: the file's `rules` and `stages` are a project process layer on top of Rovara
// Code (the instruction text of a stage, nothing else), and `designReview` is the project's design review setting (`DesignReviewSettingSchema`).
//
// The file is data from a repository, so it is read strictly: bounded in size, YAML only in its plain core form, no setting this release does not know, every text made inert. It never
// changes which stages there are, never adds skills and never writes rules for the stages Rovara does not read rules for (check, pull request). A person with write access to the
// repository can edit it, so it ranks below the company's rules in the standing block and is read from the base branch, never from a task's own branch.
// Browser-safe: nothing here imports a Node module.
import { z } from "zod";
import { DesignReviewSettingSchema } from "./design-review.js";

/** Where the file lives in the repository. */
export const PLAYBOOK_FILE_PATH = ".rovara/playbook.yaml";
export const PLAYBOOK_FILE_VERSION = 1;
/** A file bigger than this is refused unread. */
export const PLAYBOOK_FILE_MAX_BYTES = 65_536;
/** The most characters one rule text (the project-wide rules, or one stage's instructions) can have. */
export const PLAYBOOK_RULE_TEXT_MAX = 4_000;
/** The most separate lines a list form of a text can have. */
export const PLAYBOOK_RULE_LINES_MAX = 100;

/** The stages whose instructions the file may write. The other two stages of Rovara Code read no rules: see `PLAYBOOK_UNUSED_STAGES`. */
export const PLAYBOOK_STAGE_IDS = ["plan", "plan_critic", "build", "review"] as const;
export type PlaybookStageId = (typeof PLAYBOOK_STAGE_IDS)[number];
/** The stages that read no rules yet: a file that writes any is refused (`HOW_WE_WORK_UNUSED_STAGE_NOTE`). */
export const PLAYBOOK_UNUSED_STAGES = ["check", "pull_request"] as const;

/** A text may be one block (usually a YAML block scalar) or a list of lines; a list is joined with newlines. */
const TextSchema = z.union([z.string(), z.array(z.string()).max(PLAYBOOK_RULE_LINES_MAX)], { error: "must be text, or a list of lines of text" });
export type PlaybookText = z.infer<typeof TextSchema>;

const StageSchema = z.object({ instructions: TextSchema.optional() }).strict();

export const PlaybookFileSchema = z
  .object({
    version: z.literal(PLAYBOOK_FILE_VERSION),
    /** Only Rovara Code itself. A project's own process layer is an agent of Cloud, not a file. Accepted so a file can say so. */
    process: z.literal("builtin").optional(),
    /** Rules for the whole process: what the planner and the builder are told. The stages that check work (plan check, review) do not read them. */
    rules: TextSchema.optional(),
    stages: z.object(Object.fromEntries(PLAYBOOK_STAGE_IDS.map((id) => [id, StageSchema.optional()])) as Record<PlaybookStageId, z.ZodOptional<typeof StageSchema>>).strict().optional(),
    /** The same setting Cloud stores. Only `maintainers` may approve a high-risk design here (a person or a group is a Cloud setting). */
    designReview: DesignReviewSettingSchema.optional(),
  })
  .strict();
export type PlaybookFile = z.infer<typeof PlaybookFileSchema>;

/** One thing wrong with a file, as a person reads it. `path` is where in the file; the message never quotes the file. */
export interface PlaybookProblem { path: string; message: string }

export type PlaybookParse = { ok: true; file: PlaybookFile } | { ok: false; problems: PlaybookProblem[] };

/** What a file with nothing in it means: no rules, no setting. */
export const EMPTY_PLAYBOOK_FILE: PlaybookFile = { version: PLAYBOOK_FILE_VERSION };

/** What `rovara playbook init` writes: every section present and commented, nothing switched on. */
export const PLAYBOOK_FILE_TEMPLATE = `# How we work in this project (Rovara Code).
# Reviewed in a pull request like any other file. Rovara reads it from the repository's default branch.
version: 1

# Rules for the whole process. The planner and the builder are told them; the plan check and the review are not.
# rules: |
#   Every change adds or updates a test.

# Rules for one stage. The stages are plan, plan_critic (the plan check), build and review.
# stages:
#   plan:
#     instructions: |
#       Name every file the change touches.
#   build:
#     instructions: |
#       Run the repository's own test command before you finish.

# Design review before the plan. Without this section it is off. Maintainers approve a high-risk design.
# designReview:
#   mode: auto          # auto, always or never
#   tier: standard      # light, standard or thorough
#   allowSkip: true
#   capUsdPerTask: 15
#   highRiskApprover: { kind: maintainers }
`;
