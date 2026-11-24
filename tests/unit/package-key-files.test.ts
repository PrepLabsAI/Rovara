// Lane P5a (D4.1): the file side of the static check reads only a repository's own config files, refuses links, and never returns a token value.
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PACKAGE_KEY_FILE_MAX_BYTES, detectRepositoryPackageKeys, readPackageKeyFiles } from "../../packages/worker/src/package-key-files.js";

const GH = "npm.pkg.github.com";
const FAKE_TOKEN = ["ghp", "_", "Z".repeat(36)].join("");
const roots: string[] = [];
const repository = async (files: Record<string, string>): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "package-key-files-"));
  roots.push(root);
  for (const [name, text] of Object.entries(files)) await writeFile(join(root, name), text);
  return root;
};
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("detectRepositoryPackageKeys", () => {
  it("a GitHub Packages scope and no company token: untested, found from the working copy, with the committed token reported without its value", async () => {
    const repositoryRoot = await repository({ ".npmrc": `@acme:registry=https://${GH}\n//${GH}/:_authToken=${FAKE_TOKEN}\n`, "package.json": "{}" });
    const result = await detectRepositoryPackageKeys({ repositoryRoot, repo: "web", hasCompanyToken: () => false });
    expect(result.untested).toMatchObject({ detail: "missing", registryHost: GH, scopes: ["@acme"] });
    expect(result.committedTokens).toEqual([{ file: ".npmrc", line: 2, host: GH }]);
    expect(JSON.stringify(result)).not.toContain(FAKE_TOKEN);
  });

  it("reads nothing else: package.json and source files are not read", async () => {
    const files = await readPackageKeyFiles(await repository({ "package.json": "{}", "index.js": "x", "yarn.lock": "", ".npmrc": "" }));
    expect(files.map((file) => file.path).sort()).toEqual([".npmrc", "yarn.lock"]);
  });

  it("a link is never followed, and an oversized config or a directory of that name is skipped", async () => {
    const root = await repository({ ".npmrc": "x".repeat(PACKAGE_KEY_FILE_MAX_BYTES.config + 1) });
    const outside = await repository({ secret: `@acme:registry=https://${GH}` });
    await symlink(join(outside, "secret"), join(root, ".yarnrc.yml"));
    await mkdir(join(root, "yarn.lock"));
    expect(await readPackageKeyFiles(root)).toEqual([]);
  });

  it("an empty repository has no findings", async () => {
    expect(await detectRepositoryPackageKeys({ repositoryRoot: await repository({}), repo: "web", hasCompanyToken: () => false })).toEqual({ repo: "web", registries: [], committedTokens: [] });
  });

  it("a missing directory is not an error", async () => {
    expect(await readPackageKeyFiles(join(tmpdir(), "package-key-files-does-not-exist"))).toEqual([]);
  });
});
