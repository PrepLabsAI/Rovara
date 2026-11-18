// Lead 4 L4-HW2: the hosted lessons' learning port, over the model gateway's learning route (Cloud docs/model-gateway-learning.md). It is what `BrokerCoreRootInputs.lessonsLearning` takes, per company.
//
//   WHO PAYS    The company, on its OWN connected provider account, inside its learning month cap and the one combined company cap. The gateway holds, calls and settles every call itself, so a call that has no connected
//               account or no room is refused THERE (`lessons_paused`, fixed codes) and nothing is spent; Rovara never pays and no key is read, held or sent from Code, ever. The core's own `LearningSpend` therefore
//               answers ok (one place decides the money).
//   THE TOKEN   Minted exactly as a task token is (`mintTaskToken`: the install's KMS task key, purpose `task`, the install's sign-in issuer), fresh for EVERY call, with
//                 stp = `rovara-lessons-learning-call`   the learning step: the gateway accepts it on the learning paths only, and accepts nothing else there
//                 cid = the company the port was built for   never a call's argument: a call that names another company's workspace gets no token at all
//                 pid = the call's project, pay = that project, tid = `learning:<uuid>`, mdl = [the one model], no `per` (no person pays), a fresh ws/op
//   THE MODEL   DEC 254zzz58: learning has its OWN model, never the task agent model (an install whose agents run on zai.glm-5 still learns): ROVARA_CORE_LEARNING_MODEL (the stack parameter
//               CoreLearningModel, `agentx config set coreEngine.learningModel`) when set, one Claude engine name; empty (the default), the first Claude model the gateway OFFERS the company
//               that Code can price (its offered-models read, signed with the task key, fresh at most every LEARNING_MODEL_READ_MS). No Claude model offered: learning refuses as
//               `no_suitable_model` (the Lessons tab and Home say "Lessons paused: no available model can write lessons"), nothing is sent or spent, and the log says it once with a fixed notice.
//   FAIL CLOSED No gateway settings, no task-token signer or issuer, a SET learning model that is not a Claude engine name (the route is Anthropic Messages; never a fall back to another model), a company
//               id that is not well formed, a call with no project or a project name that is not one, a call for another company, an offered-models read that fails: no port, no token or a refused call,
//               so nothing is sent, nothing is spent. Anything unknown is a refusal.
//   WHERE       Only for a company the lessons switch names (`ROVARA_CORE_LESSONS`): the root asks for the port only where `createCoreLessons` would build lessons, and the model is gated on the switch again per call.
//   NOT HERE    Other providers' learning paths (Gemini, OpenAI): the company's Anthropic account is the one this port can use; a company with another provider connected gets the gateway's `no_provider` pause.
import { randomUUID } from "node:crypto";
import { AGENTX_NAME_PATTERN, CORE_CLAUDE_AGENT_MODEL, CORE_LEARNING_MODEL_VARIABLE, OfferedAgentModelsSchema, OrgIdSchema, isCoreLearningModelId, type OfferedAgentModels, type OrgId } from "@agentx/contracts";
import type { TokenSigner } from "../developer/tokens.js";
import { mintTaskToken, type TaskTokenDescriber } from "../core/model-gateway/token.js";
import { LEARNING_CALL_STEP, LEARNING_NOT_AVAILABLE, createGatewayLearningModel, gatewayLearningSpend } from "../lessons/gateway-learning.js";
import type { LearningSpend, PipelineModel } from "../lessons/ports.js";
import { listPricesPerMillion } from "@agentx/model-runtime/catalog";
import { LearningRefusal } from "../lessons/pause.js";
import { readGatewayModelAccess } from "./gateway-model-access.js";
import { offeredModelsReader } from "./offered-models-http.js";

export interface HostedLearning { model: PipelineModel; spend: LearningSpend }

