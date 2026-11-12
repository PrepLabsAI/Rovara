// The design review on `rovara up`. It builds the review's runtime (core/design-review/round-ports.ts) from what the laptop has: the registry's model choice and providers (one model, fixed by the owner), the model
// proxy's slot keys (one token per reviewer, with its own ceiling and spend record), the object storage for the files workers save, and the document store. It also gives the proxy's grant source the two functions a design review needs
// (`describeSlot`, `slotMinted`), which look a slot up in the binding the broker stored and never in anything the worker sends.
//
// The packets' sources (repository files at the pinned commits, the meta repository, MCP items through the project's context sources) are read by the broker (`design-review-sources.ts`). Not here yet (listed in
// docs/local.md): the planner's own resolve run spend is counted by the cost ledger, not added to the review's total.
import { createHash } from "node:crypto";
import { DesignReviewBindingSchema, agentXError, type WorkflowDesignReview, designReviewActive, type RegistryView, type ModelProviderAdapter, type ObjectStorage, type OrgId, type Principal } from "@agentx/contracts";
import { createDesignReviewSteps } from "../../core/design-review/steps.js";
import { answerReviewQuestions, designFirstOf, resumeParkedReview, retryBlockedReview } from "../../core/design-review/actions.js";
import { readEffectiveDesignReview } from "../../core/design-review/setting.js";
import { runDueDispatches } from "../../core/task-flow/stage-machine.js";
import { localResultOf } from "../../core/decisions/local-actions.js";
import type { LocalActionResult, LocalPageActions } from "../../core/local-pages/views.js";
import { DESIGN_CHOICE_KIND, createDesignChoiceSubject } from "../../core/design-review/choice-subject.js";
import { roundRecordPortsOf } from "../../core/design-review/outcome.js";
import { releaseDesignReviewRound } from "../../core/design-review/round-record.js";
import { sweepDesignWaits } from "../../core/design-review/wait.js";
import type { DecisionGate, DecisionSubject } from "../../core/decisions/approval-gate.js";
import type { SessionTimeline } from "../../core/merge/seams.js";
import { workspaceOperations } from "../../core/task-flow/reads.js";
import { designReviewProxyCheck } from "../../core/design-review/proxy-check.js";
import { bindingSlotOf, putSlotKey, readSlotCeiling, recordSlotReask, slotKeyRowExists } from "../../core/design-review/slot-keys.js";
import type { DesignReviewRuntime } from "../../core/design-review/round-ports.js";
import type { TaskFlowDeps } from "../../core/task-flow/deps.js";
import { operationKey, taskPointerKey } from "../../core/task-flow/keys.js";
import { readTask } from "../../core/task-flow/reads.js";
import { fromDocument, type OperationRecord, type TaskPointerRecord, type TaskRecord } from "../../core/task-flow/records.js";
import type { LocalModelChoice } from "../model-choice.js";
import type { CapabilityGrantOptions, LocalModelProxy, ModelGrantSource, ProxyRoute } from "../model-proxy/index.js";
import { PLAN_RETENTION, artifactKey } from "./callbacks.js";
import { codeHostForRecord } from "../../plugins/routing.js";
import type { ContextSourcesRuntime } from "../../context-sources/runtime.js";
import { contextToolsDependencies } from "./context-tools.js";
import { localPacketSources } from "./design-review-sources.js";
import { readVerifiedText } from "./documents.js";

/**
 * What a run of a model with no price here is COUNTED at, once the owner accepted "price unknown": 15 dollars per million input tokens and 75 per million output tokens (a top-tier model's list price). It is an assumption, not
 * a bound for every model: a model dearer than this can cost more than the limit the owner saw, and the hold says so. The owner may state another figure with `ROVARA_UNPRICED_REFERENCE_PRICE=<input>,<output>` (dollars per
 * million tokens); a dearer figure holds the limit tighter but leaves a default limit with too little room for even one reviewer call (a call is reserved at the worst case it could cost).
 */
export const UNPRICED_REFERENCE_PRICE = { inputMicrosPerMillionTokens: 15_000_000, outputMicrosPerMillionTokens: 75_000_000 } as const;

