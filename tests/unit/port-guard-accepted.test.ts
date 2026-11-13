import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ACCEPTABLE_RULES, GuardError, parseAccepted, runGuard, nameSourceFromWords, type AcceptedFinding, type Finding } from "../../scripts/port-guard.js";

// The accepted-findings list (scripts/port-guard-accepted.json): a cloud-aws or secret finding is skipped only when path, rule AND the file's exact blob at the
// tip match an entry. An edit, another rule, a new file, or a private name is flagged as before, and an entry whose file changed or is gone is itself a finding.
// The names here are invented.

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

class Lane {
  readonly dir = mkdtempSync(join(tmpdir(), "port-guard-accepted-"));
  constructor() {
    roots.push(this.dir);
    git(this.dir, "init", "-q", "-b", "code-next");
    this.write("README.md", "base\n");
    git(this.dir, "add", "-A");
    git(this.dir, "commit", "-q", "-m", "base");
    git(this.dir, "branch", "base");
    git(this.dir, "switch", "-q", "-c", "lane");
  }
  write(path: string, text: string): void {
    mkdirSync(dirname(join(this.dir, path)), { recursive: true });
    writeFileSync(join(this.dir, path), text);
  }
  commit(): void {
    git(this.dir, "add", "-A");
    git(this.dir, "commit", "-q", "-m", "lane");
  }
  blob(path: string): string {
    return git(this.dir, "rev-parse", `lane:${path}`).trim();
  }
  guard(accepted: readonly AcceptedFinding[], gitleaks: "run" | "off" = "off"): Finding[] {
    return this.run(accepted, gitleaks).findings;
  }
  run(accepted: readonly AcceptedFinding[], gitleaks: "run" | "off" = "off") {
    return runGuard({ cwd: this.dir, range: "base..lane", gitleaks, names: INVENTED, accepted });
  }
}

const HANDLER = "packages/core/src/aws/handler.ts";
const entry = (lane: Lane, path = HANDLER, rule: AcceptedFinding["rule"] = "cloud-aws"): AcceptedFinding => ({ path, rule, blob: lane.blob(path), reason: "owner decision 2026-11-12: already public" });
const rules = (findings: Finding[]) => findings.map((finding) => `${finding.rule} ${finding.file}`);

