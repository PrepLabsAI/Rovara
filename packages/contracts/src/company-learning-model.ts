// Per-company lessons LEARNING model (DEC 254zzz63; mirrors the per-company engine model, DEC 254n item 1, company-engine-model.ts). The install's learning model
// (ROVARA_CORE_LEARNING_MODEL, `coreEngine.learningModel`, else CORE_LEARNING_MODEL_DEFAULT) is the DEFAULT; a company may choose its own Claude model, from the Claude models the model gateway
// offers THAT company now (the gateway stays the authority, Code holds no list). Only the lessons' learning calls use it; a task never does.
//
//   GET /v1/dev/company/learning-model   any member of the company     -> CompanyLearningModelView
//   PUT /v1/dev/company/learning-model   owner or admin of the company  { model: <claude id> | null } -> CompanyLearningModelView (null clears it: back to the install default)
//
// The company is always the caller's LIVE membership, never a body, query, header or claim.
import { z } from "zod";
import { AGENT_MODEL_NAME } from "./agent-model-choice.js";
import { isCoreLearningModelId } from "./core-engine-infra.js";

/** A learning model a company may hold: a Claude engine name (the learning route is the company's own Anthropic account). Whether it is OFFERED is the gateway's live answer. */
export const CompanyLearningModelIdSchema = z.string().regex(AGENT_MODEL_NAME).refine((value) => isCoreLearningModelId(value));

/** The change: a Claude model id, or null to clear the company's own choice (the install default applies again). Nothing else is accepted. */
export const CompanyLearningModelBodySchema = z.object({ model: CompanyLearningModelIdSchema.nullable() }).strict();
export type CompanyLearningModelBody = z.infer<typeof CompanyLearningModelBodySchema>;

/**
 * What the read (and a successful change) answers:
 *   model      the model the company's lessons learn with now: its own when set, else the install default (null only where the install's setting is broken);
 *   source     "company" when the company chose its own, "install" otherwise;
 *   offered    the CLAUDE model ids the gateway offers THIS company now, in the gateway's order (may be empty: no Claude model offered);
 *   preselect  what a picker preselects: `model` when it is offered, else the first offered Claude model; null when none is offered.
 */
export const CompanyLearningModelViewSchema = z.object({
  model: z.string().regex(AGENT_MODEL_NAME).nullable(),
  source: z.enum(["company", "install"]),
  offered: z.array(z.string().regex(AGENT_MODEL_NAME)),
  preselect: z.string().regex(AGENT_MODEL_NAME).nullable(),
}).strict();
export type CompanyLearningModelView = z.infer<typeof CompanyLearningModelViewSchema>;
