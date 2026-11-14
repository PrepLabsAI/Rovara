// AI navigation on Cloud (design proof-test-env, section 4.8; owner choice "Option B", 2026-10-27): each AI-navigation round is charged to the org's spend ledger through a proxy key, and no model call is made
// that is not charged. This module holds the shapes both sides read: the grant a worker is given, the feature a worker advertises when it can use one, the worst-case figure a round reserves, and the gate that decides
// whether the three Cloud refusals may lift. Nothing here imports a Node module.
import { z } from "zod";
import { E2E_MODEL_ROUTE_DEFAULT_BUDGETS, type E2EModelRouteBudgets } from "./e2e-model-channel.js";

/** The invocation feature a worker lists only when its model channel calls the model through a proxy key. The worker's list and the protocol's list gain it together, when the worker uses a grant. */
export const E2E_PROXY_KEY_FEATURE = "task.workflowE2EProxyKey.v1" as const;

export const E2E_PROXY_GRANT_SCHEMA_VERSION = 1 as const;
/** A grant is for one operation and one round; this is the most it can live. */
export const E2E_PROXY_GRANT_MAX_TTL_SECONDS = 3 * 3_600;

/**
 * What the CHECKS payload carries to a worker for a round's AI-navigation calls: the proxy to call and the capped key to call it with. The key is a SECRET: it is held in the worker's memory and the executor's
 * model channel only, never written to a log, a report, a file in the workspace or the evidence, and it expires on its own. `capUsd` is what the broker reserved; the proxy refuses calls beyond it.
 */
export const E2eProxyGrantSchema = z
  .object({
    schemaVersion: z.literal(E2E_PROXY_GRANT_SCHEMA_VERSION),
    proxyBaseUrl: z.string().max(2_048).regex(/^https:\/\/[^\s/?#@]+(?:\/[^\s?#]*)?$/u, "an https address with no credentials, query or fragment"),
    key: z.string().min(16).max(512),
    keyId: z.string().min(1).max(200),
    operationId: z.string().min(1).max(200),
    routeAlias: z.string().min(1).max(128),
    capUsd: z.number().positive().max(10_000),
    expiresAt: z.number().int().positive(),
  })
  .strict();
export type E2eProxyGrant = z.infer<typeof E2eProxyGrantSchema>;

/** A model's price per million tokens, in US dollars, as the route's model has it. */
export const E2eModelPriceSchema = z.object({ inputUsdPerMTok: z.number().min(0).max(10_000), outputUsdPerMTok: z.number().min(0).max(10_000) }).strict();
export type E2eModelPrice = z.infer<typeof E2eModelPriceSchema>;

/**
 * The most a round of `groups` groups can spend: per group, the model calls the route allows, each at most the route's input and output tokens, with the group's total input tokens held to its own cap. Rounded UP
 * to a tenth of a cent, so the figure the broker reserves is never below what the proxy could be asked to charge. A price or budget that is not a number is a bug: it throws rather than reserve nothing.
 */
export function e2eRoundWorstCaseUsd(input: { groups: number; budgets?: Pick<E2EModelRouteBudgets, "maxModelCallsPerGroup" | "maxInputTokens" | "maxOutputTokens" | "maxInputTokensPerGroup">; price: E2eModelPrice }): number {
  const budgets = input.budgets ?? E2E_MODEL_ROUTE_DEFAULT_BUDGETS;
  const price = E2eModelPriceSchema.parse(input.price);
  if (!Number.isInteger(input.groups) || input.groups < 1 || input.groups > 100) throw new RangeError("a round has between 1 and 100 groups");
  const inputTokens = Math.min(budgets.maxModelCallsPerGroup * budgets.maxInputTokens, budgets.maxInputTokensPerGroup);
  const outputTokens = budgets.maxModelCallsPerGroup * budgets.maxOutputTokens;
  const perGroup = (inputTokens * price.inputUsdPerMTok + outputTokens * price.outputUsdPerMTok) / 1_000_000;
  return Math.ceil(perGroup * input.groups * 1_000) / 1_000;
}

export type E2eProxyGateRefusal = "worker_lacks_feature" | "no_proxy_route" | "no_price";
export type E2eProxyGate = { lift: true } | { lift: false; refusal: E2eProxyGateRefusal };

/**
 * Whether a Cloud round with AI-navigation steps may start: the install must have the proxy route for the e2e model AND a price for it (so the round can be reserved), and the worker that will run it must list
 * the proxy-key feature. Anything else keeps today's refusal, with today's message. Fail closed: unknown is a refusal.
 */
export function e2eProxyGate(input: { installHasProxyRoute: boolean; routePrice: E2eModelPrice | undefined; workerFeatures: readonly string[] | undefined }): E2eProxyGate {
  if (!input.installHasProxyRoute) return { lift: false, refusal: "no_proxy_route" };
  if (input.routePrice === undefined || !E2eModelPriceSchema.safeParse(input.routePrice).success) return { lift: false, refusal: "no_price" };
  if (input.workerFeatures === undefined || !input.workerFeatures.includes(E2E_PROXY_KEY_FEATURE)) return { lift: false, refusal: "worker_lacks_feature" };
  return { lift: true };
}
