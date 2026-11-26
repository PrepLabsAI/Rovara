import { createCompanyArtifactReader } from "./company-artifact-reader.js";
import { createHash } from "node:crypto";
import { agentModelIdentity, type ObjectStorage } from "@agentx/contracts";
import { createDesignReviewSteps } from "../core/design-review/steps.js";
import { designFirstOf, retryBlockedReview } from "../core/design-review/actions.js";
import type { DesignReviewRuntime } from "../core/design-review/round-ports.js";
import { workspaceKeys } from "../core/task-flow/workspace-location.js";
import { codeHostForRecord } from "../plugins/routing.js";
import { localPacketSources } from "./app/design-review-sources.js";
import type { HostedReviewerOptions } from "./hosted-reviewers.js";
import { createHostedReviewers } from "./hosted-reviewers.js";

/** Hosted counterpart of the local design runtime. Every document read goes through the company's artifact reader. */
export function createHostedDesignReview(options: HostedReviewerOptions & { env: NodeJS.ProcessEnv; blobs: ObjectStorage }) {
  const { flow, companyId, registry } = options;
  const reviewers = createHostedReviewers(options);
  const artifacts = createCompanyArtifactReader({ blobs: options.blobs, store: flow.store, companyId });
  const runtime: DesignReviewRuntime = {
    reader: { get: (key) => flow.store.get(key), allowedWhenAbsent: true }, env: options.env,
    ports: {
      table: flow.store, now: () => (flow.now?.() ?? new Date()).getTime(),
      proxy: () => options.offered === undefined ? { ok: false, notRunReason: "no_verified_model" } : { ok: true },
      price: (model) => {
        const price = reviewers.price(model);
        return price === undefined ? undefined : { inputUsdPerMTok: price.input, outputUsdPerMTok: price.output, cacheReadUsdPerMTok: price.cacheRead, cacheWriteUsdPerMTok: price.cacheWrite };
      },
      capCeilingUsd: async (orgId) => orgId !== companyId ? 0 : (await reviewers.authority())?.companyLimitUsd ?? 0,
      taskRoomUsd: async (task) => {
        if (task.companyId !== companyId) return 0;
        const access = await reviewers.authority();
        return access === undefined ? 0 : Math.min(access.companyLimitUsd, await options.taskRoomUsd(task));
      },
      sourceReaders: (task, operationId) => localPacketSources({ companyId, projectAt: (project, revision) => flow.projects.revision(project, revision), codeHostOf: (repository) => codeHostForRecord(registry, repository.host === undefined ? {} : { host: { kind: repository.host.kind } }) }, task, operationId),
    },
    async model() {
      const access = await reviewers.authority();
      const route = await flow.modelAccess?.route();
      if (route === undefined || access === undefined || !access.models.some((entry) => entry.model === route.alias)) return undefined;
      return { selection: agentModelIdentity(route.alias), route, sourceId: "company-gateway" };
    },
    // Reviewer JWTs expire after REVIEWER_GRANT_SECONDS (120 seconds). No unmeasured spend is reported as zero:
    // round-record charges the complete allocated ceiling when keySpend is unavailable.
    keys: { closeKeys: async () => undefined, keySpend: async () => undefined },
    async readArtifactText(operation, name, maxBytes) {
      try {
        const keys = await workspaceKeys(flow, operation.workspaceId);
        const row = await flow.store.get(keys.row(`ARTIFACT#${operation.id}#${name}`));
        if (typeof row?.["objectKey"] !== "string" || typeof row["sha256"] !== "string") return undefined;
        const bytes = await artifacts.get(row["objectKey"], maxBytes);
        if (bytes === undefined || createHash("sha256").update(bytes).digest("hex") !== row["sha256"]) return undefined;
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch { return undefined; }
    },
    async putDocument(key, body) {
      const bytes = new TextEncoder().encode(body);
      await options.blobs.put(key, bytes, { contentType: "text/markdown; charset=utf-8", metadata: { sha256: createHash("sha256").update(bytes).digest("hex") }, retention: "plan" });
    },
  };
  flow.designReview = { ...createDesignReviewSteps(runtime), retryBlocked: (deps, task, revision) => retryBlockedReview(deps, task, revision), designFirst: (text) => designFirstOf(runtime, companyId, text) };
  return runtime;
}