/**
 * Whether the owner accepted "price unknown" for THIS round: a spend approval made after the previous round ended and before this round's operation was made. An approval made for an earlier round is not one for a later
 * round (a later round that cannot be priced holds again and needs its own).
 */
export function spendAcceptedFor(review: Pick<WorkflowDesignReview, "rounds" | "approvals">, round: number, operationStartedAt: string): boolean {
  const previousEnded = Math.max(0, ...(review.rounds.find((entry) => entry.round === round - 1)?.reviewers.map((reviewer) => Date.parse(reviewer.endedAt)) ?? [0]));
  return (review.approvals ?? []).some((approval) => approval.kind === "spend" && Date.parse(approval.at) > previousEnded && Date.parse(approval.at) <= Date.parse(operationStartedAt));
}

/** The figure the install counts an unpriced run at: the setting when it is two positive numbers, else the default. */
export function unpricedReferencePriceOf(environment: NodeJS.ProcessEnv): { inputMicrosPerMillionTokens: number; outputMicrosPerMillionTokens: number } {
  const parts = (environment["ROVARA_UNPRICED_REFERENCE_PRICE"] ?? "").split(",").map((part) => Number(part.trim()));
  if (parts.length !== 2 || !parts.every((value) => Number.isFinite(value) && value > 0 && value <= 100_000)) return UNPRICED_REFERENCE_PRICE;
  const inputMicrosPerMillionTokens = Math.round(parts[0]! * 1_000_000);
  const outputMicrosPerMillionTokens = Math.round(parts[1]! * 1_000_000);
  // A figure that rounds to nothing would count the run at $0 and bound nothing: it is ignored like any other figure that is not a price.
  if (inputMicrosPerMillionTokens < 1 || outputMicrosPerMillionTokens < 1) return UNPRICED_REFERENCE_PRICE;
  return { inputMicrosPerMillionTokens, outputMicrosPerMillionTokens };
}

/** The sentence on the cost hold that says how an unpriced run is counted, and that the real bill can differ. */
export function unpricedNoteOf(price: { inputMicrosPerMillionTokens: number; outputMicrosPerMillionTokens: number }): string {
  const dollars = (micros: number): string => `$${String(micros / 1_000_000)}`;
  return `If you run it anyway, Rovara counts it at ${dollars(price.inputMicrosPerMillionTokens)} and ${dollars(price.outputMicrosPerMillionTokens)} per million tokens (input and output). A dearer model can cost more than the limit.`;
}

export interface LocalDesignReviewOptions {
  flow: TaskFlowDeps;
  blobs: ObjectStorage;
  registry: RegistryView;
  companyId: OrgId;
  environment: NodeJS.ProcessEnv;
  /** The model a step calls: the owner's choice (one model on a laptop), and its route for the proxy and for the worker. */
  chosen(): Promise<LocalModelChoice | undefined>;
  routeOf(choice: LocalModelChoice): { route: ProxyRoute; workerRoute: { alias: string; api: string; catalog?: string | undefined } };
  /** The providers' price tables (per million tokens), by provider id. */
  provider(id: string): Pick<ModelProviderAdapter, "prices"> | undefined;
  /** The model proxy, made after the app (the runtime hands it over late). */
  slotKeys(): LocalModelProxy["slotKeys"] | undefined;
  /** Where a reminder is written for the owner (a line on the task's session). */
  timeline?: SessionTimeline | undefined;
  /** The project's context sources, for the MCP items a design cites. Absent: none are read. */
  contextSources?: ContextSourcesRuntime | undefined;
}

