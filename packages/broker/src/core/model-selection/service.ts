// The model each step uses. One service, over the ports, that answers two questions and takes one change:
//   - `choose`: the model a step of a task runs on, with the reason, the thinking level and any fallback (the choice function is the hosted product's, `resolver.ts`, unchanged);
//   - `state`: what the owner's page, the CLI and the MCP tool read: the setting, what each step would use now, and the models a step could be set to;
//   - `apply`: the owner's change of the setting, made on the local page only (a token reads, never writes).
// Code runs as one company whose owner decides, so the hosted product's company policy row is the owner's setting (`policy-store.ts`). What stays the hosted product's: locks, per-project choices, the sources a
// company brings (its own keys, endpoints, AWS role), a person's own plan, the second-person confirmation of a less-safe change and the preview of a change across projects.
// A model's price decides one thing here: where a cap applies (a run limit is held on the model proxy), a model with no price is not a candidate, exactly as the proxy would refuse it (`model_not_priced`).
import { createHash } from "node:crypto";
import {
  ModelSelectionBodySchema, STAGE_EDIT_GROUPS, STAGE_IDS, STAGE_REFERENCE, StageModelOverridesSchema, canonicalModelName, modelCompany, sameModelOrUnrecognised,
  type ApprovalRequest, type Approvers, type AuditSink, type InvocationModelRoute, type ModelChoiceView, type ModelFallback, type ModelIdentifier, type ModelSelectionState, type ModelStepView,
  type OrgId, type Principal, type StageId, type StageModelChoice, type StageModelRefusalCode, type DocumentStore, type ThinkingLevel,
} from "@agentx/contracts";
import { usdPerMillion, type ModelPrices } from "../cost/price-table.js";
import { stagedAudit } from "../second-review/mode.js";
import { criticCapabilityTier } from "../second-review/model-ranking.js";
import { classifyStageChoiceChange } from "./classify.js";
import { STAGE_POOL_MAX, poolKey, reviewDefaultExtras } from "./review-default-pool.js";
import { resolveStageModel, type StageDecisionReason, type StageModelInput, type VerifiedStageCandidate } from "./resolver.js";
import { PolicyUnreadable, policyWrite, readModelSelectionPolicy, type ModelSelectionPolicy, type ReviewDefault, type StepOverrides } from "./policy-store.js";
import type { UsableModels } from "./usable-models.js";

/** What the install answers for the service (the core knows no provider): which models it can call, which is its own, and how a call to one is routed. */
export interface ModelSelectionSeams {
  /** The models the install could offer for a step: those of its providers that have a sign-in, of a known maker. Not a promise any one is callable (`canServe` is). */
  servable(): Promise<ModelIdentifier[]>;
  /** Whether a call to this model can be made now: its provider has a sign-in on this computer and speaks a format. */
  canServe(model: ModelIdentifier): Promise<boolean>;
  /** The model the install runs its steps on when nothing is set (the owner's `model` setting, else the first provider with a key). */
  installModel(): Promise<ModelIdentifier | undefined>;
  /** How a call to the model reaches it (the proxy alias and the request format). Undefined: it cannot be routed. */
  route(model: ModelIdentifier): Promise<InvocationModelRoute | undefined>;
}

export interface ModelSelectionDependencies {
  store: Pick<DocumentStore, "get" | "put" | "transact">;
  companyId: OrgId;
  audit: AuditSink;
  approvers: Approvers;
  seams: ModelSelectionSeams;
  prices: ModelPrices;
  usable: UsableModels;
  /** What a policy that does not say reads as: `install-model` for a laptop (Code's own default), `different-company` for a host whose rule that is. */
  defaultReviewDefault?: ReviewDefault;
  /** Whether a run limit is held on the model proxy (a model with no price then cannot be used). Read at each choice. */
  capApplies(): boolean;
  now(): number;
}

