// Setup and test health SH21: the environment key from a project's repository files (lockfile change changes the key; an unrelated file does not).
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SAVED_ENV_MAX_KEY_FILES } from "@agentx/contracts";
import { boundedReader, runDetectors } from "../../packages/worker/src/env-detect/index.js";
import {
  environmentKeyFromRepositories, hashWorkspaceFile, keyFilePaths, stripJsonComments, type KeyRepository,
} from "../../packages/worker/src/saved-env/key.js";

const DIGEST = `sha256:${"a".repeat(64)}`;
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
type Files = Record<string, string>;
const repo = (repositoryId: string, files: Files, unreadable: readonly string[] = []): KeyRepository => ({
  repositoryId,
  paths: Object.keys(files),
  readText: (file) => Promise.resolve(unreadable.includes(file) ? undefined : files[file]),
  hashFile: (file) => Promise.resolve(unreadable.includes(file) || files[file] === undefined ? undefined : sha(files[file])),
});
async function keyOf(files: Files, options: { globs?: readonly string[]; secretNames?: string[]; revision?: number; unreadable?: string[] } = {}) {
  return environmentKeyFromRepositories({
    repositories: [repo("svc", files, options.unreadable)], detectorGlobs: options.globs ?? [], testEnvRevision: options.revision ?? 1, secretNames: options.secretNames ?? [], baseImageDigest: DIGEST,
  });
}
const keyString = async (files: Files, options?: Parameters<typeof keyOf>[1]): Promise<string> => {
  const result = await keyOf(files, options);
  if (!result.ok) throw new Error(result.reason);
  return result.key;
};

const omit = (files: Files, name: string): Files => Object.fromEntries(Object.entries(files).filter(([key]) => key !== name));
const NODE: Files = {
  "package.json": '{"name":"a","dependencies":{"left-pad":"1.0.0"}}',
  "package-lock.json": '{"lockfileVersion":3}',
  "src/index.js": "console.log(1)\n",
  "README.md": "# hello\n",
};

describe("which files are key files", () => {
  it("takes lockfiles, build files, toolchain files and dev container files, and nothing else", () => {
    const paths = ["package.json", "package-lock.json", "src/index.js", "README.md", ".nvmrc", ".devcontainer/devcontainer.json", ".devcontainer/Dockerfile", "docs/guide.md", "go.sum", "Cargo.lock"];
    expect(keyFilePaths(paths, [])).toEqual([".devcontainer/Dockerfile", ".devcontainer/devcontainer.json", ".nvmrc", "Cargo.lock", "go.sum", "package-lock.json", "package.json"]);
  });

  it("adds the files a detector's globs name", () => {
    expect(keyFilePaths(["tools/special.cfg", "a.txt"], [])).toEqual([]);
    expect(keyFilePaths(["tools/special.cfg", "a.txt"], ["tools/*.cfg"])).toEqual(["tools/special.cfg"]);
  });

  it("finds a manifest in a nested directory, but never inside installed dependencies, virtual environments, CI configuration or test data", () => {
    const paths = ["services/api/package.json", "node_modules/left-pad/package.json", "web/node_modules/x/package.json", ".venv/lib/site-packages/x/pyproject.toml", ".github/workflows/ci.yml", "pkg/testdata/go.mod", ".git/config"];
    expect(keyFilePaths(paths, ["**/testdata/**", ".github/**", "**"])).toEqual(["services/api/package.json"]);
  });

  it("drops an over-long glob instead of matching with it", () => {
    expect(keyFilePaths(["a.txt"], ["a".repeat(300)])).toEqual([]);
  });
});

