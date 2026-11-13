import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { maskSpecifiers, nameSourceFromWords, runGuard, type AcceptedFinding, type Finding } from "../../scripts/port-guard.js";

// The guard follows renames: a file git sees as moved is judged as the file it was (so a package or folder move does not bring back every finding Code
// already accepted), while real new content in a moved file, a new file, and a move into a Cloud-only place are judged as before. The names are invented.

const INVENTED = nameSourceFromWords("test-salt", { "a prospect or customer name": ["zorblaxcorp"] }, [], [], []);
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

const OLD = "packages/old/src/aws/handler.ts";
const NEW = "packages/core/src/aws/handler.ts";
/** A file with enough lines that a few changed ones still leave git sure it is a move. */
const BODY = (header: string, contracts: string, relative: string): string =>
  [
    `// ${header}`,
    `import { createHash } from "node:crypto";`,
    `import { Schema, agentXError } from "${contracts}";`,
    `import { helper } from "${relative}";`,
    ...Array.from({ length: 30 }, (_, index) => `export function handler${index}(input: string): string { return helper(createHash("sha256").update(input + ${index}).digest("hex")); }`),
    "",
  ].join("\n");
const ORIGINAL = BODY(OLD, "@agentx/contracts", "../util.js");
const REWRITTEN = BODY(NEW, "@rovara-code/contracts", "../../../old/src/util.js");

class Lane {
  readonly dir = mkdtempSync(join(tmpdir(), "port-guard-moves-"));
  constructor() {
    roots.push(this.dir);
    git(this.dir, "init", "-q", "-b", "code-next");
    this.write("README.md", "base\n");
    this.write(OLD, ORIGINAL);
    this.write("packages/old/src/util.ts", "export const helper = (text: string): string => text;\n");
    git(this.dir, "add", "-A");
    git(this.dir, "commit", "-q", "-m", "base");
    git(this.dir, "branch", "base");
    git(this.dir, "switch", "-q", "-c", "lane");
  }
  write(path: string, text: string): void {
    mkdirSync(dirname(join(this.dir, path)), { recursive: true });
    writeFileSync(join(this.dir, path), text);
  }
  move(from: string, to: string): void {
    mkdirSync(dirname(join(this.dir, to)), { recursive: true });
    renameSync(join(this.dir, from), join(this.dir, to));
  }
  commit(): void {
    git(this.dir, "add", "-A");
    git(this.dir, "commit", "-q", "-m", "lane");
  }
  blob(rev: string, path: string): string {
    return git(this.dir, "rev-parse", `${rev}:${path}`).trim();
  }
  guard(accepted: readonly AcceptedFinding[] = []): Finding[] {
    return runGuard({ cwd: this.dir, range: "base..lane", gitleaks: "off", names: INVENTED, accepted }).findings;
  }
}

const describeFindings = (findings: Finding[]): string[] => findings.map((finding) => `${finding.rule} ${finding.file}${finding.line === null ? "" : `:${finding.line}`}`);
const accepted = (lane: Lane, path: string, rev = "base", rule: AcceptedFinding["rule"] = "cloud-aws"): AcceptedFinding => ({ path, rule, blob: lane.blob(rev, OLD), reason: "owner decision 2026-11-12: already public" });

describe("the guard follows renames", () => {
  it("passes a pure move of a file under an aws/ directory", () => {
    const lane = new Lane();
    lane.move(OLD, NEW);
    lane.commit();
    expect(lane.guard()).toEqual([]);
  });

  it("passes a move that only rewrites imports, package names and the own-path header", () => {
    const lane = new Lane();
    lane.move(OLD, NEW);
    lane.write(NEW, REWRITTEN);
    lane.commit();
    expect(lane.guard()).toEqual([]);
  });

  it("still fails a move that adds a private-name line", () => {
    const lane = new Lane();
    lane.move(OLD, NEW);
    lane.write(NEW, `${REWRITTEN}// built for zorblaxcorp\n`);
    lane.commit();
    const found = describeFindings(lane.guard());
    expect(found).toContain(`private-name ${NEW}:${REWRITTEN.split("\n").length}`);
  });

  it("does not report the lines a move leaves unchanged", () => {
    const lane = new Lane();
    // A name that the base file already held is not new content when the file is only moved.
    lane.write(OLD, `${ORIGINAL}// legacy note about zorblaxcorp\n`);
    git(lane.dir, "add", "-A");
    git(lane.dir, "commit", "-q", "-m", "base2");
    git(lane.dir, "branch", "-f", "base");
    lane.move(OLD, NEW);
    lane.commit();
    expect(lane.guard()).toEqual([]);
  });

  it("still fails a new file under a guarded directory", () => {
    const lane = new Lane();
    lane.write("packages/core/src/aws/brand-new.ts", "export const brandNew = 1;\n");
    lane.commit();
    expect(describeFindings(lane.guard())).toEqual(["cloud-aws packages/core/src/aws/brand-new.ts"]);
  });

  it("still fails a copy of a file under a guarded directory (the original stays, so it is a new file)", () => {
    const lane = new Lane();
    lane.write(NEW, ORIGINAL);
    lane.commit();
    expect(describeFindings(lane.guard())).toContain(`cloud-aws ${NEW}`);
  });

  it("judges a moved file with real new code by the lines it changed, as a modified file", () => {
    const lane = new Lane();
    lane.move(OLD, NEW);
    lane.write(NEW, `${REWRITTEN}export const extra = (): number => 42;\n`);
    lane.commit();
    expect(lane.guard()).toEqual([]);
    // ... and the changed lines are read: a private name among them fails, on its own line.
    lane.write(NEW, `${REWRITTEN}export const extra = "zorblaxcorp";\n`);
    lane.commit();
    expect(describeFindings(lane.guard())).toContain(`private-name ${NEW}:${REWRITTEN.split("\n").length}`);
  });

  it("still fails a moved file that now imports a Cloud-only package", () => {
    const lane = new Lane();
    lane.move(OLD, NEW);
    lane.write(NEW, BODY(NEW, "@agentx/web", "../util.js"));
    lane.commit();
    expect(describeFindings(lane.guard())).toContain(`cloud-import ${NEW}:3`);
  });

  it("still fails a move into a Cloud-only directory", () => {
    const lane = new Lane();
    lane.move(OLD, "packages/core/src/org/handler.ts");
    lane.commit();
    expect(describeFindings(lane.guard())).toEqual(["cloud-path packages/core/src/org/handler.ts"]);
  });

  it("still fails a file moved from a plain directory into an aws/ directory", () => {
    const lane = new Lane();
    lane.move("packages/old/src/util.ts", "packages/core/src/aws/util.ts");
    lane.commit();
    expect(describeFindings(lane.guard())).toEqual(["cloud-aws packages/core/src/aws/util.ts"]);
  });

  it("sees a private name added in a later commit to a file moved in an earlier one", () => {
    const lane = new Lane();
    lane.move(OLD, NEW);
    lane.commit();
    lane.write(NEW, `${ORIGINAL}// zorblaxcorp\n`.replace(OLD, NEW));
    lane.commit();
    expect(describeFindings(lane.guard()).some((entry) => entry.startsWith(`private-name ${NEW}:`))).toBe(true);
  });
});