export interface LocalDesignReview {
  runtime: DesignReviewRuntime;
  /** The cost hold's choices, a subject of the approval gate. */
  choiceSubject: DecisionSubject;
  /** The sentence the cost hold shows when no price is known: how an accepted run is counted, and that the real bill can differ. */
  unpricedNote(): string;
  /** Whether the project's setting allows skipping the review (held to the company's lock). A setting that cannot be read allows nothing. */
  allowSkip(project: string): Promise<boolean>;
  /** The page actions of the review: a cost choice through the approval gate, picking a paused review up, and answering its questions. */
  pageActions(input: { gate: DecisionGate; owner: Principal }): Pick<Required<LocalPageActions>, "designChoice" | "designResume"> & { answerQuestions(input: { taskId: string; revision: number; answers: Array<{ questionId: string; optionId?: string; text?: string }> }): Promise<LocalActionResult> };
  /** One pass of the wait sweep: reminders, parking and closing of a review that waits on a person. */
  sweepWaits(): Promise<void>;
  /** The grant source's slot functions, to be given to `capabilityModelGrants`. */
  slotGrants: Pick<Required<CapabilityGrantOptions>, "describeSlot" | "slotMinted">;
  /** Whether an operation is a design review's: its own key is never handed out, only its slots'. */
  isDesignReviewOperation(operation: { workspaceId: string; operationId: string }): Promise<boolean>;
}

