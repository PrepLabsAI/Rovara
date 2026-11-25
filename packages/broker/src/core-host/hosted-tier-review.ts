// TIER-GROWTH-MERGE, hosted wiring: the model call and the money check of the grown tier's two reviews (the code review and the security review a change that grew must pass on its current head).
//
//   WHAT RUNS     The same two reviewers' roles and prompts the tier pass already builds (`grownReviewPrompt`: the patch is ONE JSON value between boundary lines made fresh for the call, untrusted, no system text). This file is
//                 only the transport: `tierReviewCall` sends that prompt as one Anthropic Messages request to the model gateway's AGENT route (`/v1/messages`), the route every task step calls, and returns the model's text.
//   WHO PAYS      The task, as any run of it: the token is minted exactly as a task token is (`mintTaskToken`: the install's KMS task key, the sign-in issuer) from the task's own payer (`taskPayerOf`, resolved from the
//                 task's own operation, never from a request), step `review`, ONE model (`mdl`), with the gateway's current signed price for that model. The gateway holds, calls and settles the money; no key is read,
//                 held or sent from Code. The reply's usage is booked into the task's cost ledger (the same booking the workers' usage takes, so the task's cap and the company's day see it).
//   THE METER     `tierReviewMeter` runs before EVERY call and answers by reason: `true` (go), `false` (the task's spending limit: admission refused a run, no room above zero, or the call's worst-case price does not fit in the room),
//                 or "unavailable" (the task, the model, the price or the ledger could not be read: nothing is sent, and the person is not told the limit stopped it). The worst case is priced on the request body AS SENT (the
//                 prompt the tier pass gives it, JSON-escaped; without it, the patch's characters at their widest plus the framing), and `call` compares its own worst case to the room again before it sends anything.
//   BOOKING       A reply with a 2xx status is a paid call: it is booked on the task's ledger whether or not its answer can be read (the gateway's figure, else the reply's token counts, else the worst case, never $0), and a call
//                 that was sent and aborted is booked at its worst case. After a request may have reached the model nothing is repeated (`TierReviewNoRetry`): only a failure before anything was sent is tried once more. A booking
//                 that fails is kept, and the meter refuses the task's next call until it is booked.
//   THE TOKEN     A reviewer grant of the kind `tier_review` (the Cloud gateway's kind for this): step = kind, one model, a 120 second life, a fresh jti per review (slots `tier_code`, `tier_security`), exactly the members kind, slot and
//                 `ceilingUsd`, the signed run price, and the task's own workspace and latest operation. The ceiling is this call's priced worst case: the gateway holds it inside the task's limit and the company's cap, refuses a call
//                 past it, and returns what is unused. SKEW: a gateway that does not know the kind answers 401: the review does not run, the person reads "could not run", the change cannot merge. Deploy the Cloud gateway first.
//   WHICH TASK    The call is made inside the tier pass for one task (`tierReviewTask`, an async scope the pass opens): a call outside it names no task and is refused. The call's own input stays exactly what the model is sent.
//   FAIL CLOSED   No gateway settings, no task-token signer or issuer, a task that is not this company's, a payer that cannot be resolved, a model the gateway has no price for, a redirect, a body over the bound, anything
//                 unreadable: no call, or a failed call, and the tier review is not recorded, so the change cannot merge. Nothing the gateway or the model sent is echoed.
import { randomUUID } from "node:crypto";
import { agentModelIdentity, agentModelName, isRovaraAiPaused, type ModelSelection, type OrgId, type RunPrice } from "@agentx/contracts";
import type { TokenSigner } from "../developer/tokens.js";
import { TierReviewCapError, TierReviewNoRetry, TierReviewUnsupported, tierReviewTask, type TierReviewCall, type TierReviewMeter } from "../core/build-step/tier-review-calls.js";
import { taskPayerOf } from "../core/model-gateway/describer.js";
import { mintTaskToken, type TaskTokenDescriber } from "../core/model-gateway/token.js";
import { RUN_START_ACTION } from "../core/task-flow/money-stop.js";
import type { TaskFlowDeps } from "../core/task-flow/deps.js";
import { readTask, workspaceOperations } from "../core/task-flow/reads.js";
import { readWorkspace } from "../core/task-flow/stage-machine.js";
import { gatewayCallUsd } from "./gateway-call-price.js";
import { readGatewayModelAccess } from "./gateway-model-access.js";
import { boundedText } from "./offered-models-http.js";
import { runPriceReader } from "./run-price-http.js";
import type { UsageBooking } from "./usage-booking.js";

