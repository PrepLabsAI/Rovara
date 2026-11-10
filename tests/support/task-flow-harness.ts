// Lane L6a: the task flow on the W0 fakes. One harness is a flow over an in-memory store and queue, a fake worker machine adapter, and a clock
// the test moves (a queue's retry delay and a dispatch row's backoff are waited out by advancing it, never by sleeping).
import { randomUUID } from "node:crypto";
import {
  IMPLICIT_COMPANY_ID,
  orgProjectCatalogKey,
  projectRevisionKey,
  type Admission,
  type AuditEvent,
  type DocumentStore,
  type JsonValue,
  type QueueService,
  type AuditSink,
  type OrgId,
  type Principal,
  type ProjectDefinition,
  type TransactItem,
} from "@agentx/contracts";
import { RepositoryGrantService } from "../../packages/broker/src/repository-access.js";
import { FakeWorkerMachines, type FakeWorkerMachinesOptions } from "../../packages/broker/src/ports/fake-worker-machines.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { MemoryQueueService } from "../../packages/broker/src/ports/memory-queue.js";
import { createAllowAllAdmission, createNoopAuditSink, localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { createTransactionalOutbox } from "../../packages/broker/src/ports/transactional-outbox.js";
import { createStoreProjectSource } from "../../packages/broker/src/core/task-flow/project-source.js";
import { createOwnerTaskAccess } from "../../packages/broker/src/core/task-flow/access.js";
import type { TaskCaller, TaskFlowDeps } from "../../packages/broker/src/core/task-flow/deps.js";
import { createTaskFlow, TASK_FLOW_INDEXES, type TaskFlow } from "../../packages/broker/src/core/task-flow/flow.js";

export const COMPANY: OrgId = IMPLICIT_COMPANY_ID;
export const SIGNING_KEY = Buffer.alloc(32, 9);

export const definition: ProjectDefinition = {
  name: "payments",
  revision: 1,
  repositories: [{ name: "demo", url: "https://examplehost/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }],
  setup: [],
  readiness: [],
  orchestratorInstructions: "Delegate work.",
};

export interface Harness {
  flow: TaskFlow;
  deps: TaskFlowDeps;
  store: DocumentStore;
  queues: QueueService;
  machines: FakeWorkerMachines;
  clock: { now: number; advance(seconds: number): void };
  owner: TaskCaller;
  guest: TaskCaller;
  audit: AuditEvent[];
  grants: Array<{ operationId: string }>;
  registerProject(project?: ProjectDefinition): Promise<void>;
}

export interface HarnessOptions {
  understandFirst?: boolean;
  limits?: { member: number; organization: number };
  admission?: Admission;
  machines?: FakeWorkerMachinesOptions;
  /** Builds the store and queue the flow runs on (default: the in-memory fakes). The clock is the harness's. */
  backend?: (clock: { now: number }) => { store: DocumentStore; queues: QueueService };
  /** Records audit events as put items too, the way a transactional sink would. */
  audit?: "none" | "recording";
}

export function createHarness(options: HarnessOptions = {}): Harness {
  const clock = { now: Date.parse("2026-11-09T10:00:00.000Z"), advance(seconds: number) { clock.now += seconds * 1_000; } };
  const now = () => new Date(clock.now);
  const { store, queues } = options.backend?.(clock) ?? {
    store: new MemoryDocumentStore({ indexes: TASK_FLOW_INDEXES, nowSeconds: () => Math.floor(clock.now / 1_000) }),
    queues: new MemoryQueueService({ now: () => clock.now }),
  };
  const machines = new FakeWorkerMachines({ startingChecks: 2, features: ["task.workflowMode", "task.structuredPlans"], now, ...options.machines });
  const audit: AuditEvent[] = [];
  const sink: AuditSink = options.audit === "recording" ? {
    stage(event) {
      audit.push(event);
      const step: TransactItem = { kind: "put", item: { pk: `AUDIT#${event.companyId}`, sk: `EVENT#${event.eventId}`, entityType: "AUDIT", action: event.action, at: event.at }, condition: { op: "notExists", path: ["pk"] } };
      return [step];
    },
    async record(event) { audit.push(event); },
  } : createNoopAuditSink();
  const grants: Array<{ operationId: string }> = [];
  const repositoryGrants = new RepositoryGrantService(Buffer.alloc(32, 5), async () => ({ token: "unused" }));
  const deps: TaskFlowDeps = {
    companyId: COMPANY,
    store,
    queues,
    outbox: createTransactionalOutbox({ store, queues, now }),
    machines,
    admission: options.admission ?? createAllowAllAdmission(),
    audit: sink,
    projects: undefined as never,
    access: createOwnerTaskAccess(),
    repositoryGrants: { issue: (input) => { grants.push({ operationId: input.operationId }); return repositoryGrants.issue(input); } },
    callbackSigningKey: SIGNING_KEY,
    now,
    limits: options.limits ?? { member: 5, organization: 20 },
    ...(options.understandFirst === undefined ? {} : { understandFirst: options.understandFirst }),
  };
  // The project source is the store reader a deployment wires.
  deps.projects = createStoreProjectSource(store, COMPANY);
  const owner: TaskCaller = { principal: localOwnerPrincipal({ companyId: COMPANY }), client: "test" };
  const guestPrincipal: Principal = { companyId: COMPANY, personId: "guest", displayName: "Guest", roles: [], provider: "local-owner" };
  return {
    flow: createTaskFlow(deps), deps, store, queues, machines, clock, owner, guest: { principal: guestPrincipal }, audit, grants,
    async registerProject(project = definition) {
      await store.put({ item: { ...projectRevisionKey(COMPANY, project.name, project.revision), entityType: "PROJECT", definition: JSON.parse(JSON.stringify(project)) as JsonValue } });
      await store.put({ item: { ...orgProjectCatalogKey(COMPANY, project.name), entityType: "PROJECT_CATALOG", latestRevision: project.revision } });
    },
  };
}

export const newRequestId = (): string => randomUUID();
