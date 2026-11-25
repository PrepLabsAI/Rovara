// REGISTRY-TOLERANT-READ (arch rules 8 and 9). A stored project that holds a generic npm/pypi/maven registry entry (written before the company package token, c1f5aab4c) reads everywhere a stored record is read: task start, the
// setup readers, the application readiness reader, the dispatcher's prepare. A NEW generic entry is still refused (the input schema). The rules that judge what a person typed are not applied when a record is READ, so each
// that does safety work where the record is USED is asked again at use and refuses there with a stable id. And no reader quietly serves an older revision when the current one cannot be read.
import { describe, expect, it, vi } from "vitest";
import {
  GENERIC_REGISTRY_REFUSED, IMPLICIT_COMPANY_ID, agentXError, PROJECT_REVISION_UNREADABLE, PROJECT_USE_MESSAGES, ProjectRevisionUnreadableError, PROJECT_USE_RULES, ProjectDefinitionSchema, StoredProjectDefinitionSchema, UNRUNNABLE_EXTERNAL_CHECK_MESSAGE, orgProjectCatalogKey, projectMetaKey, projectRevisionKey,
  projectUseProblems, projectUseRefusal, readStoredProject, type JsonValue,
} from "@agentx/contracts";
import { COMPANY_A } from "../../packages/testing/src/isolation/two-company.js";
import { namedCompanyLatestRevisionRow } from "../../packages/broker/src/aws/company-layout.js";
import { createApplicationSelectionReader } from "../../packages/broker/src/core/e2e/application-readiness.js";
import { readSetupApply, setupApplyKey, storeSetupCandidate, type SetupApplyDeps } from "../../packages/broker/src/core/setup-agent/apply.js";
import { operationKey, workspaceKey, workspacePartition } from "../../packages/broker/src/core/task-flow/keys.js";
import type { WorkspaceRecord } from "../../packages/broker/src/core/task-flow/records.js";
import { startManualPublication } from "../../packages/broker/src/core/task-flow/manual-publication.js";
import { registeredRepositoryRecordsOf } from "../../packages/broker/src/local/registered-repositories.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { REQUEST_A, TASK_ID, operationsOf, seed } from "../support/task-actions-world.js";
import { createHarness, definition, newRequestId, type Harness } from "../support/task-flow-harness.js";

const A = COMPANY_A.orgId;
const GENERIC = [
  { kind: "npm", name: "acme-npm", url: "https://npm.acme.dev/", credentialRef: "acme-npm-token", scope: "@acme" },
  { kind: "npm", name: "acme-npm-open", url: "https://npm.acme.dev/" },
  { kind: "pypi", name: "acme-pypi", url: "https://pypi.acme.dev/simple/", credentialRef: "acme-pypi-token" },
  { kind: "pypi", name: "acme-pypi-open", url: "https://pypi.acme.dev/simple/" },
  { kind: "maven", name: "acme-maven", url: "https://maven.acme.dev/repo/", credentialRef: "acme-maven-token" },
  { kind: "maven", name: "acme-maven-open", url: "https://maven.acme.dev/repo/" },
];
const CODEARTIFACT = { kind: "codeartifact", name: "ca-npm", format: "npm", domain: "acme", domainOwner: "123456789012", repository: "npm-store", region: "us-west-2" };
const withRegistries = (registries: unknown[], extra: Record<string, unknown> = {}) => ({ ...definition, registries, ...extra }) as Record<string, unknown>;
const command = (extra: Record<string, unknown> = {}) => ({ cwd: "repo/demo", executable: "npm", args: ["ci"], timeoutSeconds: 60, ...extra });
const E2E_POLICY = {
  schemaVersion: 1, policyRevision: 1, executionMode: "trusted-scenarios", baselineScenarioIds: [], defaultSandboxProfileId: "sandbox", fallback: "mock-unconnected", modelRouteRevision: null,
  targets: [{ targetId: "project-e2e", applicationId: "orders", runtimeProfileId: "api-v1", accountProfileId: "owner", kind: "api", protocol: "http", originRef: "orders-api" }],
  capture: { screenshots: false, traces: false, video: false, downloads: false },
  limits: { runTimeoutMs: 60_000, startupTimeoutMs: 60_000, preparationTimeoutMs: 60_000, caseTimeoutMs: 60_000, maxActionsPerCase: 10, maxModelRequests: 10, maxInputTokens: 1_000, maxOutputTokens: 1_000, maxSpendUsd: null },
};
/** One violation of each rule that is kept at use, as a stored definition the read accepts. */
const BROKEN: Record<(typeof PROJECT_USE_RULES)[number], Record<string, unknown>> = {
  project_external_check: { repositories: [{ ...definition.repositories[0], externalChecks: [{ provider: "examplebuild", name: "q", reference: "pipeline/1", timeoutMinutes: 10 }] }] },
  project_allowed_domain: { network: { allowedDomains: ["github.io"] } },
  project_command_env: { setup: [command({ env: { PATH: "/tmp/x" } })] },
  project_e2e_reserved_id: { e2e: E2E_POLICY },
};

