// Saved project images (SV wiring): the environment key the broker works out from the code host's tree listing. It must move when a key file, the revision, the secret names, the base image or the detector globs
// move, stay put for any other file, and give NO key (never a key over fewer files) when the listing is cut, a key file is a link or a submodule, or a dev container file cannot be read.
import { describe, expect, it, vi } from "vitest";
import { SAVED_ENV_MAX_KEY_FILES } from "@agentx/contracts";
import { KeyListingCache, expectedEnvironmentKey, type KeyHost, type TreeEntryListing } from "../../packages/broker/src/core/test-env/saved-env-key.js";

const blob = (n: string): string => n.padStart(40, "0");
const file = (path: string, id: string, mode = "100644"): TreeEntryListing => ({ path, mode, type: "blob", sha: blob(id) });
const REPO = { name: "svc", url: "https://github.com/acme/svc.git" };
const BASE = `sha256:${"b".repeat(64)}`;

function host(entries: readonly TreeEntryListing[], over: { truncated?: boolean; texts?: Record<string, string>; list?: () => Promise<undefined> } = {}) {
  const listTree = vi.fn(async () => (over.list === undefined ? { truncated: over.truncated === true, entries } : over.list()));
  const readText = vi.fn(async (_repository: unknown, _commit: string, path: string) => over.texts?.[path]);
  return { listTree, readText } satisfies KeyHost;
}
const request = (over: Partial<Parameters<typeof expectedEnvironmentKey>[1]> = {}): Parameters<typeof expectedEnvironmentKey>[1] => ({
  orgId: "org_aaaaaaaaaaaaaaaaaaaa", repositories: [REPO], commits: new Map([["svc", "d".repeat(40)]]), detectorGlobs: [], testEnvRevision: 3, secretNames: ["NPM_TOKEN"], baseImageDigest: BASE, ...over,
});
const TREE: TreeEntryListing[] = [{ path: "src", mode: "040000", type: "tree", sha: blob("9") }, file("package.json", "1"), file("package-lock.json", "2"), file("src/index.ts", "3"), file("README.md", "4")];

describe("the key", () => {

  it("is no key when the listing is cut, missing, unreadable or the host throws", async () => {
    expect(await expectedEnvironmentKey(host(TREE, { truncated: true }), request())).toBeUndefined();
    expect(await expectedEnvironmentKey(host(TREE, { list: async () => undefined }), request())).toBeUndefined();
    expect(await expectedEnvironmentKey({ listTree: async () => { throw new Error("down"); }, readText: async () => undefined }, request())).toBeUndefined();
  });

  it("is no key when a key file is a link or a submodule, or a key file is not a file", async () => {
    expect(await expectedEnvironmentKey(host([...TREE.filter((entry) => entry.path !== "package.json"), file("package.json", "1", "120000")]), request())).toBeUndefined();
    expect(await expectedEnvironmentKey(host([...TREE.filter((entry) => entry.path !== "package.json"), { path: "package.json", mode: "160000", type: "commit", sha: blob("1") }]), request())).toBeUndefined();
    // an executable file is a file
    expect(await expectedEnvironmentKey(host([...TREE.filter((entry) => entry.path !== "package.json"), file("package.json", "1", "100755")]), request())).toBeDefined();
  });

  it("is no key for more key files than a key holds, for commits that are not the repositories, and for no repository", async () => {
    const many = Array.from({ length: SAVED_ENV_MAX_KEY_FILES + 1 }, (_, index) => file(`p${String(index)}/package.json`, String(index + 1)));
    expect(await expectedEnvironmentKey(host(many), request())).toBeUndefined();
    expect(await expectedEnvironmentKey(host(TREE), request({ commits: new Map() }))).toBeUndefined();
    expect(await expectedEnvironmentKey(host(TREE), request({ commits: new Map([["svc", "d".repeat(40)], ["other", "e".repeat(40)]]) }))).toBeUndefined();
    expect(await expectedEnvironmentKey(host(TREE), request({ repositories: [] }))).toBeUndefined();
    // the right number of commits, for another repository
    expect(await expectedEnvironmentKey(host(TREE), request({ commits: new Map([["other", "d".repeat(40)]]) }))).toBeUndefined();
  });

});

describe("the cache", () => {
  it("is per company: one company never gets a hit from another company's listing of the same repository and commit", async () => {
    const cache = new KeyListingCache();
    const mine = host(TREE);
    const theirs = host([...TREE, file("pyproject.toml", "6")]);
    const keyA = await expectedEnvironmentKey(mine, request({ orgId: "org_aaaaaaaaaaaaaaaaaaaa" }), cache);
    const keyB = await expectedEnvironmentKey(theirs, request({ orgId: "org_bbbbbbbbbbbbbbbbbbbb" }), cache);
    expect(theirs.listTree).toHaveBeenCalledTimes(1);
    expect(keyB).not.toBe(keyA);
    // the same company again is a hit, for the listing and for the text
    await expectedEnvironmentKey(mine, request({ orgId: "org_aaaaaaaaaaaaaaaaaaaa" }), cache);
    expect(mine.listTree).toHaveBeenCalledTimes(1);
    const tree = [...TREE, file(".devcontainer/devcontainer.json", "a")];
    const texts = { ".devcontainer/devcontainer.json": '{ "build": { "dockerfile": "x" } }' };
    const a = host(tree, { texts }); const b = host(tree, { texts });
    const other = { commits: new Map([["svc", "e".repeat(40)]]) };
    await expectedEnvironmentKey(a, request({ orgId: "org_aaaaaaaaaaaaaaaaaaaa", ...other }), cache);
    await expectedEnvironmentKey(b, request({ orgId: "org_bbbbbbbbbbbbbbbbbbbb", ...other }), cache);
    expect(a.readText).toHaveBeenCalledTimes(1);
    expect(b.readText).toHaveBeenCalledTimes(1);
  });

  it("keeps a bounded number of listings, and asks again for a text that was not read", async () => {
    const cache = new KeyListingCache(2);
    const h = host(TREE);
    for (const commit of ["1", "2", "3"]) await expectedEnvironmentKey(h, request({ commits: new Map([["svc", commit.repeat(40)]]) }), cache);
    await expectedEnvironmentKey(h, request({ commits: new Map([["svc", "1".repeat(40)]]) }), cache);
    expect(h.listTree).toHaveBeenCalledTimes(4);
    const tree = [...TREE, file(".devcontainer/devcontainer.json", "a")];
    const unreadable = host(tree);
    await expectedEnvironmentKey(unreadable, request(), new KeyListingCache());
    const shared = new KeyListingCache();
    await expectedEnvironmentKey(unreadable, request(), shared);
    await expectedEnvironmentKey(unreadable, request(), shared);
    expect(unreadable.readText).toHaveBeenCalledTimes(3);
  });
});
