// Per-company engine model (DEC 254n item 1, guided onboarding PR 14). The install-wide core engine agent model (ROVARA_CORE_AGENT_MODEL, `coreEngine.agentModel`) is the DEFAULT;
// a company may set its own, chosen from the models the model gateway offers THAT company now (OfferedAgentModels; the gateway stays the authority, Code holds no list).
//
//   GET /v1/dev/company/engine-model   any member of the company     -> CompanyEngineModelView
//   PUT /v1/dev/company/engine-model   owner or admin of the company  { model: <id> | null } -> CompanyEngineModelView (null clears it: back to the install default)
//
// The company is always the caller's LIVE membership, never a body, query, header or claim. A task whose company model the gateway does not offer that company now is refused
// BEFORE it starts (no machine, no spend) with ENGINE_MODEL_NOT_OFFERED; a list that cannot be read refuses with ENGINE_MODEL_UNCHECKED (never a guess).
import { z } from "zod";
import { AGENT_MODEL_NAME } from "./agent-model-choice.js";
import { isCoreAgentModelId } from "./core-engine-infra.js";

/** A model id a company may hold: well formed as the gateway names models (and as the install's own setting is checked). Whether it is OFFERED is the gateway's live answer. */
export const CompanyEngineModelIdSchema = z.string().regex(AGENT_MODEL_NAME).refine((value) => isCoreAgentModelId(value));

/** The change: a model id, or null to clear the company's own model (the install default applies again). Nothing else is accepted. */
export const CompanyEngineModelBodySchema = z.object({ model: CompanyEngineModelIdSchema.nullable() }).strict();
export type CompanyEngineModelBody = z.infer<typeof CompanyEngineModelBodySchema>;

/**
 * What the read (and a successful change) answers:
 *   model      the model the company's tasks resolve to now: its own when set, else the install default (null where the install has none);
 *   source     "company" when the company set its own, "install" otherwise;
 *   offered    the model ids the gateway offers THIS company now, in the gateway's order;
 *   preselect  what a picker preselects: `model` when it is offered, else the BEST offered model, which is the gateway's first (the gateway lists its preferred model first).
 */
export const CompanyEngineModelViewSchema = z.object({
  model: z.string().regex(AGENT_MODEL_NAME).nullable(),
  source: z.enum(["company", "install"]),
  offered: z.array(z.string().regex(AGENT_MODEL_NAME)).min(1),
  preselect: z.string().regex(AGENT_MODEL_NAME),
}).strict();
export type CompanyEngineModelView = z.infer<typeof CompanyEngineModelViewSchema>;

/** A task start whose resolved company model the gateway does not offer the company now. Fixed words, no model named. */
export const ENGINE_MODEL_NOT_OFFERED = "This company's AI model isn't available. Pick another model in Company settings, AI and spending.";
/** A task start whose company model could not be checked (the gateway's list could not be read, or the setting is unreadable). Fixed words. */
export const ENGINE_MODEL_UNCHECKED = "This company's AI model couldn't be checked just now, so the task didn't start. Try again in a moment, or pick another model in Company settings, AI and spending.";
