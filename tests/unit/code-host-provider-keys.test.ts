// Port lane P2, review L1: repository keys, the head index and the linked change request rows are filed by the connection's PROVIDER, so renaming a connection (or making another the default) orphans nothing, and a GitHub
// connection that is not called `github` is still a GitHub repository for revert detection and the reverse link.
import { describe, expect, it } from "vitest";
import type { CodeHost } from "@rovara-code/contracts";
import { findLinkedChangeRequest, linkedChangeRequestKey, linkedChangeRequestStep } from "../../packages/core/src/core/proof/revert/linked-change-requests.js";
import { codeHostRepositoryKey } from "../../packages/core/src/core/proof/revert/repository-key.js";
import { pressMerge, prepareMerge, readMergeTracking, trackPullRequest } from "../../packages/core/src/core/merge/index.js";
import { providerOf } from "../../packages/core/src/plugins/routing.js";
import { MemoryDocumentStore } from "../../packages/core/src/ports/memory-document-store.js";
import { FakeCodeHost } from "@rovara-code/core/fakes";
import { ORG, TASK_ID, mergeWorld } from "../support/merge-world.js";

/** The fake host as a GitHub connection under another name: `github-main`, of provider `github`. */
const renamed = (model: ConstructorParameters<typeof FakeCodeHost>[0]): CodeHost => Object.create(new FakeCodeHost(model), { kind: { value: "github-main" }, provider: { value: "github" } }) as CodeHost;

describe("keys by provider", () => {
  it("files a GitHub connection under owner/name whatever it is called", () => {
    const connection = renamed({ url: "https://github.com/Acme/App", id: "1", fullName: "Acme/App" } as never);
    expect(providerOf(connection)).toBe("github");
    expect(codeHostRepositoryKey(providerOf(connection), "https://github.com/Acme/App.git")).toBe("acme/app");
    // The connection's own name would have made another key: that was the orphaning.
    expect(codeHostRepositoryKey("github-main", "https://github.com/Acme/App.git")).toBe("github-main:https://github.com/Acme/App");
  });

  it("reads a link written under the provider by a connection of any name, and still reads one an earlier build wrote under the connection's own name", async () => {
    const store = new MemoryDocumentStore();
    const base = { repositoryAddress: "https://github.com/acme/app", changeRequestId: "7", repositoryId: "app", number: 7, url: "https://github.com/acme/app/pull/7", taskId: TASK_ID, workspaceId: "ws-1", candidateDigest: "a".repeat(64), createdAt: "2026-11-10T00:00:00.000Z" };
    await store.transact([linkedChangeRequestStep({ ...base, hostKind: "github" })!]);
    const query = { hostKind: "github", repositoryAddress: base.repositoryAddress, id: "7" };
    // The default connection was renamed: the provider is the same, so the row is found whatever the connection is called now.
    expect(await findLinkedChangeRequest(store, { ...query, connectionKind: "github-renamed" })).toMatchObject({ taskId: TASK_ID, hostKind: "github" });
    // A row filed under a connection's own name (before rows were filed by provider) is found through the fallback, and only for that connection.
    const legacy = new MemoryDocumentStore();
    await legacy.transact([linkedChangeRequestStep({ ...base, hostKind: "github-company" })!]);
    expect(await findLinkedChangeRequest(legacy, query)).toBeUndefined();
    expect(await findLinkedChangeRequest(legacy, { ...query, connectionKind: "github-company" })).toMatchObject({ taskId: TASK_ID, hostKind: "github-company" });
    expect(await findLinkedChangeRequest(legacy, { ...query, connectionKind: "github-other" })).toBeUndefined();
    expect(linkedChangeRequestKey("github", base.repositoryAddress, "7")?.pk).toBe("CODEHOST_CR#github#acme/app");
  });

  it("tracks and prepares a merge through a renamed GitHub connection: the task's running link is not orphaned", async () => {
    const world = await mergeWorld({ codeHost: renamed });
    await trackPullRequest(world.tracking, TASK_ID);
    const items = await readMergeTracking(world.store, TASK_ID, ORG);
    expect(items).toHaveLength(1);
    // The link the task was started with (filed under `github`) is found, so the press can be prepared.
    await expect(prepareMerge(world.deps, { taskId: TASK_ID, requestId: world.requestId() })).resolves.toBeDefined();
  });

  it("presses a merge through a renamed GitHub connection: the reverse link (filed under the provider) is the one looked up (review L1)", async () => {
    const world = await mergeWorld({ codeHost: renamed });
    await world.seedTracking();
    const prepared = await world.prepare();
    const result = await pressMerge(world.deps, { taskId: TASK_ID, requestId: prepared.request.requestId, proof: world.proofFor(prepared) });
    expect(result).toBeDefined();
    expect(world.prs[0]!.model.getChangeRequest(String(world.prs[0]!.number)).state).toBe("merged");
  });
});