describe("accepted findings", () => {
  it("skip a finding whose path, rule and exact content match an entry", () => {
    const lane = new Lane();
    lane.write(HANDLER, "export const handler = 1;\n");
    lane.commit();
    expect(rules(lane.guard([]))).toEqual([`cloud-aws ${HANDLER}`]);
    expect(lane.guard([entry(lane)])).toEqual([]);
  });

  it("flag an accepted file again once it is edited, and report the entry as stale", () => {
    const lane = new Lane();
    lane.write(HANDLER, "export const handler = 1;\n");
    lane.commit();
    const accepted = entry(lane);
    lane.write(HANDLER, "export const handler = 2;\n");
    lane.commit();
    // Changed inside the range: an error, and the file is still flagged on its own merits.
    expect(rules(lane.guard([accepted]))).toEqual([`cloud-aws ${HANDLER}`, `accepted-stale ${HANDLER}`]);
  });

  it("flag a new file under aws/ that no entry names, while the accepted one stays skipped", () => {
    const lane = new Lane();
    lane.write(HANDLER, "export const handler = 1;\n");
    lane.write("packages/core/src/aws/other.ts", "export const other = 1;\n");
    lane.commit();
    expect(rules(lane.guard([entry(lane)]))).toEqual(["cloud-aws packages/core/src/aws/other.ts"]);
  });

  it("do not cover another rule on the same file", () => {
    const lane = new Lane();
    lane.write(HANDLER, "export const handler = 1;\n");
    lane.commit();
    expect(rules(lane.guard([{ ...entry(lane), rule: "secret" }]))).toEqual([`cloud-aws ${HANDLER}`]);
  });

  it("treat an entry whose file is not at the tip and not touched by the range as inactive: it skips nothing and fails nothing, with a note", () => {
    const lane = new Lane();
    lane.write("packages/core/src/aws/other.ts", "export const other = 1;\n");
    lane.commit();
    const absent: AcceptedFinding = { path: HANDLER, rule: "cloud-aws", blob: "a".repeat(40), reason: "owner decision 2026-11-12: already public" };
    const result = lane.run([absent]);
    expect(rules(result.findings)).toEqual(["cloud-aws packages/core/src/aws/other.ts"]);
    expect(result.notes).toEqual([expect.stringContaining(`${HANDLER}: accepted cloud-aws entry inactive`)]);
    expect(result.warnings).toEqual([]);
  });

  it("only warn about an entry whose file changed before the range, when the range does not touch it", () => {
    const lane = new Lane();
    // The file is on the base already, with other content than the entry pins; the range works elsewhere.
    git(lane.dir, "switch", "-q", "base");
    lane.write(HANDLER, "export const handler = 2;\n");
    lane.commit();
    git(lane.dir, "switch", "-q", "lane");
    git(lane.dir, "reset", "-q", "--hard", "base");
    lane.write("docs/notes.md", "a note\n");
    lane.commit();
    const old: AcceptedFinding = { path: HANDLER, rule: "cloud-aws", blob: "b".repeat(40), reason: "owner decision 2026-11-12: already public" };
    const result = lane.run([old]);
    expect(result.findings).toEqual([]);
    expect(result.warnings).toEqual([expect.stringContaining(`${HANDLER}: accepted cloud-aws entry no longer matches`)]);
  });

  it("report an entry for a file the range removes as stale", () => {
    const lane = new Lane();
    lane.write(HANDLER, "export const handler = 1;\n");
    lane.commit();
    const accepted = entry(lane);
    git(lane.dir, "rm", "-q", HANDLER);
    lane.commit();
    expect(rules(lane.guard([accepted]))).toContain(`accepted-stale ${HANDLER}`);
  });

  it("never accept a private name, even in a file whose cloud-aws finding is accepted", () => {
    const lane = new Lane();
    lane.write(HANDLER, "// built for zorblaxcorp\nexport const handler = 1;\n");
    lane.commit();
    expect(rules(lane.guard([entry(lane)]))).toEqual([`private-name ${HANDLER}`]);
    expect(ACCEPTABLE_RULES).not.toContain("private-name");
    expect(() => parseAccepted(JSON.stringify({ version: 1, accepted: [{ path: HANDLER, rule: "private-name", blob: "a".repeat(40), reason: "a reason that is long" }] }), "list")).toThrow(GuardError);
  });

  it.skipIf(spawnSync("gitleaks", ["version"]).status !== 0)("skip a secret finding only for its exact file content", () => {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    const key = `${["AK", "IA"].join("")}${Array.from(randomBytes(16), (byte) => alphabet[byte % alphabet.length]).join("")}`;
    const lane = new Lane();
    lane.write("tests/fixture.ts", `export const key = "${key}";\n`);
    lane.commit();
    expect(rules(lane.guard([], "run"))).toContain("secret tests/fixture.ts");
    expect(rules(lane.guard([entry(lane, "tests/fixture.ts", "secret")], "run"))).not.toContain("secret tests/fixture.ts");
  }, 60_000);
});

describe("the accepted-findings data", () => {
  const one = (overrides: Record<string, unknown>) => JSON.stringify({ version: 1, accepted: [{ path: HANDLER, rule: "cloud-aws", blob: "a".repeat(40), reason: "a reason that is long", ...overrides }] });
  it.each([
    ["a wildcard", { path: "packages/core/src/aws/*.ts" }],
    ["a directory", { path: "packages/core/src/aws/" }],
    ["a parent step", { path: "packages/../aws/x.ts" }],
    ["another rule", { rule: "guard-files" }],
    ["a short blob", { blob: "abc" }],
    ["no reason", { reason: "" }],
    ["an extra field", { line: 3 }],
  ])("refuses %s", (_label, overrides) => {
    expect(() => parseAccepted(one(overrides), "list")).toThrow(GuardError);
  });

  it("refuses the same path and rule twice, and a list that is not version 1", () => {
    const first = (JSON.parse(one({})) as { accepted: unknown[] }).accepted[0];
    const twice = JSON.stringify({ version: 1, accepted: [first, first] });
    expect(() => parseAccepted(twice, "list")).toThrow(GuardError);
    expect(() => parseAccepted(JSON.stringify({ version: 2, accepted: [] }), "list")).toThrow(GuardError);
  });

  it("the repository's own list reads, and names only cloud-aws and secret findings with their reasons", () => {
    const list = parseAccepted(readFileSync(join(process.cwd(), "scripts/port-guard-accepted.json"), "utf8"), "scripts/port-guard-accepted.json");
    for (const accepted of list) expect(ACCEPTABLE_RULES).toContain(accepted.rule);
    expect(list.every((accepted) => /^(owner decision 2026-11-12: AWS files already public on mainline|mainline commit [0-9a-f]{8}, fake test value)/.test(accepted.reason))).toBe(true);
  });
});