/** The path every task step's model call takes on the gateway. */
export const TIER_REVIEW_MESSAGES_PATH = "/v1/messages";
/** The step the token names: the grant's kind (the gateway refuses a reviewer grant whose step is another). */
export const TIER_REVIEW_STEP = "tier_review";
/** The reviewer kind of the grant (the gateway requires the step to equal it) and the slot each review asks under: one grant, with its own ceiling and a fresh jti, per review. */
export const TIER_REVIEW_KIND = "tier_review";
const SLOT_OF = { code_review: "tier_code", security_review: "tier_security", questions: "tier_questions" } as const;
/** The most a review answers (tokens): a list of findings. */
const MAX_OUTPUT_TOKENS = 4_096;
const REPLY_MAX_BYTES = 1_000_000;
const DEFAULT_TIMEOUT_MS = 120_000;
export const TIER_REVIEW_CALL_FAILED = "The tier review call did not complete.";

export interface HostedTierReviewOptions {
  env: NodeJS.ProcessEnv;
  taskTokens: (() => { signer: TokenSigner; issuer: string } | undefined) | undefined;
  flow: TaskFlowDeps;
  companyId: OrgId;
  now: () => Date;
  /** The task's cap, less what it has spent, in dollars (`reviewerRoomUsd`): the same figure the hosted second review reads. Unknown money is 0. */
  taskRoomUsd(task: { taskId: string; companyId: OrgId; project: string }): Promise<number>;
  /** Books the call's usage into the task's cost ledger (the workers' usage booking). */
  booking: Pick<UsageBooking, "bookUsageReport">;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** What the meter assumes a character of a patch costs in the request body when it is not given the prompt itself: the JSON escape of a control character is the widest (`\\u{1f}` is eight bytes once the body is JSON). */
const FALLBACK_BYTES_PER_CHAR = 8;
/** The role text, the answer format and the boundary lines around the patch in every prompt (`grownReviewPrompt`), with room to spare. */
const FRAMING_BYTES = 4_096;

/** The task and where it runs, from its own records: the payer is the task's (who asked for it), and the workspace and operation are the real ones the gateway can bind the token to. */
async function taskScopeOf(flow: TaskFlowDeps, task: NonNullable<Awaited<ReturnType<typeof readTask>>>) {
  const workspace = await readWorkspace(flow, task.workspaceId);
  const operation = (await workspaceOperations(flow, task.workspaceId)).filter((entry) => entry.kind === "task").at(-1);
  if (workspace === undefined || operation === undefined) throw new Error(TIER_REVIEW_CALL_FAILED);
  const resolved = await taskPayerOf(flow, { operation, workspace, task });
  if (resolved === undefined || resolved.repairDraft) throw new Error(TIER_REVIEW_CALL_FAILED);
  return { ...resolved, workspaceId: workspace.id, operationId: operation.id, fence: operation.fence, records: { operation, workspace, task } };
}

/** The text of the model's answer. */
const textOf = (blocks: ReadonlyArray<{ type?: unknown; text?: unknown }>): string => blocks.filter((block) => block.type === "text" && typeof block.text === "string").map((block) => block.text as string).join("");

/** The gateway's refusals that come before any provider is called. A status that is none of them returns, and the caller books it as a call that may have been paid for. */
const GATEWAY_REFUSALS = new Set([401, 403, 409, 422, 429, 503]);
/** What a failed connection says when it never reached the gateway. */
const PRE_SEND = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);

/** A failed connection that proves nothing reached the gateway: the name did not resolve, or the connection was refused. */
const provablyNotSent = (error: unknown, aborted: boolean): boolean => !aborted && PRE_SEND.has(String((error as { cause?: { code?: unknown } } | undefined)?.cause?.code));

