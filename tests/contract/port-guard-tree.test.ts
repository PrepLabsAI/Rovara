import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { awsImportFindings, boundary, cloudPathRule, importFindings, isCodeFile, strayFileRule } from "../../scripts/port-guard.js";

// Decision 41 (the Cloud line) and decision 42a (the port): the public tree never holds Cloud-only code and never imports it.
// scripts/port-guard.ts checks a lane's range; this checks the whole tree, so code that got in some other way fails here.

const tracked = spawnSync("git", ["ls-files", "-z"], { encoding: "utf8", maxBuffer: 1 << 28 })
  .stdout.split("\0")
  .filter((path) => path !== "");

describe("the repository tree has nothing Cloud-only (decision 41)", () => {
  it("lists the tree", () => {
    expect(tracked.length).toBeGreaterThan(100);
  });

  it("holds no Cloud-only path and no internal build-system detector", () => {
    const hits = tracked.flatMap((path) => {
      const hit = cloudPathRule(path);
      return hit === null ? [] : [`${path}: ${hit.detail}`];
    });
    expect(hits).toEqual([]);
  });

  it("holds no stray editor, merge or sed leftover (*-E, *.orig, *.rej, *.bak, *~, .DS_Store)", () => {
    const hits = tracked.flatMap((path) => {
      const hit = strayFileRule(path);
      return hit === null ? [] : [`${path}: ${hit.detail}`];
    });
    expect(hits).toEqual([]);
  });

  it("imports no Cloud-only path or package from any TypeScript or JavaScript file", () => {
    const hits: string[] = [];
    for (const path of tracked) {
      if (!isCodeFile(path)) continue;
      let source: string;
      try {
        source = readFileSync(path, "utf8");
      } catch {
        continue; // a tracked file that is not on disk (a deleted-but-unstaged one) has nothing to read
      }
      for (const finding of importFindings(path, source)) hits.push(`${path}:${finding.line}: ${finding.detail}`);
    }
    expect(hits).toEqual([]);
  });

  // Decision 72 (O2): the four generic AWS adapters are the only AWS code that may be public, in one package. Cloud's boundary check reads the same
  // data file, so this keeps the two in step: the data names four adapters, and nothing in the adapters package (if it exists yet) is anything else.
  it("keeps the AWS adapters package to the four generic adapters and their SDK clients", () => {
    const data = boundary();
    expect(data.publicAwsAdapters.adapters.map((adapter) => adapter.id).sort()).toEqual(["dynamodb", "s3", "secrets-manager", "sqs"]);
    const dir = `${data.publicAwsAdapters.dir}/`;
    const hits: string[] = [];
    for (const path of tracked) {
      if (!path.startsWith(dir) || !isCodeFile(path)) continue;
      let source: string;
      try {
        source = readFileSync(path, "utf8");
      } catch {
        continue;
      }
      for (const finding of awsImportFindings(path, source, false)) hits.push(`${path}:${finding.line}: ${finding.detail}`);
    }
    expect(hits).toEqual([]);
  });
});