type Call = Parameters<PipelineModel["complete"]>[0];
const CAP_WORDS = "This learning call would cost more than its cap allows.";
const NO_PRICE_WORDS = "No price is known for the learning model.";
const NO_CLAUDE_WORDS = "The model gateway offers this company no Claude model to learn with.";
const READ_FAILED_WORDS = "The learning model could not be chosen.";
/** The one log line (fixed words, said once per company port) when the gateway offers a company no Claude model to learn with. */
export const LEARNING_NO_CLAUDE_NOTICE = "Lessons learn nothing for this company: the model gateway offers it no Claude model. Connect the company's Anthropic account, or set coreEngine.learningModel.";
/** How long one company's offered-models answer chooses its learning model before it is read again (a failed read is never kept). */
export const LEARNING_MODEL_READ_MS = 5 * 60_000;
const MICRO = 1_000_000;
/** Tokens added to the byte count for the request's own framing (roles, separators), so the bound never rests on the prompt's bytes alone. */
const FRAMING_TOKENS = 256;

/** The most one call can cost, in dollars (rounded up to a micro-dollar): every byte of the prompt as one input token (at the dearer of the input and cache-write rates) and every output token used. Undefined: the model is not priced. */
export function worstCaseUsd(modelName: string, call: Pick<Call, "system" | "user" | "maxOutputTokens">): number | undefined {
  const prices = listPricesPerMillion({ provider: "anthropic", modelId: modelName });
  if (prices === undefined || !(prices.output > 0) || !(prices.input > 0)) return undefined;
  if (!Number.isSafeInteger(call.maxOutputTokens) || call.maxOutputTokens < 1) return undefined;
  const inputTokens = FRAMING_TOKENS + Buffer.byteLength(call.system) + Buffer.byteLength(call.user);
  // A price in dollars per million tokens is exactly micro-dollars per token, so the sum is already in micro-dollars (no float noise from dividing and multiplying back).
  const micros = inputTokens * Math.max(prices.input, prices.cacheWrite) + call.maxOutputTokens * prices.output;
  return Math.ceil(micros - 1e-6) / MICRO;
}

/**
 * The learning port for each company, or undefined for a company that cannot have one (the lessons' learning calls then refuse). Settings are read when a company asks, never earlier, so a broken or
 * missing setting is "no port" and never a startup failure.
 */
/**
 * The learning model setting (DEC 254zzz58): `{ fixed }` for a set Claude engine name, `{ offered: true }` when empty (the first Claude model the gateway offers the company), undefined for a SET value that
 * is not a Claude engine name (learning is then "not set up"; never a silent fall back to the agent model or the offered list).
 */
export function hostedLearningModelSetting(env: NodeJS.ProcessEnv): { fixed: string } | { offered: true } | undefined {
  const chosen = env[CORE_LEARNING_MODEL_VARIABLE]?.trim() ?? "";
  if (chosen === "") return { offered: true };
  return isCoreLearningModelId(chosen) && CORE_CLAUDE_AGENT_MODEL.test(chosen) ? { fixed: chosen } : undefined;
}

/** The first model of the company's offered list that the learning route can use and Code can price (a Claude engine name with list prices), or undefined when there is none. */
export function firstOfferedLearningModel(offered: OfferedAgentModels): string | undefined {
  for (const { model } of offered.models) {
    if (!isCoreLearningModelId(model) || !CORE_CLAUDE_AGENT_MODEL.test(model)) continue;
    const prices = listPricesPerMillion({ provider: "anthropic", modelId: model });
    if (prices !== undefined && prices.input > 0 && prices.output > 0) return model;
  }
  return undefined;
}

export interface HostedLearningOptions {
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  /** The company's offered models (tests). Absent: the gateway's own offered-models read, signed with the task key. */
  offered?: (companyId: OrgId) => Promise<unknown>;
  /** Where the one "no Claude model" line goes. */
  log?: (entry: Record<string, unknown>) => void;
}