describe("accepted entries follow a move", () => {
  it("keep an entry keyed by the old path after a pure move", () => {
    const lane = new Lane();
    lane.move(OLD, NEW);
    lane.commit();
    expect(lane.guard([accepted(lane, OLD)])).toEqual([]);
  });

  it("keep an entry keyed by the old path after a move that only rewrites imports", () => {
    const lane = new Lane();
    lane.move(OLD, NEW);
    lane.write(NEW, REWRITTEN);
    lane.commit();
    expect(lane.guard([accepted(lane, OLD)])).toEqual([]);
  });

  it("keep an entry already keyed by the new path (old blob) after a move that only rewrites imports", () => {
    const lane = new Lane();
    lane.move(OLD, NEW);
    lane.write(NEW, REWRITTEN);
    lane.commit();
    expect(lane.guard([accepted(lane, NEW)])).toEqual([]);
  });

  it("report the entry as stale when the move also changes real code", () => {
    const lane = new Lane();
    lane.move(OLD, NEW);
    lane.write(NEW, `${REWRITTEN}export const extra = (): number => 42;\n`);
    lane.commit();
    expect(describeFindings(lane.guard([accepted(lane, OLD)]))).toContain(`accepted-stale ${NEW}`);
  });

  it("report the entry as stale when the old path is removed and nothing is at the new one", () => {
    const lane = new Lane();
    git(lane.dir, "rm", "-q", "-f", OLD);
    lane.commit();
    expect(describeFindings(lane.guard([{ path: OLD, rule: "cloud-aws", blob: lane.blob("base", OLD), reason: "owner decision 2026-11-12: already public" }]))).toEqual([`accepted-stale ${OLD}`]);
  });

  it("keep an entry for a file edited in place only in imports and package names", () => {
    const lane = new Lane();
    lane.write(OLD, ORIGINAL.replace("@agentx/contracts", "@rovara-code/contracts"));
    lane.commit();
    expect(lane.guard([accepted(lane, OLD)])).toEqual([]);
  });

  it("report the entry as stale for a file edited in place with real code", () => {
    const lane = new Lane();
    lane.write(OLD, `${ORIGINAL}export const extra = 1;\n`);
    lane.commit();
    expect(describeFindings(lane.guard([accepted(lane, OLD)]))).toEqual([`accepted-stale ${OLD}`]);
  });

  it("do not carry an entry whose blob is not in the repository or is another file", () => {
    const lane = new Lane();
    lane.move(OLD, NEW);
    lane.write(NEW, REWRITTEN);
    lane.commit();
    const wrong: AcceptedFinding = { path: OLD, rule: "cloud-aws", blob: "0".repeat(40), reason: "owner decision 2026-11-12: already public" };
    expect(describeFindings(lane.guard([wrong]))).toEqual([`accepted-stale ${NEW}`]);
  });
});

describe("maskSpecifiers", () => {
  it("empties specifiers, package names and an own-path comment, and nothing else", () => {
    expect(maskSpecifiers('// packages/a/src/x.ts\nimport { a } from "@agentx/contracts";\nconst b = require("../c.js");\n')).toBe(
      maskSpecifiers('// packages/b/src/x.ts\nimport { a } from "@rovara-code/contracts";\nconst b = require("./c.js");\n'),
    );
    expect(maskSpecifiers('import { a } from "x";\n')).not.toBe(maskSpecifiers('import { b } from "x";\n'));
    expect(maskSpecifiers("const a = 1;\n")).not.toBe(maskSpecifiers("const a = 2;\n"));
  });
});