/** The stage a workflow operation runs under, from the hosted product's mapping. CHECKS runs commands and has no model of its own: the install's model stands. */
export const STAGE_OF_WORKFLOW_MODE: Readonly<Record<string, StageId | undefined>> = {
  UNDERSTAND: "understand", SETUP_DRAFT: "plan", SETUP_AGENT: "plan", SPEC_WRITE: "plan", PLAN: "plan", PLAN_CRITIQUE: "plan_check", IMPLEMENT: "build", REVIEW: "code_review", FEEDBACK_REVIEW: "pull_request",
};

export interface StepModel {
  model: ModelIdentifier;
  thinkingLevel: ThinkingLevel | null;
  reason: StageDecisionReason | "INSTALL_MODEL";
  fallback?: ModelFallback | undefined;
  /** A checking step on the same model as the step it checks. */
  sameModelAsChecked: boolean;
  route: InvocationModelRoute;
}
export type StepChoice = { ok: true; step: StepModel } | { ok: false; code: StageModelRefusalCode | "NO_MODEL"; words: string };

export type ChangeFailure = "reauth_required" | "stale" | "invalid" | "model_unavailable" | "same_model" | "second_person_required" | "approval_unavailable" | "settings_unreadable";
export type ChangeResult = { ok: true; revision: number; lessSafe: string[] } | { ok: false; code: ChangeFailure; words: string };

export interface ModelSelectionService {
  choose(input: { stage: StageId; /** The model of the step this one checks (a checking step only). Absent: it is worked out from the setting now. */ reference?: ModelIdentifier | undefined }): Promise<StepChoice>;
  state(): Promise<ModelSelectionState>;
  apply(owner: Principal, body: unknown, context: { fresh: boolean }): Promise<ChangeResult>;
  /** What the installed prices say for a model (the picker and a page show it). */
  priceOf: ModelPrices["find"];
}

const CHECKING_STAGES = ["plan_check", "code_review", "security_review"] as const;
const CHECKING: ReadonlySet<StageId> = new Set<StageId>(["plan_check", "code_review", "security_review"]);
const same = (a: ModelIdentifier, b: ModelIdentifier): boolean => canonicalModelName(a) === canonicalModelName(b);
const label = (model: ModelIdentifier): string => `${model.provider}/${model.modelId}`;
const groupOf = (stage: StageId): readonly StageId[] => STAGE_EDIT_GROUPS.find((group) => (group as readonly StageId[]).includes(stage)) as readonly StageId[];

const WORDS: Record<StageModelRefusalCode | "NO_MODEL", string> = {
  MODEL_NOT_VERIFIED: "The model set for this step cannot be called on this computer now: its provider has no sign-in here, or it has no price while a run limit is held.",
  MODEL_STALE: "The model set for this step could not be checked just now.",
  MODEL_FORBIDDEN: "The model set for this step is not allowed.",
  MODEL_NOT_ALLOWED_IN_PROJECT: "The model set for this step is not allowed in this project.",
  STAGE_LOCKED: "This step's model is locked.",
  DIFFERENT_FROM_UNSATISFIABLE: "This step is set to use a different model or company than the step it checks, and no other model that can be called here fits.",
  LOCK_UNSATISFIABLE: "This step's locked model cannot be called here.",
  NO_VERIFIED_CANDIDATE: "No model can be called on this computer for this step: set a model key, or give the models you use a price.",
  POLICY_STALE: "The model setting changed; reload and try again.",
  DRAFT_STALE: "The model setting changed; reload and try again.",
  NEEDS_CONFIRMATION: "This change needs a confirmation that this install cannot give.",
  NO_MODEL: "No model can be called on this computer: set ANTHROPIC_API_KEY, OPENAI_API_KEY or OPENROUTER_API_KEY, or add a model provider.",
};

