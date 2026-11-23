// Engine host (lane E2): adapter modules over fakes, for the deployed composition root's tests. Each module fills one point the way a deployed adapter will; nothing here touches a cloud provider.
// Ported from the monolith's host-root fake world, over Code's own ports and fakes only.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IMPLICIT_COMPANY_ID, WORKER_INVOCATION_FEATURES, type Admission, type AuditEvent, type AuditSink, type DocumentStore, type ObjectStorage, type QueueService, type SecretStore, type TransactItem } from "@agentx/contracts";
import { FolderObjectStorage } from "../../packages/local-adapters/src/folder-object-storage.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { MemoryQueueService } from "../../packages/broker/src/ports/memory-queue.js";
import { FakeWorkerMachines, type FakeWorkerMachinesOptions } from "../../packages/broker/src/ports/fake-worker-machines.js";
import { createMemoryModelKeyStore } from "../../packages/broker/src/ports/model-key-stores.js";
import { createAllowAllAdmission, createLocalOwnerApprovers, createLocalOwnerIdentity, createPriceTableMetering } from "../../packages/broker/src/ports/policy-defaults.js";
import { FakeHostModel } from "../../packages/broker/src/plugins/fake/model.js";
import { FakeCodeHost } from "../../packages/broker/src/plugins/fake/code-host.js";
import { FakeCheckRunner } from "../../packages/broker/src/plugins/fake/check-runner.js";
import { TASK_FLOW_INDEXES } from "../../packages/broker/src/core/task-flow/flow.js";
import { coreAdapter, type CoreAdapterContext, type CoreAdapterModule } from "../../packages/broker/src/core-host/registry.js";

export const FAKE_COMPANY = "org_corehost00000000000a" as const;

export interface FakeWorld {
  clock: { now: number; advance(seconds: number): void };
  store: DocumentStore;
  queues: QueueService;
  machines: FakeWorkerMachines;
  host: FakeCodeHost;
  audit: AuditEvent[];
  /** Admission outcomes, in order (`admitted:task.start`, `refused:task.start:<code>`). */
  spend: string[];
  /** Which point's module `create` ran, in order (an off app must leave this empty). */
  created: string[];
  modules: CoreAdapterModule[];
  context(): CoreAdapterContext;
}

/** Records each decision of an admission; the decisions themselves are the inner adapter's. */
function recordingAdmission(inner: Admission, spend: string[]): Admission {
  const note = (action: string, decision: { allowed: boolean; code?: string }) => { spend.push(decision.allowed ? `admitted:${action}` : `refused:${action}:${String(decision.code)}`); };
  return {
    enforcesCost: inner.enforcesCost,
    async admit(request) { const decision = await inner.admit(request); note(request.action, decision); return decision; },
    async stage(request) { const staged = await inner.stage(request); note(request.action, staged.decision); return staged; },
    settle: (id, actual) => inner.settle(id, actual),
    release: (id) => inner.release(id),
  } as Admission;
}

/** An audit sink that stages a simple outbox row in the caller's transaction and records the event. */
function recordingAudit(events: AuditEvent[]): AuditSink {
  return {
    stage(event): TransactItem[] {
      events.push(event);
      return [{ kind: "put", item: { pk: `ORG#${event.companyId}#AUDIT_OUTBOX`, sk: `EVENT#${event.eventId}`, entityType: "AUDIT_OUTBOX", action: event.action, at: event.at }, condition: { op: "notExists", path: ["pk"] } }];
    },
    async record(event) { events.push(event); },
  };
}

/** S3's stand-in: Code's folder object storage in a temp folder. */
function folderObjects(): ObjectStorage {
  return new FolderObjectStorage({ root: join(mkdtempSync(join(tmpdir(), "core-host-objects-")), "store"), maxObjectBytes: 10_000_000 });
}

export interface FakeWorldOptions {
  /** Share the hosted broker's real port adapters over its fake external table/bucket. */
  store?: DocumentStore;
  objects?: ObjectStorage;
  machines?: FakeWorkerMachinesOptions;
  admission?: Admission;
  /** Leave these points out (to test the registry's refusal). */
  without?: readonly string[];
  /** Mark these points' modules as Code's laptop default (`isDefault`), to test the never-default rule. */
  asDefault?: readonly string[];
}

