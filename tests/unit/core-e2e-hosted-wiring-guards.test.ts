// Pin the hosted adapter's own refusals and both transaction-item sources, independently of the engines it composes.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkflowSnapshot, when, type TransactItem } from "@agentx/contracts";
import { wireHostedApplicationE2E } from "../../packages/broker/src/aws/core-application-e2e.js";
import type { HostedAuthorityDeps } from "../../packages/broker/src/core/e2e/hosted-authority.js";
import type { ApplicationE2ESeams, ApplicationTask } from "../../packages/broker/src/core/e2e/application-seams.js";
import { failClosedAuthority } from "../../packages/broker/src/core/e2e/authority.js";
import { createHarness } from "../support/task-flow-harness.js";
import { createDocumentObjectStorage } from "../../packages/broker/src/core/proof/evidence-blob-store.js";

const mocks = vi.hoisted(() => ({ creator: vi.fn(), current: vi.fn(), selection: vi.fn() }));
let authorityDeps: HostedAuthorityDeps | undefined;
vi.mock("../../packages/broker/src/aws/core-e2e-authority-store.js", () => ({ hostedCreatorAuthority: mocks.creator }));
vi.mock("../../packages/broker/src/core/e2e/application-readiness.js", () => ({ createApplicationSelectionReader: () => ({ current: mocks.current, selection: mocks.selection }) }));
vi.mock("../../packages/broker/src/core/e2e/hosted-authority.js", () => ({ createHostedE2EAuthority: (deps: HostedAuthorityDeps) => { authorityDeps = deps; return failClosedAuthority; } }));
beforeEach(() => { vi.resetAllMocks(); authorityDeps = undefined; });

function world() {
  const h = createHarness();
  const task = { companyId: h.deps.companyId, taskId: "11111111-1111-4111-8111-111111111111", developerId: "owner", project: "demo", startingRevision: 1,
    workflow: createWorkflowSnapshot({ taskId: "11111111-1111-4111-8111-111111111111", ownerId: "a".repeat(64), now: "2026-11-22T00:00:00.000Z" }) } as ApplicationTask;
  const selectedItem: TransactItem = { kind: "check", key: { pk: "selection", sk: "META" }, condition: when.eq("revision", 1) };
  const creatorItem: TransactItem = { kind: "check", key: { pk: "creator", sk: "META" }, condition: when.eq("role", "member") };
  const selection = { schemaVersion: "e2e-application-selection/v1" };
  mocks.creator.mockResolvedValue({ items: [creatorItem] });
  mocks.selection.mockResolvedValue({ selection, items: [selectedItem] });
  mocks.current.mockResolvedValue({ selection, inputs: { registeredRuntimes: [], accountEntries: [] } });
  const application = wireHostedApplicationE2E({ flow: h.deps, objects: createDocumentObjectStorage(h.store, { companyId: h.deps.companyId }), runtimeCatalogId: "catalog",
    documentClient: { send: async () => ({}) }, stateTableName: "state", signInTableName: "signin", companyId: h.deps.companyId });
  const args = [task, { schemaVersion: 2 }, { id: "plan", sha256: "a".repeat(64) }, { mode: "approve", pinned: [] }] as unknown as Parameters<ApplicationE2ESeams["rounds"]["selection"]>;
  const currentInput = { task, intent: args[1], artifact: args[2] } as Parameters<NonNullable<HostedAuthorityDeps["currentSelection"]>>[0];
  return { task, application, args, currentInput, selection, selectedItem, creatorItem };
}

describe("hosted application adapter guards", () => {
  it("refuses a missing workflow before consulting the current-selection reader", async () => {
    const w = world(); const { workflow: _workflow, ...task } = w.task; void _workflow;
    const input = { ...w.currentInput, task };
    await expect(authorityDeps!.currentSelection!(input)).resolves.toEqual({ ok: false, kind: "unevaluable", reason: "the workflow is unavailable" });
    expect(mocks.current).not.toHaveBeenCalled();
  });
  it("forwards an available workflow and returns the current selection and runtime/account inputs", async () => {
    const w = world();
    await expect(authorityDeps!.currentSelection!(w.currentInput)).resolves.toEqual({ ok: true, selection: w.selection, rows: [], accountEntries: [] });
    expect(mocks.current).toHaveBeenCalledExactlyOnceWith(w.task, w.args[1], w.args[2]);
  });
  it("refuses an absent creator before any application selection", async () => {
    const w = world(); mocks.creator.mockResolvedValue(undefined);
    await expect(w.application.rounds.selection(...w.args)).rejects.toThrow("the original creator has no current company and project authority");
    expect(mocks.selection).not.toHaveBeenCalled();
  });
  it("forwards both selection and creator conditions to the caller's transaction", async () => {
    const w = world();
    await expect(w.application.rounds.selection(...w.args)).resolves.toEqual({ selection: w.selection, items: [w.selectedItem, w.creatorItem] });
  });
});
