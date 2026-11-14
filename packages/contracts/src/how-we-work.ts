// "How we work" (H5): what a project's process looks like as a person reads it. `GET /v1/app/projects/{p}/how-we-work` answers one stage at a time, with six rows each (who does it, what it
// knows, what it may do, what it checks, what it keeps as evidence, who approves) and every value marked with where it comes from: Rovara's built-in process, the company's guardrails, or the
// project. A value can also be locked: the project cannot change it (the company's rule, or a Rovara safety fact). Browser-safe: nothing here imports a Node module. Every string and list is
// bounded, and the UI renders every text as plain text.
import { z } from "zod";
import { AGENT_STEP_KINDS, CODING_STEP_KINDS, INSTRUCTIONS_MAX_BYTES, MAX_RECIPE_STEPS } from "./agent-recipe.js";
import { forwardReader } from "./forward-reader.js";
import { HowWeWorkTrackRecordsSchema } from "./how-we-work-track-record.js";

/** Where a value comes from. */
export const HowWeWorkSourceSchema = z.enum(["rovara", "company", "project"]);
export type HowWeWorkSource = z.infer<typeof HowWeWorkSourceSchema>;

/** Who locked a value: the company's guardrails, or a fact Rovara keeps for safety. */
export const HowWeWorkLockerSchema = z.enum(["company", "rovara"]);

/** The most characters one instruction layer can have (the layer's own limit is in bytes, which is never fewer). */
export const HOW_WE_WORK_INSTRUCTION_MAX = INSTRUCTIONS_MAX_BYTES;
/** The most characters of any other line, model name or tool name. */
export const HOW_WE_WORK_LINE_MAX = 400;
export const HOW_WE_WORK_TOOL_MAX = 64;
export const HOW_WE_WORK_TOOLS_MAX = 40;
export const HOW_WE_WORK_STAGES_MAX = MAX_RECIPE_STEPS;
export const HOW_WE_WORK_LAYERS_MAX = 16;
export const HOW_WE_WORK_ITEMS_MAX = 80;
export const HOW_WE_WORK_NOTE_MAX = 200;

/** What a reviewing stage (plan check, code and security review) says about the project's rules, word for word. */
export const HOW_WE_WORK_REVIEWER_NOTE = "Project rules apply to Understand, Plan and Build. Reviewers only follow rules written for them.";

/** What the pull request stage says about rules written for it (nothing reads them yet); also the words a process layer's write of them is refused with. */
export const HOW_WE_WORK_UNUSED_STAGE_NOTE = "Rules for this stage aren't used yet.";

/** A value and where it comes from. `lockedBy` is there exactly when `locked` is true. */
function marked<T extends z.ZodType>(value: T) {
  return z
    .object({ value, source: HowWeWorkSourceSchema, locked: z.boolean(), lockedBy: HowWeWorkLockerSchema.optional() })
    .strict()
    .refine((entry) => entry.locked === (entry.lockedBy !== undefined), { message: "lockedBy is there exactly when locked is true", path: ["lockedBy"] });
}

const LineSchema = z.string().max(HOW_WE_WORK_LINE_MAX);
const InstructionSchema = z.string().max(HOW_WE_WORK_INSTRUCTION_MAX);
const StepIdSchema = z.string().min(1).max(24);
const markedLines = z.array(marked(LineSchema)).max(HOW_WE_WORK_ITEMS_MAX);

