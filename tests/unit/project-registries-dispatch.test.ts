// P1a: the prepare the dispatcher builds. Every project of a company that set a package token gets the company's registries in its PREPARE payload (where they are, never a credential) and nowhere else: not
// in the agent's task step, not in the project the worker is sent, not in anything stored. The dispatcher never reads the token (the worker asks for it, at the route). FAKE tokens, built at run time.
import { describe, expect, it, vi } from "vitest";
import { PREPARE_REGISTRIES_FEATURE, type CompanyRegistryEntry, type ProjectDefinition, type ProjectRegistry, type WorkerInvocation } from "@agentx/contracts";
import { OPERATION_SK_PREFIX, operationKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import type { OperationRecord, WorkspaceRecord } from "../../packages/broker/src/core/task-flow/records.js";
import type { CompanyRegistryStore } from "../../packages/broker/src/core/project-registries/mint.js";
import { COMPANY_REGISTRIES_UNREADABLE, REGISTRY_FEATURE_MISSING } from "../../packages/broker/src/core/project-registries/prepare.js";
import { COMPANY, createHarness, newRequestId, definition, type Harness } from "../support/task-flow-harness.js";

const PAT = `${"gh"}${"p"}_${Buffer.from("dispatch-fake-material-".repeat(4)).toString("base64url").replace(/[^A-Za-z0-9]/g, "").slice(0, 36)}`;
const ENTRY: CompanyRegistryEntry = { host: "npm.pkg.github.com", scopes: ["@acme"] };
const FEATURES = ["task.workflowMode", "task.structuredPlans", PREPARE_REGISTRIES_FEATURE];

function build(options: { features?: string[]; serve?: boolean; entries?: CompanyRegistryEntry[]; failEntries?: boolean } = {}) {
  const tokenReads = vi.fn();
  const company: CompanyRegistryStore = {
    entries: async () => { if (options.failEntries === true) throw new Error(`down ${PAT}`); return options.entries ?? [ENTRY]; },
    token: async (...args) => { tokenReads(...args); return { token: PAT }; },
  };
  const h = createHarness({ machines: { features: options.features ?? FEATURES }, extra: () => ({ ...(options.serve === false ? {} : { projectRegistries: { company } }) }) });
  return { h, tokenReads };
}

async function drain(h: Harness): Promise<void> {
  for (let round = 0; round < 12; round += 1) {
    if ((await h.flow.dispatchOnce({ maxMessages: 10 })).received === 0) return;
    h.clock.advance(70);
  }
}
async function startOf(h: Harness, project: ProjectDefinition) {
  await h.registerProject(project);
  const started = await h.flow.start(h.owner, { requestId: newRequestId(), project: project.name, instructions: "Rename the flag", workflow: true, workflowPath: "FULL" });
  await drain(h);
  const workspace = (await h.store.get(workspaceKey(h.deps.companyId, started.task.workspaceId))) as unknown as WorkspaceRecord;
  // Every operation record of the workspace (the preparation that was refused has ended, so the workspace no longer names it).
  const operationOf = async (): Promise<OperationRecord[]> => (await h.store.query({ pk: workspace.pk, sk: { op: "beginsWith", prefix: OPERATION_SK_PREFIX } })).items as unknown as OperationRecord[];
  return { started, workspace, operationOf, delivered: (): WorkerInvocation[] => (workspace.machine === undefined ? [] : h.machines.delivered(workspace.machine.machineId)) };
}

describe("the prepare payload", () => {
  it("carries the company's registries (where, never how) to a worker that lists the feature, for a project that names none", async () => {
    const { h, tokenReads } = build();
    const run = await startOf(h, definition);
    const prepare = run.delivered().at(-1)!;
    expect(prepare.kind).toBe("prepare");
    if (prepare.kind !== "prepare") throw new Error("not a prepare");
    expect(prepare.payload.registries).toStrictEqual([{ name: "ghnpm-1", kind: "npm", format: "npm", url: "https://npm.pkg.github.com/", scope: "@acme" }]);
    expect(Object.hasOwn(prepare.payload.project, "registries")).toBe(false);
    expect(JSON.stringify(prepare)).not.toContain("credentialRef\":\"mine");
    expect(JSON.stringify(prepare)).not.toContain(PAT);
    // The dispatcher never reads a token: the worker asks for it at the route.
    expect(tokenReads).not.toHaveBeenCalled();
  });

  it("is the same for another project of the company, and nothing when the company set none", async () => {
    const { h } = build();
    const first = (await startOf(h, definition)).delivered().at(-1)!;
    const second = (await startOf(h, { ...definition, name: "other" })).delivered().at(-1)!;
    if (first.kind !== "prepare" || second.kind !== "prepare") throw new Error("not prepares");
    expect(second.payload.registries).toEqual(first.payload.registries);
    const none = build({ entries: [] });
    const plain = (await startOf(none.h, definition)).delivered().at(-1)!;
    if (plain.kind !== "prepare") throw new Error("not a prepare");
    expect(Object.hasOwn(plain.payload, "registries")).toBe(false);
  });

  it("is in no later step of the task, and the PAT is in no stored record, whatever the step", async () => {
    const { h } = build();
    const run = await startOf(h, definition);
    const prepare = run.delivered().at(-1)!;
    h.machines.finish(run.workspace.machine!.machineId, prepare.operationId);
    await h.flow.recordResult({ workspaceId: run.workspace.id, operationId: prepare.operationId, fence: 1, status: "SUCCEEDED", outcome: { kind: "prepared" } });
    await drain(h);
    const later = run.delivered().filter((invocation) => invocation.operationId !== prepare.operationId);
    expect(later.length).toBeGreaterThan(0);
    for (const invocation of later) {
      expect(invocation.kind).not.toBe("prepare");
      expect(JSON.stringify(invocation)).not.toContain("registries");
      expect(JSON.stringify(invocation)).not.toContain("npm.pkg.github.com/");
      expect(JSON.stringify(invocation)).not.toContain(PAT);
    }
    const stored = JSON.stringify([await h.store.get(operationKey(COMPANY, run.workspace.id, prepare.operationId)), await h.store.get(workspaceKey(COMPANY, run.workspace.id))]);
    expect(stored).not.toContain(PAT);
    expect(stored).not.toContain("npm.pkg.github.com");
  });

  it("is refused for a worker that does not list the feature, in fixed words, and the preparation does not start", async () => {
    const { h } = build({ features: ["task.workflowMode", "task.structuredPlans"] });
    const run = await startOf(h, definition);
    expect(run.delivered()).toEqual([]);
    expect(JSON.stringify(await run.operationOf())).toContain(REGISTRY_FEATURE_MISSING);
  });

  it("is not asked of an install with no company store, and a project that needs nothing still starts there", async () => {
    const { h } = build({ serve: false });
    const plain = await startOf(h, definition);
    const prepare = plain.delivered().at(-1)!;
    if (prepare.kind !== "prepare") throw new Error("not a prepare");
    expect(Object.hasOwn(prepare.payload, "registries")).toBe(false);
  });

  it("is refused in fixed words when the company's settings cannot be read, with no word of what the store said", async () => {
    const { h } = build({ failEntries: true });
    const run = await startOf(h, definition);
    expect(run.delivered()).toEqual([]);
    const text = JSON.stringify(await run.operationOf());
    expect(text).toContain(COMPANY_REGISTRIES_UNREADABLE);
    expect(text).not.toContain(PAT);
  });

  it("is refused for a project that names a CodeArtifact registry the install cannot serve", async () => {
    const { h } = build();
    const codeArtifact: ProjectRegistry = { kind: "codeartifact", name: "internal-npm", format: "npm", domain: "acme", domainOwner: "123456789012", repository: "shared", region: "us-west-2" };
    const run = await startOf(h, { ...definition, registries: [codeArtifact] });
    expect(run.delivered()).toEqual([]);
    expect(JSON.stringify(await run.operationOf())).toContain("Package registries are not set up");
  });
});