export function hostedLessonsLearning(
  env: NodeJS.ProcessEnv,
  taskTokens: (() => { signer: TokenSigner; issuer: string } | undefined) | undefined,
  options: HostedLearningOptions = {},
): (companyId: OrgId) => HostedLearning | undefined {
  return (companyId) => {
    if (!OrgIdSchema.safeParse(companyId).success) return undefined;
    const settings = readGatewayModelAccess(env);
    if (settings === undefined || "problem" in settings) return undefined;
    // The learning route is the gateway's Anthropic Messages path, on its OWN model (never the agent model): the set Claude engine name, or the first Claude model the gateway offers the company.
    const setting = hostedLearningModelSetting(env);
    if (setting === undefined) return undefined;
    let tokens: { signer: TokenSigner; issuer: string } | undefined;
    try { tokens = taskTokens?.(); } catch { return undefined; }
    if (tokens === undefined || typeof tokens.issuer !== "string" || tokens.issuer === "" || typeof tokens.signer?.sign !== "function" || typeof tokens.signer.publicJwk !== "function") return undefined;
    const { signer, issuer } = tokens;
    const now = options.now ?? Date.now;
    const readOffered = options.offered
      ?? ((company: OrgId) => offeredModelsReader({ gatewayUrl: settings.gatewayUrl, issuer, signer, now, ...(options.fetch === undefined ? {} : { fetch: options.fetch }) }).offered(company));
    // The company's chosen model, kept for LEARNING_MODEL_READ_MS (null: the gateway offers it none). A failed read is never kept and throws fixed words: the call is a failure, never a guess.
    let chosen: { model: string | null; at: number } | undefined;
    let toldNone = false;
    const modelNow = async (): Promise<string | undefined> => {
      if ("fixed" in setting) return setting.fixed;
      const at = now();
      if (chosen === undefined || !(at - chosen.at < LEARNING_MODEL_READ_MS) || at < chosen.at) {
        let offered: OfferedAgentModels;
        try { offered = OfferedAgentModelsSchema.parse(await readOffered(companyId)); } catch { throw new Error(READ_FAILED_WORDS); }
        chosen = { model: firstOfferedLearningModel(offered) ?? null, at };
      }
      if (chosen.model === null) {
        if (!toldNone) { toldNone = true; options.log?.({ event: "core_engine.lessons_learning_not_set_up", companyId, reason: "no_claude_model", notice: LEARNING_NO_CLAUDE_NOTICE }); }
        return undefined;
      }
      toldNone = false;
      return chosen.model;
    };
    const innerFor = (modelName: string) => createGatewayLearningModel({
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
        const minted = await mintTaskToken({ signer, issuer, describer, now }, { workspaceId: randomUUID(), operationId: randomUUID(), fence: 0 });
        return { token: minted.token, model: modelName };
      },
    });
    // The per-call cap is Code's (see THE CAPS): refused before any token is minted, so nothing is sent. Another company's workspace, or a call with no project of ours, is refused before the model is chosen.
    const ours = (request: Call): boolean => request.workspaceId === companyId && typeof request.project === "string" && AGENTX_NAME_PATTERN.test(request.project);
    const model: PipelineModel = {
      async quote(request) {
        if (request.workspaceId !== companyId) return { ok: false, code: "no_provider" };
        const modelName = await modelNow();
        if (modelName === undefined) return { ok: false, code: "no_suitable_model" };
        const usd = worstCaseUsd(modelName, request);
        if (usd === undefined) return { ok: false, code: "no_suitable_model" };
        if (request.maxHoldUsd !== undefined && usd > request.maxHoldUsd) return { ok: false, code: "cost_too_high" };
        return { ok: true, usd };
      },
      async complete(request) {
        if (!ours(request)) throw new LearningRefusal("no_provider", LEARNING_NOT_AVAILABLE);
        const modelName = await modelNow();
        if (modelName === undefined) throw new LearningRefusal("no_suitable_model", NO_CLAUDE_WORDS);
        const usd = worstCaseUsd(modelName, request);
        if (usd === undefined) throw new LearningRefusal("no_suitable_model", NO_PRICE_WORDS);
        if ((request.maxHoldUsd !== undefined && usd > request.maxHoldUsd) || (request.budgetUsd !== undefined && usd > request.budgetUsd)) throw new LearningRefusal("cost_too_high", CAP_WORDS);
        return await innerFor(modelName).complete(request);
      },
    };
    return { model, spend: gatewayLearningSpend() };
  };
}
