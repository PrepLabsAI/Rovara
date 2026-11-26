import { companyChangeFeed, companyLog, companyScoped, type ChangeSubscription, type JsonValue, type DocumentStore, type DueSchedule, type OutboundEventInput, type RegistryView } from "@agentx/contracts";
import { SHARED_RAW_IDS, TWO_COMPANIES, type IsolationSurface, type TwoCompanyIsolation } from "../../../packages/testing/src/isolation/two-company.js";
import { MemoryDocumentStore } from "../../../packages/broker/src/ports/memory-document-store.js";
import { workEventRow, listWorkEvents } from "../../../packages/broker/src/core/work-events/work-events.js";
import { createFakeScheduler } from "../../../packages/broker/src/ports/fake-scheduler.js";
import { createInProcessRealtime } from "../../../packages/broker/src/ports/realtime.js";
import { publishOutboundEvent } from "../../../packages/broker/src/ports/outbound-events.js";
import { dynamoWorld } from "./dynamodb-harness.js";
import { handleNightlyFire, nightlySlotId } from "../../../packages/broker/src/core/test-env/nightly.js";
import { createProjectCompanyResolver } from "../../../packages/broker/src/core/test-env/nightly-wiring.js";
import { body, T0, SCHEDULED, HEAD1 } from "../nightly-world.js";
import { testEnvDigest } from "@agentx/contracts";
import { testEnvLatestKey, testEnvRevisionKey } from "../../../packages/broker/src/core/test-env/environment.js";
const at = "2026-11-10T00:00:00.000Z";

function feedSurface(backend: "memory" | "dynamo"): IsolationSurface {
  const dynamo = backend === "dynamo" ? dynamoWorld() : undefined;
  const memory = new MemoryDocumentStore(); const store = dynamo?.store ?? memory;
  const seen = new Map<string, unknown[]>(); const subs: ChangeSubscription[] = [];
  return {
    name: `change feed ${backend}`, kind: "event",
    async plant(me) {
      seen.set(me.orgId, []);
      subs.push(await companyChangeFeed(store.changes!, me.orgId).subscribe(me.orgId, async (batch) => { seen.get(me.orgId)!.push(...batch); }));
      await store.put({ item: { pk: companyScoped(me.orgId, SHARED_RAW_IDS.documentName), sk: "same", companyId: me.orgId, marker: me.canary } });
    },
    async observe(me) { if (dynamo) await dynamo.settled(); else await memory.settled(); return seen.get(me.orgId); },
    async teardown() { for (const sub of subs) await sub.stop(); },
  };
}