async function put(h: Harness, project: string, revision: number, value: unknown, extra: Record<string, unknown> = {}): Promise<void> {
  await h.store.put({ item: { ...projectRevisionKey(h.deps.companyId, project, revision), entityType: "PROJECT", ...extra, definition: value as JsonValue } });
}
async function point(h: Harness, project: string, revision: number): Promise<void> {
  await h.store.put({ item: { ...orgProjectCatalogKey(h.deps.companyId, project), entityType: "PROJECT_CATALOG", latestRevision: revision } });
}
const start = (h: Harness) => h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "Rename the flag" });

describe("a stored project with a generic registry entry (arch rule 8)", () => {
  it("reads in every shape a released version wrote: npm, pypi and maven, with and without a credential reference", () => {
    for (const entry of GENERIC) {
      const read = readStoredProject(withRegistries([entry]));
      expect(read.success, JSON.stringify(entry)).toBe(true);
      if (read.success) expect(read.data.registries).toEqual([]);
      expect(StoredProjectDefinitionSchema.safeParse(withRegistries([entry])).success, JSON.stringify(entry)).toBe(true);
    }
    const all = readStoredProject(withRegistries(GENERIC.slice(0, 5)));
    expect(all.success).toBe(true);
  });

  it("drops the generic entries and keeps the CodeArtifact one, to the same rules as before", () => {
    const read = readStoredProject(withRegistries([GENERIC[0], CODEARTIFACT, GENERIC[2]]));
    expect(read.success && read.data.registries).toEqual([CODEARTIFACT]);
    expect(readStoredProject(withRegistries([{ ...CODEARTIFACT, domainOwner: "short" }])).success).toBe(false);
    expect(readStoredProject(withRegistries([CODEARTIFACT, { ...CODEARTIFACT, name: "other" }])).success).toBe(false);
    expect(readStoredProject(withRegistries("not a list" as unknown as unknown[])).success).toBe(false);
  });

  it("an edit or a new project that adds a generic entry is still refused, with the existing words", () => {
    for (const entry of GENERIC) {
      const refused = ProjectDefinitionSchema.safeParse(withRegistries([entry]));
      expect(refused.success).toBe(false);
      expect(JSON.stringify(refused.error?.issues)).toContain(GENERIC_REGISTRY_REFUSED);
    }
    expect(ProjectDefinitionSchema.safeParse(withRegistries([CODEARTIFACT])).success).toBe(true);
  });

  it("the stored read still strips the legacy keys and refuses a record that is not a project", () => {
    expect(readStoredProject({ ...withRegistries(GENERIC), schemaVersion: 1, controlPlaneUrl: "http://x", auth: {}, environment: { image: "x" } }).success).toBe(true);
    expect(ProjectDefinitionSchema.safeParse({ ...definition, schemaVersion: 1 }).success).toBe(false);
    expect(readStoredProject({ ...definition, surprise: 1 }).success).toBe(false);
    expect(readStoredProject(undefined).success).toBe(false);
    expect(readStoredProject({ name: "p" }).success).toBe(false);
  });

  it("a task starts on it", async () => {
    const h = createHarness();
    await put(h, "payments", 1, withRegistries(GENERIC));
    await point(h, "payments", 1);
    const { task } = await start(h);
    expect(task.project).toBe("payments");
    expect(task.startingRevision).toBe(1);
  });

  it("the prepare is DELIVERED to the worker for it, and the project the worker is sent holds no registry of the project's", async () => {
    const h = createHarness();
    await put(h, "payments", 1, withRegistries(GENERIC));
    await point(h, "payments", 1);
    const { task } = await start(h);
    for (let round = 0; round < 12; round += 1) {
      if ((await h.flow.dispatchOnce({ maxMessages: 10 })).received === 0) break;
      h.clock.advance(70);
    }
    const workspace = (await h.store.get(workspaceKey(h.deps.companyId, task.workspaceId))) as unknown as WorkspaceRecord;
    const delivered = h.machines.delivered(workspace.machine!.machineId);
    expect(delivered.length).toBeGreaterThan(0);
    const prepare = delivered.at(-1)!;
    expect(prepare.kind).toBe("prepare");
    if (prepare.kind !== "prepare") throw new Error("not a prepare");
    expect(prepare.payload.project).toMatchObject({ name: "payments", repositories: [{ name: "demo" }] });
    expect(Object.hasOwn(prepare.payload.project, "registries")).toBe(false);
    expect(JSON.stringify(prepare)).not.toContain("acme-npm-token");
  });

  it("the setup proposal the approver reads, from a candidate revision that holds one, still reads", async () => {
    const h = createHarness();
    await h.registerProject();
    const deps = ({ flow: h.deps, store: h.store, companyId: h.deps.companyId, now: () => h.clock.now, starter: undefined, latest: async () => undefined }) as unknown as SetupApplyDeps;
    await storeSetupCandidate(deps, { project: "payments", by: "local-owner", requestId: newRequestId(), taskId: "", baseRevision: 1, candidate: { ...definition, revision: 2 }, replyExtra: {}, alsoTransact: [] });
    expect((await readSetupApply(deps, "payments"))?.setup).toEqual([]);
    await put(h, "payments", 2, withRegistries(GENERIC, { revision: 2 }), { candidate: true });
    const read = await readSetupApply(deps, "payments");
    expect(read).toBeDefined();
    expect((await h.store.get(setupApplyKey(h.deps.companyId, "payments")))?.["entityType"]).toBe("SETUP_APPLY");
  });

  it("the application readiness reader reads the pinned revision (and is refused only by a rule kept at use)", async () => {
    const h = createHarness();
    const reader = createApplicationSelectionReader({ companyId: h.deps.companyId, state: { store: h.store }, objects: {} as never, runtimeCatalogId: "catalog" });
    const ask = () => reader.selection({ companyId: h.deps.companyId, project: "payments", startingRevision: 1 } as never, {} as never, {} as never, {} as never);
    await put(h, "payments", 1, withRegistries(GENERIC));
    // It gets past the definition read (the next thing it needs, the E2E policy, is what this project does not have), and never says the pinned revision is unavailable.
    const past = await ask().then(() => "", (error: unknown) => (error as Error).message);
    expect(past).not.toContain("pinned application project revision is unavailable");
    await put(h, "payments", 1, withRegistries([], { setup: [command({ env: { PATH: "/tmp/x" } })] }));
    await expect(ask()).rejects.toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining("[project_command_env]") as string });
    await put(h, "payments", 1, { name: "payments" });
    await expect(ask()).rejects.toThrow("pinned application project revision is unavailable");
  });
});

