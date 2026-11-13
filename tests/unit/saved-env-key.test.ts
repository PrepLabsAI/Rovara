// Saved project images (SV wiring): the environment key the broker works out from the code host's tree listing. It must move when a key file, the revision, the secret names, the base image or the detector globs
// move, stay put for any other file, and give NO key (never a key over fewer files) when the listing is cut, a key file is a link or a submodule, or a dev container file cannot be read.
import { describe, expect, it, vi } from "vitest";
import { SAVED_ENV_MAX_KEY_FILES, blobKeyHash, computeEnvironmentKey } from "@rovara-code/contracts";
import { KeyListingCache, expectedEnvironmentKey, type KeyHost, type TreeEntryListing } from "../../packages/core/src/core/test-env/saved-env-key.js";

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
  it("is the contracts' key over the key files' blob ids, and ignores trees and files that are no key files", async () => {
    const key = await expectedEnvironmentKey(host(TREE), request());
    expect(key).toBe(computeEnvironmentKey({
      keyFiles: [{ repositoryId: "svc", path: "package-lock.json", sha256: blobKeyHash(blob("2")) }, { repositoryId: "svc", path: "package.json", sha256: blobKeyHash(blob("1")) }],
      testEnvRevision: 3, secretNames: ["NPM_TOKEN"], baseImageDigest: BASE,
    }));
  });

  it("moves with a key file, the revision, the secret names, the base image and the detector globs, and with nothing else", async () => {
    const base = await expectedEnvironmentKey(host(TREE), request());
    const changed = async (entries: TreeEntryListing[], over: Partial<Parameters<typeof expectedEnvironmentKey>[1]> = {}) => expectedEnvironmentKey(host(entries), request(over));
    expect(await changed(TREE.map((entry) => (entry.path === "package-lock.json" ? file("package-lock.json", "7") : entry)))).not.toBe(base);
    expect(await changed(TREE.map((entry) => (entry.path === "src/index.ts" ? file("src/index.ts", "8") : entry)))).toBe(base);
    expect(await changed([...TREE, file("docs/guide.md", "5")])).toBe(base);
    expect(await changed([...TREE, file("pyproject.toml", "6")])).not.toBe(base);
    expect(await changed(TREE, { testEnvRevision: 4 })).not.toBe(base);
    expect(await changed(TREE, { secretNames: ["NPM_TOKEN", "DB_URL"] })).not.toBe(base);
    expect(await changed(TREE, { secretNames: ["NPM_TOKEN", "NPM_TOKEN"] })).toBe(base);
    expect(await changed(TREE, { baseImageDigest: `sha256:${"c".repeat(64)}` })).not.toBe(base);
    expect(await changed(TREE, { detectorGlobs: ["src/**"] })).not.toBe(base);
    expect(await changed([...TREE].reverse())).toBe(base);
    // a directory that is named like a key file is no key file (the worker's `ls-tree -r` lists no trees)
    expect(await changed([...TREE, { path: "vendor/package.json", mode: "040000", type: "tree", sha: blob("9") }])).toBe(base);
  });

  it("includes the files a dev container file points at, read as text", async () => {
    const tree = [...TREE, file(".devcontainer/devcontainer.json", "a"), file(".devcontainer/Dockerfile", "b")];
    const texts = { ".devcontainer/devcontainer.json": '{ "build": { "dockerfile": "Dockerfile" } }' };
    const base = await expectedEnvironmentKey(host(tree, { texts }), request());
    expect(base).toBeDefined();
    expect(await expectedEnvironmentKey(host(tree.map((entry) => (entry.path === ".devcontainer/Dockerfile" ? file(".devcontainer/Dockerfile", "c") : entry)), { texts }), request())).not.toBe(base);
    // a dev container file that cannot be read, or points outside the repository, is no key
    expect(await expectedEnvironmentKey(host(tree), request())).toBeUndefined();
    expect(await expectedEnvironmentKey(host(tree, { texts: { ".devcontainer/devcontainer.json": '{ "build": { "dockerfile": "../../x" } }' } }), request())).toBeUndefined();
  });

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

  it("works several repositories into one key, in whatever order they come, each by its own name", async () => {
    const a = { name: "api", url: "https://github.com/acme/api.git" };
    const b = { name: "web", url: "https://github.com/acme/web.git" };
    const hostFor = (swap: boolean) => ({ listTree: async (repository: { name: string }) => ({ truncated: false, entries: repository.name === (swap ? "web" : "api") ? [file("package.json", "1")] : [file("package.json", "2")] }), readText: async () => undefined });
    const commits = new Map([["api", "1".repeat(40)], ["web", "2".repeat(40)]]);
    const one = await expectedEnvironmentKey(hostFor(false), request({ repositories: [a, b], commits }));
    expect(await expectedEnvironmentKey(hostFor(false), request({ repositories: [b, a], commits }))).toBe(one);
    expect(await expectedEnvironmentKey(hostFor(true), request({ repositories: [a, b], commits }))).not.toBe(one);
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

  it("lists a commit once, again for another commit, and never keeps a cut or failed listing", async () => {
    const cache = new KeyListingCache();
    const h = host(TREE);
    await expectedEnvironmentKey(h, request(), cache);
    await expectedEnvironmentKey(h, request({ secretNames: ["OTHER"] }), cache);
    expect(h.listTree).toHaveBeenCalledTimes(1);
    await expectedEnvironmentKey(h, request({ commits: new Map([["svc", "e".repeat(40)]]) }), cache);
    expect(h.listTree).toHaveBeenCalledTimes(2);
    const cut = host(TREE, { truncated: true });
    await expectedEnvironmentKey(cut, request({ commits: new Map([["svc", "a".repeat(40)]]) }), cache);
    await expectedEnvironmentKey(cut, request({ commits: new Map([["svc", "f".repeat(40)]]) }), cache);
    await expectedEnvironmentKey(cut, request({ commits: new Map([["svc", "f".repeat(40)]]) }), cache);
    expect(cut.listTree).toHaveBeenCalledTimes(3);
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
