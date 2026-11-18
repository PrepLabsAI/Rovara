// Lead 4, slice A4: the core runtime turns work events on for the flow (and off with `flowOptions.workEvents: false`), and a company's runtime writes its events only into its own partitions.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { orgProjectCatalogKey, projectRevisionKey, type JsonValue, type OrgId, type ProjectDefinition } from "@agentx/contracts";
import { createOwnerTaskAccess } from "../../packages/broker/src/core/task-flow/access.js";
import { localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { buildCoreRegistry, createCoreRuntime, readCoreEngineFlags } from "../../packages/broker/src/core-host/index.js";
import { listWorkEvents } from "../../packages/broker/src/core/work-events/work-events.js";
import { FAKE_COMPANY, createFakeWorld } from "../support/core-host-fakes.js";

const A = FAKE_COMPANY as OrgId;
const B = "org_corehost00000000000b" as OrgId;
const DEFINITION: ProjectDefinition = {
  name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
  repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }],
};

async function run(workEvents: boolean | undefined) {
  const fake = createFakeWorld();
  const registry = await buildCoreRegistry({ modules: fake.modules, context: fake.context(), areas: ["flow", "build", "merge"] });
  const started = new Map<OrgId, string>();
  for (const companyId of [A, B]) {
    await fake.store.put({ item: { ...projectRevisionKey(companyId, DEFINITION.name, DEFINITION.revision), entityType: "PROJECT", definition: JSON.parse(JSON.stringify(DEFINITION)) as JsonValue } });
    await fake.store.put({ item: { ...orgProjectCatalogKey(companyId, DEFINITION.name), entityType: "PROJECT_CATALOG", latestRevision: DEFINITION.revision } });
    const runtime = createCoreRuntime({
      registry, companyId, flags: readCoreEngineFlags({ ROVARA_CORE_ENGINE: "on" }), callbackSigningKey: Buffer.alloc(32, 7), access: createOwnerTaskAccess(), repositoryGrantKey: Buffer.alloc(32, 5),
      repositoryCredential: async () => ({ token: "unused" }), now: () => new Date(fake.clock.now), log: () => undefined, ...(workEvents === undefined ? {} : { flowOptions: { workEvents } }),
    });
    const { task } = await runtime.flow.start({ principal: localOwnerPrincipal({ companyId }), client: "test", origin: "app" as const }, { requestId: randomUUID(), project: "payments", instructions: "Add a /health endpoint", workflow: true, workflowPath: "QUICK" });
    started.set(companyId, task.taskId);
  }
  const read = (companyId: OrgId) => listWorkEvents(fake.store, { orgId: companyId, from: "2026-01-01T00:00:00.000Z", to: "2099-12-31T00:00:00.000Z" }).then((page) => page.events);
  return { started, read };
}

describe("the core runtime and work events", () => {
  it("writes the start's events for each company into its own partition, by default", async () => {
    const world = await run(undefined);
    for (const [company, other] of [[A, B], [B, A]] as const) {
      const events = await world.read(company);
      expect(events.map((event) => event.kind).sort()).toEqual(["step_started", "task_started", "waiting_changed"]);
      expect(events.every((event) => event.orgId === company && event.taskId === world.started.get(company) && event.project === "payments")).toBe(true);
      expect(events.some((event) => event.taskId === world.started.get(other))).toBe(false);
      expect(events.find((event) => event.kind === "task_started")).toMatchObject({ origin: "web" });
    }
  });

  it("writes none with flowOptions.workEvents false, and the task still starts", async () => {
    const world = await run(false);
    expect([...world.started.values()]).toHaveLength(2);
    expect(await world.read(A)).toEqual([]);
    expect(await world.read(B)).toEqual([]);
  });
});