describe("a rule that judges input is asked again where the record is used (arch rule 8 CAUTION)", () => {
  it("each kept rule: the record reads, the new-input schema refuses it, and use refuses it with the rule's fixed sentence and stable id", () => {
    for (const rule of PROJECT_USE_RULES) {
      const stored = { ...definition, ...BROKEN[rule] };
      const read = readStoredProject(stored);
      expect(read.success, rule).toBe(true);
      expect(ProjectDefinitionSchema.safeParse(stored).success, rule).toBe(false);
      if (!read.success) continue;
      expect(projectUseProblems(read.data), rule).toEqual([rule]);
      const refusal = projectUseRefusal(read.data);
      expect(refusal?.code, rule).toBe("CONFIG_INVALID");
      expect(refusal?.message, rule).toContain(PROJECT_USE_MESSAGES[rule]);
      if (rule !== "project_external_check") expect(refusal?.message, rule).toContain(`[${rule}]`);
    }
    expect(PROJECT_USE_MESSAGES.project_external_check).toBe(UNRUNNABLE_EXTERNAL_CHECK_MESSAGE);
    const clean = readStoredProject(definition);
    expect(clean.success && projectUseRefusal(clean.data)).toBeFalsy();
  });

  it("the secret-looking env value and a credential-like name are held at use too, and the sentence names no value", () => {
    const byName = readStoredProject({ ...definition, readiness: [command({ env: { API_TOKEN: "abc" } })] });
    const byValue = readStoredProject({ ...definition, setup: [command({ env: { DB: "postgres://user:hunter2hunter2@db/x" } })] });
    for (const read of [byName, byValue]) {
      expect(read.success).toBe(true);
      const refusal = read.success ? projectUseRefusal(read.data) : undefined;
      expect(refusal?.message).toContain("[project_command_env]");
      expect(refusal?.message).not.toContain("hunter2");
    }
  });

  it("a task start refuses each, once, before any workspace, and records the refusal", async () => {
    for (const rule of PROJECT_USE_RULES) {
      const h = createHarness({ audit: "recording" });
      await put(h, "payments", 1, { ...definition, ...BROKEN[rule] });
      await point(h, "payments", 1);
      await expect(start(h), rule).rejects.toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining(PROJECT_USE_MESSAGES[rule]) as string });
      expect(h.audit.some((event) => event.action === "task.start_refused"), rule).toBe(true);
      expect(await h.flow.dispatchOnce({ maxMessages: 10 }), rule).toMatchObject({ received: 0 });
    }
  });

  it("the dispatcher's prepare fails the operation with the sentence for a revision pinned before the rule applied, and sends nothing", async () => {
    for (const rule of PROJECT_USE_RULES.filter((entry) => entry !== "project_external_check")) {
      const h = createHarness();
      await h.registerProject();
      const { task } = await start(h);
      await put(h, "payments", 1, { ...definition, ...BROKEN[rule] });
      let delivered = 0;
      for (let round = 0; round < 12; round += 1) {
        const report = await h.flow.dispatchOnce({ maxMessages: 10 });
        delivered += report.delivered;
        if (report.received === 0) break;
        h.clock.advance(70);
      }
      expect(delivered, rule).toBe(0);
      const first = (await h.store.query({ pk: workspacePartition(IMPLICIT_COMPANY_ID, task.workspaceId), sk: { op: "beginsWith", prefix: "OPERATION#" } })).items[0]!;
      const operation = (await h.store.get(operationKey(IMPLICIT_COMPANY_ID, task.workspaceId, first["id"] as string)))!;
      expect(operation["status"], rule).toBe("FAILED");
      expect(JSON.stringify(operation), rule).toContain(`[${rule}]`);
    }
  });
});