/** Each surface has a fresh world; both owners use that same world's real adapters and the kit's raw ids. */
export function eventsCompanies(): TwoCompanyIsolation {
  const events = new MemoryDocumentStore();
  const scheduler = createFakeScheduler(); const fires: DueSchedule[] = [];
  scheduler.subscribe(async (due) => { fires.push(due); });
  const realtime = createInProcessRealtime(); const notices = new Map<string, unknown[]>();
  const logs = new Map<string, unknown[]>();
  const outbound: OutboundEventInput[] = [];
  const nightlyStore = new MemoryDocumentStore(); const nights = new Map<string, unknown[]>();
  return { surfaces: [
    ...(["memory", "dynamo"] as const).map(feedSurface),
    {
      name: "work events", kind: "list",
      async plant(me) { await events.put({ item: workEventRow({ version: 1, id: `wev_${"a".repeat(32)}`, kind: "task_started", orgId: me.orgId, project: SHARED_RAW_IDS.project, taskId: "12579b4b-eaa7-4bf2-87bc-6da86b97c9e6", at, actor: { kind: "person", personId: me.canary } }) }); },
      async observe(me) { return listWorkEvents(events, { orgId: me.orgId, from: at, to: at, now: Date.parse(at) }); },
    },
    {
      name: "same schedule id get and fire", kind: "delivery",
      async plant(me) { await scheduler.put({ companyId: me.orgId, scheduleId: SHARED_RAW_IDS.scheduleId, when: { kind: "every", minutes: 1 }, enabled: true, target: { kind: "test", ref: { marker: me.canary } } }); },
      async observe(me) { await scheduler.fireForTest(me.orgId, SHARED_RAW_IDS.scheduleId, at); return { entry: await scheduler.get(me.orgId, SHARED_RAW_IDS.scheduleId), due: fires.filter((fire) => fire.companyId === me.orgId) }; },
    },
    {
      name: "realtime", kind: "event",
      async plant(me) { notices.set(me.orgId, []); realtime.listen(me.orgId, (notice) => { notices.get(me.orgId)!.push(notice); }); await realtime.publish({ companyId: me.orgId, entries: [{ audience: { kind: "project", project: SHARED_RAW_IDS.project }, notice: { type: "task.changed", marker: me.canary } }] }); },
      async observe(me) { return notices.get(me.orgId); },
      async teardown() { await realtime.close?.(); },
    },
    {
      name: "company logs", kind: "event",
      async plant(me) { logs.set(me.orgId, []); companyLog(me.orgId, (line) => { logs.get(me.orgId)!.push(line); })({ event: "test", marker: me.canary }); },
      async observe(me) { return logs.get(me.orgId); },
    },
    {
      name: "outbound envelope carries company", kind: "event",
      async plant(me) {
        const registry = { names: () => ["capture"], get: () => ({ deliver: async (event: OutboundEventInput) => { outbound.push(event); } }) } as unknown as RegistryView;
        await publishOutboundEvent(registry, { version: 1, id: `evt_${me.label.repeat(16)}`, type: "task.started", company: me.orgId, createdAt: at, data: { marker: me.canary } });
      },
      async observe(me) { return outbound.filter((event) => event.company === me.orgId); },
    },
    {
      name: "nightly stored project binding", kind: "delivery",
      async plant(me) {
        const environment = body(); const digest = testEnvDigest(environment); const project = SHARED_RAW_IDS.project;
        await nightlyStore.put({ item: { pk: companyScoped(me.orgId, "PROJECTS"), sk: project, companyId: me.orgId } });
        await nightlyStore.put({ item: { ...testEnvRevisionKey(me.orgId, project, 1), entityType: "TEST_ENV_REVISION", orgId: me.orgId, project, revision: 1, approvedAt: at, approvedBy: "person_a", digest, requestId: "same", lessSafe: [], environment: JSON.parse(JSON.stringify(environment)) as JsonValue } });
        await nightlyStore.put({ item: { ...testEnvLatestKey(me.orgId, project), entityType: "TEST_ENV_LATEST", orgId: me.orgId, project, revision: 1, digest } });
        nights.set(me.orgId, []);
      },
      async observe(me) {
        const due: DueSchedule = { companyId: me.orgId, scheduleId: SHARED_RAW_IDS.scheduleId, target: { kind: "nightly", ref: { project: SHARED_RAW_IDS.project } }, scheduledAt: SCHEDULED, slotId: nightlySlotId(me.orgId, SHARED_RAW_IDS.project, SCHEDULED), attempt: 1 };
        const deps = { store: nightlyStore as DocumentStore, now: () => T0, projectCompanyRequired: true, projectCompany: createProjectCompanyResolver(async (project) => nightlyStore.get({ pk: companyScoped(me.orgId, "PROJECTS"), sk: project })), runs: { admit: async () => undefined, headOf: async () => HEAD1, startRun: async (input: { orgId: string }) => { nights.get(input.orgId)!.push({ input, marker: me.canary }); } } };
        const other = TWO_COMPANIES.find((company) => company.orgId !== me.orgId)!;
        await handleNightlyFire(deps, { ...due, companyId: other.orgId });
        await handleNightlyFire(deps, due);
        return nights.get(me.orgId);
      },
    },
  ] };
}
