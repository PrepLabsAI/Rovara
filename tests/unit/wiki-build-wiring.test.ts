// Wiki W4: the two seams W3b left to the hosting side. The citation reader is made for ONE project (a repository name is only a name inside a project); the callback's sink and build record
// writer are THIS company's wiki store for the run's own project; the end hook writes the build record from the run's own pointer only. Two-project and two-company tests throughout.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { OrgId, WikiBuildRecord } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createWikiStore } from "../../packages/broker/src/core/wiki/store.js";
import { startWikiBuild } from "../../packages/broker/src/core/wiki-build/run.js";
import { projectCitationReader, wikiBuildCallbackWiring, wikiBuildEndedHook } from "../../packages/broker/src/core/wiki-build/wiring.js";
import { API_SHA, COMPANY_A, COMPANY_B, FakeStarter, WEB_SHA, area, fileMap, repoEntry } from "../support/wiki-build-fixtures.js";

const T0 = Date.parse("2026-11-17T12:00:00.000Z");
const PROJECTS: Record<string, { definition: { repositories: Array<{ name: string; url: string }> } }> = {
  alpha: { definition: { repositories: [{ name: "api", url: "https://github.com/acme/alpha-api.git" }] } },
  beta: { definition: { repositories: [{ name: "api", url: "https://github.com/acme/beta-api.git" }] } },
};

describe("the project's citation reader", () => {
  it("reads through the code host for the project's own repository of that name, and refuses a name the project does not have", async () => {
    const calls: Array<{ url: string; path: string; commit: string; read: unknown }> = [];
    const options = { projects: { latest: async (name: string) => PROJECTS[name] }, fileAt: async (repository: { url: string }, path: string, commit: string, read: unknown) => { calls.push({ url: repository.url, path, commit, read }); return "text"; } };
    const alpha = projectCitationReader(options, "alpha");
    const beta = projectCitationReader(options, "beta");
    expect(await alpha("api", "src/a.ts", API_SHA, { untilLine: 4, timeoutMs: 1000 })).toBe("text");
    expect(await beta("api", "src/a.ts", API_SHA, { timeoutMs: 1000 })).toBe("text");
    // The same repository name is a different repository in each project.
    expect(calls.map((call) => call.url)).toEqual(["https://github.com/acme/alpha-api.git", "https://github.com/acme/beta-api.git"]);
    expect(calls[0]!.read).toEqual({ untilLine: 4, timeoutMs: 1000, maxBytes: 262_144 });
    await expect(alpha("web", "a.ts", API_SHA, { timeoutMs: 1 })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(projectCitationReader(options, "gamma")("api", "a.ts", API_SHA, { timeoutMs: 1 })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(calls).toHaveLength(2);
  });
});

describe("the callback's page sink and build record writer", () => {
  it("write into this company's own store for the named project only", async () => {
    const store = new MemoryDocumentStore();
    const wiring = wikiBuildCallbackWiring({ store, companyId: COMPANY_A, now: () => T0, standing: async () => ({ access: "manage" }), readFor: () => async () => undefined });
    const sink = wiring.sinkFor("alpha");
    expect(sink).toMatchObject({ companyId: COMPANY_A, project: "alpha" });
    await sink.putPage({
      pageId: "overview", kind: "overview", title: "T", summary: "S", order: 0, repos: [{ repo: "api", commit: API_SHA }], buildId: "build-0001",
      blocks: [{ kind: "paragraph", blockId: "p0001", text: "Text", claimIds: ["c0001"] }],
      claims: [{ claimId: "c0001", text: "A claim", citations: [{ repo: "api", path: "a.ts", commit: API_SHA, line: 1, quote: "export const a = 1;" }], source: "found", checkedAt: "2026-11-17T09:00:00.000Z" }],
    });
    const record: WikiBuildRecord = { buildId: "build-0001", kind: "first", state: "done", startedAt: "2026-11-17T10:00:00.000Z", repos: [{ repo: "api", commit: API_SHA }], counts: { pagesWritten: 1, claimsKept: 1, claimsDropped: 0, skipped: 0 }, dropped: [], skipped: [] };
    await wiring.recordBuild!("alpha", record);
    const mine = createWikiStore({ store, companyId: COMPANY_A, now: () => T0 });
    expect((await mine.readIndex("alpha")).map((entry) => entry.pageId)).toEqual(["overview"]);
    expect((await mine.lastBuild("alpha"))?.buildId).toBe("build-0001");
    expect(await mine.readIndex("beta")).toEqual([]);
    expect(await createWikiStore({ store, companyId: COMPANY_B, now: () => T0 }).readIndex("alpha")).toEqual([]);
  });
});

describe("the end hook", () => {
  async function world(company: OrgId = COMPANY_A) {
    const store = new MemoryDocumentStore();
    const starter = new FakeStarter(store);
    const map = fileMap([repoEntry("api", [area("src", { rank: 1 })])]);
    const deps = {
      store, companyId: company, now: () => T0, starter, standing: async () => ({ access: "manage" as const }), modelAccessConfigured: true, aiKey: async () => "connected" as const, fileMap: async () => map,
      defaultBranchHeads: async () => [{ repo: "api", commit: API_SHA }], requireNewWork: async () => undefined,
    };
    await startWikiBuild(deps, "p1", "alpha", { requestId: randomUUID() });
    return { store, started: starter.started[0]!, company };
  }

  it("writes the build record from the run's own pointer, for this company and project", async () => {
    const w = await world();
    const hook = wikiBuildEndedHook({ store: w.store, companyId: COMPANY_A, now: () => T0 });
    await hook({ orgId: COMPANY_A, project: "alpha", taskId: w.started.taskId });
    const last = await createWikiStore({ store: w.store, companyId: COMPANY_A, now: () => T0 }).lastBuild("alpha");
    expect(last).toMatchObject({ buildId: w.started.taskId, state: "running", kind: "first", startedBy: "p1" });
  });

  it("writes nothing for another company's scope, another project, an older task or a project with no run", async () => {
    const w = await world();
    const hook = wikiBuildEndedHook({ store: w.store, companyId: COMPANY_A, now: () => T0 });
    const mine = createWikiStore({ store: w.store, companyId: COMPANY_A, now: () => T0 });
    await hook({ orgId: COMPANY_B, project: "alpha", taskId: w.started.taskId });
    await hook({ orgId: COMPANY_A, project: "beta", taskId: w.started.taskId });
    await hook({ orgId: COMPANY_A, project: "alpha", taskId: randomUUID() });
    expect(await mine.lastBuild("alpha")).toBeUndefined();
    expect(await mine.lastBuild("beta")).toBeUndefined();
    expect(await createWikiStore({ store: w.store, companyId: COMPANY_B, now: () => T0 }).lastBuild("alpha")).toBeUndefined();
    void WEB_SHA;
  });
});
