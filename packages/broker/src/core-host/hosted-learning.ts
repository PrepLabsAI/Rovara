// Lead 4 L4-HW2: the hosted lessons' learning port, over the model gateway's learning route (Cloud docs/model-gateway-learning.md). It is what `BrokerCoreRootInputs.lessonsLearning` takes, per company.
//
//   WHO PAYS    The company, on its selected source (including company-billed product AI), inside its learning month cap and the one combined company cap. The gateway holds, calls and settles every call itself, so a call that has no connected
//               source or no room is refused THERE (`lessons_paused`, fixed codes) and nothing is spent; only the configured gateway exempt list is free and no key is read, held or sent from Code, ever. The core's own `LearningSpend` therefore
//               answers ok (one place decides the money).
//   THE TOKEN   Minted exactly as a task token is (`mintTaskToken`: the install's KMS task key, purpose `task`, the install's sign-in issuer), fresh for EVERY call, with
//                 stp = `rovara-lessons-learning-call`   the learning step: the gateway accepts it on the learning paths only, and accepts nothing else there
//                 cid = the company the port was built for   never a call's argument: a call that names another company's workspace gets no token at all
//                 pid = the call's project, pay = that project, tid = `learning:<uuid>`, mdl = [the one model], no `per` (no person pays), a fresh ws/op
//   THE MODEL   DEC 254zzz58/63: learning has its OWN model, never the task agent model (an install whose agents run on zai.glm-5 still learns). Per call: the COMPANY's own choice
//               (ORG#<company>#SETTINGS / LEARNING_MODEL, core-host/company-learning-model.ts, set by its owners or admins from the Claude models the gateway offers it), else the install's
//               (ROVARA_CORE_LEARNING_MODEL: the stack parameter CoreLearningModel, `agentx config set coreEngine.learningModel`), else CORE_LEARNING_MODEL_DEFAULT (Claude Haiku 5.5). A company
//               that is not offered the model by its selected source gets the gateway's own pause (the Lessons tab and Home say why); nothing is spent.
//   FAIL CLOSED No gateway settings, no task-token signer or issuer, a SET install learning model that is not a Claude engine name (the route is Anthropic Messages; never a fall back to another
//               model), a company id that is not well formed, a call with no project or a project name that is not one, a call for another company, a company setting that cannot be read or is
//               not exactly the company's: no port, no token or a refused call, so nothing is sent, nothing is spent. Anything unknown is a refusal.
//   WHERE       Only for a company the lessons switch names (`ROVARA_CORE_LESSONS`): the root asks for the port only where `createCoreLessons` would build lessons, and the model is gated on the switch again per call.
//   NOT HERE    Wider model-id families and source support are follow-up work; this slice keeps the existing Claude model settings and delegates source resolution to the gateway.
import { randomUUID } from "node:crypto";
import { AGENTX_NAME_PATTERN, OrgIdSchema, type OrgId, type RunPrice } from "@agentx/contracts";
import type { TokenSigner } from "../developer/tokens.js";
import { mintTaskToken, type TaskTokenDescriber } from "../core/model-gateway/token.js";
import { LEARNING_CALL_STEP, LEARNING_NOT_AVAILABLE, createGatewayLearningModel, gatewayLearningSpend } from "../lessons/gateway-learning.js";
import type { LearningSpend, PipelineModel } from "../lessons/ports.js";
import { gatewayCallUsd as worstCaseUsd } from "./gateway-call-price.js";
import { runPriceReader } from "./run-price-http.js";
export { gatewayCallUsd as worstCaseUsd } from "./gateway-call-price.js";
import { LearningRefusal } from "../lessons/pause.js";
import { readGatewayModelAccess } from "./gateway-model-access.js";
import type { EngineModelRowReader } from "./company-engine-model.js";
import { installLearningModel, readCompanyLearningModel } from "./company-learning-model.js";

export interface HostedLearning { model: PipelineModel; spend: LearningSpend }

