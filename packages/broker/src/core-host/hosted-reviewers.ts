// Hosted reviewers use only the gateway's current company attestation. A catalog listing alone grants nothing.
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { parseTaskTokenClaims, DesignReviewBindingSchema, SecondReviewerSchema, agentModelIdentity, agentModelName, configuredSecondReviewMode, designReviewActive, type ModelIdentifier, type OrgId, type RegistryView } from "@agentx/contracts";
import { taskPayerOf } from "../core/model-gateway/describer.js";
import { RUN_START_ACTION } from "../core/task-flow/money-stop.js";
import { SPEND_STOP_REASON } from "../core/task-flow/money-stop.js";
import { createSecondReview } from "../core/second-review/service.js";
import { estimateSecondReviewUsd, SECOND_REVIEW_TYPICAL_REVIEW_TOKENS } from "../core/second-review/picker.js";
import { readSecondReviewSettings } from "../core/second-review/settings.js";
import { secondOpinionOfTask } from "../core/second-review/store.js";
import { readTask, workspaceOperations } from "../core/task-flow/reads.js";
import { readTaskTokenRecords } from "../core/model-gateway/records.js";
import type { TaskFlowDeps } from "../core/task-flow/deps.js";
import type { TaskTokenDescriber, TaskTokenDescription } from "../core/model-gateway/token.js";
import { bindingSlotOf, putSlotKey, readSlotCeiling, readSlotKeyRecord, slotKeyRowExists } from "../core/design-review/slot-keys.js";
import { gatewayRouteOf } from "./gateway-model-selection.js";
import { reviewerAuthority } from "./reviewer-authority.js";
import { usdPerMillion } from "../core/cost/price-table.js";
import { registryModelPrices } from "../local/model-prices.js";

export const SECOND_PROVIDER_UNAVAILABLE = "Second review not available: connect a second AI provider";
export interface HostedReviewerOptions {
  flow: TaskFlowDeps;
  companyId: OrgId;
  registry: RegistryView;
  taskRoomUsd(task: { taskId: string; companyId: OrgId; project: string }): Promise<number>;
  offered?: ((companyId: OrgId) => Promise<unknown>) | undefined;
}