describe("publish and maintain are held to the same use rules as prepare (arch rule 8 CAUTION)", () => {
  it("a publication on a revision pinned before the rule applied fails the operation with the rule's sentence and sends nothing to the worker", async () => {
    for (const rule of PROJECT_USE_RULES.filter((entry) => entry !== "project_external_check")) {
      const { h, caller } = await seed({ workflow: null });
      const publication = await startManualPublication(h.deps, caller, TASK_ID, { requestId: REQUEST_A, title: "Add retry", body: "x", draft: true });
      await put(h, "payments", 1, { ...definition, ...BROKEN[rule] });
      let delivered = 0;
      for (let round = 0; round < 12; round += 1) {
        const report = await h.flow.dispatchOnce({ maxMessages: 10 });
        delivered += report.delivered;
        if (report.received === 0) break;
        h.clock.advance(70);
      }
      expect(delivered, rule).toBe(0);
      const operation = (await operationsOf(h)).find((candidate) => candidate.id === publication.id)!;
      expect(operation.status, rule).toBe("FAILED");
      expect(JSON.stringify(operation), rule).toContain(`[${rule}]`);
    }
  });
});

describe("the laptop's registered repositories leave one unreadable project out (arch rule 9)", () => {
  it("lists the readable projects' repositories, skips and logs the unreadable one, and still raises any other error", async () => {
    const h = createHarness();
    await h.registerProject();
    await put(h, "broken", 1, { name: "broken", revision: 1 });
    await point(h, "broken", 1);
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => { lines.push(String(line)); });
    try {
      const records = await registeredRepositoryRecordsOf(h.store, h.deps.companyId);
      expect(records.map((record) => record.url)).toEqual([definition.repositories[0]!.url]);
    } finally { spy.mockRestore(); }
    const events = lines.flatMap((line) => { try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; } }).filter((entry) => entry["event"] === "project.left_out_unreadable_revision");
    expect(events).toMatchObject([{ project: "broken", rule: "project_revision_unreadable" }]);
    const failing = { ...h.store, get: async () => { throw new Error("store down"); }, query: h.store.query.bind(h.store) } as typeof h.store;
    await expect(registeredRepositoryRecordsOf(failing, h.deps.companyId)).rejects.toThrow("store down");
  });
});