describe("fix round 1: more key files, anchored exclusions, dev container references", () => {
  it("counts requirements directories, Yarn releases, patches and the pnpm file", () => {
    const paths = ["requirements/base.txt", "requirements/dev/extra.txt", ".yarn/releases/yarn-4.1.0.cjs", "patches/left-pad+1.0.0.patch", ".pnpmfile.cjs", "src/main.py", "docs/requirements-notes.md"];
    expect(keyFilePaths(paths, [])).toEqual([".pnpmfile.cjs", ".yarn/releases/yarn-4.1.0.cjs", "patches/left-pad+1.0.0.patch", "requirements/base.txt", "requirements/dev/extra.txt"]);
  });

  it("counts pip-tools inputs and constraints files, in any directory", async () => {
    const paths = ["requirements.in", "requirements-dev.in", "svc/requirements-test.in", "constraints.txt", "svc/constraints-3.12.txt", "svc/src/constraints.py", "docs/requirements.md"];
    expect(keyFilePaths(paths, [])).toEqual(["constraints.txt", "requirements-dev.in", "requirements.in", "svc/constraints-3.12.txt", "svc/requirements-test.in"]);
    const files: Files = { "svc/requirements.in": "a", "svc/constraints-3.12.txt": "b" };
    const before = await keyString(files);
    for (const name of Object.keys(files)) expect(await keyString({ ...files, [name]: "changed" }), name).not.toBe(before);
  });

  it("counts those directories at any depth, so a workspace package's files change the key", async () => {
    const paths = ["svc/requirements/base.txt", "web/.yarn/releases/yarn-4.cjs", "web/patches/a.patch", "svc/docs/patches-notes.md", "svc/src/requirements.py"];
    expect(keyFilePaths(paths, [])).toEqual(["svc/requirements/base.txt", "web/.yarn/releases/yarn-4.cjs", "web/patches/a.patch"]);
    const files: Files = { "package.json": "{}", "svc/requirements/base.txt": "a", "web/.yarn/releases/yarn-4.cjs": "b", "web/patches/a.patch": "c" };
    const before = await keyString(files);
    for (const name of ["svc/requirements/base.txt", "web/.yarn/releases/yarn-4.cjs", "web/patches/a.patch"]) expect(await keyString({ ...files, [name]: "changed" }), name).not.toBe(before);
  });

  it("excludes target and vendor only beside the build file that makes them", () => {
    // Counted: no build file beside the directory.
    expect(keyFilePaths(["vendor/left-pad/package.json", "services/target/pom.xml", "target/package.json"], [])).toEqual(["services/target/pom.xml", "target/package.json", "vendor/left-pad/package.json"]);
    // Excluded: beside a pom.xml / Cargo.toml / go.mod / composer.json / Gemfile.
    expect(keyFilePaths(["pom.xml", "target/classes/pom.xml", "svc/Cargo.toml", "svc/target/debug/package.json", "go.mod", "vendor/x/package.json", "ruby/Gemfile", "ruby/vendor/bundle/Gemfile"], [])).toEqual(["go.mod", "pom.xml", "ruby/Gemfile", "svc/Cargo.toml"]);
  });

  it("changes the key when a vendored package manifest or a nested target pom changes", async () => {
    const files: Files = { "package.json": "{}", "vendor/left-pad/package.json": '{"v":1}', "services/target/pom.xml": "<a/>" };
    const before = await keyString(files);
    expect(await keyString({ ...files, "vendor/left-pad/package.json": '{"v":2}' })).not.toBe(before);
    expect(await keyString({ ...files, "services/target/pom.xml": "<b/>" })).not.toBe(before);
    // With a go.mod beside vendor, the vendored copy is output and no longer keyed.
    const withGo: Files = { ...files, "go.mod": "module x", "vendor/left-pad/package.json": '{"v":1}' };
    expect(await keyString({ ...withGo, "vendor/left-pad/package.json": '{"v":3}' })).toBe(await keyString(withGo));
  });

  const DEVCONTAINER = '// the dev container\n{\n  "name": "svc", /* the image */\n  "build": { "dockerfile": "../Dockerfile", "context": ".." },\n}\n';

  it("keys the Dockerfile a dev container file references, even outside .devcontainer/", async () => {
    const files: Files = { ".devcontainer/devcontainer.json": DEVCONTAINER, Dockerfile: "FROM python:3.12\n", "src/app.py": "x" };
    expect(keyFilePaths(Object.keys(files), [])).not.toContain("Dockerfile");
    const before = await keyString(files);
    expect(await keyString({ ...files, Dockerfile: "FROM python:3.13\n" })).not.toBe(before);
    expect(await keyString({ ...files, "src/app.py": "y" })).toBe(before);
  });

  it("keys the older dockerFile property and compose files, relative to the dev container file", async () => {
    const files: Files = {
      "tools/.devcontainer.json": '{ "dockerFile": "images/Dockerfile.dev", "dockerComposeFile": ["../compose.yaml", "compose.override.yaml"] }',
      "tools/images/Dockerfile.dev": "FROM a", "compose.yaml": "services: {}", "tools/compose.override.yaml": "services: {}",
    };
    const before = await keyString(files);
    for (const name of ["tools/images/Dockerfile.dev", "compose.yaml", "tools/compose.override.yaml"]) expect(await keyString({ ...files, [name]: "changed" }), name).not.toBe(before);
  });

  it("gives no key when the dev container file cannot be read or parsed, or names a file that is missing, absolute or outside the repository", async () => {
    const base = (json: string): Files => ({ ".devcontainer/devcontainer.json": json, Dockerfile: "FROM a" });
    expect(await keyOf(base(DEVCONTAINER), { unreadable: [".devcontainer/devcontainer.json"] })).toEqual({ ok: false, reason: "key_file_unreadable" });
    for (const json of ["{ not json", "[]", '{"build":{"dockerfile":"../Missing"}}', '{"build":{"dockerfile":"/etc/passwd"}}', '{"build":{"dockerfile":"../../Dockerfile"}}', '{"dockerFile":7}']) {
      expect(await keyOf(base(json)), json).toEqual({ ok: false, reason: "key_file_unreadable" });
    }
    expect((await keyOf(base('{"image":"mcr.microsoft.com/devcontainers/python:3.12"}'))).ok).toBe(true);
  });

  it("strips comments and trailing commas outside strings only", () => {
    expect(JSON.parse(stripJsonComments('{ "a": "http://x // not a comment", /* c */ "b": [1, 2,], // end\n}'))).toEqual({ a: "http://x // not a comment", b: [1, 2] });
  });
});

