// Agents can pick the models Rovara's AI serves (DEC 243c, DEC 236j, DEC 240). The core engine's agents call AI through Cloud's model gateway, which names every model it serves a company by the exact
// id it calls (a Claude engine name, or a Bedrock id for every other model). This is the per-company model choice on that list:
//
//   - the LIST is the gateway's (`OfferedModelsReader`, one company at a time; Code holds no copy). A list that cannot be read, or is malformed, is no list: nothing is offered and nothing is chosen.
//   - the CHOICE is the company's per-step model setting (`core/model-selection`, the same service and policy row the laptop uses), made on the web page only. A model is accepted only if it is on the list now,
//     and a model that is saved but no longer on the list is refused again at every step (it ends the step with fixed words before any machine starts).
//   - the ROUTE of a chosen model is always the gateway's agent route (Anthropic Messages) under the model's own name as the alias: the core never reaches a model any other way.
//   - with no setting, every step runs on the install's default model (ROVARA_CORE_AGENT_MODEL), as it did before this existed, when that model is on the list.
//
// Nothing here is built without a reader: a deployment without one keeps the single-model route of L2b (gateway-model-access.ts), byte for byte.
import {
  OfferedAgentModelsSchema, agentModelIdentity, agentModelName,
  type AuditSink, type Approvers, type DocumentStore, type InvocationModelRoute, type ModelIdentifier, type OfferedAgentModel, type OrgId,
} from "@agentx/contracts";
import { createModelSelection, type ModelSelectionSeams, type ModelSelectionService } from "../core/model-selection/service.js";

/** Reads the models the gateway offers ONE company's agents, as the contract's `OfferedAgentModels` (a wrong shape is refused here, never trusted). */
export interface OfferedModelsReader {
  offered(companyId: OrgId): Promise<unknown>;
}

/** Fixed words: the list could not be read (the reader failed, timed out or answered something that is not the contract). Never the cause. */
export const OFFERED_MODELS_UNAVAILABLE = "The models Rovara's AI offers this company could not be read just now, so no model was chosen.";
/** The longest a read of the list may take. */
export const OFFERED_MODELS_TIMEOUT_MS = 5_000;
/** How long one read of the list is reused: a model removed from the list is refused again within this time. */
export const OFFERED_MODELS_TTL_MS = 5_000;

export class OfferedModelsUnavailable extends Error {
  constructor() { super(OFFERED_MODELS_UNAVAILABLE); this.name = "OfferedModelsUnavailable"; }
}

export interface OfferedModelsView {
  /** The list now. Throws OfferedModelsUnavailable (fixed words) when it cannot be read. */
  list(): Promise<readonly OfferedAgentModel[]>;
}

/** One company's list, read through the reader once per TTL, bounded in time, checked against the contract, and never reused after a failure. */
export function createOfferedModelsView(input: { reader: OfferedModelsReader; companyId: OrgId; now: () => number; ttlMs?: number; timeoutMs?: number }): OfferedModelsView {
  let held: { at: number; models: readonly OfferedAgentModel[] } | undefined;
  const ttl = input.ttlMs ?? OFFERED_MODELS_TTL_MS;
  return {
    async list() {
      const now = input.now();
      if (held !== undefined && now >= held.at && now - held.at < ttl) return held.models;
      held = undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const answer = await Promise.race([
          input.reader.offered(input.companyId),
          new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("timeout")), input.timeoutMs ?? OFFERED_MODELS_TIMEOUT_MS); }),
        ]);
        const parsed = OfferedAgentModelsSchema.safeParse(answer);
        if (!parsed.success) throw new Error("shape");
        held = { at: now, models: Object.freeze(parsed.data.models.map((entry) => Object.freeze({ ...entry }))) };
        return held.models;
      } catch { throw new OfferedModelsUnavailable(); }
      finally { if (timer !== undefined) clearTimeout(timer); }
    },
  };
}

/** The route of a model the gateway offers: its agent route (Anthropic Messages), the model's own name as the alias and as the catalog entry its limits and usage are read from. */
export const gatewayRouteOf = (name: string): InvocationModelRoute => ({ alias: name, api: "anthropic-messages", catalog: name });

/**
 * The per-step rule's seams over the gateway's list. A model is servable, callable and routable only if its name is on the list now; the install's own model is the deployment's default (it is
 * refused too, when the list no longer has it). A list that cannot be read makes nothing servable.
 */
export function gatewayModelSelectionSeams(input: { offered: OfferedModelsView; defaultModel: () => Promise<string> }): ModelSelectionSeams {
  const onList = async (model: ModelIdentifier): Promise<string | undefined> => {
    const name = agentModelName(model);
    if (name === undefined) return undefined;
    return (await input.offered.list()).some((entry) => entry.model === name) ? name : undefined;
  };
  return {
    async servable() { return (await input.offered.list()).map((entry) => agentModelIdentity(entry.model)); },
    async canServe(model) { try { return (await onList(model)) !== undefined; } catch { return false; } },
    async installModel() { return agentModelIdentity(await input.defaultModel()); },
    async route(model) { try { const name = await onList(model); return name === undefined ? undefined : gatewayRouteOf(name); } catch { return undefined; } },
  };
}