export const HowWeWorkStageSchema = z
  .object({
    id: StepIdSchema,
    name: z.string().min(1).max(HOW_WE_WORK_LINE_MAX),
    kind: z.enum([...CODING_STEP_KINDS, ...AGENT_STEP_KINDS]),
    who: z
      .object({
        model: marked(LineSchema.nullable()),
        thinking: marked(LineSchema.nullable()),
        differentCompanyFrom: marked(z.array(StepIdSchema).max(HOW_WE_WORK_STAGES_MAX)),
        /** SH34, a review stage only and only where the install switch `cr` is on: the project's `review.otherCompany` (off, shadow or on; the same three words as `SECOND_REVIEW_MODES` in second-review.ts, which is not part of the browser entry, so they are written out here), a company lock marked locked. Absent otherwise. */
        secondOpinion: marked(z.enum(["off", "shadow", "on"])).optional(),
      })
      .strict(),
    knows: z
      .object({
        /** The instruction layers this stage is given, in order. */
        instructions: z.array(marked(InstructionSchema)).max(HOW_WE_WORK_LAYERS_MAX),
        /** Set on a stage that checks work: what the project's rules do not reach. */
        note: z.string().max(HOW_WE_WORK_NOTE_MAX).optional(),
      })
      .strict(),
    may: z
      .object({
        tools: marked(z.array(z.string().min(1).max(HOW_WE_WORK_TOOL_MAX)).max(HOW_WE_WORK_TOOLS_MAX).nullable()),
        readOnly: z.boolean(),
      })
      .strict(),
    checked: z.object({ items: markedLines }).strict(),
    evidence: z.object({ items: markedLines }).strict(),
    approves: z.object({ items: markedLines }).strict(),
    /**
     * What the stage has earned in the last 30 days (v1.2 track record): the plan check, the review (one record for code review, one for security review) and the tests carry it. Left out when it
     * could not be read: the card then shows no record, never a zero. The PR risk claim is never part of it.
     */
    trackRecord: HowWeWorkTrackRecordsSchema.optional(),
  })
  .strict();
export type HowWeWorkStage = z.infer<typeof HowWeWorkStageSchema>;

export const HowWeWorkViewSchema = z
  .object({
    project: z.string().min(1).max(HOW_WE_WORK_LINE_MAX),
    playbookRevision: z.number().int().min(0),
    process: z
      .object({
        kind: z.enum(["builtin", "project_process"]),
        agentId: z.string().min(1).max(HOW_WE_WORK_LINE_MAX),
        version: z.number().int().min(1).optional(),
        draftRevision: z.number().int().min(0).optional(),
        /**
         * Set while the playbook still runs the built-in and the project already has a process layer: where its draft is, and its current version when it has published one (the
         * project was set back to the built-in, or the first version's playbook write was lost). The project does not run that version.
         */
        draftLayer: z.object({ agentId: z.string().min(1).max(HOW_WE_WORK_LINE_MAX), draftRevision: z.number().int().min(0), currentVersion: z.number().int().min(1).optional() }).strict().optional(),
        /**
         * Set when the project runs a process layer built on an older Rovara Code than the one the company has adopted (R2): the version the layer's running version builds on, and the one
         * the company adopted. Moving to it is an ordinary reviewed change to the layer's draft; running tasks keep their version.
         */
        update: z.object({ from: z.number().int().min(1), to: z.number().int().min(1) }).strict().optional(),
      })
      .strict(),
    stages: z.array(HowWeWorkStageSchema).max(HOW_WE_WORK_STAGES_MAX),
    /** The project-wide rules (instruction layers that apply to the whole process), if any. */
    rules: z.array(marked(InstructionSchema)).max(HOW_WE_WORK_LAYERS_MAX),
    /** Choosing a model for one stage waits for the company's model settings. */
    modelsEditable: z.literal(false),
  })
  .strict();
export type HowWeWorkView = z.infer<typeof HowWeWorkViewSchema>;
/** A value of the view with its source: what a row shows. */
export type Marked<T> = { value: T; source: HowWeWorkSource; locked: boolean; lockedBy?: "company" | "rovara" };

/** How a client reads that answer: the gateway's `requestId` beside the fields is kept, not refused (as `ProjectPlaybookResponseReaderSchema`). */
export const HowWeWorkViewReaderSchema = forwardReader(HowWeWorkViewSchema);
export type HowWeWorkViewRead = z.output<typeof HowWeWorkViewReaderSchema>;
