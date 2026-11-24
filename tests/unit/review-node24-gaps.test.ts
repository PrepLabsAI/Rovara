// REVIEW-ADDED (uncommitted) tests for lane NODE24-PER-REPO. Gaps found by the reviewer; the first three FAIL on the current code or are vacuous in the lane's own tests.
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { boundedReader } from "../../packages/worker/src/env-detect/index.js";
import { detectNodeMajor } from "../../packages/worker/src/env-detect/node-version.js";
import { nodePathPrefixFor } from "../../packages/worker/src/node-runtime.js";

const reader = (files: Record<string, string>) => boundedReader(Object.keys(files), (path) => Promise.resolve(files[path])).reader;
const pick = (files: Record<string, string>) => detectNodeMajor(reader(files));

describe("review gaps", () => {
  it("Dockerfile: the Node 24 checksum is verified before the tarball is unpacked (the lane's own order assertion searches 'sha256sum -c - ' with a trailing space, never matches, so is vacuous)", () => {
    const text = readFileSync("environments/base/Dockerfile", "utf8");
    const check = text.search(/sha256sum -c -[;\s]*[^\n]*\n[^\n]*\n?[^\n]*mkdir -p \/opt\/rovara\/node\/24/u);
    const sum = text.indexOf('echo "$node_sha  /tmp/node24.tgz" | sha256sum -c -');
    const tar = text.indexOf("tar -xzf /tmp/node24.tgz");
    expect(sum).toBeGreaterThan(-1);
    expect(tar).toBeGreaterThan(-1);
    expect(sum).toBeLessThan(tar);
    expect(check).toBeGreaterThan(-1);
  });

  it("a directory outside the workspace that has its own .nvmrc 24 gets no prefix (the lane's outside-root test uses tmpdir(), which has no hint, so the guard is untested)", async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "agentx-n24rev-")));
    try {
      await mkdir(join(base, "work"), { recursive: true });
      await mkdir(join(base, "other"), { recursive: true });
      await writeFile(join(base, "other", ".nvmrc"), "24");
      expect(await nodePathPrefixFor(join(base, "work"), join(base, "other"), "/B")).toEqual([]);
    } finally { await rm(base, { recursive: true, force: true }); }
  });

  it("CRLF .nvmrc with a comment line or a trailing comment still reads (JS `.` stops at \\r, so `#.*$` does not strip it)", async () => {
    expect((await pick({ ".nvmrc": "# node\r\n24\r\n" })).major).toBe(24);
    expect((await pick({ ".nvmrc": "24 # lts\r\n" })).major).toBe(24);
    expect((await pick({ ".node-version": "# x\r\n22\r\n" })).notes).toEqual([]);
  });

  it("a note never quotes repo text beyond version characters (the quoted-spec comment says so, but a `-` or `+` tail is accepted by partial())", async () => {
    const choice = await pick({ "package.json": JSON.stringify({ engines: { node: ">=26.0.0-<img/src=x/onerror=alert(1)>" } }) });
    expect(choice.notes.join(" ")).not.toMatch(/[<>"]{1}.*img|onerror/u);
  });
});
