// The tier read takes the file entry types from the code host's own list (`entry: { head, base }`, #576) and holds them to the head it classifies (`expectedHead`):
// a docs-only change takes the docs route when the host reports entry, and an entry that describes another head is never used (not known = risky).
import { describe, expect, it } from "vitest";
import type { ChangeRequestFilesPage, ChangeRequestRef, CodeHost, HostScope } from "../../packages/contracts/src/index.js";
import { FakeHostModel } from "../../packages/broker/src/plugins/fake/model.js";
import { FakeCodeHost } from "../../packages/broker/src/plugins/fake/code-host.js";
import { readTierInput } from "../../packages/broker/src/core/merge/change-tier-read.js";
import { tierFromDiff, type ChangeTier } from "../../packages/broker/src/core/decisions/change-tier.js";

const scope = { orgId: "org_aaaaaaaaaaaaaaaaaaaa" } as const;
const repository = { url: "https://host.example.test/example/app" };
const AT = "2026-11-14T10:00:00.000Z";

async function docsChange() {
  const model = new FakeHostModel({ ...repository, id: "1", fullName: "example/app", initialFiles: { "docs/guide.md": "Old line.\n" } });
  const head = model.commit("feature", { "docs/guide.md": "New line.\n" });
  const { cr } = model.reconcile({ sourceBranch: "feature", targetBranch: "main", title: "docs fix" });
  return { model, head, number: Number(cr.id), branch: "feature" };
}
const tierOf = async (host: CodeHost, number: number, headSha: string): Promise<{ tier: ChangeTier; entries: unknown[] }> => {
  const read = await readTierInput([{ host, repositoryId: "app", repositoryUrl: repository.url, number, headSha }], scope);
  return { tier: tierFromDiff(read.diff, { headSha, mergeBase: "b".repeat(40), at: AT, head: read.head }), entries: read.diff.files.map((file) => file.entry) };
};

describe("the tier read gets the file entry types from the host path", () => {
  it("a docs-only change takes the docs route when the host reports entry", async () => {
    const { model, head, number } = await docsChange();
    const host = new FakeCodeHost(model);
    const { tier, entries } = await tierOf(host, number, head);
    expect(entries).toEqual([{ head: "file", base: "file" }]);
    expect(tier).toMatchObject({ level: "small", kinds: ["docs"] });
  });

  it("the same change from a host that reports no entry is not the docs route (entry is not known, never an ordinary file)", async () => {
    const { model, head, number } = await docsChange();
    const fake = new FakeCodeHost(model);
    const silent = Object.create(fake, {
      changedFiles: { value: async (ref: ChangeRequestRef, page: number, at: HostScope): Promise<ChangeRequestFilesPage> => { const read = await fake.changedFiles(ref, page, at); return { ...read, files: read.files.map(({ entry: _entry, ...file }) => file) }; } }, // eslint-disable-line @typescript-eslint/no-unused-vars -- left out on purpose
    }) as CodeHost;
    const { tier, entries } = await tierOf(silent, number, head);
    expect(entries).toEqual([undefined]);
    expect(tier.kinds).not.toEqual(["docs"]);
  });

  it("the head the tier classifies is passed to the host, so an entry never describes a newer head", async () => {
    const { model, head, number, branch } = await docsChange();
    const fake = new FakeCodeHost(model);
    const asked: Array<string | undefined> = [];
    const spy = Object.create(fake, {
      changedFiles: { value: async (ref: ChangeRequestRef, page: number, at: HostScope, options?: { expectedHead?: string }): Promise<ChangeRequestFilesPage> => { asked.push(options?.expectedHead); return fake.changedFiles(ref, page, at, options); } },
    }) as CodeHost;
    await tierOf(spy, number, head);
    expect(asked).toEqual([head]);
    // A person pushes between the check and the read: the host's head is newer than the one the tier is for, so no entry is reported and the change is not read as plain docs.
    model.commit(branch, { "docs/guide.md": "Newer line.\n", "run.sh": "echo hi\n" });
    const stale = await tierOf(spy, number, head);
    expect(asked).toEqual([head, head]);
    expect(stale.entries.every((entry) => entry === undefined)).toBe(true);
    expect(stale.tier.kinds).not.toEqual(["docs"]);
  });
});