export function createFakeWorld(options: FakeWorldOptions = {}): FakeWorld {
  const clock = { now: Date.parse("2026-11-15T10:00:00.000Z"), advance(seconds: number) { clock.now += seconds * 1_000; } };
  const now = () => new Date(clock.now);
  const store = options.store ?? new MemoryDocumentStore({ indexes: TASK_FLOW_INDEXES, ttlAttribute: "indexExpiresAt", nowSeconds: () => Math.floor(clock.now / 1_000) });
  const queues = new MemoryQueueService({ now: () => clock.now });
  const machines = new FakeWorkerMachines({ startingChecks: 0, features: [...WORKER_INVOCATION_FEATURES], now, ...options.machines });
  const hostModel = new FakeHostModel({ url: "https://github.com/example/demo.git", id: "1", fullName: "example/demo" });
  // A repository record that names no host is the code host registered as `github`.
  const host = Object.defineProperties(new FakeCodeHost(hostModel), { kind: { value: "github" } });
  // The fake host's clock is its own; a credential a worker is sent must expire in the real future.
  const issue = host.issueGitCredential.bind(host);
  host.issueGitCredential = async (repository, access, scope) => ({ ...(await issue(repository, access, scope)), expiresAt: new Date(Date.now() + 50 * 60_000).toISOString() });
  const audit: AuditEvent[] = [];
  const spend: string[] = [];
  const created: string[] = [];
  const secrets: SecretStore = { async read() { return undefined; } };
  // These stand-ins are NOT marked `isDefault`: they stand for the deployed adapters a real install registers (the never-default rule is tested with `asDefault`).
  const all: CoreAdapterModule[] = [
    coreAdapter({ point: "storage", name: "dynamodb", owner: "fake", create: () => store }),
    coreAdapter({ point: "queue", name: "sqs", owner: "fake", create: () => queues }),
    coreAdapter({ point: "worker-machines", name: "ec2", owner: "fake", create: () => machines }),
    coreAdapter({ point: "admission", name: "deployed", owner: "fake", create: () => options.admission ?? recordingAdmission(createAllowAllAdmission(), spend) }),
    coreAdapter({ point: "metering", name: "deployed", owner: "fake", create: () => createPriceTableMetering({ currency: "USD", models: {} }) }),
    coreAdapter({ point: "audit-sink", name: "deployed", owner: "fake", create: () => recordingAudit(audit) }),
    coreAdapter({ point: "approvers", name: "deployed", owner: "fake", create: () => createLocalOwnerApprovers({ now }) }),
    coreAdapter({ point: "identity", name: "deployed", owner: "fake", create: () => createLocalOwnerIdentity({ companyId: IMPLICIT_COMPANY_ID }) }),
    coreAdapter({ point: "object-storage", name: "s3", owner: "fake", create: () => options.objects ?? folderObjects() }),
    coreAdapter({ point: "code-host", name: host.kind, owner: "fake", create: () => host }),
    coreAdapter({ point: "check-runner", name: "fake-checks", owner: "fake", create: () => ({ kind: "fake-checks", create: () => new FakeCheckRunner(hostModel) }) }),
    coreAdapter({ point: "model-keys", name: "secrets-manager", owner: "fake", create: () => createMemoryModelKeyStore({}) }),
    coreAdapter({ point: "secrets", name: "secrets-manager", owner: "fake", create: () => secrets }),
  ];
  const modules = all
    .filter((module) => !(options.without ?? []).includes(module.point))
    .map((module) => {
      const wrapped: CoreAdapterModule = { ...module, ...((options.asDefault ?? []).includes(module.point) ? { isDefault: true } : {}), create: (context, registry) => { created.push(module.point); return module.create(context, registry); } };
      return wrapped;
    });
  return {
    clock, store, queues, machines, host, audit, spend, created, modules,
    context: () => ({ installCompanyId: FAKE_COMPANY, now, env: {}, clients: {}, log: () => undefined }),
  };
}