export function createLocalDesignReview(options: LocalDesignReviewOptions): LocalDesignReview {
  const { flow, blobs, companyId } = options;
  const store = flow.store;
  const operationOf = async (operation: { workspaceId: string; operationId: string }) => fromDocument<OperationRecord>(await store.get(operationKey(operation.workspaceId, operation.operationId)));

  const runtime: DesignReviewRuntime = {
    reader: { get: (key) => store.get(key), allowedWhenAbsent: true },
    env: options.environment,
    // The owner's page offers the cost hold's choices (run it anyway, raise the limit, a lighter tier, skip), so a hold waits for the owner instead of ending the review.
    holdAnswerable: true,
    ports: {
      table: store,
      now: () => (flow.now?.() ?? new Date()).getTime(),
      proxy: () => designReviewProxyCheck(options.slotKeys() === undefined ? undefined : { slotKeys: true }),
      price: (model) => {
        const price = options.provider(model.provider)?.prices?.models[model.modelId];
        return price === undefined ? undefined : {
          inputUsdPerMTok: price.inputMicrosPerMillionTokens / 1_000_000, outputUsdPerMTok: price.outputMicrosPerMillionTokens / 1_000_000,
          ...(price.cacheReadMicrosPerMillionTokens === undefined ? {} : { cacheReadUsdPerMTok: price.cacheReadMicrosPerMillionTokens / 1_000_000 }),
          ...(price.cacheWriteMicrosPerMillionTokens === undefined ? {} : { cacheWriteUsdPerMTok: price.cacheWriteMicrosPerMillionTokens / 1_000_000 }),
        };
      },
      // No company lock is written on a laptop (the owner is the company); a lock a hosted install wrote is read by the setting, not here.
      capCeilingUsd: async () => undefined,
      // Code has no run limit before a price table exists (docs/local.md): the review's own cap is the limit.
      taskRoomUsd: async () => Number.MAX_SAFE_INTEGER,
      // The broker's own readers: the repository's code host at the pinned commits, and the context sources through the plan check's stage.
      sourceReaders: (task, operationId) => localPacketSources({
        companyId, projectAt: (project, revision) => flow.projects.revision(project, revision),
        codeHostOf: (repository) => codeHostForRecord(options.registry, repository.host === undefined ? {} : { host: { kind: repository.host.kind } }),
        contextTools: options.contextSources === undefined ? undefined : contextToolsDependencies(flow, options.contextSources, () => (flow.now?.() ?? new Date()).getTime()),
      }, task, operationId),
    },
    async model() {
      const choice = await options.chosen();
      if (choice === undefined) return undefined;
      const { workerRoute } = options.routeOf(choice);
      return { selection: { provider: choice.provider, modelId: choice.model }, route: workerRoute as never, sourceId: choice.provider };
    },
    keys: {
      closeKeys: async (_orgId, keyIds) => { options.slotKeys()?.closeKeys(keyIds); },
      keySpend: async (keyIds) => options.slotKeys()?.spendUsd(keyIds),
    },
    async readArtifactText(operation, name, maxBytes) {
      const found = await store.get(artifactKey(operation.workspaceId, operation.id, name));
      if (found === undefined || typeof found["objectKey"] !== "string" || typeof found["sha256"] !== "string") return undefined;
      const read = await readVerifiedText(blobs, { objectKey: found["objectKey"], sha256: found["sha256"] }, maxBytes);
      return "text" in read ? read.text : undefined;
    },
    async putDocument(objectKey, body) {
      const bytes = new TextEncoder().encode(body);
      await blobs.put(objectKey, bytes, { contentType: "text/markdown; charset=utf-8", metadata: { sha256: createHash("sha256").update(bytes).digest("hex") }, retention: PLAN_RETENTION });
    },
  };
  flow.designReview = {
    ...createDesignReviewSteps(runtime),
    retryBlocked: (deps, task, expectedRevision) => retryBlockedReview(deps, task, expectedRevision),
    designFirst: (text) => designFirstOf(runtime, companyId, text),
  };
  /** The actor id the review's own record names for the owner's act: the task's owner, as the workflow knows them (the install's owner is the one person who can act on a laptop). */
  const ownerActorOf = async (taskId: string): Promise<string> => (await readTask(flow, taskId))?.workflow?.ownerId ?? "";
  /** Blocks the keys of the task's rounds up to `throughRound` and removes what they left stored (a park or a close). Idempotent; never throws. */
  const releaseKeys = async (task: TaskRecord, throughRound: number): Promise<void> => {
    try {
      const ports = roundRecordPortsOf(flow, runtime);
      for (const operation of await workspaceOperations(flow, task.workspaceId)) {
        const binding = DesignReviewBindingSchema.safeParse(operation.designReview);
        if (binding.success && operation.workflowMode === "PLAN_CRITIQUE" && binding.data.round <= throughRound) await releaseDesignReviewRound(ports, operation);
      }
    } catch (error) {
      flow.log?.({ component: "design-review", event: "design_review.wait_keys_not_released", taskId: task.taskId, error: error instanceof Error ? error.name : "unknown" });
    }
  };

  /** The slot of an operation's stored binding, with the task's review still active; undefined for anything else. */
  async function slotOf(operation: { workspaceId: string; operationId: string }, slotName: string) {
    const stored = await operationOf(operation);
    const binding = DesignReviewBindingSchema.safeParse(stored?.designReview);
    if (stored === undefined || !binding.success || stored.kind !== "task" || stored.workflowMode !== "PLAN_CRITIQUE") return undefined;
    const slot = bindingSlotOf(binding.data, slotName);
    if (slot === undefined) return undefined;
    const pointer = fromDocument<TaskPointerRecord>(await store.get(taskPointerKey(operation.workspaceId)));
    const task = pointer === undefined ? undefined : await readTask(flow, pointer.taskId);
    const review = task?.workflow?.designReview;
    if (task === undefined || review === undefined || !designReviewActive(review)) return undefined;
    return { slot, binding: binding.data, task, startedAt: stored.createdAt };
  }

  return {
    runtime,
    choiceSubject: createDesignChoiceSubject({ flow, reader: runtime.reader }),
    unpricedNote: () => unpricedNoteOf(unpricedReferencePriceOf(options.environment)),
    async allowSkip(project) { return (await readEffectiveDesignReview(runtime.reader, companyId, project).catch(() => undefined))?.setting.allowSkip === true; },
    pageActions: ({ gate }) => ({
      async designChoice(input) {
        const result = await gate.decide({
          companyId, kind: DESIGN_CHOICE_KIND, subjectId: input.taskId, requestId: input.approval.requestId, outcome: "approve", seen: { revision: input.approval.revision, artifactDigest: input.approval.artifactDigest },
          credentials: [{ method: input.proof.method, token: input.proof.token, ...(input.proof.claimedAccount === undefined ? {} : { claimedAccount: input.proof.claimedAccount }) }], details: { choice: input.choice },
        });
        const answered = localResultOf(result, "Done.");
        // The round (or the planning step after a skip) is due: it is run now, and the recovery sweep runs it otherwise.
        if (answered.ok) await runDueDispatches(flow).catch(() => undefined);
        return answered;
      },
      async designResume(input) {
        try {
          await resumeParkedReview(flow, { taskId: input.taskId, expectedRevision: input.revision, actorId: await ownerActorOf(input.taskId) });
        } catch (error) {
          const message = error instanceof Error ? error.message.replace(/^[A-Z_]+: /u, "") : "That could not be done.";
          return { ok: false, reason: /changed|Read the latest/iu.test(message) ? "stale" : "refused", message };
        }
        return { ok: true, message: "Picked up again." };
      },
      async answerQuestions(input) {
        try {
          await answerReviewQuestions(flow, { taskId: input.taskId, expectedRevision: input.revision, answers: input.answers, actorId: await ownerActorOf(input.taskId) });
        } catch (error) {
          const message = error instanceof Error ? error.message.replace(/^[A-Z_]+: /u, "") : "That was not accepted.";
          return { ok: false, reason: /changed|Read the latest/iu.test(message) ? "stale" : "refused", message };
        }
        return { ok: true, message: "Your answers were sent." };
      },
    }),
    async sweepWaits() { await sweepDesignWaits({ flow, reader: runtime.reader, env: options.environment, ...(options.timeline === undefined ? {} : { timeline: options.timeline }), releaseKeys }); },
    slotGrants: {
      async describeSlot(operation, slotName) {
        const found = await slotOf(operation, slotName);
        if (found === undefined) return undefined;
        const scope = { orgId: companyId, operationId: operation.operationId, slot: found.slot.keySlot };
        // One-shot: a slot's token is minted once. A second ask is recorded, the first token is blocked, and the slot fails closed.
        if (await slotKeyRowExists(store, scope)) {
          const keyId = await recordSlotReask(store, scope, Date.now());
          if (keyId !== undefined) options.slotKeys()?.closeKeys([keyId]);
          throw agentXError("FORBIDDEN", "a design review asks for a model key by one of its own slots");
        }
        const ceiling = await readSlotCeiling(store, scope);
        if (ceiling === undefined || !(ceiling > 0)) return undefined;
        // The slot may call only the model the binding names, and only if it is still the owner's choice (a model the owner changed since is not served).
        const choice = await options.chosen();
        if (choice === undefined || choice.provider !== found.slot.model.provider || choice.model !== found.slot.model.modelId) return undefined;
        // A model with no price here cannot have its spend held to a budget. It runs only after the owner accepted "price unknown" at the cost hold (the review records that approval), and then the slot is bounded by an ASSUMED price
        // (`unpricedReferencePriceOf`): a stated assumption that holds the slot's ceiling only for a model that costs no more than it. Without that acceptance an unpriced slot gets no key.
        const priced = options.provider(choice.provider)?.prices?.models[choice.model] !== undefined;
        const review = found.task.workflow?.designReview;
        const accepted = review !== undefined && spendAcceptedFor(review, found.binding.round, found.startedAt);
        if (!priced && !accepted) return undefined;
        return {
          routes: [options.routeOf(choice).route], budget: { micros: Math.round(ceiling * 1_000_000), currency: "USD" }, taskId: found.task.taskId, projectName: found.task.project,
          ...(priced ? {} : { assumedPrice: unpricedReferencePriceOf(options.environment) }),
        };
      },
      async slotMinted(operation, slotName, minted) {
        const found = await slotOf(operation, slotName);
        if (found === undefined) throw agentXError("FORBIDDEN", "a design review asks for a model key by one of its own slots");
        const scope = { orgId: companyId, operationId: operation.operationId, slot: found.slot.keySlot };
        const ceiling = await readSlotCeiling(store, scope);
        const choice = await options.chosen();
        const stored = await putSlotKey(store, {
          ...scope, purpose: found.slot.purpose, round: found.binding.round, keyId: minted.keyId, expiresAt: minted.expiresAt, budgetUsd: ceiling ?? 0,
          alias: choice === undefined ? "none" : options.routeOf(choice).route.alias, nowMs: Date.now(),
        });
        // Another ask recorded a key for this slot first: this token is blocked and never returned.
        if (!stored) throw agentXError("FORBIDDEN", "a design review asks for a model key by one of its own slots");
      },
    },
    async isDesignReviewOperation(operation) { return (await operationOf(operation))?.designReview !== undefined; },
  };
}

export type { ModelGrantSource };
