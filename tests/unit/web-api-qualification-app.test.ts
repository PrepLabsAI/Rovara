import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { webApiQualificationAppTreeDigest } from "../../packages/contracts/src/index.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe("the installed qualification app", () => {

  it("digests the tree independently of the order the files are listed in", () => {
    const files = [{ path: "b.txt", sha256: "1".repeat(64) }, { path: "a/c.txt", sha256: "2".repeat(64) }];
    expect(webApiQualificationAppTreeDigest(files)).toBe(webApiQualificationAppTreeDigest([...files].reverse()));
    expect(webApiQualificationAppTreeDigest(files)).not.toBe(webApiQualificationAppTreeDigest([files[0]!, { ...files[1]!, path: "a/d.txt" }]));
  });
});
