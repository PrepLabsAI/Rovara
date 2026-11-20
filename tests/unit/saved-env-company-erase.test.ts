import { describe, expect, it, vi } from "vitest";
import { closeCompanySavedEnvironments, eraseCompanySavedEnvironments, SAVED_ENV_ERASE_DRAIN_MS } from "../../packages/broker/src/aws/saved-env-company-erase.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { documentOf } from "../../packages/broker/src/core/test-env/deps.js";
import { savedEnvWorld } from "../support/saved-env-world.js";
import { savedEnvRepositoryName } from "@agentx/contracts";

const companyId = "org_staging0000000000001";
const other = "org_staging0000000000002";
const repository = (projectId: string, orgId = companyId) => savedEnvRepositoryName({ env: "test", orgId, projectId });
async function world(closing = true) {
  const w = savedEnvWorld({ enabled: false, ids: { orgId: companyId, projectId: "app" } });
  const store = new MemoryDocumentStore();
  w.seed({ job: { jobId: "job", leaseToken: "x".repeat(48), reason: "no_image", approved: { revision: 1, digest: "a".repeat(64) }, commits: {}, expectedKey: "b".repeat(64), createdAt: new Date(w.clock.now).toISOString(), leaseUntil: new Date(w.clock.now + 3_600_000).toISOString() } });
  await store.put({ item: documentOf({ pk: `ORG#${companyId}`, sk: "SAVED_ENV#app", ...w.row() }) });
  const lifecycle = { closing };
  const companyClosing = vi.fn(async (id: string) => id === companyId && lifecycle.closing);
  const markCompanyClosing = vi.fn(async (id: string) => { if (id !== companyId) throw new Error(); lifecycle.closing = true; });
  const rows = new Set([repository("app"), repository("orphan")]);
  const listCompanyRepositories = vi.fn(async () => [...rows]);
  const deleteRepository = vi.fn(async ({ repository }: { repository: string }) => { rows.delete(repository); return "deleted" as const; });
  const input = { companyId, store, saved: w.deps, companyClosing, sessions: { listCompanyRepositories }, registry: { deleteRepository } };
  return { w, store, rows, lifecycle, companyClosing, markCompanyClosing, listCompanyRepositories, deleteRepository,
    run: () => eraseCompanySavedEnvironments(input), close: () => closeCompanySavedEnvironments({ ...input, markCompanyClosing }) };
}
describe("company saved image erase", () => {
  it("the close job blocks new company work before erase and retains project rows throughout the drain", async () => {
    const h = await world(false);
    const newWork = vi.fn(() => { if (h.lifecycle.closing) throw new Error("company closing"); });
    newWork();
    h.companyClosing.mockImplementation(async id => {
      expect(h.markCompanyClosing).toHaveBeenCalledWith(companyId);
      expect(newWork).toThrow("company closing");
      return id === companyId && h.lifecycle.closing;
    });
    expect(await h.close()).toEqual({ complete: false, reason: "push_sessions_draining" });
    expect(h.w.row()).toMatchObject({ deleted: true });
    expect((await h.store.query({ pk: `ORG#${companyId}`, sk: { op: "beginsWith", prefix: "SAVED_ENV#" } })).items).toHaveLength(1);
    expect(h.listCompanyRepositories).not.toHaveBeenCalled();
    h.w.clock.now += SAVED_ENV_ERASE_DRAIN_MS + 1;
    expect(await h.close()).toEqual({ complete: true, repositories: 2 });
    expect(newWork).toThrow("company closing");
    expect(h.w.row()).toBeDefined();
    expect(h.listCompanyRepositories).toHaveBeenCalledWith({ companyId });
  });
  it("does not erase if marking closing fails or the durable closing read disagrees", async () => {
    for (const fails of [true, false]) {
      const h = await world(false);
      if (fails) h.markCompanyClosing.mockRejectedValue(new Error("private mark detail"));
      else h.markCompanyClosing.mockImplementation(async () => undefined);
      expect(await h.close()).toEqual({ complete: false, reason: "unavailable" });
      expect(h.w.row()?.deleted).not.toBe(true);
      expect(h.listCompanyRepositories).not.toHaveBeenCalled();
    }
  });
  it("refuses foreign repository names, partial deletes, and recreation after deletion", async () => {
    for (const mode of ["foreign", "leftover", "failure"] as const) {
      const h = await world();
      await h.run(); h.w.clock.now += SAVED_ENV_ERASE_DRAIN_MS + 1;
      if (mode === "foreign") h.rows.add(repository("app", other));
      if (mode === "leftover") h.deleteRepository.mockImplementation(async () => "deleted");
      if (mode === "failure") h.deleteRepository.mockRejectedValue(new Error("private detail"));
      expect(await h.run()).toEqual({ complete: false, reason: "unavailable" });
      if (mode === "foreign") expect(h.deleteRepository).not.toHaveBeenCalled();
    }
  });
});
