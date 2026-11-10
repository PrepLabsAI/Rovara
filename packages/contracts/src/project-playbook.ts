// "How we work" (H2): a project's playbook document. It says which process the project runs: the built-in Rovara Code, or the project's own process layer (a project-owned custom
// agent that extends Rovara Code and is marked `purpose: "process"`). A project with no document runs the built-in. Browser-safe: nothing here imports a Node module.
import { z } from "zod";
import { prefixedIdPattern } from "./agent.js";
import { forwardReader } from "./forward-reader.js";
import { DesignReviewSettingSchema } from "./design-review.js";

/** A process layer is a custom agent, so a built-in agent's id is not one. */
const ProcessAgentIdSchema = z.string().regex(prefixedIdPattern("agt"));

export const DefaultProcessSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("builtin") }).strict(),
  z.object({ kind: z.literal("project_process"), agentId: ProcessAgentIdSchema }).strict(),
]);
export type DefaultProcess = z.infer<typeof DefaultProcessSchema>;

export const ProjectPlaybookSchema = z
  .object({
    revision: z.number().int().min(0),
    defaultProcess: DefaultProcessSchema,
    /** Design review stage: absent means the owner's defaults (`designReviewSettingOf`). */
    designReview: DesignReviewSettingSchema.optional(),
  })
  .strict();
export type ProjectPlaybook = z.infer<typeof ProjectPlaybookSchema>;

/** What a project with no playbook document has. */
export const DEFAULT_PROJECT_PLAYBOOK: ProjectPlaybook = { revision: 0, defaultProcess: { kind: "builtin" } };

/** `PUT /v1/app/projects/{p}/playbook`: the revision the caller read and the default process to set. */
export const ProjectPlaybookBodySchema = z
  .object({
    expectedRevision: z.number().int().min(0),
    defaultProcess: DefaultProcessSchema,
    designReview: DesignReviewSettingSchema.optional(),
  })
  .strict();
export type ProjectPlaybookBody = z.infer<typeof ProjectPlaybookBodySchema>;

/** The design review fields a company lock holds fixed (the project cannot change them). Names only, never values. */
export const DESIGN_REVIEW_LOCKED_FIELDS = ["designReview.tier", "designReview.allowSkip", "designReview.capUsdPerTask", "designReview.highRiskApprover"] as const;
export const DesignReviewLockedFieldSchema = z.enum(DESIGN_REVIEW_LOCKED_FIELDS);

/**
 * `GET` and an applied `PUT` of a project's playbook. When the company has a design review lock, `playbook.designReview` is the setting HELD TO that lock (what the project really runs with, never a looser stored
 * value) and `designReviewLocked` names the fields the project cannot change. A lock that cannot be read shows the strictest setting with every field locked.
 */
export const ProjectPlaybookResponseSchema = z.object({
  playbook: ProjectPlaybookSchema,
  designReviewLocked: z.array(DesignReviewLockedFieldSchema).max(DESIGN_REVIEW_LOCKED_FIELDS.length).optional(),
  /** DR11: true only on an install that has groups. The editor offers "a group" as the high-risk approver only then; the broker refuses a group elsewhere. Absent reads as false. */
  designReviewGroups: z.boolean().optional(),
  /** DR-FU4: present only where the design review stage exists in the environment (`dr` on). False: the company has not allowed design review, so the project's setting is not shown or editable; true: it is. */
  designReviewAllowed: z.boolean().optional(),
  /** The project's saved design review setting could not be read, so the project runs with design review Off until a maintainer chooses again. Present only (as true) with `designReviewAllowed: true`; absent means readable. */
  designReviewUnreadable: z.literal(true).optional(),
}).strict();
export type ProjectPlaybookResponse = z.infer<typeof ProjectPlaybookResponseSchema>;

/** How a client reads that answer: the gateway's `requestId` beside the fields is kept, not refused (as `CodeSettingsResponseReaderSchema`). */
export const ProjectPlaybookResponseReaderSchema = forwardReader(ProjectPlaybookResponseSchema);
export type ProjectPlaybookResponseRead = z.output<typeof ProjectPlaybookResponseReaderSchema>;

/** What PLAYBOOK_STALE (409) says: the playbook changed since the caller read it. */
export const PLAYBOOK_STALE_MESSAGE = "Someone changed how this project works. Reload and try again.";

/** What PROCESS_UNAVAILABLE (400) says, whatever the reason: the process can't be set, or can't run, in this project. The process is never named. */
export const PROCESS_UNAVAILABLE_MESSAGE = "This project's process isn't available. Check that it is published and not archived.";

/** What PROCESS_UNAVAILABLE (400) says when work is started: the person starting it is not necessarily a maintainer, so it says who can fix it and where. */
/** What starting work answers (400 `CONFIG_INVALID`) when the start box's "Design first" is sent while design review is not available for the company. It does not say why. The page matches it to word its own refusal. */
export const DESIGN_FIRST_UNAVAILABLE_MESSAGE = "Design review isn't available right now.";
export const PROCESS_START_REFUSED_MESSAGE = "This project's way of working can't be used right now. A maintainer can fix it in How we work.";