describe("the environment key from files", () => {
  it("changes when a lockfile changes", async () => {
    const before = await keyString(NODE);
    const after = await keyString({ ...NODE, "package-lock.json": '{"lockfileVersion":3,"packages":{"x":{}}}' });
    expect(after).not.toBe(before);
  });

  it("does not change when an unrelated file changes, is added or is removed", async () => {
    const before = await keyString(NODE);
    expect(await keyString({ ...NODE, "src/index.js": "console.log(2)\n" })).toBe(before);
    expect(await keyString({ ...NODE, "src/new.js": "x" })).toBe(before);
    expect(await keyString(omit(NODE, "README.md"))).toBe(before);
  });

  it("changes when a key file appears or disappears", async () => {
    const before = await keyString(NODE);
    expect(await keyString({ ...NODE, "yarn.lock": "# yarn" })).not.toBe(before);
    expect(await keyString(omit(NODE, "package-lock.json"))).not.toBe(before);
  });

  it("does not depend on the order paths are listed in", async () => {
    const shuffled = Object.fromEntries(Object.entries(NODE).reverse());
    expect(await keyString(shuffled)).toBe(await keyString(NODE));
  });

  it("changes with the revision, the secret names and the base image, and ignores the order of secret names", async () => {
    const key = await keyString(NODE, { secretNames: ["A", "B"], revision: 2 });
    expect(await keyString(NODE, { secretNames: ["B", "A"], revision: 2 })).toBe(key);
    expect(await keyString(NODE, { secretNames: ["A", "B"], revision: 3 })).not.toBe(key);
    expect(await keyString(NODE, { secretNames: ["A"], revision: 2 })).not.toBe(key);
    const other = await environmentKeyFromRepositories({ repositories: [repo("svc", NODE)], detectorGlobs: [], testEnvRevision: 2, secretNames: ["A", "B"], baseImageDigest: `sha256:${"b".repeat(64)}` });
    expect(other.ok && other.key).not.toBe(key);
  });

  it("counts the same path in two repositories separately", async () => {
    const both = await environmentKeyFromRepositories({ repositories: [repo("one", { "package.json": "1" }), repo("two", { "package.json": "2" })], detectorGlobs: [], testEnvRevision: 1, secretNames: [], baseImageDigest: DIGEST });
    const swapped = await environmentKeyFromRepositories({ repositories: [repo("one", { "package.json": "2" }), repo("two", { "package.json": "1" })], detectorGlobs: [], testEnvRevision: 1, secretNames: [], baseImageDigest: DIGEST });
    expect(both.ok && swapped.ok).toBe(true);
    expect(both.ok && swapped.ok && both.key !== swapped.key).toBe(true);
  });

  it("gives no key when a key file cannot be hashed (it never keys over fewer files)", async () => {
    expect(await keyOf(NODE, { unreadable: ["package-lock.json"] })).toEqual({ ok: false, reason: "key_file_unreadable" });
  });

  it("gives no key when a hasher throws", async () => {
    const throwing: KeyRepository = { repositoryId: "svc", paths: ["package.json"], readText: () => Promise.resolve(undefined), hashFile: () => Promise.reject(new Error("disk")) };
    expect(await environmentKeyFromRepositories({ repositories: [throwing], detectorGlobs: [], testEnvRevision: 1, secretNames: [], baseImageDigest: DIGEST })).toEqual({ ok: false, reason: "key_file_unreadable" });
  });

  it("gives no key over more key files than a key holds", async () => {
    const files = Object.fromEntries(Array.from({ length: SAVED_ENV_MAX_KEY_FILES + 1 }, (_, index) => [`d${String(index)}/package.json`, "x"]));
    expect(await keyOf(files)).toEqual({ ok: false, reason: "too_many_key_files" });
  });

  it("reports an invalid input (a bad revision) as a reason, not a crash", async () => {
    expect(await keyOf(NODE, { revision: 0 })).toEqual({ ok: false, reason: "invalid_input" });
  });

  it("uses the lists the detectors build (a nested Maven module's pom changes the key)", async () => {
    const files: Files = { "pom.xml": "<project><modules><module>a</module></modules></project>", "a/pom.xml": "<project>1</project>", "a/src/Main.java": "class Main {}" };
    const bounded = boundedReader(Object.keys(files), (file) => Promise.resolve(files[file]));
    const detection = await runDetectors(bounded.reader, "svc");
    const globs = detection.fullSuiteOn.map((item) => item.value);
    expect(globs.length).toBeGreaterThan(0);
    const before = await keyString(files, { globs });
    expect(await keyString({ ...files, "a/pom.xml": "<project>2</project>" }, { globs })).not.toBe(before);
    expect(await keyString({ ...files, "a/src/Main.java": "class Main { int x; }" }, { globs })).toBe(before);
  });
});

