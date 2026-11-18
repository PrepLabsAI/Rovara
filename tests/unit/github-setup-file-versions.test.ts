// L4-DR (DEC 254z c): the GitHub adapter's `setupFileVersions`: the watched files of one tree read, each with the host's object id (never content). It reads through the same company-bound tree read as
// `instructionFiles`, says plainly when the tree was cut, and throws (never answers an empty list) when GitHub cannot answer.
import { describe, expect, it } from "vitest";
import { agentXError, isSetupWatchedPath } from "@agentx/contracts";
import { githubCodeHost } from "../../packages/broker/src/plugins/code-host/github/index.js";
import { setupFileList, type IndexedTree } from "../../packages/broker/src/plugins/code-host/github/file-details.js";
import type { GitHubCodeHostProvider } from "../../packages/broker/src/plugins/code-host/github/provider.js";

const URL_ = "https://github.com/acme/app";
const REVISION = "a".repeat(40);
const scope = { orgId: "org_aaaaaaaaaaaaaaaaaaaa" } as never;
const sha = (n: number): string => n.toString(16).padStart(40, "0");
const entry = (path: string, n: number, mode = "100644", type = "blob") => ({ path, mode, type, sha: sha(n) });

function hostOver(entries: Array<ReturnType<typeof entry>>, options: { truncated?: boolean; fail?: boolean } = {}) {
  const reads: string[] = [];
  const provider = {
    listTreeAtCommit: async (_url: string, commit: string) => {
      reads.push(commit);
      if (options.fail === true) throw agentXError("RUNTIME_UNAVAILABLE", "GitHub could not be reached");
      return { truncated: options.truncated === true, entries };
    },
    checkRepository: async () => undefined,
  } as unknown as GitHubCodeHostProvider;
  return { host: githubCodeHost(provider, { credentialRef: "github" }), reads };
}
const match = (path: string): boolean => isSetupWatchedPath(path);

describe("setupFileVersions on the GitHub adapter", () => {
  it("lists the watched files with their object ids, sorted, and nothing else", async () => {
    const { host } = hostOver([
      entry("src/index.ts", 1), entry("package.json", 2), entry("services", 3, "040000", "tree"), entry("services/api/Dockerfile", 4), entry("package-lock.json", 5), entry("vendor/x/package.json", 6),
      entry("docker-compose.yml", 7, "120000"), entry("module", 8, "160000", "commit"),
    ]);
    const read = await host.setupFileVersions!({ url: URL_ }, REVISION, scope, { match, max: 50 });
    expect(read).toEqual({
      complete: true,
      files: [{ path: "docker-compose.yml", id: sha(7) }, { path: "package-lock.json", id: sha(5) }, { path: "package.json", id: sha(2) }, { path: "services/api/Dockerfile", id: sha(4) }],
    });
  });

  it("says the list is not whole when GitHub cut the tree, and when more files matched than the limit", async () => {
    const cut = hostOver([entry("package.json", 1)], { truncated: true });
    expect(await cut.host.setupFileVersions!({ url: URL_ }, REVISION, scope, { match, max: 10 })).toMatchObject({ complete: false });
    const many = hostOver([entry("a/package.json", 1), entry("b/package.json", 2), entry("c/package.json", 3)]);
    const read = await many.host.setupFileVersions!({ url: URL_ }, REVISION, scope, { match, max: 2 });
    expect(read.complete).toBe(false);
    expect(read.files).toHaveLength(2);
  });

  it("throws when GitHub cannot answer, a commit that is not a full id, and an object id that is not one", async () => {
    await expect(hostOver([], { fail: true }).host.setupFileVersions!({ url: URL_ }, REVISION, scope, { match, max: 5 })).rejects.toThrow();
    await expect(hostOver([entry("package.json", 1)]).host.setupFileVersions!({ url: URL_ }, "main", scope, { match, max: 5 })).rejects.toThrow();
    await expect(hostOver([{ path: "package.json", mode: "100644", type: "blob", sha: "xyz" }]).host.setupFileVersions!({ url: URL_ }, REVISION, scope, { match, max: 5 })).rejects.toThrow();
    await expect(hostOver([entry("package.json", 1)]).host.setupFileVersions!({ url: URL_ }, REVISION, scope, { match, max: -1 })).rejects.toThrow();
  });

  it("an entry of an unknown kind at a watched path is refused, never listed as an ordinary file", () => {
    const tree: IndexedTree = { truncated: false, entries: new Map([["package.json", entry("package.json", 1, "100600")]]) };
    expect(() => setupFileList(tree, { match, max: 5 })).toThrow();
  });
});