export function createModelSelection(deps: ModelSelectionDependencies): ModelSelectionService {
  const orgId = deps.companyId;
  /** Whether a cap can be held to this model: it has a price in DOLLARS (the budget is in dollars, so a price in another currency is no price to it: the proxy would refuse every call). */
  const pricedInDollars = (model: ModelIdentifier): boolean => usdPerMillion(deps.prices.findCap(model)) !== undefined;

  /** Everything one choice reads, taken once so the steps of one answer agree with each other. */
  /**
   * `wide`: also ask the install which models it could serve across ALL its providers (the page and the state read do, to offer them; so does a "different company" default, which draws from them). Without it only the
   * providers the setting and the install's own model name are asked for a credential: a provider that is installed but not chosen is never asked (an AWS role is not resolved for a task that does not use it).
   */
  async function context(wide: boolean): Promise<{ policy: ModelSelectionPolicy; unusable: ReadonlySet<string>; install: ModelIdentifier | undefined; candidates: VerifiedStageCandidate[]; capApplies: boolean }> {
    const policy = await readModelSelectionPolicy(deps.store, orgId, deps.defaultReviewDefault);
    // A rule that a step differ from the step it checks needs other companies' models to draw from, like the "different company" default.
    const reach = wide || policy.reviewDefault === "different-company" || Object.values(policy.stepOverrides).some((override) => override?.differentFrom !== undefined);
    const [unusable, install, servable] = await Promise.all([deps.usable.unusable(), deps.seams.installModel(), reach ? deps.seams.servable().catch(() => [] as ModelIdentifier[]) : Promise.resolve([] as ModelIdentifier[])]);
    const capApplies = deps.capApplies();
    // The pool: the models the setting names, the install's own, and (within the pool's limit) the strongest the install could serve, a few of each maker, which a "different company" default draws from.
    const pool = new Map<string, ModelIdentifier>();
    const add = (model: ModelIdentifier | undefined): void => { if (model !== undefined) pool.set(`${model.provider}\0${model.modelId}`, { provider: model.provider, modelId: model.modelId }); };
    for (const override of Object.values(policy.stepOverrides)) { add(override?.model); add(override?.fallbackModel); }
    add(install);
    const extras = reviewDefaultExtras({ servable, approved: undefined, forbidden: [], have: new Set([...pool.values()].map(poolKey)), size: pool.size });
    for (const extra of extras) add(extra);
    if (pool.size > STAGE_POOL_MAX) throw new PolicyUnreadable();
    const candidates: VerifiedStageCandidate[] = [];
    for (const model of pool.values()) {
      const callable = await deps.seams.canServe(model).catch(() => false);
      // Where a cap applies, a model with no price cannot be held to it: it is not a candidate (the proxy would refuse every call to it).
      const enabled = callable && (!capApplies || pricedInDollars(model));
      candidates.push({
        model, sourceId: "rovara", enabled, inEffectiveOrder: true,
        evidence: { orgId, sourcesRevision: 0, kind: "rovara_catalog" },
        ...(unusable.has(canonicalModelName(model)) ? { accountCannotUse: true as const } : {}),
      });
    }
    return { policy, unusable, install, candidates, capApplies };
  }

  type Context = Awaited<ReturnType<typeof context>>;

  /** The words for a refusal. Where a limit is held and a model that could be called has no price, they name it: that is the one thing the owner can fix at once. */
  function refusalWords(code: StageModelRefusalCode, ctx: Context): string {
    const unpriced = ctx.capApplies && (code === "NO_VERIFIED_CANDIDATE" || code === "MODEL_NOT_VERIFIED") ? ctx.candidates.find((entry) => !pricedInDollars(entry.model)) : undefined;
    return unpriced === undefined ? WORDS[code] : `${label(unpriced.model)} has no price, and a run limit is held, so it cannot be used: add its price to its model provider, or set ROVARA_RUN_LIMIT=0 to run without a limit.`;
  }

  const settingOf = (policy: ModelSelectionPolicy, stage: StageId): StepOverrides[StageId] => policy.stepOverrides[stage];
  /** What a view shows of a stored setting: the owner's choice without the lock flag (an install of one owner holds no locks). */
  const choiceOf = (setting: StepOverrides[StageId]): StageModelChoice | null => {
    if (setting === undefined) return null;
    const { locked: _locked, ...choice } = setting;
    void _locked;
    return choice;
  };

  async function routed(model: ModelIdentifier, found: Omit<StepModel, "route" | "model">): Promise<StepChoice> {
    const route = await deps.seams.route(model);
    if (route === undefined) return { ok: false, code: "MODEL_NOT_VERIFIED", words: WORDS.MODEL_NOT_VERIFIED };
    return { ok: true, step: { ...found, model, route } };
  }

  async function choose(ctx: Context, stage: StageId, reference?: ModelIdentifier, depth = 0): Promise<StepChoice> {
    const setting = settingOf(ctx.policy, stage);
    const checking = CHECKING.has(stage);
    // Nothing set for this step and the install has no model at all (no key): there is no model to choose.
    if (ctx.install === undefined && setting?.model === undefined) return { ok: false, code: "NO_MODEL", words: WORDS.NO_MODEL };
    let referenceModel = reference;
    if (checking && referenceModel === undefined && depth === 0) {
      const checked = await choose(ctx, STAGE_REFERENCE[stage as keyof typeof STAGE_REFERENCE], undefined, 1);
      referenceModel = checked.ok ? checked.step.model : ctx.install;
    }
    const installOnly = (): Promise<StepChoice> => {
      if (ctx.install === undefined) return Promise.resolve({ ok: false, code: "NO_MODEL", words: WORDS.NO_MODEL });
      const candidate = ctx.candidates.find((entry) => same(entry.model, ctx.install!));
      if (candidate === undefined || !candidate.enabled) return Promise.resolve({ ok: false, code: "MODEL_NOT_VERIFIED", words: WORDS.MODEL_NOT_VERIFIED });
      return routed(candidate.model, { thinkingLevel: null, reason: "INSTALL_MODEL", sameModelAsChecked: referenceModel !== undefined && same(candidate.model, referenceModel) });
    };
    // A checking step nobody set, on an install that keeps one model for everything (what a laptop always did): the install's model, and the step says it is the same one.
    if (checking && setting?.model === undefined && setting?.differentFrom === undefined && ctx.policy.reviewDefault === "install-model") return installOnly();
    const input: StageModelInput = {
      orgId, stage, sourcesRevision: 0, candidates: ctx.candidates, forbidden: [],
      ...(setting?.locked === true ? { companyLock: setting } : setting === undefined ? {} : { companyDefault: setting }),
      ...(ctx.install === undefined ? {} : { builtinDefault: ctx.install }),
      ...(referenceModel === undefined ? {} : { referenceModel }),
      reviewDefaultDifferentCompany: ctx.policy.reviewDefault === "different-company",
      // Where nothing else than the reference's own model is left, the step runs on it and says so, as the hosted product's default does.
      allowLegacyDefaultFallback: true,
    };
    const result = resolveStageModel(input);
    if (result.kind === "refusal") return { ok: false, code: result.code, words: refusalWords(result.code, ctx) };
    return routed(result.model, {
      thinkingLevel: result.thinkingLevel, reason: result.reason, ...(result.fallback === undefined ? {} : { fallback: result.fallback }),
      sameModelAsChecked: checking && referenceModel !== undefined && same(result.model, referenceModel),
    });
  }

  const viewOfPrice = (model: ModelIdentifier): { input: number; output: number; source: "provider" | "catalog" | "built-in" } | undefined => {
    const found = deps.prices.find(model);
    const usd = usdPerMillion(found);
    return found === undefined || usd === undefined ? undefined : { input: usd.input, output: usd.output, source: found.origin };
  };

  async function state(): Promise<ModelSelectionState> {
    const ctx = await context(true);
    const steps: ModelStepView[] = [];
    for (const stage of STAGE_IDS) {
      const setting = settingOf(ctx.policy, stage);
      const outcome = await choose(ctx, stage);
      const price = outcome.ok ? viewOfPrice(outcome.step.model) : undefined;
      steps.push({
        stage, setting: choiceOf(setting),
        ...(outcome.ok
          ? { effective: {
            model: outcome.step.model, thinkingLevel: outcome.step.thinkingLevel, reason: outcome.step.reason, sameModelAsChecked: outcome.step.sameModelAsChecked,
            ...(outcome.step.fallback === undefined ? {} : { fallback: outcome.step.fallback }), ...(price === undefined ? {} : { priceUsdPerMillion: price }),
          } }
          : { refusal: { code: outcome.code, words: outcome.words } }),
      });
    }
    const unpricedNow = new Set(ctx.candidates.filter((entry) => !pricedInDollars(entry.model)).map((entry) => poolKey(entry.model)));
    const models: ModelChoiceView[] = ctx.candidates.map((entry) => {
      const price = viewOfPrice(entry.model);
      return {
        model: entry.model, company: modelCompany(entry.model), label: label(entry.model).slice(0, 100), priced: !unpricedNow.has(poolKey(entry.model)),
        ...(price === undefined ? {} : { priceUsdPerMillion: price }), usable: entry.accountCannotUse !== true,
      };
    });
    return { version: 1, revision: ctx.policy.revision, reviewDefault: ctx.policy.reviewDefault, runLimit: { enforced: ctx.capApplies }, install: ctx.install ?? null, steps, models };
  }

  /** The approval request a less-safe change is asked under, bound to exactly this change (the stages and the setting they get). */
  function approvalRequest(next: StepOverrides, revision: number, owner: Principal): ApprovalRequest {
    const digest = createHash("sha256").update(JSON.stringify(["model-selection", revision, next])).digest("hex");
    return { companyId: orgId, requestId: `model-selection:${digest.slice(0, 32)}`, kind: "setting", subject: { type: "model-selection", id: "company" }, revision, artifactDigest: digest, requestedBy: owner, risk: "high" };
  }

  async function apply(owner: Principal, rawBody: unknown, ctxIn: { fresh: boolean }): Promise<ChangeResult> {
    const parsed = ModelSelectionBodySchema.safeParse(rawBody);
    if (!parsed.success) return { ok: false, code: "invalid", words: "That is not a change the model setting offers." };
    const body = parsed.data;
    // Every change is the owner's own act in a page session opened within ten minutes, never a token's.
    if (!ctxIn.fresh) return { ok: false, code: "reauth_required", words: "That change needs a recent sign-in. Close this page and run `rovara open models` again, then make the change within ten minutes." };
    let ctx: Context;
    try { ctx = await context(true); } catch { return { ok: false, code: "settings_unreadable", words: "The model setting could not be read, so it was not changed." }; }
    const policy = ctx.policy;
    if (body.expectedRevision !== policy.revision) return { ok: false, code: "stale", words: "The model setting changed since this page was drawn. Reload it and try again." };
    let nextOverrides: StepOverrides = { ...policy.stepOverrides };
    let reviewDefault: ReviewDefault = policy.reviewDefault;
    if (body.action === "review-default") {
      reviewDefault = body.value;
    } else {
      // A group of steps shares one setting (the plan and understand steps; the code and security reviews): the change is made to the whole group.
      // A choice that sets nothing is not a setting: clearing a step is its own action.
      if (body.action === "set" && Object.values(body.choice).every((value) => value === undefined)) return { ok: false, code: "invalid", words: "Choose a model, a thinking level, a backup or a rule for the step; to go back to the default, clear it." };
      const members = groupOf(body.stage);
      for (const member of members) {
        if (body.action === "clear") delete nextOverrides[member];
        else nextOverrides[member] = { ...body.choice, locked: false };
      }
      if (body.action === "set") {
        const named = [body.choice.model, body.choice.fallbackModel].filter((model): model is ModelIdentifier => model !== undefined);
        for (const model of named) {
          const callable = await deps.seams.canServe(model).catch(() => false);
          if (!callable || (ctx.capApplies && !pricedInDollars(model))) {
            return { ok: false, code: "model_unavailable", words: `${label(model)} cannot be called on this computer now: its provider has no sign-in here${ctx.capApplies ? ", or it has no price while a run limit is held" : ""}.` };
          }
        }
      }
    }
    const checkedOverrides = StageModelOverridesSchema.safeParse(nextOverrides);
    if (!checkedOverrides.success) return { ok: false, code: "invalid", words: "That setting is not valid for these steps." };
    nextOverrides = checkedOverrides.data;
    // A checking step is set to a model other than the one that writes what it checks: the plan check against the plan, the reviews against the build. The step it checks is read as it would run under the new
    // setting (an unset step runs on the install's model), so a check cannot be saved that the dispatch would refuse every time.
    const nextCtx: Context = { ...ctx, policy: { ...policy, stepOverrides: nextOverrides, reviewDefault } };
    for (const stage of CHECKING_STAGES) {
      const named = [nextOverrides[stage]?.model, nextOverrides[stage]?.fallbackModel].filter((model): model is ModelIdentifier => model !== undefined);
      if (named.length === 0) continue;
      const checked = await choose(nextCtx, STAGE_REFERENCE[stage], undefined, 1);
      const reference = checked.ok ? checked.step.model : nextOverrides[STAGE_REFERENCE[stage]]?.model;
      if (reference !== undefined && named.some((model) => sameModelOrUnrecognised(model, reference))) {
        return { ok: false, code: "same_model", words: "A checking step must use a different model than the step it checks. Choose another model." };
      }
    }
    const lessSafe = new Set(classifyStageChoiceChange({ kind: "company", before: policy.stepOverrides, after: nextOverrides }));
    // Two less-safe changes the classifier cannot see from the settings alone: a weaker model for a check that had none set (it ran on whatever the default chose), and giving up the different-company default.
    for (const stage of CHECKING_STAGES) {
      const now = nextOverrides[stage]?.model;
      if (now === undefined || policy.stepOverrides[stage]?.model !== undefined) continue;
      const was = await choose(ctx, stage, undefined, 0);
      if (was.ok && criticCapabilityTier(now) > criticCapabilityTier(was.step.model)) lessSafe.add(`Moves the company ${stage} default to a weaker model`);
    }
    if (policy.reviewDefault === "different-company" && reviewDefault === "install-model") lessSafe.add("Stops checking steps nobody set from using a different AI company's model");
    if (lessSafe.size > 0) {
      // A less-safe change (a weaker model for a check, a new AI company, the same model as the step it checks) is made only when this install's approval rules let the owner approve their own change; rules that
      // need a different person cannot be met on a laptop, and the change is not made.
      try {
        const requirement = await deps.approvers.requirement(approvalRequest(nextOverrides, policy.revision, owner));
        if (requirement.minApprovers > 1 || !requirement.selfApprovalAllowed) return { ok: false, code: "second_person_required", words: "This change needs a different person to confirm it, and this install has no second person. It was not made." };
      } catch { return { ok: false, code: "approval_unavailable", words: "The approval rules could not be read, so the change was not made." }; }
    }
    const at = deps.now();
    const items = [
      policyWrite({ orgId, seenRevision: policy.revision, stepOverrides: nextOverrides, reviewDefault, by: owner.personId, at: new Date(at).toISOString() }),
      ...stagedAudit({ audit: deps.audit, companyId: orgId }, {
        action: "model.policy.changed", subject: { type: "company", id: orgId.slice(0, 100) },
        details: {
          revision: policy.revision + 1, policyDigest: createHash("sha256").update(JSON.stringify(nextOverrides)).digest("hex"), previousDigest: createHash("sha256").update(JSON.stringify(policy.stepOverrides)).digest("hex"),
          reviewDefault, lessSafe: lessSafe.size,
        },
      }, owner.personId, at),
    ];
    const committed = await deps.store.transact(items);
    if (!committed.applied) return { ok: false, code: "stale", words: "The model setting changed since this page was drawn. Reload it and try again." };
    return { ok: true, revision: policy.revision + 1, lessSafe: [...lessSafe] };
  }

  return {
    async choose(input) {
      let ctx: Context;
      try { ctx = await context(false); } catch { return { ok: false, code: "MODEL_STALE", words: WORDS.MODEL_STALE }; }
      return choose(ctx, input.stage, input.reference);
    },
    state,
    apply,
    priceOf: (model) => deps.prices.find(model),
  };
}