describe("a project that cannot be read is told apart by class, never by text", () => {
  it("every reader refuses with ProjectRevisionUnreadableError, and its name stays AgentXError", async () => {
    const h = createHarness();
    await put(h, "payments", 1, { name: "payments", revision: 1 });
    const error = await h.deps.projects.latest("payments").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProjectRevisionUnreadableError);
    expect(error).toMatchObject({ name: "AgentXError", code: "CONFIG_INVALID", message: expect.stringContaining(PROJECT_REVISION_UNREADABLE) as string });
    const db = new FakeDynamoDb({ seed: 3 });
    db.set({ pk: `ORG#${A}#PROJECT#p`, sk: "REV#000000000001", entityType: "PROJECT", definition: { name: "p", revision: 1 } });
    expect(await namedCompanyLatestRevisionRow(db, "S", A, "p").catch((caught: unknown) => caught)).toBeInstanceOf(ProjectRevisionUnreadableError);
    // A plain AgentXError with the same words is not it.
    expect(agentXError("CONFIG_INVALID", PROJECT_REVISION_UNREADABLE)).not.toBeInstanceOf(ProjectRevisionUnreadableError);
  });
});

describe("no silent fallback to an older revision (arch rule 9)", () => {
  it("task start: the catalogue names a revision that does not read, so the start is refused with the stable sentence and never runs revision 1", async () => {
    const h = createHarness({ audit: "recording" });
    await put(h, "payments", 1, definition);
    await put(h, "payments", 2, { name: "payments", revision: 2 });
    await point(h, "payments", 2);
    await expect(start(h)).rejects.toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining(PROJECT_REVISION_UNREADABLE) as string });
    expect(h.audit.some((event) => event.action === "task.start_refused")).toBe(true);
    expect(await h.flow.dispatchOnce({ maxMessages: 10 })).toMatchObject({ received: 0 });
    // The same when the pointer names a row that is not there.
    await point(h, "payments", 7);
    await expect(start(h)).rejects.toThrow(PROJECT_REVISION_UNREADABLE);
  });

  it("task start: with no pointer, a newest revision that does not read is refused too, not swapped for the one before it", async () => {
    const h = createHarness();
    await put(h, "payments", 1, definition);
    await put(h, "payments", 2, { name: "payments", revision: 2 });
    await expect(start(h)).rejects.toThrow(PROJECT_REVISION_UNREADABLE);
    // A pinned read of a revision that does not read is just absent (nothing is substituted).
    expect(await h.deps.projects.revision("payments", 2)).toBeUndefined();
    expect((await h.deps.projects.revision("payments", 1))?.definition.revision).toBe(1);
  });

  it("the dispatcher's company read: the catalogue's revision is THE revision; one that does not read is refused, an older readable one is never returned", async () => {
    const db = new FakeDynamoDb({ seed: 3 });
    const rev = (n: number, value: unknown) => db.set({ pk: `ORG#${A}#PROJECT#p`, sk: `REV#${String(n).padStart(12, "0")}`, entityType: "PROJECT", definition: value });
    const readable = (n: number, extra: Record<string, unknown> = {}) => ({ name: "p", revision: n, orchestratorInstructions: "x", setup: [], readiness: [], repositories: [{ name: "r", url: "https://github.com/acme/r", path: "repo/r", defaultBranch: "main", credentialRef: "g" }], ...extra });
    rev(1, readable(1));
    rev(2, readable(2, { registries: GENERIC }));
    db.set({ pk: `ORG#${A}#PROJECT_CATALOG`, sk: "PROJECT#p", latestRevision: 2 });
    // A stored generic entry reads: revision 2 is served, as the catalogue says.
    expect(((await namedCompanyLatestRevisionRow(db, "S", A, "p"))?.definition as { revision: number }).revision).toBe(2);
    rev(2, { name: "p", revision: 2 });
    await expect(namedCompanyLatestRevisionRow(db, "S", A, "p")).rejects.toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining(PROJECT_REVISION_UNREADABLE) as string });
    // A pointer to nothing is refused as well; without a pointer the newest non-candidate is the latest, and one that does not read is refused.
    db.set({ pk: `ORG#${A}#PROJECT_CATALOG`, sk: "PROJECT#p", latestRevision: 9 });
    await expect(namedCompanyLatestRevisionRow(db, "S", A, "p")).rejects.toThrow(PROJECT_REVISION_UNREADABLE);
    db.delete(`ORG#${A}#PROJECT_CATALOG`, "PROJECT#p");
    await expect(namedCompanyLatestRevisionRow(db, "S", A, "p")).rejects.toThrow(PROJECT_REVISION_UNREADABLE);
    // A deleted project is still absent, not refused.
    db.set({ ...projectMetaKey(A, "p"), entityType: "PROJECT_META", companyId: A, project: "p", incarnationRevision: 2, status: "deleted" });
    expect(await namedCompanyLatestRevisionRow(db, "S", A, "p")).toBeUndefined();
  });
});