async function refuseBeforeSend(response: Response): Promise<void> {
  if (!GATEWAY_REFUSALS.has(response.status)) return;
  if (response.status !== 422) throw new Error(TIER_REVIEW_CALL_FAILED);
  // A 422 with the code `budget_exceeded` is the limit of the task, the person, the project or the company, unless it is about the grant itself ("Key=reviewer": a source or an estimate the grant cannot serve, for example an
  // OpenRouter model): that one is not the spending limit. Any other or unreadable 422 is not read as the limit either.
  let refusal: { type?: unknown; message?: unknown } = {};
  try { refusal = (JSON.parse(await boundedText(response, 65_536)) as { error?: typeof refusal }).error ?? {}; } catch { /* unreadable: not the limit */ }
  if (refusal.type === "budget_exceeded" && !/Key=reviewer\b/u.test(typeof refusal.message === "string" ? refusal.message : "")) throw new TierReviewCapError();
  throw new TierReviewUnsupported();
}

const numberOf = (value: unknown): number => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0);

/**
 * What a call cost, as the usage report the ledger books: the gateway's own figure when it gives a readable one (never above the call's worst case), else the reply's token counts; a reply with neither is booked at
 * the worst case, never at nothing.
 */
function usagePayload(input: { provider: string; modelId: string; usage: Record<string, unknown> | undefined; cost: string | null; worst: number }) {
  const { usage } = input;
  const tokens = { input: numberOf(usage?.["input_tokens"]), output: numberOf(usage?.["output_tokens"]), cacheRead: numberOf(usage?.["cache_read_input_tokens"]), cacheWrite: numberOf(usage?.["cache_creation_input_tokens"]) };
  const reported = input.cost === null ? Number.NaN : Number(input.cost);
  const costUsd = Number.isFinite(reported) && reported >= 0 ? Math.min(reported, input.worst) : Object.values(tokens).some((count) => count > 0) ? undefined : input.worst;
  return { provider: input.provider, modelId: input.modelId, tokens, ...(costUsd === undefined ? {} : { costUsd }) };
}

type UnbookedUsage = Parameters<UsageBooking["bookUsageReport"]>[0];

