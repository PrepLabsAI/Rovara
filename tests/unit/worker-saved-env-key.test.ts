// Setup and test health SH21: the environment key from a project's repository files (lockfile change changes the key; an unrelated file does not).
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashWorkspaceFile, keyFilePaths, stripJsonComments } from "../../packages/worker/src/saved-env/key.js";

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");


describe("which files are key files", () => {
  it("takes lockfiles, build files, toolchain files and dev container files, and nothing else", () => {
    const paths = ["package.json", "package-lock.json", "src/index.js", "README.md", ".nvmrc", ".devcontainer/devcontainer.json", ".devcontainer/Dockerfile", "docs/guide.md", "go.sum", "Cargo.lock"];
    expect(keyFilePaths(paths, [])).toEqual([".devcontainer/Dockerfile", ".devcontainer/devcontainer.json", ".nvmrc", "Cargo.lock", "go.sum", "package-lock.json", "package.json"]);
  });

});

describe("fix round 1: more key files, anchored exclusions, dev container references", () => {

  it("strips comments and trailing commas outside strings only", () => {
    expect(JSON.parse(stripJsonComments('{ "a": "http://x // not a comment", /* c */ "b": [1, 2,], // end\n}'))).toEqual({ a: "http://x // not a comment", b: [1, 2] });
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

});