type Call = Parameters<PipelineModel["complete"]>[0];
const CAP_WORDS = "This learning call would cost more than its cap allows.";
const NO_PRICE_WORDS = "No price is known for the learning model.";
const READ_FAILED_WORDS = "The learning model could not be chosen.";
export interface HostedLearningOptions {
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

/** What the root gives per company: where the company's own learning model setting is read (its core store). Absent: the install's model only. */
export interface HostedLearningContext { settings?: EngineModelRowReader }

/**
 * The learning port for each company, or undefined for a company that cannot have one (the lessons' learning calls then refuse). Settings are read when a company asks, never earlier, so a broken or
 * missing setting is "no port" and never a startup failure.
 */
export function hostedLessonsLearning(
  env: NodeJS.ProcessEnv,
  taskTokens: (() => { signer: TokenSigner; issuer: string } | undefined) | undefined,
  options: HostedLearningOptions = {},
): (companyId: OrgId, context?: HostedLearningContext) => HostedLearning | undefined {
  return (companyId, context) => {
    if (!OrgIdSchema.safeParse(companyId).success) return undefined;
    const settings = readGatewayModelAccess(env);
    if (settings === undefined || "problem" in settings) return undefined;
    // The learning route is the gateway's Anthropic Messages path, on its OWN model (never the agent model): the install's, unless the company chose its own (read per call).
    const installModel = installLearningModel(env);
    if (installModel === undefined) return undefined;
    let tokens: { signer: TokenSigner; issuer: string } | undefined;
    try { tokens = taskTokens?.(); } catch { return undefined; }
    if (tokens === undefined || typeof tokens.issuer !== "string" || tokens.issuer === "" || typeof tokens.signer?.sign !== "function" || typeof tokens.signer.publicJwk !== "function") return undefined;
    const { signer, issuer } = tokens;
    const now = options.now ?? Date.now;
    const readPrice = runPriceReader({ gatewayUrl: settings.gatewayUrl, signer, issuer, now, ...(options.fetch === undefined ? {} : { fetch: options.fetch }) });
    // The company's own choice when it made one, else the install's. A setting that cannot be read (or is not exactly this company's) is a failure in fixed words, never the default in its place.
    const modelNow = async (): Promise<string> => {
      if (context?.settings === undefined) return installModel;
      let own: string | undefined;
      try { own = await readCompanyLearningModel(context.settings, companyId); } catch { throw new Error(READ_FAILED_WORDS); }
      return own ?? installModel;
    };
    const innerFor = (modelName: string, price: RunPrice) => createGatewayLearningModel({
      gatewayUrl: settings.gatewayUrl,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      async token(call) {
        // The company is the port's, never the call's: another company's workspace, or a call with no project of ours, gets no token.
        if (call.workspaceId !== companyId) return undefined;
        const project = call.project;
        if (typeof project !== "string" || !AGENTX_NAME_PATTERN.test(project)) return undefined;
        const describer: TaskTokenDescriber = {
          describe: async () => ({ companyId, project, payer: { kind: "project", project }, taskId: `learning:${randomUUID()}`, step: LEARNING_CALL_STEP, models: [modelName] }),
        };
        const minted = await mintTaskToken({ signer, issuer, describer, now, runPrice: async () => price }, { workspaceId: randomUUID(), operationId: randomUUID(), fence: 0 });
        return { token: minted.token, model: modelName };
      },
    });
    // The per-call cap is Code's: priced by the gateway and refused before an inference token is minted, so nothing is sent. Another company's workspace, or a call with no project of ours, is refused before the model is chosen.
    const ours = (request: Call): boolean => request.workspaceId === companyId && typeof request.project === "string" && AGENTX_NAME_PATTERN.test(request.project);
    const model: PipelineModel = {
      async quote(request) {
        if (!ours(request)) return { ok: false, code: "no_provider" };
        const modelName = await modelNow();
        const price = await readPrice(companyId, modelName);
        const usd = worstCaseUsd(price, request);
        if (usd === undefined) return { ok: false, code: "no_suitable_model" };
        if (request.maxHoldUsd !== undefined && usd > request.maxHoldUsd) return { ok: false, code: "cost_too_high" };
        return { ok: true, usd };
      },
      async complete(request) {
        if (!ours(request)) throw new LearningRefusal("no_provider", LEARNING_NOT_AVAILABLE);
        const modelName = await modelNow();
        const price = await readPrice(companyId, modelName);
        const usd = worstCaseUsd(price, request);
        if (usd === undefined || price === undefined) throw new LearningRefusal("no_suitable_model", NO_PRICE_WORDS);
        if ((request.maxHoldUsd !== undefined && usd > request.maxHoldUsd) || (request.budgetUsd !== undefined && usd > request.budgetUsd)) throw new LearningRefusal("cost_too_high", CAP_WORDS);
        return await innerFor(modelName, price).complete(request);
      },
    };
    return { model, spend: gatewayLearningSpend() };
  };
}