export function createHostedReviewers(options: HostedReviewerOptions) {
  const { flow, companyId, registry } = options;
  const authority = () => reviewerAuthority({ companyId, offered: options.offered });
  const admitted = async (task: { taskId: string; companyId: OrgId; project: string }) => task.companyId === companyId && (await flow.admission.admit({ companyId, action: RUN_START_ACTION, idempotencyKey: `reviewer-gate:${task.taskId}`, projectName: task.project, subject: { type: "task", id: task.taskId } })).allowed;
  const prices = registryModelPrices(registry);
  async function taskModels(input: { taskId: string; project: string }) {
    const task = await readTask(flow, input.taskId);
    if (task === undefined || task.companyId !== companyId || task.project !== input.project) return { builds: [undefined], firstReviewer: undefined };
    const operations = await workspaceOperations(flow, task.workspaceId);
    const fallback = await flow.modelAccess?.route();
    const defaultModel = fallback === undefined ? undefined : agentModelIdentity(fallback.alias);
    const builds = operations.filter((operation) => operation.workflowMode === "IMPLEMENT").map((operation) => operation.modelChoice?.model ?? defaultModel);
    const reviewed = operations.filter((operation) => operation.workflowMode === "REVIEW").at(-1);
    return { builds: builds.length === 0 ? [defaultModel] : builds, firstReviewer: reviewed?.modelChoice?.model ?? defaultModel };
  }
  const price = (model: ModelIdentifier) => usdPerMillion(prices.findCap(model));
  const service = (access: Awaited<ReturnType<typeof authority>>) => createSecondReview({
    store: flow.store, companyId, audit: registry.require("audit-sink"), approvers: registry.require("approvers"), admission: flow.admission,
    now: () => (flow.now?.() ?? new Date()).getTime(), ...(flow.log === undefined ? {} : { log: flow.log }),
    seams: {
      sources: async () => (access?.models ?? []).map((entry) => agentModelIdentity(entry.model)).filter((model) => price(model) !== undefined), taskModels, price: (model) => { const rates = price(model); return rates === undefined ? undefined : { inputUsdPerMTok: rates.input, outputUsdPerMTok: rates.output, cacheReadUsdPerMTok: rates.cacheRead, cacheWriteUsdPerMTok: rates.cacheWrite }; },
      route: async (model) => {
        const name = agentModelName(model);
        if (name === undefined || access === undefined || !access.models.some((entry) => entry.model === name)) return undefined;
        const rates = price(model);
        if (rates === undefined) return undefined;
        // Admission holds this same estimate. The key can never be given more than that hold.
        const heldUsd = estimateSecondReviewUsd({ inputUsdPerMTok: rates.input, outputUsdPerMTok: rates.output, cacheReadUsdPerMTok: rates.cacheRead, cacheWriteUsdPerMTok: rates.cacheWrite }, { input: SECOND_REVIEW_TYPICAL_REVIEW_TOKENS.input, maxOutput: SECOND_REVIEW_TYPICAL_REVIEW_TOKENS.output });
        return { workerRoute: gatewayRouteOf(name), alias: name, cap: { capUsd: Math.min(access.companyLimitUsd, Math.floor(heldUsd * 1_000_000) / 1_000_000), usdPerMTok: rates } };
      },
    },
  });
  const base = service(undefined);
  const secondReview: NonNullable<TaskFlowDeps["secondReview"]> = {
    ...base,
    async prepare(input) {
      if (input.task?.workflow?.candidate === undefined || (input.reviewers !== undefined && !input.reviewers.includes("CRITIC"))) return {};
      const task = await readTask(flow, input.task.taskId);
      if (task === undefined || task.companyId !== companyId || task.project !== input.task.project) return {};
      let mode;
      try {
        const settings = await readSecondReviewSettings(flow.store, companyId, task.project);
        mode = configuredSecondReviewMode({ project: settings.projectMode, companyDefault: settings.companyDefault, companyLock: settings.companyLock });
      } catch { mode = "shadow" as const; }
      if (mode === "off") return {};
      const unavailable = () => ({ firstEvent: SECOND_PROVIDER_UNAVAILABLE, record: { candidateDigest: input.task!.workflow!.candidate!.digest, notRun: { mode: mode === "on" ? "on" as const : "shadow" as const, reason: "no-candidate" as const } } });
      const access = await authority();
      const primary = (await taskModels(input.task)).firstReviewer;
      const provider = access?.models.find((entry) => entry.model === (primary === undefined ? undefined : agentModelName(primary)))?.provider;
      if (access === undefined || provider === undefined || !access.models.some((entry) => entry.provider !== provider)) return unavailable();
      if (!await admitted(task) || !(await options.taskRoomUsd(task) > 0)) return { firstEvent: SPEND_STOP_REASON, record: { candidateDigest: input.task.workflow.candidate.digest, notRun: { mode: mode === "on" ? "on" : "shadow", reason: "budget" } } };
      const connected = { ...access, models: access.models.filter((entry) => entry.provider !== provider) };
      const prepared = await service(connected).prepare(input);
      if (prepared.field === undefined) return prepared.record?.notRun?.reason === "no-candidate" ? unavailable() : prepared.record?.notRun?.reason === "budget" ? { ...prepared, firstEvent: SPEND_STOP_REASON } : prepared;
      // One grant, one model. Never hand the primary token to an additional reviewer or authorize fallback aliases.
      const first = prepared.field.candidates[0]!;
      const name = first.modelRoute?.alias;
      return { ...prepared, field: { ...prepared.field, candidates: [{ ...first, keySlot: "second_review" as const }] }, ...(prepared.record === undefined ? {} : { record: { ...prepared.record, aliases: name === undefined ? [] : [name], caps: name === undefined ? {} : Object.fromEntries([[name, prepared.record.caps![name]!]]), ...(prepared.record.plan === undefined ? {} : { plan: { ...prepared.record.plan, candidates: [first.model] } }) } }) };
    },
    prLines(task, digest, accepted) {
      const opinion = secondOpinionOfTask(task, digest);
      if (opinion?.unavailable && opinion.unavailableReason === "no-candidate") return [SECOND_PROVIDER_UNAVAILABLE];
      if (opinion?.unavailable && opinion.unavailableReason === "budget") return [SPEND_STOP_REASON];
      return base.prLines(task, digest, accepted);
    },
  };

  const grants: Pick<TaskTokenDescriber, "describeReviewer" | "reviewerMinted"> = {
    async describeReviewer(scope, records, slot) {
      const { operation, task, workspace } = records;
      if (operation.kind !== "task" || operation.companyId !== companyId || task.companyId !== companyId || workspace.companyId !== companyId) return undefined;
      if (scope.workspaceId !== workspace.id || scope.operationId !== operation.id || operation.workspaceId !== workspace.id || task.workspaceId !== workspace.id || task.project !== workspace.projectName
        || operation.status !== "RUNNING" || task.closedAt !== undefined || task.releasedAt !== undefined || task.stopRequest !== undefined || workspace.closedAt !== undefined
        || ["CLOSING", "CLOSED", "STOPPED"].includes(workspace.status) || ["CLOSED", "MERGED"].includes(task.workflow?.stage ?? "")) return undefined;
      const keyScope = { orgId: companyId, operationId: operation.id, slot };
      const exists = await slotKeyRowExists(flow.store, keyScope);
      const saved = exists ? await readSlotKeyRecord(flow.store, keyScope) : undefined;
      const first = saved?.reviewerGrant;
      const now = Math.floor((flow.now?.() ?? new Date()).getTime() / 1000);
      if (exists && (first?.reviewer === undefined || saved!.askedAgain > 0 || now < first.iat || now + 120 > first.iat + 600 || saved!.expiresAt <= now * 1000)) return undefined;
      // The gateway already holds the original ceiling. A renewal is no new admission or reservation;
      // the gateway still checks provider access and session room on every turn.
      const access = first === undefined ? await authority() : undefined;
      if (first === undefined && (access === undefined || !await admitted(task))) return undefined;
      let kind: "second_review" | "design_review", alias: string | undefined, ceilingUsd: number | undefined;
      if (slot === "second_review" && operation.workflowMode === "REVIEW" && task.workflow?.stage === "REVIEW" && operation.designReview === undefined) {
        const second = SecondReviewerSchema.safeParse(operation.dispatch?.payload?.["workflowSecondReviewer"]);
        if (!second.success || second.data.candidates.length !== 1 || second.data.candidates[0]?.keySlot !== slot || operation.secondReviewPlan?.candidateDigest !== task.workflow?.candidate?.digest) return undefined;
        alias = second.data.candidates[0].modelRoute?.alias;
        if (first === undefined) {
          const primary = operation.modelChoice?.route.alias ?? (await flow.modelAccess?.route())?.alias;
          const provider = access!.models.find((entry) => entry.model === primary)?.provider;
          const other = access!.models.find((entry) => entry.model === alias)?.provider;
          if (provider === undefined || other === undefined || provider === other) return undefined;
        }
        ceilingUsd = alias === undefined ? undefined : operation.secondReviewPlan?.caps?.[alias]?.capUsd;
        kind = "second_review";
      } else {
        const binding = DesignReviewBindingSchema.safeParse(operation.designReview);
        const review = task.workflow?.designReview;
        if (operation.workflowMode !== "PLAN_CRITIQUE" || !binding.success || review === undefined || !designReviewActive(review) || review.rounds.some((round) => round.round === binding.data.round)) return undefined;
        const found = bindingSlotOf(binding.data, slot);
        if (found === undefined) return undefined;
        alias = found.modelRoute?.alias ?? agentModelName(found.model);
        ceilingUsd = await readSlotCeiling(flow.store, { orgId: companyId, operationId: operation.id, slot });
        kind = "design_review";
      }
      if (alias === undefined || (first === undefined && !access!.models.some((entry) => entry.model === alias)) || ceilingUsd === undefined || !Number.isFinite(ceilingUsd) || ceilingUsd <= 0) return undefined;
      const room = first?.reviewer?.ceilingUsd ?? await options.taskRoomUsd(task);
      if (!(room > 0) || !Number.isFinite(room)) return undefined;
      const resolved = await taskPayerOf(flow, records);
      if (resolved === undefined) return undefined;
      const { payer, person, origin } = resolved;
      const description: TaskTokenDescription = { companyId, project: workspace.projectName, payer, ...(person === undefined ? {} : { person }), ...(origin === undefined ? {} : { origin }), taskId: task.taskId, step: kind, models: [alias], reviewer: { kind, slot, ceilingUsd: Math.min(ceilingUsd, first?.reviewer?.ceilingUsd ?? access!.companyLimitUsd, room) } };
      if (first?.reviewer === undefined) return description;
      if (first.reviewer.ceilingUsd > ceilingUsd) return undefined;
      const original: TaskTokenDescription = { companyId: first.cid, project: first.pid, taskId: first.tid, step: first.stp, payer: first.pay,
        ...(first.per === undefined ? {} : { person: first.per }), ...(first.src === undefined ? {} : { origin: first.src }), models: first.mdl, reviewer: first.reviewer };
      if (first.ws !== scope.workspaceId || first.op !== scope.operationId || !isDeepStrictEqual(description, original)) return undefined;
      return { ...description, reviewerGrant: first };
    },
    async reviewerMinted(operation, description, token, expiresAt) {
      const reviewer = description.reviewer;
      if (reviewer === undefined) return;
      // Re-read after signing: a task closed or rebound during key I/O must not get a renewal.
      const records = await readTaskTokenRecords(flow, operation);
      const current = await grants.describeReviewer!(operation, records, reviewer.slot);
      if (current === undefined || !isDeepStrictEqual(current, description)) throw new Error("reviewer access ended");
      const claims = parseTaskTokenClaims(JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()));
      if (claims?.reviewer === undefined || claims.exp * 1000 !== expiresAt) throw new Error("invalid reviewer grant");
      if (description.reviewerGrant !== undefined) {
        if (claims.jti !== description.reviewerGrant.jti) throw new Error("reviewer identity changed");
        return;
      }
      const binding = reviewer.kind === "design_review" ? DesignReviewBindingSchema.parse(records.operation.designReview) : undefined;
      const slot = binding === undefined ? undefined : bindingSlotOf(binding, reviewer.slot);
      const kept = await putSlotKey(flow.store, { orgId: companyId, operationId: operation.operationId, slot: reviewer.slot, purpose: slot?.purpose ?? "reviewer", round: binding?.round ?? 1, keyId: createHash("sha256").update(token).digest("hex"), expiresAt: (claims.iat + 600) * 1000, budgetUsd: reviewer.ceilingUsd, alias: description.models[0]!, nowMs: claims.iat * 1000, reviewerGrant: claims });
      if (!kept) throw new Error("reviewer key already issued");
    },
  };
  return { secondReview, grants, authority, price };
}