/** The call and the meter the tier pass takes (`deps.tierReviewCall`, `deps.tierReviewMeter`), or undefined when this install cannot make them (no gateway, no task-token key): the tier pass then says the reviews could not run. */
export function hostedTierReview(options: HostedTierReviewOptions): { call: TierReviewCall; meter: TierReviewMeter } | undefined {
  const { flow, companyId } = options;
  const settings = readGatewayModelAccess(options.env);
  if (settings === undefined || "problem" in settings) return undefined;
  let tokens: { signer: TokenSigner; issuer: string } | undefined;
  try { tokens = options.taskTokens?.(); } catch { return undefined; }
  if (tokens === undefined || typeof tokens.issuer !== "string" || tokens.issuer === "" || typeof tokens.signer?.sign !== "function" || typeof tokens.signer.publicJwk !== "function") return undefined;
  const { signer, issuer } = tokens;
  const nowMs = () => options.now().getTime();
  const send: typeof fetch = (input, init) => (options.fetch ?? fetch)(input, init);
  const readPrice = runPriceReader({ gatewayUrl: settings.gatewayUrl, signer, issuer, now: nowMs, ...(options.fetch === undefined ? {} : { fetch: options.fetch }) });
  /**
   * Usage a call spent that the ledger would not take: kept in a row of its own (so a restart does not forget it) and in memory, and nothing more is paid for the task until it is booked (fail closed). The row is a new
   * partition nothing else reads; booking is idempotent on the entry id.
   */
  const unbookedPk = (taskId: string) => `TIER_REVIEW_UNBOOKED#${companyId}#${taskId}`;
  const unbooked = new Map<string, UnbookedUsage[]>();
  const keep = async (report: UnbookedUsage): Promise<void> => {
    unbooked.set(report.taskId, [...(unbooked.get(report.taskId) ?? []), report]);
    await flow.store.put({ item: { pk: unbookedPk(report.taskId), sk: `ENTRY#${report.entryId}`, entityType: "TIER_REVIEW_UNBOOKED", ...JSON.parse(JSON.stringify(report)) as Record<string, unknown> } }).catch(() => undefined);
  };
  const bookPending = async (taskId: string): Promise<boolean> => {
    const stored = (await flow.store.query({ pk: unbookedPk(taskId), sk: { op: "beginsWith", prefix: "ENTRY#" } })).items as unknown as UnbookedUsage[];
    const pending = new Map([...(unbooked.get(taskId) ?? []), ...stored].map((report) => [report.entryId, report]));
    for (const report of [...pending.values()]) {
      try {
        await options.booking.bookUsageReport({ companyId: report.companyId, taskId: report.taskId, entryId: report.entryId, at: report.at, payload: report.payload });
        pending.delete(report.entryId);
        await flow.store.delete({ key: { pk: unbookedPk(taskId), sk: `ENTRY#${report.entryId}` } }).catch(() => undefined);
      } catch { /* kept: the next call is refused */ }
    }
    if (pending.size === 0) { unbooked.delete(taskId); return true; }
    unbooked.set(taskId, [...pending.values()]);
    return false;
  };

  /** The task, only when it is this company's, still open and at a stage where a model call for it makes sense. */
  const openTask = async (taskId: string) => {
    const task = await readTask(flow, taskId);
    return task === undefined || task.companyId !== companyId || task.closedAt !== undefined || task.releasedAt !== undefined || task.workflow === undefined || ["CLOSED", "MERGED"].includes(task.workflow.stage) ? undefined : task;
  };
  /** The gateway's name for the model the checking stage chose, else the install's agent route (the one every task step without a choice of its own is dispatched with, as the token describer reads it). */
  const modelOf = async (model: ModelSelection | undefined): Promise<string | undefined> => {
    if (model !== undefined) return agentModelName(model);
    try { return (await flow.modelAccess?.route())?.alias; } catch { return undefined; }
  };
  /** The worst this call can cost: the gateway's price for the model over the request body exactly as it is sent (JSON, so every quote and newline of the prompt counts). */
  const worstOf = async (alias: string, user: string): Promise<{ price: RunPrice; worst: number } | undefined> => {
    const price = await readPrice(companyId, alias);
    const worst = gatewayCallUsd(price, { system: "", user, maxOutputTokens: MAX_OUTPUT_TOKENS });
    return price === undefined || worst === undefined ? undefined : { price, worst };
  };

  const meter: TierReviewMeter = async ({ taskId, model, promptChars, prompt }) => {
    try {
      const task = await openTask(taskId);
      if (task === undefined || !(await bookPending(taskId))) return "unavailable";
      const verdict = await flow.admission.admit({ companyId, action: RUN_START_ACTION, idempotencyKey: `tier-review:${taskId}:${randomUUID()}`, projectName: task.project, subject: { type: "task", id: taskId } });
      if (!verdict.allowed) return false;
      const room = await options.taskRoomUsd({ taskId, companyId, project: task.project });
      if (!(room > 0)) return false;
      const alias = await modelOf(model);
      if (alias === undefined) return "unavailable";
      // The prompt actually sent when the caller has it; else the widest it could be (the patch's characters, each at its widest in JSON, and the framing around it).
      const priced = await worstOf(alias, prompt ?? "x".repeat(Math.max(0, promptChars) * FALLBACK_BYTES_PER_CHAR + FRAMING_BYTES));
      return priced === undefined ? "unavailable" : priced.worst <= room;
    } catch {
      return "unavailable";
    }
  };

  const call: TierReviewCall = async ({ model, prompt, purpose, signal }) => {
    const taskId = tierReviewTask.getStore()?.taskId;
    if (taskId === undefined) throw new Error(TIER_REVIEW_CALL_FAILED);
    const task = await openTask(taskId);
    const alias = await modelOf(model);
    if (task === undefined || alias === undefined) throw new Error(TIER_REVIEW_CALL_FAILED);
    const priced = await worstOf(alias, prompt);
    if (priced === undefined) throw new Error(TIER_REVIEW_CALL_FAILED);
    // The meter's answer is not the last word: this call's own worst case, for the prompt as it is sent, must fit in what the task has left NOW.
    if (!(priced.worst <= await options.taskRoomUsd({ taskId, companyId, project: task.project }))) throw new TierReviewCapError();
    const scope = await taskScopeOf(flow, task);
    // A reviewer grant of the kind `tier_review` (step = kind, one model, a 120 second life, a fresh jti), bound to the task's own workspace and latest operation, with this call's priced worst case as its ceiling: the gateway
    // holds that ceiling inside the task's limit and the company's cap, refuses a call past it, and gives back what is unused.
    const slot = SLOT_OF[purpose];
    const describer: TaskTokenDescriber = {
      describe: async () => undefined,
      describeReviewer: async () => ({ companyId, project: task.project, ...(scope.person === undefined ? {} : { person: scope.person }), payer: scope.payer, taskId, step: TIER_REVIEW_STEP,
        ...(scope.origin === undefined ? {} : { origin: scope.origin }), models: [alias], reviewer: { kind: TIER_REVIEW_KIND, slot, ceilingUsd: Math.min(priced.worst, 1_000_000) } }),
      reviewerMinted: async () => undefined,
    };
    const minted = await mintTaskToken({ signer, issuer, describer, now: nowMs, runPrice: async () => priced.price }, { workspaceId: scope.workspaceId, operationId: scope.operationId, fence: scope.fence, reviewerSlot: slot }, scope.records);
    const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const guard = AbortSignal.any([signal, timeout]);
    // `estimate`: the amount is the call's worst case, not a figure the gateway gave (a send that was cut off, or a failure after the model may have been called).
    const bookUsage = async (usage: Record<string, unknown> | undefined, cost: string | null, estimate = false): Promise<void> => {
      const report: UnbookedUsage = { companyId, taskId, entryId: `tier-review:${estimate ? "estimate:" : ""}${randomUUID()}`, at: options.now().toISOString(), payload: usagePayload({ provider: model?.provider ?? agentModelIdentity(alias).provider, modelId: alias, usage, cost, worst: priced.worst }) };
      try { await options.booking.bookUsageReport(report); } catch { await keep(report); throw new TierReviewNoRetry(); }
    };
    let response: Response;
    try {
      response = await send(new URL(TIER_REVIEW_MESSAGES_PATH, settings.gatewayUrl), {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": minted.token, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: alias, max_tokens: MAX_OUTPUT_TOKENS, messages: [{ role: "user", content: prompt }] }),
        signal: guard,
        // The token goes to the gateway only: a redirect is never followed.
        redirect: "manual",
      });
    } catch (error) {
      // Only a failure that proves nothing was sent (the name did not resolve, the connection was refused) may be tried once more. Anything else (aborted, or a socket cut after the request was written) may have reached the model:
      // it is booked at its worst case (an estimate) and never repeated.
      if (provablyNotSent(error, guard.aborted)) throw new Error(TIER_REVIEW_CALL_FAILED, { cause: error });
      await bookUsage(undefined, null, true);
      throw new TierReviewNoRetry();
    }
    // Not 2xx. The gateway's own refusals come before any provider is called (401 a kind it does not know, 403, 409, 422 a limit or an unsupported source, 429, 503 unavailable): nothing was spent. Any other status may come AFTER
    // the model was called (an upstream failure): booked at the gateway's figure when it gives one, else the worst case, and never repeated.
    if (response.status < 200 || response.status >= 300) {
      await refuseBeforeSend(response);
      await bookUsage(undefined, response.headers.get("x-rovara-cost-usd"), true);
      throw new TierReviewNoRetry();
    }
    // A 2xx is a call that was paid for: it is booked whether or not its answer can be read, and never repeated.
    let body: { content?: unknown; usage?: Record<string, unknown> } | undefined;
    try { body = JSON.parse(await boundedText(response, REPLY_MAX_BYTES)) as typeof body; } catch { body = undefined; }
    await bookUsage(body?.usage, response.headers.get("x-rovara-cost-usd"));
    const blocks = Array.isArray(body?.content) ? body.content as Array<{ type?: unknown; text?: unknown }> : undefined;
    if (isRovaraAiPaused(response.status, body) || blocks === undefined || blocks.some((block) => block === null || typeof block !== "object")) throw new TierReviewNoRetry(TIER_REVIEW_CALL_FAILED);
    return textOf(blocks);
  };
  return { call, meter };
}

/** Gives the flow's deps the hosted call and meter, where this install can make them. Without them the tier pass records that the reviews could not run, and the change cannot merge through Rovara. */
export function wireHostedTierReview(options: HostedTierReviewOptions): void {
  const built = hostedTierReview(options);
  if (built !== undefined) Object.assign(options.flow, { tierReviewCall: built.call, tierReviewMeter: built.meter });
}
