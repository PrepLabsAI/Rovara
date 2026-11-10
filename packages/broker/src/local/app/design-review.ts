// The design review on `rovara up`. It builds the review's runtime (core/design-review/round-ports.ts) from what the laptop has: the registry's model choice and providers (one model, fixed by the owner), the model
// proxy's slot keys (one token per reviewer, with its own ceiling and spend record), the object storage for the files workers save, and the document store. It also gives the proxy's grant source the two functions a design review needs
// (`describeSlot`, `slotMinted`), which look a slot up in the binding the broker stored and never in anything the worker sends.
//
// Not here yet (listed in docs/local.md): repository files at the pinned commit are not read for the packets (no `CodeHost.fileAtRevision` caller on a laptop), so a reviewer reads the design, the requirements and the checkout itself; meta repository
// files and MCP items are not read (no context sources); the planner's own resolve run spend is counted by the cost ledger, not added to the review's total.
import { createHash } from "node:crypto";
import { DesignReviewBindingSchema, agentXError, designReviewActive, type AdapterRegistry, type ModelProviderAdapter, type ObjectStorage, type OrgId } from "@agentx/contracts";
import { createDesignReviewSteps } from "../../core/design-review/steps.js";
import { designReviewProxyCheck } from "../../core/design-review/proxy-check.js";
import { bindingSlotOf, putSlotKey, readSlotCeiling, recordSlotReask, slotKeyRowExists } from "../../core/design-review/slot-keys.js";
import type { DesignReviewRuntime } from "../../core/design-review/round-ports.js";
import type { TaskFlowDeps } from "../../core/task-flow/deps.js";
import { operationKey, taskPointerKey } from "../../core/task-flow/keys.js";
import { readTask } from "../../core/task-flow/reads.js";
import { fromDocument, type OperationRecord, type TaskPointerRecord } from "../../core/task-flow/records.js";
import type { LocalModelChoice } from "../model-choice.js";
import type { CapabilityGrantOptions, LocalModelProxy, ModelGrantSource, ProxyRoute } from "../model-proxy/index.js";
import { PLAN_RETENTION, artifactKey } from "./callbacks.js";
import { readVerifiedText } from "./documents.js";

export interface LocalDesignReviewOptions {
  flow: TaskFlowDeps;
  blobs: ObjectStorage;
  registry: Pick<AdapterRegistry, "get" | "names">;
  companyId: OrgId;
  environment: NodeJS.ProcessEnv;
  /** The model a step calls: the owner's choice (one model on a laptop), and its route for the proxy and for the worker. */
  chosen(): Promise<LocalModelChoice | undefined>;
  routeOf(choice: LocalModelChoice): { route: ProxyRoute; workerRoute: { alias: string; api: string; catalog?: string | undefined } };
  /** The providers' price tables (per million tokens), by provider id. */
  provider(id: string): Pick<ModelProviderAdapter, "prices"> | undefined;
  /** The model proxy, made after the app (the runtime hands it over late). */
  slotKeys(): LocalModelProxy["slotKeys"] | undefined;
}

export interface LocalDesignReview {
  runtime: DesignReviewRuntime;
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
      sourceReaders: async () => ({
        readers: { readRepoFile: async () => undefined, readMetaFile: async () => undefined, fetchMcpItem: async () => ({ ok: false }) },
        repositoryNames: [], origin: [],
      }),
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
  flow.designReview = createDesignReviewSteps(runtime);

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
    return { slot, binding: binding.data, task };
  }

  return {
    runtime,
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
        return { routes: [options.routeOf(choice).route], budget: { micros: Math.round(ceiling * 1_000_000), currency: "USD" }, taskId: found.task.taskId, projectName: found.task.project };
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
