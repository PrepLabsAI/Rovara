import type { TaskRecord } from "../../packages/broker/src/core/task-flow/records.js";
import { composeHostedPrFeedbackRoutes, hostedPrFeedbackRoutes } from "../../packages/broker/src/core-host/pr-feedback-routes.js";
import type { Admission } from "@agentx/contracts";
import type { BrokerResponse } from "../../packages/broker/src/handler.js";
import type { CoreRuntime } from "../../packages/broker/src/core-host/core-runtime.js";
import { vi, type MockInstance } from "vitest";
import { CORE_ENGINE_ON } from "../../packages/broker/src/core-host/flags.js";
import type { CoreHostApp } from "../../packages/broker/src/core-host/app.js";
import { createCoreDevRoutes, type CoreDevWiring, type CoreDevRoutes, type CompanyMembership, type DeployedCaller } from "../../packages/broker/src/core-host/dev-routes.js";
import { reviewedFeedbackWorld, type ReviewedFeedbackWorld } from "./pr-feedback-world.js";

interface HostedFeedbackWorld extends ReviewedFeedbackWorld {
  runtime: CoreRuntime;
  app: CoreHostApp;
  wiring: CoreDevWiring;
  routes: CoreDevRoutes;
  caller: DeployedCaller;
  membership: CompanyMembership;
  send(method: string, route?: string, body?: unknown, who?: DeployedCaller): Promise<BrokerResponse | undefined>;
  admit: MockInstance<Admission["admit"]>;
  held: Set<string>;
}
export async function hostedFeedbackWorld(status: "COMPLETE" | "BLOCKED" = "COMPLETE", missing?: "ownerActing" | "taskCapUsd" | "taskSpendUsd" | "feedbackArtifacts" | "codeHosts"): Promise<HostedFeedbackWorld> {
  const w = await reviewedFeedbackWorld(status);
  w.h.deps.access.ownerActing = async () => ({ actorId: w.task.ownerKey });
  w.h.deps.taskCapUsd = async () => 10;
  w.h.deps.taskSpendUsd = async () => 0;
  const runtime = { companyId: w.h.deps.companyId, flow: w.h.flow, services: {} };
  const app: CoreHostApp = { flags: CORE_ENGINE_ON, engineForNewTask: () => "core", engineOfTask: async () => "core", runtimeFor: async () => runtime, registry: async () => w.registry, handleScheduledJob: async () => undefined, relayOutbox: async () => [] };
  const caller: DeployedCaller = { principal: w.h.owner.principal, client: "cli" };
  const membership = { companyId: runtime.companyId, role: "member" as const };
  if (missing === "ownerActing") delete w.h.deps.access.ownerActing;
  else if (missing !== undefined) delete w.h.deps[missing];
  composeHostedPrFeedbackRoutes(w.h.deps);
  const wiring: CoreDevWiring = { origin: () => "https://api.example", prFeedback: hostedPrFeedbackRoutes(w.h.deps), taskActions: { roundCap: async () => ({ limitUsd: 10, spentUsd: 0 }) } };
  const routes = createCoreDevRoutes({ app, companyOf: async () => membership, wiring: () => wiring });
  const send = (method: string, route = "", body?: unknown, who = caller) => routes.route({ method, path: `/v1/dev/tasks/${w.task.taskId}${route}`, headers: {}, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, who);
  const held = new Set<string>();
  const admit = vi.spyOn(w.h.deps.admission, "admit").mockImplementation(async () => { held.add("round"); return { allowed: true, reservationId: "round" }; });
  vi.spyOn(w.h.deps.admission, "release").mockImplementation(async id => { held.delete(id); });
  return { ...w, runtime, app, wiring, routes, caller, membership, send, admit, held };
}

/** The existing public views exercised by these route tests. */
export interface FeedbackRouteBody {
  task: Omit<TaskRecord, "workflow"> & { workflow: NonNullable<TaskRecord["workflow"]>; money?: unknown };
  review: {
    revision: number; reviewDigest: string; reportOrder: string[]; recommendedFindingIds: string[];
    findings: Array<{ id: string; comments: Array<{ body: string }>; checkChanges: { added: unknown[] } }>;
  };
  started?: boolean;
  error: { code: string };
}
