// The company's agent guardrails: the limits the owner sets for every agent in the company. This file holds what the document is and which values it accepts;
// the broker reads and writes it and checks recipes against it (packages/broker/src/core/agents/guardrails.ts).
import { z } from "zod";
import { AutonomySchema, BuiltinAgentIdSchema } from "./agent.js";
import { ModelIdentifierSchema } from "./models.js";
import { canonicalModelName, legacyAliasModelName, type ModelIdentifier } from "./models-node.js";

// The defaults an install has until its owner changes the document. (The hosted product keeps them beside its spend settings; the values are the same.)
const DEFAULT_MAX_AGENT_MONTHLY_USD = 50;
const DEFAULT_MAX_PER_RUN_CEILING_USD = 100;
const DEFAULT_MAX_AUTONOMY = "prepare" as const;

export const MAX_FORBIDDEN_MODELS = 50;
export const MAX_EXTRA_TRIGGER_LABELS = 50;
export const MAX_EXTRA_COMMAND_WORDS = 50;
export const MAX_REPORT_LINK_DOMAINS = 20;
const MAX_ENTRY_LENGTH = 64;
const MAX_AMOUNT_USD = 1_000_000;

/** A GitHub-style label: starts with a letter or digit, then letters, digits, spaces and `. _ : / -`. */
const LABEL_BODY = /^[a-z0-9][a-z0-9 ._:/-]*$/;
/** A lower-case DNS name with at least two parts: an exact host, never a URL, a path or a wildcard. */
const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

const amount = z.number().min(0).max(MAX_AMOUNT_USD);

/** At most `max` entries, none twice. */
function uniqueList<T extends z.ZodType<string>>(entry: T, max: number) {
  return z.array(entry).max(max).superRefine((entries, context) => {
    const seen = new Set<string>();
    for (const [index, value] of entries.entries()) {
      if (seen.has(value)) context.addIssue({ code: "custom", path: [index], message: `${value} is listed twice` });
      seen.add(value);
    }
  });
}

/** A trigger label as the org writes it: lower-cased, either a plain label or a prefix pattern ending `-*`. */
const TriggerLabelSchema = z.string().trim().toLowerCase().max(MAX_ENTRY_LENGTH).refine(
  (label) => LABEL_BODY.test(label) || (label.endsWith("-*") && LABEL_BODY.test(label.slice(0, -2))),
  "must be a label in lower case, or a prefix ending in -* such as deploy-*",
);
/** A word an org's own automations act on: one token, lower-cased. */
const CommandWordSchema = z.string().trim().toLowerCase().min(1).max(MAX_ENTRY_LENGTH).refine((word) => !/\s/u.test(word), "must be one word, with no spaces");
const ReportDomainSchema = z.string().trim().toLowerCase().refine((host) => HOST.test(host), "must be an exact host name such as reports.example.com (no scheme, path or wildcard)");

/**
 * The guardrails document. A forbidden model listed twice is refused by name: the READER names models as it did before Bedrock's other geographies were read (`legacyAliasModelName`), so a stored row or
 * a pending approval that lists `claude-opus-5` and `jp.anthropic.claude-opus-5` still reads (both entries forbid, which is harmless); the WRITER names them by `canonicalModelName`, so a new save of that pair is refused.
 */
function guardrailsSchema(nameOf: (model: ModelIdentifier) => string) {
  return z.object({
    /** Models no agent may use. Matched by canonical name, so the same model on another route is the same entry. */
    forbiddenModels: z.array(ModelIdentifierSchema).max(MAX_FORBIDDEN_MODELS).superRefine((models, context) => {
      const seen = new Set<string>();
      for (const [index, model] of models.entries()) {
        const name = nameOf(model);
        if (seen.has(name)) context.addIssue({ code: "custom", path: [index], message: `${name} is listed twice` });
        seen.add(name);
      }
    }),
    /** A review step must use a model from a different AI company than the build steps'. */
    requireCrossCompanyReview: z.boolean(),
    maxAgentMonthlyUsd: amount,
    maxPerRunCeilingUsd: amount,
    /** The most a single step's budget may be; unset means no limit. */
    maxStepBudgetUsd: amount.optional(),
    maxAutonomy: AutonomySchema,
    disabledBuiltins: uniqueList(BuiltinAgentIdSchema, BuiltinAgentIdSchema.options.length),
    /** Label patterns that make an agent's label write need a person, beyond the maintained list. They only add to it. */
    extraTriggerLabels: uniqueList(TriggerLabelSchema, MAX_EXTRA_TRIGGER_LABELS),
    /** Words that make an agent's comment need a person, beyond the maintained list. They only add to it. */
    extraCommandWords: uniqueList(CommandWordSchema, MAX_EXTRA_COMMAND_WORDS),
    /** Hosts an agent's report may link to, besides the cell's own. */
    reportLinkDomains: uniqueList(ReportDomainSchema, MAX_REPORT_LINK_DOMAINS),
    /**
     * "locked_off" stops projects learning from PR review comments; absent means "allowed". The schema is strict and its readers throw on an unknown field, so a reader of this document knows the field before any writer sets it.
     */
    prCommentLearning: z.enum(["allowed", "locked_off"]).optional(),
  }).strict();
}

export const AgentGuardrailsSchema = guardrailsSchema(legacyAliasModelName);
export type AgentGuardrails = z.infer<typeof AgentGuardrailsSchema>;

/** The writer's schema. A forbidden model twice by canonical name (any geography) is refused here, and only here. */
export const AgentGuardrailsWriteSchema = guardrailsSchema(canonicalModelName);

/** What an org has until its owners and admins change it. `maxStepBudgetUsd` is left unset. */
export const DEFAULT_AGENT_GUARDRAILS: AgentGuardrails = {
  forbiddenModels: [],
  requireCrossCompanyReview: false,
  maxAgentMonthlyUsd: DEFAULT_MAX_AGENT_MONTHLY_USD,
  maxPerRunCeilingUsd: DEFAULT_MAX_PER_RUN_CEILING_USD,
  maxAutonomy: DEFAULT_MAX_AUTONOMY,
  disabledBuiltins: [],
  extraTriggerLabels: [],
  extraCommandWords: [],
  reportLinkDomains: [],
};