describe("hashing a file in a checkout", () => {
  const made: string[] = [];
  afterEach(async () => { await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
  async function checkout(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "saved-env-key-"));
    made.push(dir);
    return dir;
  }

  it("hashes the bytes of a regular file, even one over the detectors' read limit", async () => {
    const root = await checkout();
    await mkdir(path.join(root, "sub"));
    const big = "x".repeat(300 * 1_024);
    await writeFile(path.join(root, "sub", "package-lock.json"), big);
    expect(await hashWorkspaceFile(root, "sub/package-lock.json")).toBe(sha(big));
  });

  it("refuses a missing file, a directory, an escaping path and an absolute path", async () => {
    const root = await checkout();
    await mkdir(path.join(root, "dir"));
    expect(await hashWorkspaceFile(root, "nope.txt")).toBeUndefined();
    expect(await hashWorkspaceFile(root, "dir")).toBeUndefined();
    expect(await hashWorkspaceFile(root, "../x")).toBeUndefined();
    expect(await hashWorkspaceFile(root, "/etc/hosts")).toBeUndefined();
    expect(await hashWorkspaceFile(root, "a//b")).toBeUndefined();
  });

  it("refuses a symbolic link as the file and as a directory above it", async () => {
    const root = await checkout();
    const outside = await checkout();
    await writeFile(path.join(outside, "secret.txt"), "outside");
    await symlink(path.join(outside, "secret.txt"), path.join(root, "package.json"));
    await symlink(outside, path.join(root, "linked"));
    expect(await hashWorkspaceFile(root, "package.json")).toBeUndefined();
    expect(await hashWorkspaceFile(root, "linked/secret.txt")).toBeUndefined();
  });
});