/** The words of the hosted page: the models are the gateway's, not a computer's. */
export const HOSTED_MODEL_WORDS = {
  refusals: {
    MODEL_NOT_VERIFIED: "The model set for this step is not offered to this company by Rovara's AI now.",
    MODEL_STALE: "The model set for this step could not be checked just now.",
    NO_VERIFIED_CANDIDATE: "No model Rovara's AI offers this company can run this step.",
    LOCK_UNSATISFIABLE: "This step's locked model is not offered to this company by Rovara's AI now.",
    NO_MODEL: "Rovara's AI has no model to run this step.",
  },
  unavailable: (label: string): string => `${label} is not offered to this company by Rovara's AI now, or the list of offered models could not be read just now.`,
  reauth: "That change needs a recent sign-in. Confirm it's you on the sign-in page, then make the change within a few minutes.",
} as const;

/** What the deployed core hands the pages and the engine for one company. */
export interface AgentModelChoice {
  /** The per-step rule the engine chooses a step's model with (`TaskFlowDeps.stepModels`): `choose` only. */
  readonly stepModels: Pick<ModelSelectionService, "choose">;
  /** The rule for one page request (reads, and the company's change when the page proved a fresh sign-in): the audit sink names the caller it came through. */
  service(audit?: AuditSink): ModelSelectionService;
  /** Every model the gateway offers the company now (the picker's whole list). Throws OfferedModelsUnavailable. */
  offered(): Promise<readonly OfferedAgentModel[]>;
}

export interface AgentModelChoiceInputs {
  store: Pick<DocumentStore, "get" | "put" | "transact">;
  companyId: OrgId;
  audit: AuditSink;
  approvers: Approvers;
  reader: OfferedModelsReader;
  /** The install's default model's gateway name (ROVARA_CORE_AGENT_MODEL): what a step runs on while the company has chosen none. */
  defaultModel: () => Promise<string>;
  now: () => number;
  /** How long a read of the list may take (default OFFERED_MODELS_TIMEOUT_MS). */
  readTimeoutMs?: number;
}

const NO_PRICES = { find: () => undefined, findCap: () => undefined };
// The gateway enforces the company's one combined budget and meters what a model costs; a model's price is not the engine's to decide, and no failed call is learned here (the gateway's refusal ends the step).
const NO_USABILITY = { async unusable(): Promise<ReadonlySet<string>> { return new Set<string>(); }, async markUnusable(): Promise<void> {} };

export function createAgentModelChoice(inputs: AgentModelChoiceInputs): AgentModelChoice {
  const view = createOfferedModelsView({ reader: inputs.reader, companyId: inputs.companyId, now: inputs.now, ...(inputs.readTimeoutMs === undefined ? {} : { timeoutMs: inputs.readTimeoutMs }) });
  const seams = gatewayModelSelectionSeams({ offered: view, defaultModel: inputs.defaultModel });
  const build = (audit: AuditSink): ModelSelectionService => createModelSelection({
    store: inputs.store, companyId: inputs.companyId, audit, approvers: inputs.approvers, seams, prices: NO_PRICES, usable: NO_USABILITY,
    capApplies: () => false, now: inputs.now, words: HOSTED_MODEL_WORDS,
  });
  const base = build(inputs.audit);
  return { stepModels: { choose: (input) => base.choose(input) }, service: (audit) => (audit === undefined ? base : build(audit)), offered: () => view.list() };
}

/**
 * The one company's step rule over the registry the root built (the broker's and the dispatcher's use this alone, so they cannot differ): undefined without a reader, so a deployment without one
 * keeps its declared route and nothing here is built. The install's default model is the route the deployment declared (ROVARA_CORE_AGENT_MODEL), read when a step is chosen.
 */
export function agentModelChoiceFromRegistry(input: {
  registry: { require(point: "storage"): DocumentStore; require(point: "audit-sink"): AuditSink; require(point: "approvers"): Approvers };
  companyId: OrgId;
  reader: OfferedModelsReader | undefined;
  modelAccess: { route(): Promise<InvocationModelRoute | undefined> };
  now: () => number;
}): AgentModelChoice | undefined {
  if (input.reader === undefined) return undefined;
  return createAgentModelChoice({
    store: input.registry.require("storage"), companyId: input.companyId, audit: input.registry.require("audit-sink"), approvers: input.registry.require("approvers"), reader: input.reader, now: input.now,
    defaultModel: async () => {
      const declared = await input.modelAccess.route();
      if (declared === undefined) throw new OfferedModelsUnavailable();
      return declared.alias;
    },
  });
}

/**
 * Every company's step rule in one deployment root (the broker's): one rule per company, built on its own registry and kept for that company's page routes, so the engine and the page of a
 * company always read the same rule and no company ever reaches another's.
 */
export function createCompanyModelChoices(input: { reader: OfferedModelsReader | undefined; now: () => number }): {
  /** The flow options of a company's runtime: the gateway wiring's own object while no reader is wired (nothing changes), else a copy with the company's step rule. */
  flowOptionsFor<O extends { modelAccess: { route(): Promise<InvocationModelRoute | undefined> } }>(registry: Parameters<typeof agentModelChoiceFromRegistry>[0]["registry"], companyId: OrgId, options: O): O & { stepModels?: AgentModelChoice["stepModels"] };
  /** The company's rule for its page's routes (undefined until its runtime was built, and without a reader). */
  choiceFor(companyId: string): AgentModelChoice | undefined;
} {
  const choices = new Map<string, AgentModelChoice>();
  return {
    flowOptionsFor(registry, companyId, options) {
      const choice = agentModelChoiceFromRegistry({ registry, companyId, reader: input.reader, modelAccess: options.modelAccess, now: input.now });
      if (choice === undefined) return options;
      choices.set(companyId, choice);
      return { ...options, stepModels: choice.stepModels };
    },
    choiceFor: (companyId) => choices.get(companyId),
  };
}
