// Validation building blocks shared by every place that reads or writes deploy-shaped answers:
// `DeployAnswersSchema` (commands.ts, the `agentx deploy` answers file) and `InitAnswersSchema`
// (../init/install-state.ts, `agentx init`'s own saved answers), plus `agentx init`'s prompts
// themselves where they validate the same shapes fresh from a person typing them in. Living here,
// instead of inside commands.ts, means neither the init nor the deploy side owns the other's
// validation: both import the same regex or schema object, so a region, account, identity, models,
// images or alert-email answer is refused (or accepted) identically wherever it is checked.
import { z } from "zod";

/** Shared with `runInitExport`'s own `--region`/`--account` validation, so both commands refuse the
 * same malformed values the same way. */
export const REGION_PATTERN = /^[a-z]{2}(-[a-z]+)+-\d$/;
export const ACCOUNT_PATTERN = /^\d{12}$/;

/** Shared between `InitAnswersSchema` (../init/install-state.js, parsing a GitHub account already
 * stored) and `agentx init`'s own `--github-account` prompt and flag validation, so a GitHub
 * organization or user name is accepted or refused identically wherever it is checked. */
export const GITHUB_LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export const IdentityAnswersSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("cognito") }).strict(),
  z
    .object({
      mode: z.literal("oidc"),
      issuer: z.string().url(),
      audience: z.string().min(1),
      adminClaim: z.string().min(1).optional(),
      adminValues: z.array(z.string().min(1)).min(1).optional(),
      clientId: z.string().min(1).optional(),
    })
    .strict(),
]);

const ModelProviderSchema = z.enum(["amazon-bedrock", "openrouter"]);
export const ModelsAnswersSchema = z.object({
  orchestrator: z.string().min(1), classifier: z.string().min(1), worker: z.string().min(1),
  providers: z.object({ orchestrator: ModelProviderSchema.optional(), classifier: ModelProviderSchema.optional(), worker: ModelProviderSchema.optional() }).strict().optional(),
  openRouter: z.object({
    secretArn: z.string().regex(/^arn:aws[a-z-]*:secretsmanager:[a-z0-9-]+:\d{12}:secret:[A-Za-z0-9/_+=.@-]+$/),
    providers: z.array(z.string().regex(/^[a-z0-9][a-z0-9_/-]{0,79}$/)).min(1).optional(),
  }).strict().optional(),
}).strict();
export type ModelsAnswers = z.infer<typeof ModelsAnswersSchema>;

export const ImagesAnswersSchema = z.object({ worker: z.string().min(1).optional(), slack: z.string().min(1).optional() }).strict();

/** The one email check an alert-by-email answer goes through, whether it is being parsed back out of
 * install answers already stored in SSM or validated fresh at the `agentx init` prompt: both call
 * this schema rather than each keeping their own regex that could quietly drift apart. */
export const AlertEmailSchema = z.email();

/** FR-047: the monthly budget init offers; absent means none. */
export const BudgetAnswersSchema = z.object({ monthlyUsd: z.number().int().min(1).max(1_000_000), scope: z.enum(["tag", "account"]) }).strict();
